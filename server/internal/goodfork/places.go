package goodfork

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PlaceInput struct {
	Name        string   `json:"name"`
	Cuisine     string   `json:"cuisine"`
	Area        string   `json:"area"`
	City        string   `json:"city"`
	Address     string   `json:"address"`
	Lat         *float64 `json:"lat"`
	Lng         *float64 `json:"lng"`
	Price       *int16   `json:"price"`
	Description string   `json:"description"`
	Dietary     []string `json:"dietary"`
	Hours       []string `json:"hours"`
	Website     string   `json:"website"`
	Phone       string   `json:"phone"`
	MenuURL     string   `json:"menuURL,omitempty"`
	CoverURL    string   `json:"coverURL,omitempty"`
}

var phonePattern = regexp.MustCompile(`^[+0-9() .-]{6,32}$`)

func (p *PlaceInput) validate() error {
	fields := []struct {
		field    *string
		label    string
		min, max int
	}{
		{&p.Name, "Restaurant name", 1, 100},
		{&p.Cuisine, "Cuisine", 1, 48},
		{&p.Area, "Neighborhood", 0, 72},
		{&p.City, "City", 1, 72},
		{&p.Address, "Address", 4, 180},
	}
	for _, f := range fields {
		value, err := tidy(*f.field, f.min, f.max, f.label)
		if err != nil {
			return err
		}
		*f.field = value
	}
	if p.Lat == nil || p.Lng == nil || !coordinates(*p.Lat, *p.Lng) {
		return invalid("Choose a valid location for the restaurant.")
	}
	return p.validateDetails()
}

func (p *PlaceInput) validateDetails() error {
	description, err := tidy(p.Description, 0, 650, "Description")
	if err != nil {
		return err
	}
	p.Description = description
	if p.Price != nil && (*p.Price < 1 || *p.Price > 4) {
		return invalid("Choose a price level from 1 to 4.")
	}
	if len(p.Hours) > 7 || len(p.Dietary) > 8 {
		return invalid("Enter up to 7 hours entries and 8 dietary tags.")
	}
	if p.Dietary == nil {
		p.Dietary = []string{}
	}
	if p.Hours == nil {
		p.Hours = []string{}
	}
	for i, tag := range p.Dietary {
		clean, err := tidy(tag, 1, 36, "Dietary tag")
		if err != nil {
			return err
		}
		p.Dietary[i] = clean
	}
	for i, hours := range p.Hours {
		clean, err := tidy(hours, 1, 72, "Hours")
		if err != nil {
			return err
		}
		p.Hours[i] = clean
	}
	p.Phone = strings.TrimSpace(p.Phone)
	if p.Phone != "" && !phonePattern.MatchString(p.Phone) {
		return invalid("Enter a valid phone number.")
	}
	for _, website := range []*string{&p.Website, &p.MenuURL, &p.CoverURL} {
		*website = strings.TrimSpace(*website)
		if *website != "" && !httpsURL(*website) {
			return invalid("Use a valid HTTPS address for website or photo links.")
		}
	}
	return nil
}

func httpsURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= 1024 && u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}

func coordinates(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

const insertPlace = `
	INSERT INTO places(submitted_by,name,cuisine,area,city,address,lat,lng,price,description,dietary,hours,website,phone,cover_url,status,menu_url)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13,$14,$15,$16,$17)
`

func (p PlaceInput) args(author any, status string) []any {
	return []any{author, p.Name, p.Cuisine, p.Area, p.City, p.Address, *p.Lat, *p.Lng, p.Price,
		p.Description, p.Dietary, p.Hours, p.Website, p.Phone, p.CoverURL, status, p.MenuURL}
}

// ImportPlaces validates the complete directory before committing a single import.
func ImportPlaces(ctx context.Context, db *pgxpool.Pool, source io.Reader) (int, error) {
	var places []PlaceInput
	d := json.NewDecoder(source)
	d.DisallowUnknownFields()
	if err := d.Decode(&places); err != nil {
		return 0, err
	}
	if d.Decode(new(any)) != io.EOF {
		return 0, invalid("Expected one JSON array of restaurants.")
	}
	for i := range places {
		if err := places[i].validate(); err != nil {
			return 0, err
		}
	}
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		for _, place := range places {
			_, err := tx.Exec(ctx, insertPlace+`
				ON CONFLICT (lower(name),lower(address),lower(city)) DO UPDATE SET
					cuisine=excluded.cuisine,area=excluded.area,lat=excluded.lat,lng=excluded.lng,
					price=excluded.price,description=excluded.description,dietary=excluded.dietary,
					hours=excluded.hours,website=excluded.website,phone=excluded.phone,
					cover_url=excluded.cover_url,menu_url=excluded.menu_url,listing_revision=places.listing_revision+1
					WHERE places.status='published' AND places.listing_updated_at IS NULL
						AND NOT EXISTS(SELECT 1 FROM restaurant_owners o WHERE o.place_id=places.id)`, place.args(nil, "published")...)
			if err != nil {
				return err
			}
		}
		return nil
	})
	return len(places), err
}

func (a *API) submitPlace(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body PlaceInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	body.CoverURL = ""
	if err := body.validate(); err != nil {
		return err
	}
	if err := a.filter(strings.Join([]string{body.Name, body.Cuisine, body.Description, body.Area, body.City,
		body.Address, strings.Join(body.Hours, " "), strings.Join(body.Dietary, " ")}, " ")); err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.limit(ctx, "submit-place:"+viewer, 8, time.Hour); err != nil {
		return err
	}
	value, err := one(ctx, a.db, `WITH added AS (`+insertPlace+` RETURNING *) SELECT gf_place(added,$1) FROM added`,
		body.args(viewer, "pending")...)
	if unique(err) {
		return conflict("A restaurant with this name and address already exists or is under review.")
	}
	if err != nil {
		return err
	}
	return send(w, http.StatusCreated, value)
}

func (a *API) place(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.resource(w, r, `
		SELECT gf_place(p,$2) FROM places p
		WHERE p.id=$1 AND (p.status='published' OR (p.status='pending' AND p.submitted_by=$2))`,
		r.PathValue("id"), nullable(viewer))
}

func (a *API) placeReviews(w http.ResponseWriter, r *http.Request, viewer string) error {
	id := r.PathValue("id")
	unanswered := r.URL.Query().Get("unanswered") == "1"
	query := `SELECT gf_post(p,d,a,$1)` + postJoin + `
		WHERE d.id=$2 AND d.status='published' AND (p.status='published' OR p.author_id=$1)
			AND gf_visible($1,p.author_id)
			AND (NOT $3::bool OR (p.status='published' AND NOT EXISTS (
				SELECT 1 FROM restaurant_replies b JOIN restaurant_owners o ON o.place_id=d.id AND o.person_id=b.author_id
				WHERE b.post_id=p.id
			)))`
	if usesCursor(r) {
		return a.chronologicalPage(w, r, "place:"+id+":"+viewer+":"+r.URL.Query().Get("unanswered"),
			query, nullable(viewer), id, unanswered)
	}
	return a.list(w, r, query+` ORDER BY (p.author_id IS NOT DISTINCT FROM $1) DESC,p.created_at DESC,p.id DESC`,
		nullable(viewer), id, unanswered)
}

func (a *API) ownerReviews(w http.ResponseWriter, r *http.Request, viewer string) error {
	id := r.PathValue("id")
	var allowed bool
	err := a.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM places d JOIN restaurant_owners o ON o.place_id=d.id
		WHERE d.id=$1 AND d.status='published' AND o.person_id=$2)`, id, viewer).Scan(&allowed)
	if err := existsResult(err, allowed); err != nil {
		return err
	}
	unanswered := r.URL.Query().Get("unanswered") == "1"
	return a.chronologicalPage(w, r, "owner:"+id+":"+viewer+":"+r.URL.Query().Get("unanswered"),
		"SELECT gf_post(p,d,a,$1)"+postJoin+`
		JOIN restaurant_owners o ON o.place_id=d.id
		WHERE d.id=$2 AND d.status='published' AND p.status='published' AND o.person_id=$1
		  AND p.author_id<>$1 AND gf_visible($1,p.author_id)
		  AND (NOT $3::bool OR NOT EXISTS(SELECT 1 FROM restaurant_replies b WHERE b.post_id=p.id AND b.author_id=$1))`,
		viewer, id, unanswered)
}

func (a *API) savePlace(w http.ResponseWriter, r *http.Request, viewer string) error {
	active, err := activeValue(w, r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	id := r.PathValue("id")
	if active {
		var exists bool
		err = a.db.QueryRow(ctx, `
			WITH added AS (
				INSERT INTO saves(person_id,place_id) SELECT $1,id FROM places WHERE id=$2 AND status='published'
				ON CONFLICT DO NOTHING
			)
			SELECT EXISTS(SELECT 1 FROM places WHERE id=$2 AND status='published')`, viewer, id).Scan(&exists)
		if err == nil && !exists {
			return notFound
		}
	} else {
		_, err = a.db.Exec(ctx, "DELETE FROM saves WHERE person_id=$1 AND place_id=$2", viewer, id)
	}
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) saved(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.list(w, r, `
		SELECT gf_place(p,$1) FROM saves s JOIN places p ON p.id=s.place_id
		WHERE s.person_id=$1 AND p.status='published' ORDER BY s.created_at DESC,p.id`, viewer)
}

const rankOrder = "array_position(m.rank_order,p.id) ASC NULLS LAST,p.score DESC,p.created_at DESC,p.id"

func (a *API) ranked(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.list(w, r, `
		SELECT gf_post(p,d,m,$1) FROM posts p JOIN people m ON m.id=p.author_id JOIN places d ON d.id=p.place_id
		WHERE p.author_id=$1 AND p.status<>'hidden' AND d.status='published'
		ORDER BY `+rankOrder, viewer)
}

func (a *API) rank(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Winner string `json:"winner"`
		Loser  string `json:"loser"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !uuid.MatchString(body.Winner) || !uuid.MatchString(body.Loser) || body.Winner == body.Loser {
		return invalid("Choose two different past visits.")
	}
	ctx := r.Context()
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, "SELECT id::text FROM people WHERE id=$1 FOR NO KEY UPDATE", viewer).Scan(&locked); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT p.id::text FROM posts p JOIN people m ON m.id=p.author_id
			JOIN places d ON d.id=p.place_id WHERE p.author_id=$1 AND p.status<>'hidden' AND d.status='published'
			ORDER BY `+rankOrder, viewer)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		hasWinner, hasLoser := false, false
		for _, id := range ids {
			hasWinner = hasWinner || id == body.Winner
			hasLoser = hasLoser || id == body.Loser
		}
		if !hasWinner || !hasLoser {
			return notFound
		}
		order := make([]string, 0, len(ids))
		for _, id := range ids {
			if id == body.Winner {
				continue
			}
			if id == body.Loser {
				order = append(order, body.Winner)
			}
			order = append(order, id)
		}
		_, err = tx.Exec(ctx, "UPDATE people SET rank_order=$2::text[]::uuid[] WHERE id=$1", viewer, order)
		return err
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func activeValue(w http.ResponseWriter, r *http.Request) (bool, error) {
	var body struct {
		Active *bool `json:"active"`
	}
	err := decode(w, r, &body)
	if err != nil {
		return false, err
	}
	if body.Active == nil {
		return false, invalid("Choose whether to add or remove the item.")
	}
	return *body.Active, nil
}

func existsResult(err error, exists bool) error {
	if err != nil {
		return err
	}
	if !exists {
		return notFound
	}
	return nil
}
