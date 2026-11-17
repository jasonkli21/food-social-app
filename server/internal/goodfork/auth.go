package goodfork

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var validHandle = regexp.MustCompile(`^[a-z0-9_]{3,24}$`)

const sessionDuration = 30 * 24 * time.Hour

type credentials struct {
	Email        string `json:"email"`
	Handle       string `json:"handle"`
	Password     string `json:"password"`
	Name         string `json:"name,omitempty"`
	RecoveryCode string `json:"recoveryCode,omitempty"`
	Agreed       bool   `json:"agreed,omitempty"`
}

func normalizeHandle(handle string) string {
	return strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(handle), "@")))
}

func accountEmail(value string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(email)
	return email, err == nil && parsed.Address == email && len(email) <= 254
}

func privateKey(label, value string) string {
	return label + ":" + hex.EncodeToString(digest(value))
}

func passwordOK(password string) bool { return len(password) >= 12 && len(password) <= 128 }

func (a *API) password(ctx context.Context, password string, salt []byte) ([]byte, error) {
	select {
	case a.passwords <- struct{}{}:
		defer func() { <-a.passwords }()
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, slowDown
	}
	return pbkdf2.Key(sha256.New, password, salt, 600000, 32)
}

func digest(secret string) []byte {
	hash := sha256.Sum256([]byte(secret))
	return hash[:]
}

func secret(size int) string {
	data := make([]byte, size)
	rand.Read(data)
	return base64.RawURLEncoding.EncodeToString(data)
}

func issueSession(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	token := secret(32)
	_, err := tx.Exec(ctx, "INSERT INTO sessions (token_hash, person_id, expires_at) VALUES ($1,$2,$3)",
		digest(token), id, time.Now().Add(sessionDuration))
	return token, err
}

func (a *API) resolveSession(ctx context.Context, raw string) (string, error) {
	token, ok := strings.CutPrefix(raw, "Bearer ")
	if !ok || len(token) != 43 {
		return "", signIn
	}
	var id string
	err := a.db.QueryRow(ctx, "SELECT person_id::text FROM sessions WHERE token_hash=$1 AND expires_at > now()", digest(token)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", signIn
	}
	return id, err
}

func (a *API) register(w http.ResponseWriter, r *http.Request, _ string) error {
	var body credentials
	if err := decode(w, r, &body); err != nil {
		return err
	}
	email, accepted := accountEmail(body.Email)
	if !accepted {
		return invalid("Enter a valid email address.")
	}
	handle := normalizeHandle(body.Handle)
	if !validHandle.MatchString(handle) {
		return invalid("Use 3–24 letters, numbers, or underscores for your handle.")
	}
	if !passwordOK(body.Password) {
		return invalid("Use a password of at least 12 characters and up to 128 bytes.")
	}
	if !body.Agreed {
		return invalid("Agree to the terms and community guidelines to create an account.")
	}
	name, err := tidy(body.Name, 1, 48, "Name")
	if err != nil {
		return err
	}
	if err := a.filter(handle + " " + name); err != nil {
		return err
	}
	ctx := r.Context()
	if a.config.Mailer == nil {
		return apiError{http.StatusServiceUnavailable, "Account signup is temporarily unavailable."}
	}
	if err := a.budget(ctx, "signup"); err != nil {
		return err
	}
	if err := a.emailBudget(ctx, email); err != nil {
		return err
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	hash, err := a.password(ctx, body.Password, salt)
	if err != nil {
		return err
	}
	registration := secret(32)
	code, err := verificationCode()
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx, `
		INSERT INTO registrations (id_hash,email,handle,name,password_hash,password_salt,code_hash,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes')`,
		digest(registration), email, handle, name, hash, salt, digest(registration+":"+code))
	if err != nil {
		return err
	}
	if err := a.deliverCode(ctx, email, code); err != nil {
		return err
	}
	return send(w, http.StatusAccepted, map[string]string{"registrationId": registration})
}

func verificationCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(100000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%08d", n.Int64()), nil
}

func (a *API) resendVerification(w http.ResponseWriter, r *http.Request, _ string) error {
	var body struct {
		RegistrationID string `json:"registrationId"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	expired := invalid("This signup expired. Return to signup to request a new code.")
	if len(body.RegistrationID) != 43 {
		return expired
	}
	if a.config.Mailer == nil {
		return apiError{http.StatusServiceUnavailable, "Account signup is temporarily unavailable."}
	}
	ctx := r.Context()
	if err := a.budget(ctx, "signup"); err != nil {
		return err
	}
	key := digest(body.RegistrationID)
	var email string
	var issuedAt time.Time
	err := a.db.QueryRow(ctx, "SELECT email,issued_at FROM registrations WHERE id_hash=$1 AND expires_at>now()", key).Scan(&email, &issuedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return expired
	}
	if err != nil {
		return err
	}
	availableAt := issuedAt.Add(30 * time.Second)
	if time.Now().Before(availableAt) {
		return throttled{availableAt}
	}
	if err := a.limit(ctx, privateKey("resend", body.RegistrationID), 3, time.Hour); err != nil {
		return err
	}
	if err := a.emailBudget(ctx, email); err != nil {
		return err
	}
	code, err := verificationCode()
	if err != nil {
		return err
	}
	res, err := a.db.Exec(ctx, `
		UPDATE registrations SET code_hash=$2,issued_at=now(),expires_at=now()+interval '15 minutes'
		WHERE id_hash=$1 AND expires_at>now() AND issued_at=$3`, key, digest(body.RegistrationID+":"+code), issuedAt)
	if err != nil {
		return err
	}
	if res.RowsAffected() != 1 {
		return expired
	}
	if err := a.deliverCode(ctx, email, code); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) verifyEmail(w http.ResponseWriter, r *http.Request, _ string) error {
	var body struct {
		RegistrationID string `json:"registrationId"`
		Code           string `json:"code"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	body.Code = strings.TrimSpace(body.Code)
	badCode := invalid("Check your verification code or request a new one.")
	if len(body.RegistrationID) != 43 || len(body.Code) != 8 {
		return badCode
	}
	ctx := r.Context()
	if err := a.budget(ctx, "verify"); err != nil {
		return err
	}
	if err := a.limit(ctx, privateKey("verify", body.RegistrationID), 8, 15*time.Minute); err != nil {
		return err
	}
	recovery := secret(18)
	var token string
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var email, name, handle, person string
		var password, salt []byte
		err := tx.QueryRow(ctx, `
			DELETE FROM registrations WHERE id_hash=$1 AND code_hash=$2 AND expires_at>now()
			RETURNING email,handle,name,password_hash,password_salt`,
			digest(body.RegistrationID), digest(body.RegistrationID+":"+body.Code)).
			Scan(&email, &handle, &name, &password, &salt)
		if errors.Is(err, pgx.ErrNoRows) {
			return badCode
		}
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO people (email,handle,name,password_hash,password_salt,recovery_hash)
			VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`, email, handle, name, password, salt, digest(recovery)).Scan(&person); err != nil {
			return err
		}
		token, err = issueSession(ctx, tx, person)
		return err
	})
	if unique(err) {
		return conflict("That email or handle is already in use. Sign in or choose a different handle.")
	}
	if err != nil {
		return err
	}
	return send(w, http.StatusCreated, map[string]string{"token": token, "recoveryCode": recovery})
}

func (a *API) login(w http.ResponseWriter, r *http.Request, _ string) error {
	var body credentials
	if err := decode(w, r, &body); err != nil {
		return err
	}
	email, ok := accountEmail(body.Email)
	badLogin := apiError{http.StatusUnauthorized, "Check your email and password."}
	if !ok || !passwordOK(body.Password) {
		return badLogin
	}
	ctx := r.Context()
	if err := a.budget(ctx, "login"); err != nil {
		return err
	}
	if err := a.limit(ctx, privateKey("login", email), 10, 10*time.Minute); err != nil {
		return err
	}
	var id string
	var hash, salt []byte
	err := a.db.QueryRow(ctx, "SELECT id::text,password_hash,password_salt FROM people WHERE email=$1 AND octet_length(password_hash)>0", email).Scan(&id, &hash, &salt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if id == "" {
		hash, salt = make([]byte, 32), make([]byte, 16)
	}
	check, err := a.password(ctx, body.Password, salt)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(check, hash) != 1 || id == "" {
		return badLogin
	}
	var token string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		// Avoid minting a session from an old password if it changed during verification.
		var current []byte
		if err := tx.QueryRow(ctx, "SELECT password_hash FROM people WHERE id=$1 FOR UPDATE", id).Scan(&current); err != nil {
			return err
		}
		if subtle.ConstantTimeCompare(hash, current) != 1 {
			return badLogin
		}
		token, err = issueSession(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, map[string]string{"token": token})
}

func (a *API) recoverAccount(w http.ResponseWriter, r *http.Request, _ string) error {
	var body credentials
	if err := decode(w, r, &body); err != nil {
		return err
	}
	email, ok := accountEmail(body.Email)
	code := strings.TrimSpace(body.RecoveryCode)
	badCode := apiError{http.StatusUnauthorized, "Check your email and recovery code."}
	if !ok || len(code) != 24 {
		return badCode
	}
	if !passwordOK(body.Password) {
		return invalid("Use a password of at least 12 characters and up to 128 bytes.")
	}
	ctx := r.Context()
	if err := a.budget(ctx, "recover"); err != nil {
		return err
	}
	if err := a.limit(ctx, privateKey("recover", email), 5, time.Hour); err != nil {
		return err
	}
	var matches bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM people WHERE email=$1 AND recovery_hash=$2)`,
		email, digest(code)).Scan(&matches); err != nil {
		return err
	}
	if !matches {
		return badCode
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	hash, err := a.password(ctx, body.Password, salt)
	if err != nil {
		return err
	}
	recovery := secret(18)
	var token string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var id string
		err := tx.QueryRow(ctx, `
			UPDATE people SET password_hash=$1,password_salt=$2,recovery_hash=$3
			WHERE email=$4 AND recovery_hash=$5 RETURNING id::text`, hash, salt, digest(recovery), email, digest(code)).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return badCode
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "DELETE FROM sessions WHERE person_id=$1", id); err != nil {
			return err
		}
		token, err = issueSession(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, map[string]string{"token": token, "recoveryCode": recovery})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request, _ string) error {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if _, err := a.db.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", digest(token)); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) deleteAccount(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Password string `json:"password"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.limit(ctx, "delete:"+viewer, 6, 10*time.Minute); err != nil {
		return err
	}
	var hash, salt []byte
	if err := a.db.QueryRow(ctx, "SELECT password_hash,password_salt FROM people WHERE id=$1", viewer).Scan(&hash, &salt); err != nil {
		return err
	}
	if len(hash) == 0 {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		res, err := a.db.Exec(ctx, `
			DELETE FROM people p USING sessions s WHERE p.id=$1 AND s.person_id=p.id AND s.token_hash=$2
			  AND s.created_at>now()-interval '10 minutes' AND s.expires_at>now()
			  AND p.google_subject IS NOT NULL AND octet_length(p.password_hash)=0`, viewer, digest(token))
		if err != nil {
			return err
		}
		if res.RowsAffected() != 1 {
			return invalid("Sign out and sign in with Google again to confirm your identity.")
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	wrongPassword := invalid("Check your password and try again.")
	if !passwordOK(body.Password) {
		return wrongPassword
	}
	check, err := a.password(ctx, body.Password, salt)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(check, hash) != 1 {
		return wrongPassword
	}
	result, err := a.db.Exec(ctx, "DELETE FROM people WHERE id=$1 AND password_hash=$2", viewer, check)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return wrongPassword
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func unique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
