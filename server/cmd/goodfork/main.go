package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"cloud.google.com/go/storage"
	"goodfork/internal/goodfork"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(os.Args[1:], log); err != nil {
		log.Error("goodfork stopped", "message", err.Error())
		os.Exit(1)
	}
}

func run(args []string, log *slog.Logger) error {
	command := "serve"
	if len(args) > 0 {
		command, args = args[0], args[1:]
	}
	arguments := map[string]int{"serve": 0, "migrate": 0, "import-places": 1, "queue": 0, "audit": 0, "moderate": 2, "purge": 0, "download-media": 1}
	expected, recognized := arguments[command]
	if !recognized || (len(args) != expected && !(command == "moderate" && len(args) == 3)) {
		return errors.New("usage: goodfork {serve|migrate|import-places FILE|queue|audit|moderate ACTION ID [REVISION]|purge|download-media ID}")
	}
	local := os.Getenv("APP_ENV") == "local"
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("set DATABASE_URL to the Neon Postgres connection string")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	start, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	db, err := goodfork.Open(start, dsn, local)
	if err != nil {
		return err
	}
	defer db.Close()
	switch command {
	case "migrate":
		return goodfork.Migrate(start, db)
	case "import-places":
		f, err := os.Open(args[0])
		if err != nil {
			return err
		}
		defer f.Close()
		count, err := goodfork.ImportPlaces(ctx, db, f)
		if err == nil {
			log.Info("directory imported", "restaurants", count)
		}
		return err
	case "queue", "audit":
		read := goodfork.Queue
		if command == "audit" {
			read = goodfork.AuditEvents
		}
		items, err := read(start, db)
		if err != nil {
			return err
		}
		e := json.NewEncoder(os.Stdout)
		e.SetIndent("", "  ")
		return e.Encode(items)
	case "moderate":
		principal := strings.TrimSpace(os.Getenv("GOODFORK_OPERATOR_PRINCIPAL"))
		if !local && principal == "" {
			return errors.New("set GOODFORK_OPERATOR_PRINCIPAL to the operator's non-secret principal identifier")
		}
		if len(principal) > 160 {
			return errors.New("operator principal must be at most 160 characters")
		}
		start = goodfork.WithOperatorPrincipal(start, principal)
		return goodfork.Moderate(start, db, args[0], args[1], args[2:]...)
	}

	var expiryErr error
	if command == "purge" {
		expiryErr = goodfork.ClearExpired(ctx, db)
	}
	var store goodfork.MediaStore
	if bucket := os.Getenv("GCS_BUCKET"); bucket != "" {
		client, err := storage.NewClient(start)
		if err != nil {
			return errors.Join(expiryErr, fmt.Errorf("initialize Cloud Storage: %w", err))
		}
		defer client.Close()
		store = goodfork.CloudStorage(client, bucket)
	} else if local {
		dir := os.Getenv("MEDIA_DIR")
		if dir == "" {
			dir = ".goodfork-media"
		}
		store = goodfork.LocalMedia(dir)
	} else {
		return errors.Join(expiryErr, errors.New("set GCS_BUCKET to the private Goodfork media bucket"))
	}

	switch command {
	case "download-media":
		return goodfork.DownloadMedia(ctx, store, args[0], os.Stdout)
	case "purge":
		count, mediaErr := goodfork.Purge(ctx, db, store, 1000)
		log.Info("media cleanup batch finished", "objects", count, "complete", mediaErr == nil)
		return errors.Join(expiryErr, mediaErr)
	}

	if local {
		if err := goodfork.Migrate(start, db); err != nil {
			return err
		}
	}
	if err := goodfork.RequireSchema(start, db); err != nil {
		return err
	}
	config := goodfork.Config{
		SupportEmail: os.Getenv("SUPPORT_EMAIL"),
		PrivacyURL:   os.Getenv("PRIVACY_URL"),
		TermsURL:     os.Getenv("TERMS_URL"),
		WebOrigin:    os.Getenv("WEB_ORIGIN"),
		BlockedTerms: strings.Split(os.Getenv("BLOCKED_TERMS"), ","),
	}
	if raw := os.Getenv("GOODFORK_UPLOAD_CONCURRENCY"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 4 {
			return errors.New("GOODFORK_UPLOAD_CONCURRENCY must be between 1 and 4")
		}
		config.UploadConcurrency = value
	}
	if config.WebOrigin != "" && !validWebOrigin(config.WebOrigin, local) {
		return errors.New("WEB_ORIGIN must be an HTTPS origin without a path. Local development permits HTTP loopback.")
	}
	config.Budgets = goodfork.DefaultBudgets()
	for action := range config.Budgets {
		key := "GOODFORK_LIMIT_" + strings.ToUpper(action)
		if raw := os.Getenv(key); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 || value > 10000 {
				return fmt.Errorf("%s must be between 1 and 10000", key)
			}
			config.Budgets[action] = value
		}
	}
	dining, err := assistProvider("AI_DINING")
	if err != nil {
		return err
	}
	if dining != nil {
		config.DiningProvider = dining
	}
	reply, err := assistProvider("AI_REPLY")
	if err != nil {
		return err
	}
	if reply != nil {
		config.ReplyProvider = reply
	}
	mailConfig := goodfork.SMTP{
		Host: os.Getenv("SMTP_HOST"), Port: os.Getenv("SMTP_PORT"), User: os.Getenv("SMTP_USER"),
		Password: os.Getenv("SMTP_PASSWORD"), From: os.Getenv("SMTP_FROM"),
	}
	if mailConfig.Port == "" {
		mailConfig.Port = "587"
	}
	if mailConfig.Host != "" {
		if sender, err := mail.ParseAddress(mailConfig.From); err != nil || sender.Address != mailConfig.From ||
			mailConfig.User == "" || mailConfig.Password == "" {
			return errors.New("set SMTP_FROM, SMTP_USER and SMTP_PASSWORD for the configured SMTP relay")
		}
		config.Mailer = mailConfig
	} else if local {
		config.Mailer = goodfork.LocalMail{Log: log}
	} else {
		return errors.New("set SMTP_HOST to enable email verification through an authenticated STARTTLS relay")
	}
	googleClientID := os.Getenv("GOOGLE_CLIENT_ID")
	googleSecret := os.Getenv("GOOGLE_CLIENT_SECRET")
	googleRedirect := os.Getenv("GOOGLE_REDIRECT_URL")
	if googleClientID != "" || googleSecret != "" || googleRedirect != "" {
		callback, parseErr := url.Parse(googleRedirect)
		if googleClientID == "" || googleSecret == "" || parseErr != nil || !webAddress(googleRedirect) ||
			callback.EscapedPath() != "/v1/auth/google/callback" || callback.RawQuery != "" || callback.ForceQuery {
			return errors.New("set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the HTTPS /v1/auth/google/callback URL")
		}
		config.Google = goodfork.NewGoogleOAuth(googleClientID, googleSecret, googleRedirect)
	}
	if !local {
		if _, err := mail.ParseAddress(config.SupportEmail); err != nil || !webAddress(config.PrivacyURL) || !webAddress(config.TermsURL) {
			return errors.New("set SUPPORT_EMAIL, HTTPS PRIVACY_URL and HTTPS TERMS_URL before serving")
		}
		if strings.TrimSpace(os.Getenv("BLOCKED_TERMS")) == "" {
			return errors.New("set BLOCKED_TERMS to the comma-separated terms screened by your moderation policy")
		}
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := net.JoinHostPort("", port)
	if local {
		addr = net.JoinHostPort("127.0.0.1", port)
	}
	srv := &http.Server{
		BaseContext: func(net.Listener) context.Context { return ctx },
		Addr:        addr, Handler: goodfork.NewAPI(db, store, config, log),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 55 * time.Second,
		WriteTimeout: 65 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 32 << 10,
	}
	done := make(chan error, 1)
	go func() {
		log.Info("goodfork listening", "address", addr)
		done <- srv.ListenAndServe()
	}()
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, stopShutdown := context.WithTimeout(context.Background(), 8*time.Second)
		defer stopShutdown()
		return srv.Shutdown(shutdown)
	}
	return nil
}

func webAddress(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" && u.Opaque == ""
}

func validWebOrigin(value string, local bool) bool {
	u, err := url.Parse(value)
	if err != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.User != nil || u.Hostname() == "" || u.Opaque != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	host := u.Hostname()
	return local && u.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
}

func assistProvider(prefix string) (*goodfork.HTTPAssist, error) {
	endpoint, model, token := os.Getenv(prefix+"_URL"), os.Getenv(prefix+"_MODEL"), os.Getenv(prefix+"_TOKEN")
	if endpoint == "" && model == "" && token == "" {
		return nil, nil
	}
	provider, err := goodfork.NewHTTPAssist(endpoint, model, token)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", prefix, err)
	}
	return provider, nil
}
