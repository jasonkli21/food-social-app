package goodfork

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type phase3Fixture struct {
	t       *testing.T
	ctx     context.Context
	db      *pgxpool.Pool
	handler http.Handler
}

func phase3Setup(t *testing.T, timeout time.Duration) *phase3Fixture {
	t.Helper()
	ctx, db, _ := phaseDatabase(t)
	noError(t, Migrate(ctx, db))
	return &phase3Fixture{t, ctx, db, NewAPI(db, LocalMedia(t.TempDir()), Config{RequestTimeout: timeout},
		slog.New(slog.NewTextHandler(io.Discard, nil)))}
}
func (f *phase3Fixture) user(handle string) (string, string) {
	f.t.Helper()
	var id string
	noError(f.t, f.db.QueryRow(f.ctx, `INSERT INTO people(handle,name,password_hash,password_salt,recovery_hash)
        VALUES($1,$1,'','', '') RETURNING id::text`, handle).Scan(&id))
	token := secret(32)
	_, err := f.db.Exec(f.ctx, "INSERT INTO sessions(token_hash,person_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", digest(token), id)
	noError(f.t, err)
	return id, token
}
func (f *phase3Fixture) restaurant(name string) string {
	f.t.Helper()
	var id string
	noError(f.t, f.db.QueryRow(f.ctx, `INSERT INTO places(name,cuisine,city,address,lat,lng,status)
        VALUES($1,'Japanese','Fixture City',$1,40.72,-73.98,'published') RETURNING id::text`, name).Scan(&id))
	return id
}
func (f *phase3Fixture) request(method, path, token string, body any, status int) map[string]any {
	f.t.Helper()
	data, err := json.Marshal(body)
	noError(f.t, err)
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != status {
		f.t.Fatalf("%s %s got %d, want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	var result map[string]any
	if w.Code != 204 {
		noError(f.t, json.Unmarshal(w.Body.Bytes(), &result))
	}
	return result
}

func TestPrivateJournalIsolation(t *testing.T) {
	f := phase3Setup(t, 0)
	person, token := f.user("journal_a")
	_, other := f.user("journal_b")
	place := f.restaurant("Journal counter")
	input := map[string]any{"restaurantId": place, "requestId": "9b75cc00-1111-4111-8111-000000000001", "visitDate": "2026-11-16", "note": "Private fixture memory", "dish": "Noodles", "score": nil}
	first := f.request("POST", "/v1/me/visits", token, input, 200)
	replay := f.request("POST", "/v1/me/visits", token, input, 200)
	if first["id"] != replay["id"] {
		t.Fatal("create replay duplicated a visit")
	}
	input["requestId"] = "9b75cc00-1111-4111-8111-000000000002"
	second := f.request("POST", "/v1/me/visits", token, input, 200)
	path := "/v1/me/visits/" + first["id"].(string)
	f.request("GET", path, other, nil, 404)
	f.request("DELETE", path, other, map[string]any{"revision": first["revision"]}, 404)
	f.request("GET", path, "", nil, 401)
	if len(f.request("GET", "/v1/me/visits", token, nil, 200)["items"].([]any)) != 2 {
		t.Fatal("repeated visits were not separate")
	}
	public := f.request("GET", "/v1/places/"+place, "", nil, 200)
	if public["ratingCount"] != float64(0) || strings.Contains(fmt.Sprint(public), "Private fixture") {
		t.Fatal("journal changed public content")
	}
	edit := map[string]any{"revision": first["revision"], "visitDate": "2026-11-15", "note": "Updated private memory", "dish": "Soup", "score": 8.2}
	updated := f.request("PATCH", path, token, edit, 200)
	f.request("PATCH", path, token, edit, 409)
	f.request("DELETE", path, token, map[string]any{"revision": first["revision"]}, 409)
	_, err := f.db.Exec(f.ctx, "UPDATE places SET status='hidden' WHERE id=$1", place)
	noError(t, err)
	hidden := f.request("GET", path, token, nil, 200)
	if hidden["restaurantId"] != nil || hidden["unavailable"] != true || hidden["restaurantName"] != "Journal counter" {
		t.Fatal("hidden listing projection leaked or erased memory")
	}
	_, err = f.db.Exec(f.ctx, "DELETE FROM places WHERE id=$1", place)
	noError(t, err)
	f.request("GET", path, token, nil, 200)
	f.request("DELETE", path, token, map[string]any{"revision": updated["revision"]}, 204)
	f.request("GET", "/v1/me/visits/"+second["id"].(string), token, nil, 200)
	_, err = f.db.Exec(f.ctx, "DELETE FROM people WHERE id=$1", person)
	noError(t, err)
	var count int
	noError(t, f.db.QueryRow(f.ctx, "SELECT count(*) FROM private_visits").Scan(&count))
	if count != 0 {
		t.Fatal("account deletion retained journal")
	}
}

func TestPopulated005Upgrade(t *testing.T) {
	ctx, db, _ := phaseDatabase(t)
	_, err := db.Exec(ctx, "CREATE TABLE schema_migrations(name text PRIMARY KEY)")
	noError(t, err)
	entries, err := migrations.ReadDir("sql")
	noError(t, err)
	for _, entry := range entries {
		if entry.Name() > "005.sql" {
			continue
		}
		body, err := migrations.ReadFile("sql/" + entry.Name())
		noError(t, err)
		_, err = db.Exec(ctx, string(body), pgx.QueryExecModeSimpleProtocol)
		noError(t, err)
		_, err = db.Exec(ctx, "INSERT INTO schema_migrations(name) VALUES($1)", entry.Name())
		noError(t, err)
	}
	var person, place, post, version string
	noError(t, db.QueryRow(ctx, `INSERT INTO people(handle,name,password_hash,password_salt,recovery_hash)
        VALUES('upgrade_diner','Upgrade diner','','','') RETURNING id::text`).Scan(&person))
	noError(t, db.QueryRow(ctx, `INSERT INTO places(name,cuisine,city,address,lat,lng,status,hours,listing_revision)
        VALUES('Upgrade counter','Japanese','Fixture City','Fixture Street',40,-74,'published',ARRAY['Tue 11–20'],7) RETURNING id::text`).Scan(&place))
	noError(t, db.QueryRow(ctx, `INSERT INTO posts(request_id,author_id,place_id,score,text,status)
        VALUES(gen_random_uuid(),$1,$2,8.6,'Existing phase five review.','published') RETURNING id::text,revision::text`, person, place).Scan(&post, &version))
	_, err = db.Exec(ctx, "UPDATE people SET rank_order=ARRAY[$2::uuid] WHERE id=$1", person, post)
	noError(t, err)
	_, err = db.Exec(ctx, `INSERT INTO reports(reporter_id,target_type,target_id,reason)
        VALUES($1,'post',$2,'Existing legacy report')`, person, post)
	noError(t, err)
	noError(t, Migrate(ctx, db))
	noError(t, RequireSchema(ctx, db))
	var current string
	var listing int
	var score float64
	noError(t, db.QueryRow(ctx, "SELECT revision::text,score::float8 FROM posts WHERE id=$1", post).Scan(&current, &score))
	noError(t, db.QueryRow(ctx, "SELECT listing_revision FROM places WHERE id=$1", place).Scan(&listing))
	if current != version || score != 8.6 || listing != 7 {
		t.Fatal("upgrade changed existing review or listing versions")
	}
	var ranked bool
	noError(t, db.QueryRow(ctx, "SELECT rank_order=ARRAY[$2::uuid] FROM people WHERE id=$1", person, post).Scan(&ranked))
	if !ranked {
		t.Fatal("upgrade changed private ranking")
	}
	var visits int
	noError(t, db.QueryRow(ctx, "SELECT count(*) FROM private_visits").Scan(&visits))
	if visits != 0 {
		t.Fatal("upgrade invented visit dates")
	}
	var legacy bool
	noError(t, db.QueryRow(ctx, "SELECT content_evidence IS NULL AND target_version='' FROM reports").Scan(&legacy))
	if !legacy {
		t.Fatal("upgrade invented report evidence")
	}
}

func TestConcurrentOwnerTransitions(t *testing.T) {
	for _, mode := range []string{"publish", "reply", "listing"} {
		t.Run(mode, func(t *testing.T) {
			f := phase3Setup(t, 0)
			owner, token := f.user("concurrent_owner")
			diner, _ := f.user("concurrent_diner")
			place := f.restaurant("Concurrent transition counter")
			var postID, revision, claim string
			author, status := diner, "published"
			if mode == "publish" {
				author, status = owner, "pending"
			}
			noError(t, f.db.QueryRow(f.ctx, `INSERT INTO posts(request_id,author_id,place_id,score,text,status)
                VALUES(gen_random_uuid(),$1,$2,8,'Concurrent fixture',$3) RETURNING id::text,revision::text`, author, place, status).Scan(&postID, &revision))
			if mode == "publish" {
				noError(t, f.db.QueryRow(f.ctx, `INSERT INTO restaurant_claims(place_id,person_id,email,role,status)
                    VALUES($1,$2,'fixture@example.test','Owner','pending') RETURNING id::text`, place, owner).Scan(&claim))
			} else {
				_, err := f.db.Exec(f.ctx, "INSERT INTO restaurant_owners(place_id,person_id) VALUES($1,$2)", place, owner)
				noError(t, err)
			}
			hold, err := f.db.Begin(f.ctx)
			noError(t, err)
			defer hold.Rollback(f.ctx)
			noError(t, lockPlace(f.ctx, hold, place))
			operations := make(chan error, 1)
			writes := make(chan int, 1)
			go func() {
				action, target, version := "revoke-owner", place, ""
				if mode == "publish" {
					action, target, version = "approve-claim", claim, "1"
				}
				operations <- Moderate(WithOperatorPrincipal(f.ctx, "fixture:concurrent"), f.db, action, target, version)
			}()
			go func() {
				if mode == "publish" {
					err := Moderate(f.ctx, f.db, "publish-post", postID, revision)
					if err == nil {
						writes <- 204
					} else {
						var api apiError
						if errors.As(err, &api) {
							writes <- api.status
						} else {
							writes <- 500
						}
					}
					return
				}
				method, path, body := "PUT", "/v1/posts/"+postID+"/reply", map[string]any{"text": "Thank you for visiting.", "revision": ""}
				if mode == "listing" {
					method, path, body = "PATCH", "/v1/places/"+place+"/listing", map[string]any{"revision": 1, "description": "Concurrent listing edit", "price": nil, "dietary": []string{}, "hours": []string{}, "phone": "", "website": "", "menuURL": ""}
				}
				data, _ := json.Marshal(body)
				req := httptest.NewRequest(method, path, bytes.NewReader(data))
				req.Header.Set("Authorization", "Bearer "+token)
				response := httptest.NewRecorder()
				f.handler.ServeHTTP(response, req)
				writes <- response.Code
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				var waiting int
				noError(t, f.db.QueryRow(f.ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
                    AND wait_event_type='Lock' AND query LIKE '%FOR NO KEY UPDATE%'`).Scan(&waiting))
				if waiting >= 2 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("concurrent operations did not reach the place-lock barrier")
				}
				time.Sleep(5 * time.Millisecond)
			}
			noError(t, hold.Commit(f.ctx))
			noError(t, <-operations)
			code := <-writes
			if code != 200 && code != 204 && code != 404 && code != 409 {
				t.Fatalf("concurrent write returned %d", code)
			}
			var managed, held bool
			noError(t, f.db.QueryRow(f.ctx, "SELECT EXISTS(SELECT 1 FROM restaurant_owners WHERE place_id=$1)", place).Scan(&managed))
			if mode == "publish" {
				noError(t, f.db.QueryRow(f.ctx, "SELECT ownership_conflict AND status='hidden' FROM posts WHERE id=$1", postID).Scan(&held))
				if !managed || !held {
					t.Fatal("concurrent approval/publication exposed a self-review")
				}
			} else if managed {
				t.Fatal("concurrent owner revocation did not persist")
			}
			if mode == "reply" {
				var replies int
				noError(t, f.db.QueryRow(f.ctx, "SELECT count(*) FROM restaurant_replies WHERE post_id=$1", postID).Scan(&replies))
				if replies != 0 {
					t.Fatal("revoked owner response survived")
				}
			}
		})
	}
}

func TestReportEvidenceAndReviewRevision(t *testing.T) {
	f := phase3Setup(t, 0)
	author, token := f.user("review_author")
	_, reporter := f.user("review_reporter")
	place := f.restaurant("Revision counter")
	post := f.request("POST", "/v1/posts", token, map[string]any{"restaurantId": place, "requestId": "9b75cc00-1111-4111-8111-000000000003", "score": 8.2, "text": "The original meal was lovely.", "dish": "Soup"}, 201)
	id := post["id"].(string)
	report := map[string]any{"targetType": "post", "targetId": id, "reason": "Fixture report", "revision": post["revision"]}
	f.request("POST", "/v1/reports", reporter, report, 204)
	f.request("POST", "/v1/reports", reporter, report, 409)
	var reportID string
	noError(t, f.db.QueryRow(f.ctx, "SELECT id::text FROM reports WHERE target_id=$1", id).Scan(&reportID))
	edit := map[string]any{"revision": post["revision"], "score": 9.1, "text": "A newer public description.", "dish": "Ramen"}
	updated := f.request("PATCH", "/v1/posts/"+id, token, edit, 200)
	replay := f.request("PATCH", "/v1/posts/"+id, token, edit, 200)
	if updated["revision"] != replay["revision"] {
		t.Fatal("ambiguous edit replay changed its result")
	}
	edit["text"] = "An unrelated stale draft."
	f.request("PATCH", "/v1/posts/"+id, token, edit, 409)
	f.request("DELETE", "/v1/posts/"+id, token, map[string]any{"revision": post["revision"]}, 409)
	if Moderate(f.ctx, f.db, "hide-reported-post", reportID) == nil {
		t.Fatal("stale reported revision hid newer review")
	}
	noError(t, Moderate(WithOperatorPrincipal(f.ctx, "fixture:operator-a"), f.db, "dismiss-report", reportID))
	report["revision"] = updated["revision"]
	f.request("POST", "/v1/reports", reporter, report, 204)
	var evidence string
	noError(t, f.db.QueryRow(f.ctx, "SELECT content_evidence->>'text' FROM reports WHERE id=$1", reportID).Scan(&evidence))
	if evidence != "The original meal was lovely." {
		t.Fatal("report evidence changed after edit")
	}
	var latestReport string
	noError(t, f.db.QueryRow(f.ctx, "SELECT id::text FROM reports WHERE target_id=$1 AND resolved_at IS NULL", id).Scan(&latestReport))
	noError(t, Moderate(WithOperatorPrincipal(f.ctx, "fixture:operator-b"), f.db, "hide-reported-post", latestReport))
	var principal string
	noError(t, f.db.QueryRow(f.ctx, "SELECT actor_principal FROM audit_events WHERE action='hide-reported-post'").Scan(&principal))
	if principal != "fixture:operator-b" {
		t.Fatal("operator attribution missing")
	}
	_, err := f.db.Exec(f.ctx, "DELETE FROM people WHERE id=$1", author)
	noError(t, err)
	var retained int
	noError(t, f.db.QueryRow(f.ctx, "SELECT count(*) FROM reports WHERE evidence_author=$1", author).Scan(&retained))
	if retained != 0 {
		t.Fatal("deleted author evidence retained")
	}
}

func TestReportSnapshotsAcrossTargets(t *testing.T) {
	f := phase3Setup(t, 0)
	author, token := f.user("snapshot_author")
	_, reporter := f.user("snapshot_reporter")
	place := f.restaurant("Snapshot counter")
	_, err := f.db.Exec(f.ctx, "UPDATE places SET submitted_by=$2 WHERE id=$1", place, author)
	noError(t, err)
	post := f.request("POST", "/v1/posts", token, map[string]any{"restaurantId": place, "requestId": "9b75cc00-1111-4111-8111-000000000019", "score": 8.1, "dish": "Soup", "text": "A public fixture review."}, 201)
	comment := f.request("POST", "/v1/posts/"+post["id"].(string)+"/comments", token, map[string]any{"text": "Original fixture comment.", "requestId": "9b75cc00-1111-4111-8111-000000000020"}, 200)
	for kind, id := range map[string]string{"person": author, "place": place, "comment": comment["id"].(string)} {
		f.request("POST", "/v1/reports", reporter, map[string]any{"targetType": kind, "targetId": id, "reason": "Snapshot fixture report."}, 204)
	}
	_, err = f.db.Exec(f.ctx, "UPDATE people SET bio='Updated profile' WHERE id=$1", author)
	noError(t, err)
	_, err = f.db.Exec(f.ctx, "UPDATE places SET description='Updated listing',listing_revision=2 WHERE id=$1", place)
	noError(t, err)
	f.request("DELETE", "/v1/comments/"+comment["id"].(string), token, nil, 204)
	queue, err := Queue(f.ctx, f.db)
	noError(t, err)
	snapshot, _ := json.Marshal(queue)
	if !bytes.Contains(snapshot, []byte("Original fixture comment.")) || bytes.Contains(snapshot, []byte("Updated profile")) || bytes.Contains(snapshot, []byte("Updated listing")) {
		t.Fatal("operator queue replaced reported evidence with current content")
	}
	for kind, id := range map[string]string{"person": author, "place": place} {
		f.request("POST", "/v1/reports", reporter, map[string]any{"targetType": kind, "targetId": id, "reason": "Changed fixture report."}, 204)
	}
	var count int
	noError(t, f.db.QueryRow(f.ctx, "SELECT count(*) FROM reports").Scan(&count))
	if count != 5 {
		t.Fatal("revised content did not create distinct reports")
	}
	_, err = f.db.Exec(f.ctx, "DELETE FROM people WHERE id=$1", author)
	noError(t, err)
	noError(t, f.db.QueryRow(f.ctx, "SELECT count(*) FROM reports").Scan(&count))
	if count != 0 {
		t.Fatal("author deletion retained attributed snapshot evidence")
	}
}

func TestOwnerReplyProviderPrivacy(t *testing.T) {
	f := phase3Setup(t, 0)
	owner, token := f.user("assist_owner")
	diner, _ := f.user("assist_diner")
	place := f.restaurant("Reply privacy counter")
	_, err := f.db.Exec(f.ctx, "INSERT INTO restaurant_owners(place_id,person_id) VALUES($1,$2)", place, owner)
	noError(t, err)
	var postID string
	noError(t, f.db.QueryRow(f.ctx, `INSERT INTO posts(request_id,author_id,place_id,score,text,status)
        VALUES(gen_random_uuid(),$1,$2,8.7,'The food was delicious. Private fixture wording.','published') RETURNING id::text`, diner, place).Scan(&postID))
	var calls atomic.Int64
	var response atomic.Value
	response.Store(`{"topic":"food","opening":"appreciate","close":"welcome"}`)
	stub := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var payload map[string]json.RawMessage
		noError(t, json.NewDecoder(r.Body).Decode(&payload))
		expected := `{"topics":["food"],"sentiment":"positive","tone":"warm"}`
		if len(payload) != 3 || string(payload["operation"]) != `"owner_reply"` || string(payload["input"]) != expected {
			t.Error("unexpected reply provider fields")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, response.Load().(string))
	}))
	defer stub.Close()
	provider, err := NewHTTPAssist(stub.URL, "fixture", "")
	noError(t, err)
	provider.client.Transport = stub.Client().Transport
	f.handler = NewAPI(f.db, LocalMedia(t.TempDir()), Config{ReplyProvider: provider}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	body := map[string]any{"tone": "warm", "allowRemote": false}
	f.request("POST", "/v1/posts/"+postID+"/reply/draft", token, body, 200)
	if calls.Load() != 0 {
		t.Fatal("provider called without consent")
	}
	body["allowRemote"] = true
	result := f.request("POST", "/v1/posts/"+postID+"/reply/draft", token, body, 200)
	if result["outcome"] != "provider" || strings.Contains(result["draft"].(string), "Private fixture") {
		t.Fatal("provider reply leaked review text or failed")
	}
	response.Store(`{"topic":"invented","opening":"appreciate","close":"welcome"}`)
	result = f.request("POST", "/v1/posts/"+postID+"/reply/draft", token, body, 200)
	if result["outcome"] != "fallback" {
		t.Fatal("unsupported provider result did not fall back")
	}
	count := calls.Load()
	f.request("POST", "/v1/posts/"+postID+"/reply/draft", token, body, 200)
	if calls.Load() != count {
		t.Fatal("provider cooldown did not suppress calls")
	}
	var published int
	noError(t, f.db.QueryRow(f.ctx, "SELECT count(*) FROM restaurant_replies WHERE post_id=$1", postID).Scan(&published))
	if published != 0 {
		t.Fatal("assistant automatically published a reply")
	}
}

type hoursFixture struct {
	Schedule Schedule `json:"schedule"`
	Cases    []struct {
		At   string `json:"at"`
		Open bool   `json:"open"`
	} `json:"cases"`
}

func readHoursFixture(t *testing.T) hoursFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/hours.json")
	noError(t, err)
	var fixture hoursFixture
	noError(t, json.Unmarshal(raw, &fixture))
	return fixture
}
func TestHoursAndNegation(t *testing.T) {
	fixture := readHoursFixture(t)
	noError(t, fixture.Schedule.validate())
	for _, scenario := range fixture.Cases {
		at, err := time.Parse(time.RFC3339, scenario.At)
		noError(t, err)
		if fixture.Schedule.isOpen(at) != scenario.Open {
			t.Errorf("hours mismatch at %s", scenario.At)
		}
	}
	fixture.Schedule.Week[5] = []Period{{1080, 2220}}
	if fixture.Schedule.validate() == nil {
		t.Fatal("cross-midnight overlap accepted")
	}
	if !hasNegativePreference("not Italian") || !hasNegativePreference("avoid vegan food") || hasNegativePreference("Japanese noodles") {
		t.Fatal("negative preference interpretation regressed")
	}
}
func TestHoursSQLAndOpenNow(t *testing.T) {
	f := phase3Setup(t, 0)
	fixture := readHoursFixture(t)
	raw, err := json.Marshal(fixture.Schedule)
	noError(t, err)
	for _, scenario := range fixture.Cases {
		var open bool
		noError(t, f.db.QueryRow(f.ctx, "SELECT gf_is_open($1::jsonb,$2::timestamptz)", string(raw), scenario.At).Scan(&open))
		if open != scenario.Open {
			t.Errorf("SQL hours mismatch at %s", scenario.At)
		}
	}
	place := f.restaurant("Hours counter")
	allDay := Schedule{Timezone: "Pacific/Auckland", Week: make([][]Period, 7), Exceptions: []HoursException{}}
	for day := range allDay.Week {
		allDay.Week[day] = []Period{{0, 1440}}
	}
	raw, err = json.Marshal(allDay)
	noError(t, err)
	_, err = f.db.Exec(f.ctx, "UPDATE places SET schedule=$2::jsonb WHERE id=$1", place, string(raw))
	noError(t, err)
	f.restaurant("Unknown hours")
	result := f.request("GET", "/v1/places?openNow=true", "", nil, 200)
	if len(result["items"].([]any)) != 1 || result["asOf"] == nil {
		t.Fatal("unknown hours treated as open or clock anchor missing")
	}
	f.request("GET", "/v1/places?openNow=true&asOf=2020-01-01T00:00:00Z", "", nil, 400)
}

func TestInteractiveLockDeadline(t *testing.T) {
	f := phase3Setup(t, 120*time.Millisecond)
	owner, token := f.user("deadline_owner")
	place := f.restaurant("Deadline counter")
	_, err := f.db.Exec(f.ctx, "INSERT INTO restaurant_owners(place_id,person_id) VALUES($1,$2)", place, owner)
	noError(t, err)
	held, err := f.db.Begin(f.ctx)
	noError(t, err)
	defer held.Rollback(f.ctx)
	noError(t, lockPlace(f.ctx, held, place))
	input := map[string]any{"revision": 1, "description": "A valid fixture description.", "price": 2, "dietary": []string{}, "hours": []string{}, "website": "", "menuURL": "", "phone": ""}
	started := time.Now()
	f.request("PATCH", "/v1/places/"+place+"/listing", token, input, 503)
	if time.Since(started) > time.Second {
		t.Fatal("interactive lock wait exceeded budget")
	}
	noError(t, held.Commit(f.ctx))
	body := map[string]any{"revision": 1, "description": "Changed description", "phone": "", "website": "", "menuURL": "", "dietary": []string{}, "hours": []string{}, "price": nil, "schedule": nil}
	f.request("PATCH", "/v1/places/"+place+"/listing", token, body, 200)
}

func TestPhotoOrientationAndMemory(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4000, 3000))
	draw.Draw(source, source.Bounds(), image.NewUniform(color.NRGBA{R: 140, G: 70, B: 30, A: 255}), image.Point{}, draw.Src)
	var encoded bytes.Buffer
	noError(t, jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 85}))
	// A benign TIFF orientation=6 marker means a clockwise quarter turn.
	marker := []byte{0xff, 0xe1, 0, 34, 'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	input := append(append(append([]byte{}, encoded.Bytes()[:2]...), marker...), encoded.Bytes()[2:]...)
	source = nil
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, clean, err := prepareMedia(input)
	noError(t, err)
	runtime.ReadMemStats(&after)
	config, err := jpeg.DecodeConfig(bytes.NewReader(clean))
	noError(t, err)
	if config.Width != 3000 || config.Height != 4000 || bytes.Contains(clean, []byte("Exif")) {
		t.Fatal("photo orientation or metadata normalization failed")
	}
	t.Logf("12MP oriented photo allocation delta %.1f MiB", float64(after.TotalAlloc-before.TotalAlloc)/(1<<20))
}

func TestSkewedDishEligibility(t *testing.T) {
	f := phase3Setup(t, 0)
	author, _ := f.user("local_author")
	local := f.restaurant("Local dish counter")
	remote := f.restaurant("Popular distant counter")
	_, err := f.db.Exec(f.ctx, "UPDATE places SET lng=0 WHERE id=$1", remote)
	noError(t, err)
	_, err = f.db.Exec(f.ctx, `INSERT INTO people(handle,name,password_hash,password_salt,recovery_hash)
        SELECT 'fan_'||s,'Fixture fan','','','' FROM generate_series(1,301)s`)
	noError(t, err)
	_, err = f.db.Exec(f.ctx, `INSERT INTO posts(request_id,author_id,place_id,score,text,dish,status)
        SELECT gen_random_uuid(),id,$1,8,'Synthetic search fixture','Smoky aubergine','published' FROM people WHERE handle LIKE 'fan_%'`, remote)
	noError(t, err)
	_, err = f.db.Exec(f.ctx, `INSERT INTO posts(request_id,author_id,place_id,score,text,dish,status,created_at)
        VALUES(gen_random_uuid(),$1,$2,8,'Older local fixture','Smoky aubergine','published',now()-interval '10 days')`, author, local)
	noError(t, err)
	nearby := f.request("GET", "/v1/places?q=aubergine&sort=nearby&lat=40.72&lng=-73.98", "", nil, 200)["items"].([]any)
	if len(nearby) != 1 || nearby[0].(map[string]any)["id"] != local {
		t.Fatal("remote review fanout excluded local dish")
	}
	all := f.request("GET", "/v1/places?q=aubergine", "", nil, 200)["items"].([]any)
	if len(all) != 2 {
		t.Fatal("popular restaurant crowded out other dish matches")
	}
}

func TestRestrictedRoleOperations(t *testing.T) {
	f := phase3Setup(t, 0)
	_, token := f.user("role_diner")
	place := f.restaurant("Role counter")
	suffix := strings.ReplaceAll(secret(9), "-", "")
	suffix = strings.ReplaceAll(suffix, "_", "")
	names := []string{"gf_run_" + suffix, "gf_op_" + suffix, "gf_clean_" + suffix}
	for _, name := range names {
		_, err := f.db.Exec(f.ctx, "CREATE ROLE "+pgx.Identifier{name}.Sanitize())
		noError(t, err)
	}
	t.Cleanup(func() {
		for _, name := range names {
			_, _ = f.db.Exec(context.Background(), "DROP OWNED BY "+pgx.Identifier{name}.Sanitize())
			_, _ = f.db.Exec(context.Background(), "DROP ROLE "+pgx.Identifier{name}.Sanitize())
		}
	})
	grants, err := os.ReadFile(filepath.Join("..", "..", "grants.sql"))
	noError(t, err)
	schema := f.db.Config().ConnConfig.RuntimeParams["search_path"]
	grantsSQL := strings.NewReplacer("goodfork_runtime", pgx.Identifier{names[0]}.Sanitize(),
		"goodfork_operator", pgx.Identifier{names[1]}.Sanitize(), "goodfork_cleanup", pgx.Identifier{names[2]}.Sanitize(),
		"SCHEMA public", "SCHEMA "+schema).Replace(string(grants))
	_, err = f.db.Exec(f.ctx, grantsSQL, pgx.QueryExecModeSimpleProtocol)
	noError(t, err)
	pools := make([]*pgxpool.Pool, 3)
	for index, name := range names {
		config := f.db.Config().Copy()
		config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
			_, err := conn.Exec(ctx, "SET ROLE "+pgx.Identifier{name}.Sanitize())
			return err
		}
		pools[index], err = pgxpool.NewWithConfig(f.ctx, config)
		noError(t, err)
		defer pools[index].Close()
	}
	f.handler = NewAPI(pools[0], LocalMedia(t.TempDir()), Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	f.request("POST", "/v1/me/visits", token, map[string]any{"restaurantId": place, "requestId": "9b75cc00-1111-4111-8111-000000000011", "visitDate": "2026-11-17", "note": "Role-private fixture", "dish": "", "score": nil}, 200)
	f.request("GET", "/v1/me/visits", token, nil, 200)
	f.request("GET", "/v1/feed", "", nil, 200)
	if _, err := pools[0].Exec(f.ctx, "SELECT * FROM audit_events"); err == nil {
		t.Fatal("runtime read audit history")
	}
	for _, pool := range pools[1:] {
		if _, err := pool.Exec(f.ctx, "SELECT note FROM private_visits"); err == nil {
			t.Fatal("operational role read private journal")
		}
	}
	_, err = Queue(f.ctx, pools[1])
	noError(t, err)
	noError(t, Moderate(WithOperatorPrincipal(f.ctx, "fixture:restricted-operator"), pools[1], "hide-place", place))
	noError(t, ClearExpired(f.ctx, pools[2]))
}

func TestQueuedOwnerWriteAfterRevocation(t *testing.T) {
	f := phase3Setup(t, 0)
	owner, token := f.user("queued_owner")
	place := f.restaurant("Queued owner counter")
	_, err := f.db.Exec(f.ctx, "INSERT INTO restaurant_owners(place_id,person_id) VALUES($1,$2)", place, owner)
	noError(t, err)
	hold, err := f.db.Begin(f.ctx)
	noError(t, err)
	defer hold.Rollback(f.ctx)
	noError(t, lockPlace(f.ctx, hold, place))
	_, err = hold.Exec(f.ctx, "DELETE FROM restaurant_owners WHERE place_id=$1", place)
	noError(t, err)
	body, _ := json.Marshal(map[string]any{"revision": 1, "description": "Queued description", "price": nil, "dietary": []string{}, "hours": []string{}, "website": "", "menuURL": "", "phone": ""})
	request := httptest.NewRequest("PATCH", "/v1/places/"+place+"/listing", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { f.handler.ServeHTTP(response, request); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var waiting bool
		noError(t, f.db.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR NO KEY UPDATE%')`).Scan(&waiting))
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("queued owner request never reached the lock barrier")
		}
		time.Sleep(5 * time.Millisecond)
	}
	noError(t, hold.Commit(f.ctx))
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("queued write did not finish")
	}
	if response.Code != 404 {
		t.Fatalf("revoked queued owner write returned %d", response.Code)
	}
	var description string
	noError(t, f.db.QueryRow(f.ctx, "SELECT description FROM places WHERE id=$1", place).Scan(&description))
	if description != "" {
		t.Fatal("revoked queued write changed listing")
	}
}
