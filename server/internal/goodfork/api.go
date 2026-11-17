package goodfork

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	SupportEmail      string
	PrivacyURL        string
	TermsURL          string
	WebOrigin         string
	BlockedTerms      []string
	Mailer            Mailer
	Google            GoogleIdentityProvider
	Budgets           map[string]int
	DiningProvider    diningProvider
	ReplyProvider     replyProvider
	RequestTimeout    time.Duration
	UploadConcurrency int
}

type API struct {
	db          *pgxpool.Pool
	storage     MediaStore
	config      Config
	log         *slog.Logger
	passwords   chan struct{}
	uploads     chan struct{}
	router      *http.ServeMux
	quotaMu     sync.Mutex
	quotaClosed map[string]time.Time
}

type apiError struct {
	status  int
	message string
}

func (e apiError) Error() string { return e.message }

func invalid(message string) error  { return apiError{http.StatusBadRequest, message} }
func conflict(message string) error { return apiError{http.StatusConflict, message} }

var (
	notFound = apiError{http.StatusNotFound, "This item is no longer available."}
	signIn   = apiError{http.StatusUnauthorized, "Sign in to continue."}
	slowDown = apiError{http.StatusTooManyRequests, "Too many attempts. Try again shortly."}
	uuid     = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
)

func NewAPI(db *pgxpool.Pool, storage MediaStore, config Config, log *slog.Logger) http.Handler {
	budgets := DefaultBudgets()
	for key, value := range config.Budgets {
		if value > 0 {
			budgets[key] = value
		}
	}
	config.Budgets = budgets
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.UploadConcurrency < 1 || config.UploadConcurrency > 4 {
		config.UploadConcurrency = 1
	}
	a := &API{quotaClosed: make(map[string]time.Time), db: db, storage: storage, config: config, log: log,
		router: http.NewServeMux(), passwords: make(chan struct{}, 4), uploads: make(chan struct{}, config.UploadConcurrency)}
	a.handle("GET /healthz", false, func(w http.ResponseWriter, _ *http.Request, _ string) error {
		return send(w, http.StatusOK, map[string]bool{"ok": true})
	})
	a.handle("GET /readyz", false, a.ready)
	a.handle("GET /v1/config", false, a.publicConfig)
	a.handle("POST /v1/auth/register", false, a.register)
	a.handle("POST /v1/auth/verify", false, a.verifyEmail)
	a.handle("POST /v1/auth/verify/resend", false, a.resendVerification)
	a.handle("POST /v1/auth/google/link/start", true, a.startGoogleLink)
	a.handle("POST /v1/auth/google/link/finish", true, a.finishGoogleLink)
	a.handle("GET /v1/auth/google/start", false, a.startGoogle)
	a.handle("GET /v1/auth/google/callback", false, a.finishGoogleProvider)
	a.handle("POST /v1/auth/google/finish", false, a.finishGoogleDevice)
	a.handle("POST /v1/auth/login", false, a.login)
	a.handle("POST /v1/auth/recover", false, a.recoverAccount)
	a.handle("DELETE /v1/auth/session", true, a.logout)
	a.handle("GET /v1/me", true, a.me)
	a.handle("PATCH /v1/me", true, a.editProfile)
	a.handle("DELETE /v1/me", true, a.deleteAccount)
	a.handle("GET /v1/me/visits", true, a.visits)
	a.handle("POST /v1/me/visits", true, a.writeVisit)
	a.handle("GET /v1/me/visits/{id}", true, a.visit)
	a.handle("PATCH /v1/me/visits/{id}", true, a.writeVisit)
	a.handle("DELETE /v1/me/visits/{id}", true, a.deleteVisit)
	a.handle("GET /v1/me/saved", true, a.saved)
	a.handle("GET /v1/me/ranked", true, a.ranked)
	a.handle("PUT /v1/me/ranked", true, a.rank)
	a.handle("GET /v1/me/restaurants", true, a.myRestaurants)
	a.handle("GET /v1/me/blocked", true, a.blocked)
	a.handle("GET /v1/me/activity", true, a.activity)
	a.handle("PUT /v1/me/activity/read", true, a.readActivity)
	a.handle("GET /v1/feed", false, a.feed)
	a.handle("GET /v1/places", false, a.places)
	a.handle("POST /v1/assist/dining", false, a.suggestPlaces)
	a.handle("POST /v1/places", true, a.submitPlace)
	a.handle("GET /v1/places/{id}", false, a.place)
	a.handle("POST /v1/places/{id}/claim", true, a.claimRestaurant)
	a.handle("PATCH /v1/places/{id}/listing", true, a.editListing)
	a.handle("POST /v1/places/{id}/hours/preview", true, a.previewHours)
	a.handle("GET /v1/places/{id}/owner/reviews", true, a.ownerReviews)
	a.handle("GET /v1/places/{id}/reviews", false, a.placeReviews)
	a.handle("PUT /v1/places/{id}/save", true, a.savePlace)
	a.handle("GET /v1/people", false, a.people)
	a.handle("GET /v1/people/{id}", false, a.person)
	a.handle("GET /v1/people/{id}/reviews", false, a.personReviews)
	a.handle("PUT /v1/people/{id}/follow", true, a.follow)
	a.handle("PUT /v1/people/{id}/block", true, a.block)
	a.handle("POST /v1/posts", true, a.createPost)
	a.handle("GET /v1/posts/{id}", false, a.post)
	a.handle("PATCH /v1/posts/{id}", true, a.editPost)
	a.handle("DELETE /v1/posts/{id}", true, a.deletePost)
	a.handle("PUT /v1/posts/{id}/like", true, a.like)
	a.handle("PUT /v1/posts/{id}/reply", true, a.replyToReview)
	a.handle("POST /v1/posts/{id}/reply/draft", true, a.suggestReply)
	a.handle("DELETE /v1/posts/{id}/reply", true, a.deleteReply)
	a.handle("GET /v1/posts/{id}/comments", false, a.comments)
	a.handle("POST /v1/posts/{id}/comments", true, a.addComment)
	a.handle("DELETE /v1/comments/{id}", true, a.deleteComment)
	a.handle("GET /v1/media/{id}", false, a.media)
	a.handle("POST /v1/reports", true, a.report)
	a.handle("GET /r/{id}", false, a.sharePlace)
	a.handle("GET /p/{id}", false, a.sharePost)
	a.router.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { respondError(w, notFound) })

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		if config.WebOrigin != "" && r.Header.Get("Origin") == config.WebOrigin {
			w.Header().Set("Access-Control-Allow-Origin", config.WebOrigin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range, If-Range")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		a.router.ServeHTTP(w, r)
	})
}

type endpoint func(http.ResponseWriter, *http.Request, string) error

func (a *API) handle(pattern string, required bool, run endpoint) {
	a.router.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		budget := a.config.RequestTimeout
		if pattern == "GET /v1/media/{id}" {
			budget = 60 * time.Second
		}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			budget = 55 * time.Second
		}
		ctx, cancel := context.WithTimeout(r.Context(), budget)
		defer cancel()
		r = r.WithContext(ctx)
		if target := r.PathValue("id"); target != "" && !uuid.MatchString(target) {
			respondError(w, notFound)
			return
		}
		var id string
		var err error
		if raw := r.Header.Get("Authorization"); raw != "" {
			id, err = a.resolveSession(r.Context(), raw)
		} else if required {
			err = signIn
		}
		if err == nil {
			r = r.WithContext(context.WithValue(r.Context(), managerActorKey, id))
			err = run(w, r, id)
		}
		if err == nil {
			return
		}
		var clientError apiError
		if !errors.As(err, &clientError) && !errors.Is(err, pgx.ErrNoRows) {
			// Keep SQL details, credentials and user content out of request logs.
			a.log.Error("request failed", "route", pattern, "error_type", fmt.Sprintf("%T", err))
		}
		respondError(w, err)
	})
}

func send(w http.ResponseWriter, status int, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
	return nil
}

func respondError(w http.ResponseWriter, err error) {
	if retry := retrySeconds(err); retry > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retry))
	}
	var result apiError
	if errors.Is(err, pgx.ErrNoRows) {
		result = notFound
	} else if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		w.Header().Set("Retry-After", "1")
		result = apiError{http.StatusServiceUnavailable, "This request took too long. Please try again."}
	} else if !errors.As(err, &result) {
		result = apiError{http.StatusInternalServerError, "Something went wrong. Please try again."}
	}
	_ = send(w, result.status, map[string]string{"error": result.message})
}

func decode(w http.ResponseWriter, r *http.Request, dest any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	parser := json.NewDecoder(r.Body)
	parser.DisallowUnknownFields()
	if err := parser.Decode(dest); err != nil || parser.Decode(new(any)) != io.EOF {
		return invalid("Check the information and try again.")
	}
	return nil
}

func nullable(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func optionalJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

func tidy(text string, minLen, maxLen int, label string) (string, error) {
	text = strings.TrimSpace(text)
	if length := len([]rune(text)); length < minLen || length > maxLen {
		return "", invalid(fmt.Sprintf("%s must be %d–%d characters.", label, minLen, maxLen))
	}
	for _, r := range text {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", invalid(label + " contains unsupported characters.")
		}
	}
	return text, nil
}

func (a *API) filter(text string) error {
	tokens := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
	normalized := " " + strings.Join(tokens, " ") + " "
	for _, term := range a.config.BlockedTerms {
		term = strings.TrimSpace(strings.ToLower(term))
		if term != "" && strings.Contains(normalized, " "+term+" ") {
			return invalid("Please revise the language to follow the community guidelines.")
		}
	}
	return nil
}

const pageSize = 20

type page struct {
	Items      []json.RawMessage `json:"items"`
	NextOffset *int              `json:"nextOffset"`
	NextCursor string            `json:"nextCursor,omitempty"`
	AsOf       string            `json:"asOf,omitempty"`
}

func offset(r *http.Request) (int, error) {
	value := r.URL.Query().Get("offset")
	if value == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 || n > 10000 {
		return 0, invalid("Invalid page.")
	}
	return n, nil
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func one(ctx context.Context, db querier, query string, args ...any) (json.RawMessage, error) {
	var value json.RawMessage
	err := db.QueryRow(ctx, query, args...).Scan(&value)
	return value, err
}

func many(ctx context.Context, db querier, query string, args ...any) ([]json.RawMessage, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var value json.RawMessage
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		items = append(items, value)
	}
	return items, rows.Err()
}

func (a *API) list(w http.ResponseWriter, r *http.Request, query string, args ...any) error {
	start, err := offset(r)
	if err != nil {
		return err
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET $%d", pageSize+1, len(args)+1)
	items, err := many(r.Context(), a.db, query, append(args, start)...)
	if err != nil {
		return err
	}
	result := page{Items: items}
	if len(items) > pageSize {
		result.Items = items[:pageSize]
		next := start + pageSize
		result.NextOffset = &next
	}
	return send(w, http.StatusOK, result)
}

func (a *API) resource(w http.ResponseWriter, r *http.Request, query string, args ...any) error {
	value, err := one(r.Context(), a.db, query, args...)
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, value)
}

func (a *API) limit(ctx context.Context, key string, max int, period time.Duration) error {
	start := time.Now().Truncate(period)
	bucket := start.Unix()
	var n int
	err := a.db.QueryRow(ctx, `
		INSERT INTO limits (scope, bucket, hits) VALUES ($1,$2,1)
		ON CONFLICT (scope, bucket) DO UPDATE SET hits = LEAST(limits.hits + 1, $3 + 1)
		RETURNING hits`, key, bucket, max).Scan(&n)
	if err != nil {
		return err
	}
	if n > max {
		return throttled{start.Add(period)}
	}
	return nil
}

func (a *API) ready(w http.ResponseWriter, r *http.Request, _ string) error {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := a.db.Ping(ctx); err != nil {
		return apiError{http.StatusServiceUnavailable, "Database is unavailable."}
	}
	return send(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) publicConfig(w http.ResponseWriter, _ *http.Request, _ string) error {
	return send(w, http.StatusOK, map[string]any{
		"googleEnabled": a.config.Google != nil, "assistRemote": map[string]bool{"dining": a.config.DiningProvider != nil, "reply": a.config.ReplyProvider != nil}, "supportEmail": a.config.SupportEmail, "privacyURL": a.config.PrivacyURL, "termsURL": a.config.TermsURL,
	})
}
