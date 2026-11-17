package goodfork

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const chronological = " ORDER BY p.created_at DESC,p.id DESC"

type reviewCursor struct {
	At    time.Time `json:"at"`
	ID    string    `json:"id"`
	Scope string    `json:"scope"`
}

func usesCursor(r *http.Request) bool {
	return r.URL.Query().Get("paging") == "cursor" || r.URL.Query().Get("cursor") != ""
}

func (a *API) chronologicalPage(w http.ResponseWriter, r *http.Request, scope string, query string, args ...any) error {
	scope = hex.EncodeToString(digest(scope))[:24]
	var afterAt any
	var afterID any
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		var cursor reviewCursor
		if len(raw) > 384 {
			return invalid("Invalid page. Refresh this list.")
		}
		body, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(body, &cursor) != nil || cursor.Scope != scope ||
			!uuid.MatchString(cursor.ID) || cursor.At.IsZero() {
			return invalid("Invalid page. Refresh this list.")
		}
		afterAt, afterID = cursor.At, cursor.ID
	}
	size := len(args)
	query += fmt.Sprintf(" AND ($%d::timestamptz IS NULL OR (p.created_at,p.id)<($%d::timestamptz,$%d::uuid))", size+1, size+1, size+2) + chronological
	query += fmt.Sprintf(" LIMIT %d", pageSize+1)
	items, err := many(r.Context(), a.db, query, append(args, afterAt, afterID)...)
	if err != nil {
		return err
	}
	result := page{Items: items}
	if len(items) > pageSize {
		var tail struct {
			ID        string    `json:"id"`
			CreatedAt time.Time `json:"createdAt"`
		}
		if err := json.Unmarshal(items[pageSize-1], &tail); err != nil {
			return err
		}
		body, err := json.Marshal(reviewCursor{At: tail.CreatedAt, ID: tail.ID, Scope: scope})
		if err != nil {
			return err
		}
		result.Items, result.NextCursor = items[:pageSize], base64.RawURLEncoding.EncodeToString(body)
	}
	return send(w, http.StatusOK, result)
}
