package goodfork

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRestaurantCommunity(t *testing.T) {
	dsn := os.Getenv("GOODFORK_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("Set GOODFORK_TEST_DATABASE_URL to a disposable Postgres instance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	root, err := Open(ctx, dsn, true)
	noError(t, err)
	defer root.Close()
	schema := "test_" + strings.ToLower(strings.NewReplacer("-", "x", "_", "y").Replace(secret(9)))
	quoted := pgx.Identifier{schema}.Sanitize()
	_, err = root.Exec(ctx, "CREATE SCHEMA "+quoted)
	noError(t, err)
	defer func() {
		_, err := root.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE")
		noError(t, err)
	}()
	conf := root.Config()
	conf.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, conf)
	noError(t, err)
	defer db.Close()
	noError(t, Migrate(ctx, db))
	noError(t, Migrate(ctx, db))

	dir := LocalMedia(t.TempDir())
	logs := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mail := &testMail{}
	app := NewAPI(db, dir, Config{BlockedTerms: []string{"test blocked phrase"}, Mailer: mail, Google: testGoogle{}}, logs)
	type object = map[string]any
	type list struct {
		Items []object `json:"items"`
	}

	req := func(method, path, token string, body any, status int) *httptest.ResponseRecorder {
		t.Helper()
		var input io.Reader
		if body != nil {
			packet, err := json.Marshal(body)
			noError(t, err)
			input = bytes.NewReader(packet)
		}
		r := httptest.NewRequest(method, path, input)
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, w.Code, status, w.Body.String())
		}
		return w
	}
	doc := func(w *httptest.ResponseRecorder) object {
		t.Helper()
		var v object
		noError(t, json.Unmarshal(w.Body.Bytes(), &v))
		return v
	}
	items := func(w *httptest.ResponseRecorder) []object {
		t.Helper()
		var v list
		noError(t, json.Unmarshal(w.Body.Bytes(), &v))
		return v.Items
	}
	expect := func(ok bool, detail string) {
		t.Helper()
		if !ok {
			t.Fatal(detail)
		}
	}

	req("GET", "/readyz", "", nil, 200)
	req("GET", "/v1/config", "", nil, 200)
	req("GET", "/v1/me", "", nil, 401)
	places := `[
	  {"name":"Test Ramen","cuisine":"Japanese","area":"East Village","address":"1 Test Lane","city":"New York",
	   "description":"Integration fixture","lat":40.72,"lng":-73.98,"price":2,"dietary":["Vegetarian"],"hours":["Mon 5–9 PM"]},
	  {"name":"Test Pizza","cuisine":"Italian","area":"Brooklyn","address":"2 Test Lane","city":"New York","lat":40.68,"lng":-73.94}
	]`
	for range 2 {
		n, err := ImportPlaces(ctx, db, strings.NewReader(places))
		noError(t, err)
		expect(n == 2, "import did not include both restaurants")
	}
	r := items(req("GET", "/v1/places?q=ramen&cuisine=Japanese&price=2&diet=Vegetarian&sort=nearby&lat=40.7&lng=-74", "", nil, 200))
	expect(len(r) == 1 && r[0]["distanceKm"].(float64) < 5, "nearby filters returned the wrong restaurant")
	ramen := r[0]["id"].(string)
	pizza := items(req("GET", "/v1/places?q=Pizza", "", nil, 200))[0]["id"].(string)
	expect(len(items(req("GET", "/v1/places", "", nil, 200))) == 2, "import retry created duplicates")
	req("GET", "/r/"+ramen, "", nil, 200)

	pass := "a longer test password"
	account := func(handle string) object {
		email := handle + "@gmail.com"
		pending := doc(req("POST", "/v1/auth/register", "", object{
			"name": handle, "handle": handle, "email": email, "password": pass, "agreed": true,
		}, 202))["registrationId"]
		req("POST", "/v1/auth/login", "", object{"email": email, "password": pass}, 401)
		req("POST", "/v1/auth/verify", "", object{"registrationId": pending, "code": "xxxxxxxx"}, 400)
		if handle == "test_alex" {
			prior := mail.codes[email]
			res := req("POST", "/v1/auth/verify/resend", "", object{"registrationId": pending}, 429)
			expect(res.Header().Get("Retry-After") != "", "resend cooldown did not provide a retry delay")
			_, err := db.Exec(ctx, "UPDATE registrations SET issued_at=now()-interval '31 seconds' WHERE id_hash=$1", digest(pending.(string)))
			noError(t, err)
			req("POST", "/v1/auth/verify/resend", "", object{"registrationId": pending}, 204)
			if prior != mail.codes[email] {
				req("POST", "/v1/auth/verify", "", object{"registrationId": pending, "code": prior}, 400)
			}
		}
		auth := doc(req("POST", "/v1/auth/verify", "", object{"registrationId": pending, "code": mail.codes[email]}, 201))
		req("POST", "/v1/auth/verify", "", object{"registrationId": pending, "code": mail.codes[email]}, 400)
		return auth
	}
	alexAccount, mayaAccount := account("test_alex"), account("test_maya")
	alex, maya := alexAccount["token"].(string), mayaAccount["token"].(string)
	a := doc(req("GET", "/v1/me", alex, nil, 200))["id"].(string)
	b := doc(req("PATCH", "/v1/me", maya, object{"name": "Test Maya", "bio": "Testing."}, 200))["id"].(string)
	expect(len(items(req("GET", "/v1/people?q=maya", alex, nil, 200))) == 1, "diner search missed exact handle")
	expect(doc(req("GET", "/v1/people/"+a, "", nil, 200))["email"] == nil, "public profile exposed private email")
	expect(doc(req("GET", "/v1/me", alex, nil, 200))["email"] == "test_alex@gmail.com", "private profile lost email")

	verifier := secret(36)
	challenge := hex.EncodeToString(digest(verifier))
	start := req("GET", "/v1/auth/google/start?target=native&agreed=1&challenge="+challenge, "", nil, 303)
	provider, err := url.Parse(start.Header().Get("Location"))
	noError(t, err)
	callback := func(state string) string {
		return "/v1/auth/google/callback?code=authorized&state=" + url.QueryEscape(state)
	}
	collision := req("GET", callback(provider.Query().Get("state")), "", nil, 303)
	expect(strings.Contains(collision.Header().Get("Location"), "error=account_exists"), "Google sign-in attached by email")
	linkStart := doc(req("POST", "/v1/auth/google/link/start", alex, object{"target": "native", "challenge": challenge, "password": pass}, 200))
	provider, err = url.Parse(linkStart["authorizationURL"].(string))
	noError(t, err)
	relay := req("GET", callback(provider.Query().Get("state")), "", nil, 303)
	link, err := url.Parse(relay.Header().Get("Location"))
	noError(t, err)
	handoff := link.Query().Get("code")
	expect(link.Scheme == "goodfork" && handoff != "", "Google link missed the device handoff")
	req("POST", "/v1/auth/google/finish", "", object{"code": handoff, "verifier": verifier}, 400)
	req("POST", "/v1/auth/google/link/finish", maya, object{"code": handoff, "verifier": verifier}, 400)
	req("POST", "/v1/auth/google/link/finish", alex, object{"code": handoff, "verifier": verifier}, 204)
	req("POST", "/v1/auth/google/link/finish", alex, object{"code": handoff, "verifier": verifier}, 400)
	start = req("GET", "/v1/auth/google/start?target=native&agreed=1&challenge="+challenge, "", nil, 303)
	provider, err = url.Parse(start.Header().Get("Location"))
	noError(t, err)
	relay = req("GET", callback(provider.Query().Get("state")), "", nil, 303)
	link, err = url.Parse(relay.Header().Get("Location"))
	noError(t, err)
	handoff = link.Query().Get("code")
	req("POST", "/v1/auth/google/finish", "", object{"code": handoff, "verifier": secret(36)}, 400)
	googleToken := doc(req("POST", "/v1/auth/google/finish", "", object{"code": handoff, "verifier": verifier}, 200))["token"].(string)
	expect(doc(req("GET", "/v1/me", googleToken, nil, 200))["id"] == a, "returning Google subject did not resolve linked account")
	req("POST", "/v1/auth/google/finish", "", object{"code": handoff, "verifier": verifier}, 400)

	suggestion := object{"name": "Test Bakery", "cuisine": "Bakery", "address": "3 Test Lane", "city": "New York", "lat": 40.70, "lng": -73.92}
	place := doc(req("POST", "/v1/places", alex, suggestion, 201))
	suggested := place["id"].(string)
	expect(place["status"] == "pending", "restaurant bypassed moderation")
	req("GET", "/v1/places/"+suggested, "", nil, 404)
	req("GET", "/v1/places/"+suggested, alex, nil, 200)
	noError(t, Moderate(ctx, db, "publish-place", suggested))
	req("GET", "/v1/places/"+suggested, "", nil, 200)

	write := func(place string, score float64, id string) object {
		return object{"requestId": id, "restaurantId": place, "score": score, "text": "A delicious meal.", "dish": "Lunch special"}
	}
	request1 := "19f76015-1634-4c8e-8a9a-a13f805af198"
	request2 := "19f76015-1634-4c8e-8a9a-a13f805af199"
	request3 := "19f76015-1634-4c8e-8a9a-a13f805af190"
	review := doc(req("POST", "/v1/posts", alex, write(ramen, 9.4, request1), 201))
	id := review["id"].(string)
	expect(doc(req("POST", "/v1/posts", alex, write(ramen, 9.4, request1), 200))["id"] == id, "retry did not return original review")
	req("POST", "/v1/posts", alex, write(ramen, 8.4, request2), 409)
	second := doc(req("POST", "/v1/posts", alex, write(pizza, 8.4, request2), 201))["id"].(string)
	req("PUT", "/v1/me/ranked", alex, object{"winner": second, "loser": id}, 204)
	expect(items(req("GET", "/v1/me/ranked", alex, nil, 200))[0]["id"] == second, "comparison did not persist")
	review = doc(req("PATCH", "/v1/posts/"+id, alex, object{"score": 9.2, "text": "Thoughtful update.", "dish": "Spicy ramen", "revision": review["revision"]}, 200))
	expect(doc(req("GET", "/v1/places/"+ramen, "", nil, 200))["score"] == 9.2, "rating did not reflect edited review")
	req("GET", "/v1/places/"+ramen+"/reviews", "", nil, 200)
	req("GET", "/v1/feed?kind=for-you", alex, nil, 200)
	req("GET", "/v1/people/"+a+"/reviews", "", nil, 200)
	req("PUT", "/v1/places/"+pizza+"/save", maya, object{"active": true}, 204)
	expect(items(req("GET", "/v1/me/saved", maya, nil, 200))[0]["id"] == pizza, "save did not persist")

	clip, err := os.ReadFile("../../../assets/food/ramen-reel.mp4")
	noError(t, err)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	clipFields := write(ramen, 8.7, request3)
	clipFields["dish"] = "Black garlic noodles"
	for key, value := range clipFields {
		noError(t, form.WriteField(key, fmt.Sprint(value)))
	}
	file, err := form.CreateFormFile("media", "sample.mp4")
	noError(t, err)
	_, err = file.Write(clip)
	noError(t, err)
	noError(t, form.Close())
	upload := httptest.NewRequest("POST", "/v1/posts", &body)
	upload.Header.Set("Authorization", "Bearer "+maya)
	upload.Header.Set("Content-Type", form.FormDataContentType())
	w := httptest.NewRecorder()
	app.ServeHTTP(w, upload)
	expect(w.Code == 201, "media upload did not succeed: "+w.Body.String())
	payload := doc(w)
	media := payload["media"].(map[string]any)["source"].(string)
	video := payload["id"].(string)
	req("GET", media, "", nil, 404)
	req("GET", media, maya, nil, 200)
	expect(len(items(req("GET", "/v1/feed?kind=clips", "", nil, 200))) == 0, "pending clip leaked")
	expect(len(items(req("GET", "/v1/places?q=black+garlic", "", nil, 200))) == 0, "pending dish evidence leaked")
	updatedClip := doc(req("PATCH", "/v1/posts/"+video, maya, object{"text": "The noodles were excellent.", "dish": "Black garlic noodles", "score": 8.7, "revision": payload["revision"]}, 200))
	expect(Moderate(ctx, db, "publish-post", video, payload["revision"].(string)) != nil, "a stale queue entry published revised media")
	noError(t, Moderate(ctx, db, "publish-post", video, updatedClip["revision"].(string)))
	dishMatches := items(req("GET", "/v1/places?q=black+garlic+village", "", nil, 200))
	expect(len(dishMatches) == 1 && dishMatches[0]["dishMatch"].(object)["reviewId"] == video, "dish and neighborhood search missed the source review")
	meal := doc(req("POST", "/v1/assist/dining", "", object{"prompt": "Black garlic noodles in the East Village with vegetarian options", "filters": object{}}, 200))
	expect(len(meal["suggestions"].([]any)) == 1, "local dining assist did not convert the request into a current match")

	expect(len(items(req("GET", "/v1/feed?kind=clips", "", nil, 200))) == 1, "clip absent after moderation")
	rangeRequest := httptest.NewRequest("GET", media, nil)
	rangeRequest.Header.Set("Range", "bytes=1-25")
	part := httptest.NewRecorder()
	app.ServeHTTP(part, rangeRequest)
	expect(part.Code == 206 && bytes.Equal(part.Body.Bytes(), clip[1:26]), "byte range did not match the uploaded video")
	filePath := string(dir) + "/" + strings.TrimPrefix(media, "/v1/media/")
	noError(t, os.Rename(filePath, filePath+".test-hold"))
	req("GET", media, "", nil, 503)
	noError(t, os.Rename(filePath+".test-hold", filePath))

	req("PUT", "/v1/people/"+b+"/follow", alex, object{"active": true}, 204)
	expect(len(items(req("GET", "/v1/feed?kind=following", alex, nil, 200))) == 1, "following feed was not filtered")
	req("PUT", "/v1/posts/"+id+"/like", maya, object{"active": true}, 204)
	req("PUT", "/v1/posts/"+id+"/like", maya, object{"active": true}, 204)
	comment := object{"requestId": request1, "text": "I will order it next time."}
	c := doc(req("POST", "/v1/posts/"+id+"/comments", maya, comment, 200))["id"].(string)
	expect(doc(req("POST", "/v1/posts/"+id+"/comments", maya, comment, 200))["id"] == c, "comment was not idempotent")
	req("POST", "/v1/posts/"+id+"/comments", maya, object{"requestId": request2, "text": "A test blocked phrase!"}, 400)
	expect(len(items(req("GET", "/v1/posts/"+id+"/comments", alex, nil, 200))) == 1, "comment missing")
	events := items(req("GET", "/v1/me/activity", alex, nil, 200))
	expect(len(events) == 2 && events[0]["read"] == false, "activity feed did not include unread like and comment")
	req("PUT", "/v1/me/activity/read", alex, object{"through": events[0]["createdAt"]}, 204)
	expect(items(req("GET", "/v1/me/activity", alex, nil, 200))[0]["read"] == true, "read marker did not persist")

	req("POST", "/v1/reports", alex, object{"targetType": "comment", "targetId": c, "reason": "Review this comment"}, 204)
	queue, err := Queue(ctx, db)
	noError(t, err)
	expect(len(queue) == 1, "report not in moderation queue")
	noError(t, Moderate(ctx, db, "remove-comment", c))
	expect(len(items(req("GET", "/v1/posts/"+id+"/comments", alex, nil, 200))) == 0, "removed comment remained visible")
	req("PUT", "/v1/people/"+b+"/block", alex, object{"active": true}, 204)
	req("GET", "/v1/people/"+b, alex, nil, 404)
	req("GET", media, alex, nil, 404)
	expect(len(items(req("GET", "/v1/places?q=black+garlic", alex, nil, 200))) == 0, "blocked review supplied dish evidence")
	req("PUT", "/v1/people/"+a+"/follow", maya, object{"active": true}, 404)
	expect(len(items(req("GET", "/v1/me/blocked", alex, nil, 200))) == 1, "block did not persist")
	req("PUT", "/v1/people/"+b+"/block", alex, object{"active": false}, 204)
	req("GET", "/v1/people/"+b, alex, nil, 200)
	expect(len(items(req("GET", "/v1/feed?kind=following", alex, nil, 200))) == 0, "blocking did not remove the follow relationship")

	owner := account("test_owner")["token"].(string)
	listing := object{"description": "Updated by the restaurant.", "hours": []string{"Mon–Sun 9 AM–4 PM"},
		"menuURL": "https://example.test/menu", "price": 3, "dietary": []string{"Vegetarian"}}
	req("PATCH", "/v1/places/"+ramen+"/listing", owner, listing, 404)
	req("PUT", "/v1/posts/"+id+"/reply", owner, object{"text": "Thanks for visiting."}, 404)
	req("POST", "/v1/posts", owner, write(ramen, 10, request1), 201)
	claimInput := object{"email": "owner@example.test", "role": "Owner"}
	claim := doc(req("POST", "/v1/places/"+ramen+"/claim", owner, claimInput, 201))
	expect(claim["status"] == "pending", "ownership was not queued for verification")
	claims := items(req("GET", "/v1/me/restaurants", owner, nil, 200))
	expect(len(claims) == 1 && claims[0]["email"] == nil, "claim details were missing or exposed")
	rival := doc(req("POST", "/v1/places/"+ramen+"/claim", maya, claimInput, 201))["id"].(string)
	queue, err = Queue(ctx, db)
	noError(t, err)
	expect(len(queue) == 2, "operator did not receive competing claims")
	revisedClaim := doc(req("POST", "/v1/places/"+ramen+"/claim", owner, object{"email": "business@example.test", "role": "General manager"}, 201))
	expect(Moderate(ctx, db, "approve-claim", claim["id"].(string), fmt.Sprint(claim["revision"])) != nil, "stale claim was approved")
	noError(t, Moderate(ctx, db, "approve-claim", claim["id"].(string), fmt.Sprint(revisedClaim["revision"])))
	expect(Moderate(ctx, db, "approve-claim", rival, "1") != nil, "a second owner claimed the listing")
	publicPlace := doc(req("GET", "/v1/places/"+ramen, "", nil, 200))
	expect(publicPlace["managed"] == true && publicPlace["canManage"] == false && publicPlace["ratingCount"] == float64(2), "public rating retained owner review or leaked edit access")
	listing["revision"] = publicPlace["listingRevision"]
	updated := doc(req("PATCH", "/v1/places/"+ramen+"/listing", owner, listing, 200))
	req("PATCH", "/v1/places/"+ramen+"/listing", owner, listing, 409)
	expect(updated["canManage"] == true && updated["menuURL"] == "https://example.test/menu", "owner updates did not persist")
	_, err = ImportPlaces(ctx, db, strings.NewReader(places))
	noError(t, err)
	expect(doc(req("GET", "/v1/places/"+ramen, "", nil, 200))["menuURL"] == "https://example.test/menu", "import overwrote owner details")
	req("POST", "/v1/posts/"+id+"/reply/draft", alex, object{"tone": "warm"}, 404)
	draft := doc(req("POST", "/v1/posts/"+id+"/reply/draft", owner, object{"tone": "warm"}, 200))
	expect(draft["outcome"] == "local" && len(draft["draft"].(string)) > 5, "local owner draft unavailable")
	expect(doc(req("GET", "/v1/posts/"+id, "", nil, 200))["ownerReply"] == nil, "the assist published a draft")
	req("PUT", "/v1/posts/"+id+"/reply", owner, object{"text": "Thanks for visiting."}, 204)
	reply := doc(req("GET", "/v1/posts/"+id, "", nil, 200))["ownerReply"].(object)
	expect(reply["text"] == "Thanks for visiting.", "restaurant response was not attributed to the review")
	unanswered := items(req("GET", "/v1/places/"+ramen+"/owner/reviews?unanswered=1", owner, nil, 200))
	expect(len(unanswered) == 1 && unanswered[0]["id"] == video, "owner inbox included answered or hidden reviews")
	req("POST", "/v1/reports", alex, object{"targetType": "reply", "targetId": id, "reason": "Please look at this response", "revision": reply["revision"]}, 204)
	req("PUT", "/v1/posts/"+id+"/reply", owner, object{"text": "Thank you for sharing that.", "revision": reply["revision"]}, 204)
	queue, err = Queue(ctx, db)
	noError(t, err)
	expect(strings.Contains(string(queue[len(queue)-1]), "Thanks for visiting."), "the original reported version was lost")
	expect(Moderate(ctx, db, "remove-reply", id, reply["revision"].(string)) != nil, "a stale report removed the new reply")
	currentReply := doc(req("GET", "/v1/posts/"+id, "", nil, 200))["ownerReply"].(object)
	noError(t, Moderate(ctx, db, "remove-reply", id, currentReply["revision"].(string)))
	expect(doc(req("GET", "/v1/posts/"+id, "", nil, 200))["ownerReply"] == nil, "removed response stayed visible")

	noError(t, Moderate(ctx, db, "revoke-owner", ramen))
	req("PATCH", "/v1/places/"+ramen+"/listing", owner, listing, 404)
	req("PUT", "/v1/posts/"+id+"/reply", owner, object{"text": "Thanks for visiting."}, 404)

	newPass := "new password after recovery"
	recover := doc(req("POST", "/v1/auth/recover", "", object{"email": "test_maya@gmail.com", "password": newPass, "recoveryCode": mayaAccount["recoveryCode"]}, 200))
	req("GET", "/v1/me", maya, nil, 401)
	req("POST", "/v1/auth/login", "", object{"email": "test_maya@gmail.com", "password": pass}, 401)
	session := doc(req("POST", "/v1/auth/login", "", object{"email": "test_maya@gmail.com", "password": newPass}, 200))["token"].(string)
	req("DELETE", "/v1/auth/session", session, nil, 204)
	req("GET", "/v1/me", session, nil, 401)
	req("DELETE", "/v1/me", recover["token"].(string), object{"password": newPass}, 204)
	req("GET", media, "", nil, 404)
	req("GET", "/v1/posts/"+video, "", nil, 404)
	_, err = db.Exec(ctx, "UPDATE objects SET created_at=now()-interval '2 hours'")
	noError(t, err)
	removed, err := Purge(ctx, db, dir, 5)
	noError(t, err)
	expect(removed == 1, "orphaned media was not purged")
	req("DELETE", "/v1/posts/"+id, alex, object{"revision": doc(req("GET", "/v1/posts/"+id, alex, nil, 200))["revision"]}, 204)
	req("GET", "/v1/posts/"+id, "", nil, 404)
}

func TestBadMedia(t *testing.T) {
	for _, invalid := range [][]byte{nil, []byte("not a media file"), {0xff, 0xd8, 0xff, 0xe1}, {0, 0, 0, 1, 'f', 't', 'y', 'p'}} {
		if _, _, err := prepareMedia(invalid); err == nil {
			t.Fatal("malformed media was accepted")
		}
	}
}

type testMail struct{ codes map[string]string }

func (m *testMail) SendVerification(_ context.Context, email, code string) error {
	if m.codes == nil {
		m.codes = make(map[string]string)
	}
	m.codes[email] = code
	return nil
}

type testGoogle struct{}

func (testGoogle) AuthorizationURL(state, _, _ string) string {
	return "https://example.test/google?state=" + url.QueryEscape(state)
}

func (testGoogle) Verify(_ context.Context, code, verifier, nonce string) (GoogleIdentity, error) {
	if code != "authorized" || verifier == "" || nonce == "" {
		return GoogleIdentity{}, fmt.Errorf("invalid provider request")
	}
	return GoogleIdentity{Subject: "google-alex", Email: "test_alex@gmail.com", Name: "Test Alex"}, nil
}

func noError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
