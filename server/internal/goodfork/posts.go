package goodfork

import (
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const postJoin = " FROM posts p JOIN places d ON d.id=p.place_id JOIN people a ON a.id=p.author_id"

func (a *API) feed(w http.ResponseWriter, r *http.Request, viewer string) error {
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "for-you"
	}
	if kind != "for-you" && kind != "following" && kind != "clips" {
		return invalid("Choose a feed.")
	}
	filter := `
		LEFT JOIN objects o ON p.object_id=o.id
		WHERE p.status='published' AND d.status='published' AND gf_visible($1,p.author_id)
		  AND ($2<>'following' OR EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND followed_id=p.author_id))
		  AND ($2<>'clips' OR o.content_type LIKE 'video/%')`
	if kind != "for-you" && usesCursor(r) {
		return a.chronologicalPage(w, r, "feed:"+kind+":"+viewer, `SELECT gf_post(p,d,a,$1)`+postJoin+filter, nullable(viewer), kind)
	}
	order := chronological
	if kind == "for-you" && viewer != "" {
		// Rank a bounded set of recent reviews. Older reviews remain available on diner and restaurant pages.
		filter += ` AND p.id IN (SELECT id FROM posts WHERE status='published' AND created_at>now()-interval '30 days' ORDER BY created_at DESC,id DESC LIMIT 1000)`
		order = ` ORDER BY p.created_at +
			CASE WHEN EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND followed_id=p.author_id)
				THEN interval '2 hours' ELSE interval '0' END +
			CASE WHEN EXISTS(SELECT 1 FROM saves s JOIN places t ON t.id=s.place_id
				WHERE s.person_id=$1 AND lower(t.cuisine)=lower(d.cuisine))
				THEN interval '1 hour' ELSE interval '0' END DESC,p.id DESC`
	}
	return a.list(w, r, `SELECT gf_post(p,d,a,$1)`+postJoin+filter+order, nullable(viewer), kind)
}

const readPost = `SELECT gf_post(p,d,a,$1)` + postJoin + `
	WHERE p.id=$2 AND d.status='published' AND (p.status='published' OR p.author_id=$1) AND gf_visible($1,p.author_id)`

func (a *API) post(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.resource(w, r, readPost, nullable(viewer), r.PathValue("id"))
}

type reviewInput struct {
	Score        float64 `json:"score"`
	Text         string  `json:"text"`
	Dish         string  `json:"dish"`
	RestaurantID string  `json:"restaurantId,omitempty"`
	RequestID    string  `json:"requestId,omitempty"`
	Revision     string  `json:"revision,omitempty"`
}

func (a *API) reviewInput(d *reviewInput) error {
	if math.IsNaN(d.Score) || d.Score < 1 || d.Score > 10 || math.Abs(math.Round(d.Score*10)-d.Score*10) > 1e-8 {
		return invalid("Pick a score from 1 to 10 with at most one decimal.")
	}
	var err error
	d.Text, err = tidy(d.Text, 5, 1500, "Review")
	if err != nil {
		return err
	}
	d.Dish, err = tidy(d.Dish, 0, 72, "Dish")
	if err != nil {
		return err
	}
	return a.filter(d.Text + " " + d.Dish)
}

func (a *API) createPost(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body reviewInput
	var data []byte
	var mime string
	var err error
	multipart := strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data")
	if multipart {
		select {
		case a.uploads <- struct{}{}:
			defer func() { <-a.uploads }()
		default:
			return slowDown
		}
		r.Body = http.MaxBytesReader(w, r.Body, MaxMediaBytes+(32<<10))
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			return invalid("Choose one photo or video up to 16 MB.")
		}
		defer r.MultipartForm.RemoveAll()
		body = reviewInput{Text: r.PostFormValue("text"), Dish: r.PostFormValue("dish"),
			RestaurantID: r.PostFormValue("restaurantId"), RequestID: r.PostFormValue("requestId")}
		body.Score, _ = strconv.ParseFloat(r.PostFormValue("score"), 64)
	} else if err := decode(w, r, &body); err != nil {
		return err
	}
	if !uuid.MatchString(body.RestaurantID) || !uuid.MatchString(body.RequestID) {
		return invalid("Choose a restaurant before posting.")
	}
	ctx := r.Context()
	const existingPost = `SELECT gf_post(p,d,a,$1)` + postJoin + ` WHERE p.author_id=$1 AND p.request_id=$2 AND d.status='published' AND p.place_id=$3`
	existing, err := one(ctx, a.db, existingPost, viewer, body.RequestID, body.RestaurantID)
	if err == nil {
		return send(w, http.StatusOK, existing)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err := a.reviewInput(&body); err != nil {
		return err
	}
	if err := a.limit(ctx, "post:"+viewer, 20, time.Hour); err != nil {
		return err
	}
	var appropriate, reviewed bool
	err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM places WHERE id=$1 AND status='published'),
		EXISTS(SELECT 1 FROM posts WHERE author_id=$2 AND place_id=$1)`, body.RestaurantID, viewer).Scan(&appropriate, &reviewed)
	if err := existsResult(err, appropriate); err != nil {
		return err
	}
	if reviewed {
		return conflict("You already reviewed this restaurant. Open its current review to edit it.")
	}
	if err := ownerConflict(ctx, a.db, body.RestaurantID, viewer); err != nil {
		return err
	}
	if multipart {
		if len(r.MultipartForm.File["media"]) != 1 || len(r.MultipartForm.File) != 1 {
			return invalid("Attach one photo or video.")
		}
		f, _, err := r.FormFile("media")
		if err != nil {
			return invalid("Add the photo or video again.")
		}
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, MaxMediaBytes+1))
		if err != nil {
			return err
		}
		if len(data) == 0 || len(data) > MaxMediaBytes {
			return invalid("Choose one photo or video up to 16 MB.")
		}
		mime, data, err = prepareMedia(data)
		if err != nil {
			return err
		}
	}
	var objectID string
	status := "published"
	if len(data) > 0 {
		objectID, err = a.postMedia(ctx, mime, data)
		if err != nil {
			return err
		}
		status = "pending"
	}
	var postID string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		place := body.RestaurantID
		if err := lockPlace(ctx, tx, place); err != nil {
			return err
		}
		var published bool
		err := tx.QueryRow(ctx, "SELECT status='published' FROM places WHERE id=$1", place).Scan(&published)
		if err := existsResult(err, published); err != nil {
			return err
		}
		if err := ownerConflict(ctx, tx, place, viewer); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			INSERT INTO posts(request_id,author_id,place_id,object_id,score,text,dish,status)
			VALUES ($1,$2,$3,$4,$5::float8::numeric,$6,$7,$8)
			RETURNING id::text`, body.RequestID, viewer, place, nullable(objectID), body.Score, body.Text, body.Dish, status).Scan(&postID)
	})
	if unique(err) {
		value, lookupErr := one(ctx, a.db, existingPost, viewer, body.RequestID, body.RestaurantID)
		if lookupErr == nil {
			return send(w, http.StatusOK, value)
		}
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			return conflict("You already reviewed this restaurant. Edit your review from your profile.")
		}
		return lookupErr
	}
	if err != nil {
		return err
	}
	value, err := one(ctx, a.db, readPost, viewer, postID)
	if err != nil {
		return err
	}
	return send(w, http.StatusCreated, value)
}

func (a *API) editPost(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body reviewInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if err := a.reviewInput(&body); err != nil {
		return err
	}
	if !uuid.MatchString(body.Revision) {
		return conflict("Reload this review before changing it.")
	}
	id := r.PathValue("id")
	ctx := r.Context()
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := lockPostPlace(ctx, tx, id); err != nil {
			return err
		}
		var current string
		if err := tx.QueryRow(ctx, "SELECT revision::text FROM posts WHERE id=$1 AND author_id=$2", id, viewer).Scan(&current); err != nil {
			return err
		}
		if current != body.Revision {
			var same bool
			if err := tx.QueryRow(ctx, "SELECT score=$3::float8::numeric AND text=$4 AND dish=$5 FROM posts WHERE id=$1 AND author_id=$2", id, viewer, body.Score, body.Text, body.Dish).Scan(&same); err != nil {
				return err
			}
			if same {
				return nil
			}
			return conflict("This review changed. Load its current version before saving.")
		}
		res, err := tx.Exec(ctx, `
			UPDATE posts p SET score=$3::float8::numeric,text=$4,dish=$5,revision=gen_random_uuid(),
				status=CASE WHEN p.status='hidden' THEN 'pending' ELSE p.status END
			FROM places d WHERE p.id=$1 AND p.author_id=$2 AND p.place_id=d.id AND d.status='published'
				AND NOT p.ownership_conflict
				AND NOT EXISTS(SELECT 1 FROM restaurant_owners o WHERE o.place_id=p.place_id AND o.person_id=$2)`,
			id, viewer, body.Score, body.Text, body.Dish)
		return existsResult(err, res.RowsAffected() > 0)
	})
	if err != nil {
		return err
	}
	return a.resource(w, r, readPost, viewer, id)
}

func (a *API) deletePost(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Revision string `json:"revision"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !uuid.MatchString(body.Revision) {
		return conflict("Reload this review before deleting it.")
	}
	err := pgx.BeginFunc(r.Context(), a.db, func(tx pgx.Tx) error {
		if _, err := lockPostPlace(r.Context(), tx, r.PathValue("id")); err != nil {
			return err
		}
		res, err := tx.Exec(r.Context(), "DELETE FROM posts WHERE id=$1 AND author_id=$2 AND revision=$3", r.PathValue("id"), viewer, body.Revision)
		if err != nil {
			return err
		}
		if res.RowsAffected() == 0 {
			return conflict("This review changed or was removed. Reload it before deleting.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type sharedContent struct {
	Title, Description, Link string
}

func (a *API) sharePlace(w http.ResponseWriter, r *http.Request, _ string) error {
	id := r.PathValue("id")
	var data sharedContent
	if err := a.db.QueryRow(r.Context(), "SELECT name,concat_ws(' · ',cuisine,address,city) FROM places WHERE id=$1 AND status='published'", id).
		Scan(&data.Title, &data.Description); err != nil {
		return err
	}
	data.Link = "goodfork://restaurant/" + id
	return sharePage(w, data)
}

func (a *API) sharePost(w http.ResponseWriter, r *http.Request, _ string) error {
	id := r.PathValue("id")
	var data sharedContent
	if err := a.db.QueryRow(r.Context(), `SELECT d.name,p.text`+postJoin+` WHERE p.id=$1 AND p.status='published' AND d.status='published'`, id).
		Scan(&data.Title, &data.Description); err != nil {
		return err
	}
	data.Link = "goodfork://review/" + id
	return sharePage(w, data)
}
