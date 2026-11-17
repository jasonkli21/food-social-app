package goodfork

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/jackc/pgx/v5"
)

const MaxMediaBytes = 16 << 20

type MediaStore interface {
	Put(context.Context, string, string, []byte) error
	Open(context.Context, string, int64) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

type GCS struct{ bucket *storage.BucketHandle }

func CloudStorage(client *storage.Client, bucket string) GCS { return GCS{client.Bucket(bucket)} }

func objectKey(id string) string { return "reviews/" + id }

func (g GCS) Put(ctx context.Context, id, contentType string, data []byte) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	w := g.bucket.Object(objectKey(id)).If(storage.Conditions{DoesNotExist: true}).NewWriter(ctx)
	w.ContentType = contentType
	w.CacheControl = "private, no-store"
	if _, err := w.Write(data); err != nil {
		cancel()
		_ = w.Close()
		return err
	}
	return w.Close()
}

func (g GCS) Open(ctx context.Context, id string, offset int64) (io.ReadCloser, error) {
	return g.bucket.Object(objectKey(id)).NewRangeReader(ctx, offset, -1)
}

func (g GCS) Delete(ctx context.Context, id string) error {
	err := g.bucket.Object(objectKey(id)).Delete(ctx)
	if errors.Is(err, storage.ErrObjectNotExist) {
		return nil
	}
	return err
}

type LocalMedia string

func (l LocalMedia) Put(ctx context.Context, id, _ string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(string(l), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(string(l), ".upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(data)
	if err := errors.Join(writeErr, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(string(l), id))
}

func (l LocalMedia) Open(_ context.Context, id string, offset int64) (io.ReadCloser, error) {
	f, err := os.Open(filepath.Join(string(l), id))
	if err != nil {
		return nil, err
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func (l LocalMedia) Delete(_ context.Context, id string) error {
	err := os.Remove(filepath.Join(string(l), id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func prepareMedia(data []byte) (string, []byte, error) {
	if len(data) == 0 || len(data) > MaxMediaBytes {
		return "", nil, invalid("Choose one photo or clip up to 16 MB.")
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/jpeg", "image/png":
		dim, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || dim.Width < 1 || dim.Height < 1 || int64(dim.Width)*int64(dim.Height) > 12_000_000 {
			return "", nil, invalid("Choose a valid photo up to 12 megapixels.")
		}
		photo, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return "", nil, invalid("This photo could not be opened. Choose another file.")
		}
		var clean bytes.Buffer
		if mime == "image/jpeg" {
			photo = orientPhoto(photo, jpegOrientation(data))
			err = jpeg.Encode(&clean, photo, &jpeg.Options{Quality: 88})
		} else {
			err = png.Encode(&clean, photo)
		}
		if err != nil || clean.Len() > MaxMediaBytes {
			return "", nil, invalid("Choose a smaller photo up to 16 MB.")
		}
		return mime, clean.Bytes(), nil
	}

	ftyp := mp4Box(data, "ftyp")
	if len(ftyp) < 8 {
		return "", nil, invalid("Choose a JPEG or PNG photo, or an H.264 clip in MP4 or MOV.")
	}
	movie := mp4Box(data, "moov")
	if len(mp4Box(data, "mdat")) == 0 || !validDuration(mp4Box(movie, "mvhd")) || !compatibleTracks(movie) {
		return "", nil, invalid("Choose an H.264 video with optional AAC audio, up to 30 seconds long.")
	}
	removeMediaMetadata(data, 0)
	if string(ftyp[:4]) == "qt  " {
		return "video/quicktime", data, nil
	}
	return "video/mp4", data, nil
}

// nextMP4Box returns the type, payload and remainder of a single ISO media box.
func nextMP4Box(data []byte) (string, []byte, []byte) {
	if len(data) < 8 {
		return "", nil, nil
	}
	size := uint64(binary.BigEndian.Uint32(data[:4]))
	header := uint64(8)
	switch size {
	case 0:
		size = uint64(len(data))
	case 1:
		if len(data) < 16 {
			return "", nil, nil
		}
		header = 16
		size = binary.BigEndian.Uint64(data[8:16])
	}
	if size < header || size > uint64(len(data)) {
		return "", nil, nil
	}
	return string(data[4:8]), data[header:size], data[size:]
}

func mp4Box(data []byte, kind string) []byte {
	for len(data) > 0 {
		name, body, rest := nextMP4Box(data)
		if name == kind {
			return body
		}
		data = rest
	}
	return nil
}

func compatibleTracks(movie []byte) bool {
	video, audio := 0, 0
	for len(movie) > 0 {
		name, track, rest := nextMP4Box(movie)
		if name == "" {
			return false
		}
		movie = rest
		if name != "trak" {
			continue
		}
		media := mp4Box(track, "mdia")
		handler := mp4Box(media, "hdlr")
		stbl := mp4Box(mp4Box(media, "minf"), "stbl")
		descriptions := mp4Box(stbl, "stsd")
		sizes := mp4Box(stbl, "stsz")
		if len(handler) < 12 || len(descriptions) < 16 ||
			binary.BigEndian.Uint32(descriptions[4:8]) != 1 || len(sizes) < 12 ||
			binary.BigEndian.Uint32(sizes[8:12]) == 0 {
			return false
		}
		codec, entry, _ := nextMP4Box(descriptions[8:])
		switch string(handler[8:12]) {
		case "vide":
			if (codec != "avc1" && codec != "avc3") || len(entry) < 78 || len(mp4Box(entry[78:], "avcC")) < 7 {
				return false
			}
			video++
		case "soun":
			if codec != "mp4a" {
				return false
			}
			audio++
		default:
			return false
		}
	}
	return video == 1 && audio <= 1
}

// Keep media offsets stable when removing common container metadata.
func removeMediaMetadata(data []byte, depth int) {
	for len(data) > 0 && depth < 8 {
		name, body, rest := nextMP4Box(data)
		if name == "" {
			return
		}
		switch name {
		case "moov", "trak", "mdia", "minf", "stbl":
			removeMediaMetadata(body, depth+1)
		case "udta", "meta", "uuid":
			copy(data[4:8], "free")
			clear(body)
		}
		data = rest
	}
}

func validDuration(header []byte) bool {
	if len(header) < 20 {
		return false
	}
	var scale, duration uint64
	switch header[0] {
	case 0:
		scale = uint64(binary.BigEndian.Uint32(header[12:16]))
		duration = uint64(binary.BigEndian.Uint32(header[16:20]))
	case 1:
		if len(header) < 32 {
			return false
		}
		scale = uint64(binary.BigEndian.Uint32(header[20:24]))
		duration = binary.BigEndian.Uint64(header[24:32])
	default:
		return false
	}
	return scale > 0 && duration > 0 && duration <= scale*30
}

type mediaReader struct {
	ctx      context.Context
	store    MediaStore
	id       string
	size     int64
	position int64
	openedAt int64
	reader   io.ReadCloser
}

func (m *mediaReader) Read(p []byte) (int, error) {
	if m.position >= m.size {
		return 0, io.EOF
	}
	if m.reader == nil || m.openedAt != m.position {
		m.close()
		r, err := m.store.Open(m.ctx, m.id, m.position)
		if err != nil {
			return 0, err
		}
		m.reader = r
	}
	n, err := m.reader.Read(p)
	m.position += int64(n)
	m.openedAt = m.position
	return n, err
}
func (m *mediaReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += m.position
	case io.SeekEnd:
		offset += m.size
	default:
		return 0, errors.New("invalid seek origin")
	}
	if offset < 0 {
		return 0, errors.New("invalid seek position")
	}
	m.position = offset
	return offset, nil
}
func (m *mediaReader) close() {
	if m.reader != nil {
		_ = m.reader.Close()
		m.reader = nil
	}
}

func (a *API) media(w http.ResponseWriter, r *http.Request, viewer string) error {
	id := r.PathValue("id")
	var mime string
	var size int64
	var created time.Time
	err := a.db.QueryRow(r.Context(), `
		SELECT o.content_type,o.size,o.created_at FROM objects o
		JOIN posts p ON p.object_id=o.id JOIN places d ON d.id=p.place_id
		WHERE o.id=$1 AND d.status='published' AND gf_visible($2,p.author_id)
		  AND (p.status='published' OR (p.status='pending' AND p.author_id=$2))`,
		id, nullable(viewer)).Scan(&mime, &size, &created)
	if err != nil {
		return err
	}
	if strings.Contains(r.Header.Get("Range"), ",") {
		w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
		return apiError{http.StatusRequestedRangeNotSatisfiable, "Request a single byte range."}
	}
	source, err := a.storage.Open(r.Context(), id, 0)
	if err != nil {
		a.log.Warn("authorized media unavailable")
		return apiError{http.StatusServiceUnavailable, "The attachment is temporarily unavailable. Try again shortly."}
	}
	m := &mediaReader{ctx: r.Context(), store: a.storage, id: id, size: size, reader: source}
	defer m.close()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("ETag", `"`+id+`"`)
	http.ServeContent(w, r, id, created, m)
	return nil
}

func (a *API) postMedia(ctx context.Context, mime string, data []byte) (string, error) {
	var id string
	err := a.db.QueryRow(ctx, "INSERT INTO objects(content_type,size) VALUES ($1,$2) RETURNING id::text", mime, len(data)).Scan(&id)
	if err != nil {
		return "", err
	}
	if err := a.storage.Put(ctx, id, mime, data); err != nil {
		return "", err
	}
	return id, nil
}

func Purge(ctx context.Context, db interface {
	Begin(context.Context) (pgx.Tx, error)
}, store MediaStore, max int) (int, error) {
	for count := 0; count < max; count++ {
		err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
			var id string
			// An age floor prevents deleting an object while an upload is in progress.
			err := tx.QueryRow(ctx, `
				SELECT o.id::text FROM objects o WHERE o.created_at<now()-interval '1 hour'
				  AND NOT EXISTS (SELECT 1 FROM posts WHERE object_id=o.id)
				ORDER BY o.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
			if err != nil {
				return err
			}
			if err := store.Delete(ctx, id); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "DELETE FROM objects WHERE id=$1", id)
			return err
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return count, nil
		}
		if err != nil {
			return count, err
		}
	}
	return max, nil
}
