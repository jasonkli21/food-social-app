package goodfork

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type directoryFilter struct {
	Q       string   `json:"q,omitempty"`
	Area    string   `json:"area,omitempty"`
	Cuisine string   `json:"cuisine,omitempty"`
	Diet    string   `json:"diet,omitempty"`
	Price   int      `json:"price,omitempty"`
	Sort    string   `json:"sort,omitempty"`
	Lat     *float64 `json:"lat,omitempty"`
	Lng     *float64 `json:"lng,omitempty"`
	OpenNow bool     `json:"openNow,omitempty"`
	AsOf    string   `json:"asOf,omitempty"`
}

func (f *directoryFilter) validate() error {
	if f.OpenNow {
		if f.AsOf == "" {
			f.AsOf = time.Now().UTC().Format(time.RFC3339Nano)
		}
		at, err := time.Parse(time.RFC3339Nano, f.AsOf)
		if err != nil || time.Since(at) > 15*time.Minute || time.Until(at) > 5*time.Second {
			return invalid("Reload results to refresh opening hours.")
		}
	}
	for _, field := range []struct {
		value *string
		name  string
		limit int
	}{
		{&f.Q, "Search", 120}, {&f.Area, "Area", 72}, {&f.Cuisine, "Cuisine", 48}, {&f.Diet, "Dietary option", 36},
	} {
		value, err := tidy(*field.value, 0, field.limit, field.name)
		if err != nil {
			return err
		}
		*field.value = value
	}
	if f.Price < 0 || f.Price > 4 {
		return invalid("Choose a price level from 1 to 4.")
	}
	switch f.Sort {
	case "", "relevance":
	case "nearby":
		if f.Lat == nil || f.Lng == nil || !coordinates(*f.Lat, *f.Lng) {
			return invalid("Choose a valid location for distance sorting.")
		}
	default:
		return invalid("Choose relevance or distance.")
	}
	return nil
}

func searchWords(text string) []string {
	tokens := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
	words := make([]string, 0, min(len(tokens), 8))
	seen := make(map[string]bool)
	for _, token := range tokens {
		if seen[token] || len([]rune(token)) > 36 {
			continue
		}
		seen[token] = true
		words = append(words, token)
		if len(words) == 8 {
			break
		}
	}
	return words
}

func (a *API) places(w http.ResponseWriter, r *http.Request, viewer string) error {
	q := r.URL.Query()
	f := directoryFilter{Q: q.Get("q"), Area: q.Get("area"), Cuisine: q.Get("cuisine"), Diet: q.Get("diet"), Sort: q.Get("sort"),
		OpenNow: q.Get("openNow") == "true" || q.Get("openNow") == "1", AsOf: q.Get("asOf")}
	if raw := q.Get("price"); raw != "" {
		price, err := strconv.Atoi(raw)
		if err != nil || price < 1 || price > 4 {
			return invalid("Choose a price level from 1 to 4.")
		}
		f.Price = price
	}
	if f.Sort == "nearby" {
		lat, latErr := strconv.ParseFloat(q.Get("lat"), 64)
		lng, lngErr := strconv.ParseFloat(q.Get("lng"), 64)
		if latErr != nil || lngErr != nil {
			return invalid("Choose a valid location for distance sorting.")
		}
		f.Lat, f.Lng = &lat, &lng
	}
	if err := f.validate(); err != nil {
		return err
	}
	start, err := offset(r)
	if err != nil {
		return err
	}
	items, err := a.findPlaces(r.Context(), viewer, f, pageSize+1, start)
	if err != nil {
		return err
	}
	result := page{Items: items, AsOf: f.AsOf}
	if len(items) > pageSize {
		next := start + pageSize
		result.Items, result.NextOffset = items[:pageSize], &next
	}
	return send(w, http.StatusOK, result)
}

func (a *API) findPlaces(ctx context.Context, viewer string, f directoryFilter, limit, start int) ([]json.RawMessage, error) {
	words := searchWords(f.Q)
	for i := range words {
		words[i] += ":*"
	}
	// Select one visible, fully eligible source per restaurant before paging.
	// Read rating details once the directory page has been selected.
	return many(ctx, a.db, `
		WITH terms AS (
			SELECT CASE WHEN $2::text='' THEN NULL::tsquery ELSE to_tsquery('simple',$2) END AS all_words,
			       CASE WHEN $3::text='' THEN NULL::tsquery ELSE to_tsquery('simple',$3) END AS any_word
		), dish_candidates AS MATERIALIZED (
			SELECT DISTINCT ON(p.place_id) p.id,p.place_id,p.dish,p.created_at
			FROM posts p JOIN places d ON d.id=p.place_id CROSS JOIN terms t
			WHERE p.status='published' AND d.status='published' AND gf_visible($1,p.author_id)
			  AND p.dish_terms @@ t.any_word AND (d.directory_terms || p.dish_terms) @@ t.all_words
			  AND ($5='' OR strpos(lower(d.area||' '||d.city),lower($5))>0)
			  AND ($6='' OR lower(d.cuisine)=lower($6))
			  AND ($7::int=0 OR d.price=$7)
			  AND ($8='' OR EXISTS(SELECT 1 FROM unnest(d.dietary) label WHERE lower(label)=lower($8)))
			  AND (NOT $9::bool OR (d.lat BETWEEN $10::float8-0.46 AND $10::float8+0.46 AND
			    6371*acos(least(1.0,greatest(-1.0,sin(radians($10::float8))*sin(radians(d.lat))+
			    cos(radians($10::float8))*cos(radians(d.lat))*cos(radians(d.lng-$11::float8)))))<=50))
			  AND (NOT $14::bool OR gf_is_open(d.schedule,$15::timestamptz)=true)
			ORDER BY p.place_id,p.created_at DESC,p.id DESC
		), dish_matches AS (
			SELECT DISTINCT ON (place_id) id,place_id,dish FROM dish_candidates ORDER BY place_id,created_at DESC,id DESC
		), matching AS (
			SELECT d.id FROM places d CROSS JOIN terms t WHERE d.status='published' AND (t.all_words IS NULL OR d.directory_terms @@ t.all_words)
				AND (NOT $9::bool OR d.lat BETWEEN $10::float8-0.46 AND $10::float8+0.46)
			UNION SELECT place_id FROM dish_matches
		), selected AS MATERIALIZED (
			SELECT d.id, hit.id AS source_id,hit.dish,distance.km,
				CASE WHEN $4::text<>'' AND lower(d.name)=lower($4) THEN 0
				     WHEN $4<>'' AND starts_with(lower(d.name),lower($4)) THEN 1
				     WHEN t.all_words IS NULL OR d.directory_terms @@ t.all_words THEN 2 ELSE 3 END AS relevance,
				lower(d.name) AS sort_name
			FROM matching m JOIN places d USING(id) CROSS JOIN terms t
			LEFT JOIN dish_matches hit ON hit.place_id=d.id AND NOT (d.directory_terms @@ t.all_words)
			CROSS JOIN LATERAL (SELECT CASE WHEN $9::bool AND d.lat BETWEEN $10::float8-0.46 AND $10::float8+0.46 THEN
				6371 * acos(least(1.0, greatest(-1.0,
					sin(radians($10::float8))*sin(radians(d.lat))
					+ cos(radians($10::float8))*cos(radians(d.lat))*cos(radians(d.lng-$11::float8)))))
				ELSE NULL END AS km) distance
			WHERE ($5='' OR strpos(lower(d.area||' '||d.city),lower($5))>0)
			  AND ($6='' OR lower(d.cuisine)=lower($6))
			  AND ($7::int=0 OR d.price=$7)
			  AND ($8='' OR EXISTS(SELECT 1 FROM unnest(d.dietary) label WHERE lower(label)=lower($8)))
			  AND (NOT $9::bool OR distance.km<=50)
			  AND (NOT $14::bool OR gf_is_open(d.schedule,$15::timestamptz)=true)
			ORDER BY distance.km ASC NULLS LAST,relevance,sort_name,d.id LIMIT $12 OFFSET $13
		)
		SELECT gf_place(d,$1) || jsonb_build_object('distanceKm',s.km,'dishMatch',
			CASE WHEN s.source_id IS NULL THEN NULL ELSE jsonb_build_object('reviewId',s.source_id,'dish',s.dish) END)
		FROM selected s JOIN places d ON d.id=s.id
		ORDER BY s.km ASC NULLS LAST,s.relevance,s.sort_name,d.id`,
		nullable(viewer), strings.Join(words, " & "), strings.Join(words, " | "), f.Q, f.Area, f.Cuisine, f.Price, f.Diet,
		f.Sort == "nearby", f.Lat, f.Lng, limit, start, f.OpenNow, nullable(f.AsOf))
}
