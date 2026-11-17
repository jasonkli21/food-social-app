package goodfork

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type visitInput struct {
	RestaurantID string   `json:"restaurantId"`
	RequestID    string   `json:"requestId"`
	Revision     string   `json:"revision"`
	VisitDate    string   `json:"visitDate"`
	Note         string   `json:"note"`
	Dish         string   `json:"dish"`
	Score        *float64 `json:"score"`
}

const visitProjection = `SELECT jsonb_build_object(
    'id',v.id,'restaurantId',CASE WHEN d.status='published' THEN d.id ELSE NULL END,
    'restaurantName',v.place_name,'unavailable',coalesce(d.status<>'published',true),
    'visitDate',to_char(v.visit_date,'YYYY-MM-DD'),'note',v.note,'dish',v.dish,'score',v.score,
    'revision',v.revision,'createdAt',v.created_at,'updatedAt',v.updated_at)
    FROM private_visits v LEFT JOIN places d ON d.id=v.place_id`

func (a *API) visits(w http.ResponseWriter, r *http.Request, viewer string) error {
	place := r.URL.Query().Get("place")
	if place != "" && !uuid.MatchString(place) {
		return invalid("Choose a restaurant.")
	}
	date, id := "9999-12-31", "ffffffff-ffff-ffff-ffff-ffffffffffff"
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		if len(cursor) > 320 {
			return invalid("Reload your journal to continue.")
		}
		decoded, err := base64.RawURLEncoding.DecodeString(cursor)
		parts := strings.Split(string(decoded), "|")
		if err != nil || len(parts) != 4 || parts[0] != viewer || parts[1] != place || !uuid.MatchString(parts[3]) {
			return invalid("Reload your journal to continue.")
		}
		if _, err := time.Parse("2006-01-02", parts[2]); err != nil {
			return invalid("Reload your journal to continue.")
		}
		date, id = parts[2], parts[3]
	}
	items, err := many(r.Context(), a.db, visitProjection+`
        WHERE v.person_id=$1 AND ($2::uuid IS NULL OR v.place_id=$2)
        AND (v.visit_date,v.id)<($3::date,$4::uuid)
        ORDER BY v.visit_date DESC,v.id DESC LIMIT 21`, viewer, nullable(place), date, id)
	if err != nil {
		return err
	}
	result := page{Items: items}
	if len(items) > 20 {
		result.Items = items[:20]
		var last struct {
			ID   string `json:"id"`
			Date string `json:"visitDate"`
		}
		if err := json.Unmarshal(items[19], &last); err != nil {
			return err
		}
		result.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(viewer + "|" + place + "|" + last.Date + "|" + last.ID))
	}
	return send(w, http.StatusOK, result)
}

func (a *API) visit(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.resource(w, r, visitProjection+" WHERE v.id=$2 AND v.person_id=$1", viewer, r.PathValue("id"))
}

func (a *API) writeVisit(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body visitInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if date, err := time.Parse("2006-01-02", body.VisitDate); err != nil || date.Year() < 1 {
		return invalid("Enter a date in YYYY-MM-DD format.")
	}
	var err error
	body.Note, err = tidy(body.Note, 0, 1500, "Private note")
	if err != nil {
		return err
	}
	body.Dish, err = tidy(body.Dish, 0, 160, "Dishes")
	if err != nil {
		return err
	}
	if body.Score != nil && (math.IsNaN(*body.Score) || *body.Score < 1 || *body.Score > 10 || math.Abs(math.Round(*body.Score*10)-*body.Score*10) > 1e-8) {
		return invalid("Choose an optional score from 1 to 10 with one decimal.")
	}
	ctx := r.Context()
	id := r.PathValue("id")
	if id == "" {
		if !uuid.MatchString(body.RestaurantID) || !uuid.MatchString(body.RequestID) {
			return invalid("Choose a restaurant before saving.")
		}
		// A replay returns the original entry even when the listing has since been hidden.
		err = a.db.QueryRow(ctx, `SELECT id::text FROM private_visits WHERE person_id=$1 AND request_id=$2 AND place_id=$3`,
			viewer, body.RequestID, body.RestaurantID).Scan(&id)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		if id == "" {
			if err := a.limit(ctx, "visit:"+viewer, 60, time.Hour); err != nil {
				return err
			}
			err = a.db.QueryRow(ctx, `
                INSERT INTO private_visits(person_id,place_id,place_name,request_id,visit_date,note,dish,score)
                SELECT $1,d.id,d.name,$3,$4::date,$5,$6,$7::float8::numeric FROM places d
                WHERE d.id=$2 AND d.status='published'
                ON CONFLICT(person_id,request_id) DO UPDATE SET request_id=private_visits.request_id
                    WHERE private_visits.place_id=excluded.place_id
                RETURNING id::text`, viewer, body.RestaurantID, body.RequestID, body.VisitDate, body.Note, body.Dish, body.Score).Scan(&id)
			if err != nil {
				return err
			}
		}
	} else {
		if !uuid.MatchString(body.Revision) {
			return conflict("Reload this memory before changing it.")
		}
		res, err := a.db.Exec(ctx, `UPDATE private_visits SET visit_date=$4::date,note=$5,dish=$6,score=$7::float8::numeric,
            revision=gen_random_uuid(),updated_at=now() WHERE id=$1 AND person_id=$2 AND revision=$3`,
			id, viewer, body.Revision, body.VisitDate, body.Note, body.Dish, body.Score)
		if err != nil {
			return err
		}
		if res.RowsAffected() == 0 {
			var mine bool
			if err := a.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM private_visits WHERE id=$1 AND person_id=$2)", id, viewer).Scan(&mine); err != nil {
				return err
			}
			if !mine {
				return notFound
			}
			return conflict("This memory changed. Load its current version before saving.")
		}
	}
	value, err := one(ctx, a.db, visitProjection+" WHERE v.id=$2 AND v.person_id=$1", viewer, id)
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, value)
}

func (a *API) deleteVisit(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Revision string `json:"revision"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !uuid.MatchString(body.Revision) {
		return conflict("Reload this memory before deleting it.")
	}
	res, err := a.db.Exec(r.Context(), "DELETE FROM private_visits WHERE id=$1 AND person_id=$2 AND revision=$3", r.PathValue("id"), viewer, body.Revision)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		var mine bool
		if err := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM private_visits WHERE id=$1 AND person_id=$2)", r.PathValue("id"), viewer).Scan(&mine); err != nil {
			return err
		}
		if !mine {
			return notFound
		}
		return conflict("This memory changed or was removed. Reload your journal.")
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
