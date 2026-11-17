package goodfork

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func phaseDatabase(t *testing.T) (context.Context, *pgxpool.Pool, string) {
	t.Helper()
	dsn := os.Getenv("GOODFORK_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("GOODFORK_TEST_REQUIRED") == "1" {
			t.Fatal("set GOODFORK_TEST_DATABASE_URL to the disposable test database")
		}
		t.Skip("set GOODFORK_TEST_DATABASE_URL to run Postgres checks")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	root, err := Open(ctx, dsn, true)
	noError(t, err)
	t.Cleanup(root.Close)
	schema := "phase_" + strings.ToLower(strings.NewReplacer("-", "a", "_", "b").Replace(secret(9)))
	quoted := pgx.Identifier{schema}.Sanitize()
	_, err = root.Exec(ctx, "CREATE SCHEMA "+quoted)
	noError(t, err)
	t.Cleanup(func() { _, err := root.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE"); noError(t, err) })
	cfg := root.Config()
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	noError(t, err)
	t.Cleanup(db.Close)
	return ctx, db, quoted
}

func TestUpgradePreservesVerifiedListingAndReviewIntegrity(t *testing.T) {
	ctx, db, schema := phaseDatabase(t)
	entries, err := migrations.ReadDir("sql")
	noError(t, err)
	_, err = db.Exec(ctx, "CREATE TABLE schema_migrations(name text PRIMARY KEY)")
	noError(t, err)
	for _, entry := range entries {
		if entry.Name() > "004.sql" {
			continue
		}
		body, err := migrations.ReadFile("sql/" + entry.Name())
		noError(t, err)
		_, err = db.Exec(ctx, string(body), pgx.QueryExecModeSimpleProtocol)
		noError(t, err)
		_, err = db.Exec(ctx, "INSERT INTO schema_migrations(name) VALUES ($1)", entry.Name())
		noError(t, err)
	}
	var person, place, review string
	noError(t, db.QueryRow(ctx, `
		INSERT INTO people(handle,name,password_hash,password_salt,recovery_hash)
		VALUES ('fixture_owner','Fixture Owner',''::bytea,''::bytea,''::bytea) RETURNING id::text`).Scan(&person))
	noError(t, db.QueryRow(ctx, `
		INSERT INTO places(name,cuisine,city,address,lat,lng,status)
		VALUES ('Hidden Test Cafe','Café','Fixture City','1 Test Ave',37.77,-122.42,'hidden') RETURNING id::text`).Scan(&place))
	noError(t, db.QueryRow(ctx, `
		INSERT INTO posts(request_id,author_id,place_id,score,text,status)
		VALUES (gen_random_uuid(),$1,$2,8,'Earlier author score.','published') RETURNING id::text`, person, place).Scan(&review))
	_, err = db.Exec(ctx, "INSERT INTO restaurant_owners(place_id,person_id) VALUES ($1,$2)", place, person)
	noError(t, err)
	if RequireSchema(ctx, db) == nil {
		t.Fatal("004 was reported current")
	}
	noError(t, Migrate(ctx, db))
	noError(t, RequireSchema(ctx, db))
	if _, err := ImportPlaces(ctx, db, strings.NewReader(`[{"name":"Hidden Test Cafe","cuisine":"Other","city":"Fixture City","address":"1 Test Ave","lat":37.77,"lng":-122.42}]`)); err != nil {
		t.Fatal(err)
	}
	var status, cuisine string
	var protected bool
	noError(t, db.QueryRow(ctx, "SELECT status,cuisine FROM places WHERE id=$1", place).Scan(&status, &cuisine))
	if status != "hidden" || cuisine != "Café" {
		t.Fatal("import modified the moderated listing")
	}
	noError(t, db.QueryRow(ctx, "SELECT status,ownership_conflict FROM posts WHERE id=$1", review).Scan(&status, &protected))
	if status != "hidden" || !protected {
		t.Fatal("the migration did not exclude the owner's former rating")
	}

	guids := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(secret(8), "-", "a"), "_", "b"))
	runtime, cleanup, operator := pgx.Identifier{"runtime_" + guids}.Sanitize(), pgx.Identifier{"cleanup_" + guids}.Sanitize(), pgx.Identifier{"operator_" + guids}.Sanitize()
	for _, role := range []string{runtime, cleanup, operator} {
		_, err = db.Exec(ctx, "CREATE ROLE "+role+" NOLOGIN")
		noError(t, err)
		t.Cleanup(func() {
			_, err := db.Exec(context.Background(), "DROP OWNED BY "+role+"; DROP ROLE "+role, pgx.QueryExecModeSimpleProtocol)
			noError(t, err)
		})
	}
	grants, err := os.ReadFile("../../grants.sql")
	noError(t, err)
	statement := strings.NewReplacer("SCHEMA public", "SCHEMA "+schema, "goodfork_runtime", runtime, "goodfork_cleanup", cleanup, "goodfork_operator", operator).Replace(string(grants))
	_, err = db.Exec(ctx, statement, pgx.QueryExecModeSimpleProtocol)
	noError(t, err)
	conn, err := db.Acquire(ctx)
	noError(t, err)
	defer conn.Release()
	defer func() { _, _ = conn.Exec(context.Background(), "RESET ROLE") }()
	checks := []struct{ role, allowed, denied string }{
		{runtime, "SELECT id FROM posts", "SELECT * FROM audit_events"},
		{cleanup, "SELECT id FROM objects FOR UPDATE", "SELECT password_hash FROM people"},
		{operator, "SELECT handle FROM people", "SELECT password_hash FROM people"},
	}
	for _, check := range checks {
		_, err := conn.Exec(ctx, "SET ROLE "+check.role)
		noError(t, err)
		_, err = conn.Exec(ctx, check.allowed)
		noError(t, err)
		if _, err = conn.Exec(ctx, check.denied); err == nil {
			t.Fatalf("unexpected permission for %s", check.role)
		}
	}
}

func TestChronologicalCursorAcrossInsert(t *testing.T) {
	ctx, db, _ := phaseDatabase(t)
	noError(t, Migrate(ctx, db))
	var place string
	noError(t, db.QueryRow(ctx, `
		INSERT INTO places(name,cuisine,city,address,lat,lng,status)
		VALUES ('Fixture Bakery','Bakery','Fixture City','1 Test Ave',37.77,-122.42,'published') RETURNING id::text`).Scan(&place))
	insert := func(prefix string, count int) {
		_, err := db.Exec(ctx, `
			WITH authors AS (
				INSERT INTO people(handle,name,password_hash,password_salt,recovery_hash)
				SELECT $1 || i, 'Fixture Diner',''::bytea,''::bytea,''::bytea FROM generate_series(1,$2::int) i
				RETURNING id
			)
			INSERT INTO posts(request_id,author_id,place_id,score,text,status)
			SELECT gen_random_uuid(),id,$3,7,'Fixture visit.','published' FROM authors`, prefix, count, place)
		noError(t, err)
	}
	insert("fixture_", 23)
	app := NewAPI(db, LocalMedia(t.TempDir()), Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	fetch := func(path string, status int) page {
		w := httptest.NewRecorder()
		app.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != status {
			t.Fatalf("page returned %d: %s", w.Code, w.Body.String())
		}
		var result page
		noError(t, json.Unmarshal(w.Body.Bytes(), &result))
		return result
	}
	path := "/v1/places/" + place + "/reviews?paging=cursor"
	first := fetch(path, 200)
	if len(first.Items) != 20 || first.NextCursor == "" {
		t.Fatal("first page did not yield its cursor")
	}
	insert("newer_", 1)
	second := fetch(path+"&cursor="+first.NextCursor, 200)
	if len(second.Items) != 3 {
		t.Fatalf("second page has %d original results", len(second.Items))
	}
	ids := map[string]bool{}
	for _, item := range append(first.Items, second.Items...) {
		var doc struct {
			ID string `json:"id"`
		}
		noError(t, json.Unmarshal(item, &doc))
		if ids[doc.ID] {
			t.Fatal("duplicate review across the cursor")
		}
		ids[doc.ID] = true
	}
	fetch("/v1/feed?kind=clips&cursor="+first.NextCursor, 400)
}

func TestMediaSanitization(t *testing.T) {
	var original bytes.Buffer
	noError(t, jpeg.Encode(&original, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil))
	marker := []byte("fixture-photo-metadata")
	packet := []byte{0xff, 0xd8, 0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(packet[4:6], uint16(len(marker)+2))
	packet = append(append(packet, marker...), original.Bytes()[2:]...)
	mime, clean, err := prepareMedia(packet)
	noError(t, err)
	if mime != "image/jpeg" || bytes.Contains(clean, marker) {
		t.Fatal("photo metadata was carried into the public asset")
	}
	video, err := os.ReadFile("testdata/short-avc-aac.mp4")
	noError(t, err)
	mime, clean, err = prepareMedia(video)
	noError(t, err)
	if mime != "video/mp4" || bytes.Contains(clean, []byte("synthetic test clip")) {
		t.Fatal("clip metadata was carried into the public asset")
	}
	audio, err := os.ReadFile("testdata/audio-only.mp4")
	noError(t, err)
	if _, _, err = prepareMedia(audio); err == nil {
		t.Fatal("audio-only attachment accepted")
	}
}

func TestProviderProtocol(t *testing.T) {
	cases := []struct {
		name, response string
		delay          time.Duration
		valid          bool
	}{
		{"structured", `{"cuisine":"Japanese","diet":"Vegetarian"}`, 0, true},
		{"unsupported", `{"cuisine":"Italian","diet":"Vegetarian"}`, 0, false},
		{"malformed", `{"cuisine":"Japanese","diet":"Vegetarian","extra":"unexpected"}`, 0, false},
		{"oversized", strings.Repeat("x", 9000), 0, false},
		{"timeout", `{"cuisine":"Japanese","diet":"Vegetarian"}`, 120 * time.Millisecond, false},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			wire := make(chan map[string]json.RawMessage, 1)
			stub := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]json.RawMessage
				_ = json.NewDecoder(r.Body).Decode(&payload)
				wire <- payload
				if scenario.delay > 0 {
					time.Sleep(scenario.delay)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, scenario.response)
			}))
			defer stub.Close()
			adapter, err := NewHTTPAssist(stub.URL, "local-fixture", "")
			noError(t, err)
			adapter.client.Transport = stub.Client().Transport
			if scenario.delay > 0 {
				adapter.client.Timeout = 60 * time.Millisecond
			}
			started := time.Now()
			result, err := adapter.InterpretDiningIntent(context.Background(), diningSignals{Cuisines: []string{"Japanese"}, Diets: []string{"Vegetarian"}})
			if scenario.valid {
				noError(t, err)
				if result.Cuisine != "Japanese" {
					t.Fatal("provider choice was lost")
				}
			} else if err == nil {
				t.Fatal("rejected provider result succeeded")
			}
			var body map[string]json.RawMessage
			select {
			case body = <-wire:
			case <-time.After(time.Second):
				t.Fatal("provider fixture did not receive a request")
			}
			if len(body) != 3 || string(body["operation"]) != "\"dining\"" || string(body["input"]) != `{"cuisines":["Japanese"],"diets":["Vegetarian"]}` {
				t.Fatal("unexpected outbound provider fields")
			}
			t.Logf("valid=%t elapsed=%s", scenario.valid, time.Since(started).Round(time.Millisecond))
		})
	}
}
