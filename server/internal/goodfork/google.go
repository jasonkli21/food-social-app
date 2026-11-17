package goodfork

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"
)

type GoogleIdentity struct {
	Subject string
	Email   string
	Name    string
}

type GoogleIdentityProvider interface {
	AuthorizationURL(state, verifier, nonce string) string
	Verify(ctx context.Context, code, verifier, nonce string) (GoogleIdentity, error)
}

type GoogleOAuth struct{ conf oauth2.Config }

func NewGoogleOAuth(clientID, secret, redirect string) *GoogleOAuth {
	return &GoogleOAuth{oauth2.Config{
		ClientID: clientID, ClientSecret: secret, RedirectURL: redirect, Endpoint: google.Endpoint,
		Scopes: []string{"openid", "email", "profile"},
	}}
}

func (g *GoogleOAuth) AuthorizationURL(state, verifier, nonce string) string {
	return g.conf.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier),
		oauth2.SetAuthURLParam("nonce", nonce), oauth2.SetAuthURLParam("prompt", "select_account"))
}

func (g *GoogleOAuth) Verify(ctx context.Context, code, verifier, nonce string) (GoogleIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	token, err := g.conf.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return GoogleIdentity{}, err
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok || raw == "" {
		return GoogleIdentity{}, errors.New("Google did not return an ID token")
	}
	payload, err := idtoken.Validate(ctx, raw, g.conf.ClientID)
	if err != nil {
		return GoogleIdentity{}, err
	}
	emailClaim, _ := payload.Claims["email"].(string)
	verified, _ := payload.Claims["email_verified"].(bool)
	tokenNonce, _ := payload.Claims["nonce"].(string)
	hosted, _ := payload.Claims["hd"].(string)
	name, _ := payload.Claims["name"].(string)
	email, accepted := accountEmail(emailClaim)
	// Google establishes authoritative email ownership for Gmail and signed Workspace-domain accounts.
	if !accepted || !verified || (!strings.HasSuffix(email, "@gmail.com") && hosted == "") ||
		(payload.Issuer != "https://accounts.google.com" && payload.Issuer != "accounts.google.com") ||
		payload.Subject == "" || subtle.ConstantTimeCompare([]byte(tokenNonce), []byte(nonce)) != 1 {
		return GoogleIdentity{}, errors.New("Google identity could not be verified")
	}
	return GoogleIdentity{Subject: payload.Subject, Email: email, Name: name}, nil
}

type browserChallenge struct {
	Challenge string `json:"challenge"`
	Target    string `json:"target"`
}

func (a *API) googleChallenge(request browserChallenge) ([]byte, error) {
	if a.config.Google == nil {
		return nil, notFound
	}
	challenge, err := hex.DecodeString(request.Challenge)
	if err != nil || len(challenge) != 32 ||
		(request.Target != "native" && !(request.Target == "web" && a.config.WebOrigin != "")) {
		return nil, invalid("Google sign-in could not start. Return to Goodfork and try again.")
	}
	return challenge, nil
}

func (a *API) newGoogleFlow(ctx context.Context, challenge []byte, target string, session []byte) (string, error) {
	state, verifier, nonce := secret(32), secret(32), secret(24)
	if _, err := a.db.Exec(ctx, `
		INSERT INTO google_flows(state_hash,device_challenge,provider_verifier,nonce,target,link_session,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, digest(state), challenge, verifier, nonce, target, session); err != nil {
		return "", err
	}
	return a.config.Google.AuthorizationURL(state, verifier, nonce), nil
}

func (a *API) startGoogle(w http.ResponseWriter, r *http.Request, _ string) error {
	q := r.URL.Query()
	if q.Get("agreed") != "1" {
		return invalid("Agree to the terms before continuing with Google.")
	}
	request := browserChallenge{Challenge: q.Get("challenge"), Target: q.Get("target")}
	challenge, err := a.googleChallenge(request)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.budget(ctx, "google_start"); err != nil {
		return err
	}
	if err := a.limit(ctx, privateKey("google", hex.EncodeToString(challenge)), 5, time.Hour); err != nil {
		return err
	}
	location, err := a.newGoogleFlow(ctx, challenge, request.Target, nil)
	if err != nil {
		return err
	}
	http.Redirect(w, r, location, http.StatusSeeOther)
	return nil
}

func (a *API) startGoogleLink(w http.ResponseWriter, r *http.Request, viewer string) error {
	var request struct {
		browserChallenge
		Password string `json:"password"`
	}
	if err := decode(w, r, &request); err != nil {
		return err
	}
	challenge, err := a.googleChallenge(request.browserChallenge)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.budget(ctx, "google_start"); err != nil {
		return err
	}
	if err := a.limit(ctx, "google_link:"+viewer, 6, time.Hour); err != nil {
		return err
	}
	badPassword := invalid("Confirm your Goodfork password to connect Google.")
	if !passwordOK(request.Password) {
		return badPassword
	}
	var hash, salt []byte
	var linked bool
	err = a.db.QueryRow(ctx, `
		SELECT password_hash,password_salt,google_subject IS NOT NULL FROM people WHERE id=$1 AND email IS NOT NULL`, viewer).Scan(&hash, &salt, &linked)
	if err != nil {
		return err
	}
	if linked {
		return conflict("Google is already connected to this account.")
	}
	if len(hash) == 0 {
		return badPassword
	}
	check, err := a.password(ctx, request.Password, salt)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(check, hash) != 1 {
		return badPassword
	}
	session := digest(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	location, err := a.newGoogleFlow(ctx, challenge, request.Target, session)
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, map[string]string{"authorizationURL": location})
}

func (a *API) finishGoogleProvider(w http.ResponseWriter, r *http.Request, _ string) error {
	if a.config.Google == nil {
		return notFound
	}
	ctx := r.Context()
	query := r.URL.Query()
	state := query.Get("state")
	expired := invalid("This sign-in link expired. Return to Goodfork and try again.")
	if len(state) != 43 {
		return expired
	}
	if err := a.budget(ctx, "google_finish"); err != nil {
		return err
	}
	var verifier, nonce, target string
	var challenge, linkSession []byte
	err := a.db.QueryRow(ctx, `
		DELETE FROM google_flows WHERE state_hash=$1 AND expires_at>now()
		RETURNING device_challenge,provider_verifier,nonce,target,link_session`, digest(state)).Scan(&challenge, &verifier, &nonce, &target, &linkSession)
	if errors.Is(err, pgx.ErrNoRows) {
		return expired
	}
	if err != nil {
		return err
	}
	redirect := "goodfork://auth/google"
	if target == "web" {
		redirect = strings.TrimRight(a.config.WebOrigin, "/") + "/auth/google"
	}
	fail := func(code string) error {
		http.Redirect(w, r, redirect+"?error="+code, http.StatusSeeOther)
		return nil
	}
	code := query.Get("code")
	if query.Has("error") {
		return fail("canceled")
	}
	if code == "" || len(code) > 2048 {
		return fail("sign_in_failed")
	}
	identity, err := a.config.Google.Verify(ctx, code, verifier, nonce)
	if err != nil {
		a.log.Warn("Google verification did not complete")
		return fail("sign_in_failed")
	}
	name, err := tidy(identity.Name, 1, 48, "Name")
	if err != nil || a.filter(name) != nil {
		name = "Goodfork diner"
	}
	handoff := secret(32)
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if linkSession != nil {
			var id string
			err := tx.QueryRow(ctx, `
				SELECT p.id::text FROM people p JOIN sessions s ON s.person_id=p.id
				WHERE s.token_hash=$1 AND s.expires_at>now() AND p.email=$2 AND p.google_subject IS NULL`,
				linkSession, identity.Email).Scan(&id)
			if errors.Is(err, pgx.ErrNoRows) {
				return errGoogleLink
			}
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `
				INSERT INTO google_handoffs(code_hash,device_challenge,person_id,link_session,link_subject,link_email,expires_at)
				VALUES ($1,$2,$3,$4,$5,$6,now()+interval '90 seconds')`,
				digest(handoff), challenge, id, linkSession, identity.Subject, identity.Email)
			return err
		}
		id, err := googlePerson(ctx, tx, identity, name)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO google_handoffs(code_hash,device_challenge,person_id,expires_at)
			VALUES ($1,$2,$3,now()+interval '90 seconds')`, digest(handoff), challenge, id)
		return err
	})
	if errors.Is(err, errGoogleCollision) {
		return fail("account_exists")
	}
	if errors.Is(err, errGoogleLink) {
		return fail("link_mismatch")
	}
	if err != nil {
		a.log.Warn("Google account could not be resolved")
		return fail("sign_in_failed")
	}
	http.Redirect(w, r, redirect+"?code="+url.QueryEscape(handoff), http.StatusSeeOther)
	return nil
}

var (
	errGoogleCollision = errors.New("google email matches an existing account")
	errGoogleLink      = errors.New("google verification does not match the linking session")
)

func googlePerson(ctx context.Context, tx pgx.Tx, value GoogleIdentity, name string) (string, error) {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text,67))", value.Email); err != nil {
		return "", err
	}
	var id string
	err := tx.QueryRow(ctx, "SELECT id::text FROM people WHERE google_subject=$1", value.Subject).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	handle := "diner_" + hex.EncodeToString(digest(secret(20)))[:12]
	err = tx.QueryRow(ctx, `
		INSERT INTO people(email,handle,name,password_hash,password_salt,recovery_hash,google_subject)
		VALUES ($1,$2,$3,$4,$4,$4,$5) ON CONFLICT DO NOTHING RETURNING id::text`, value.Email, handle, name, []byte{}, value.Subject).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errGoogleCollision
	}
	return id, err
}

type googleHandoff struct {
	Code     string `json:"code"`
	Verifier string `json:"verifier"`
}

func parseGoogleHandoff(w http.ResponseWriter, r *http.Request) (googleHandoff, error) {
	var body googleHandoff
	if err := decode(w, r, &body); err != nil {
		return body, err
	}
	if len(body.Code) != 43 || len(body.Verifier) < 43 || len(body.Verifier) > 128 {
		return body, invalid("Google sign-in expired. Try again.")
	}
	return body, nil
}

func (a *API) finishGoogleDevice(w http.ResponseWriter, r *http.Request, _ string) error {
	if a.config.Google == nil {
		return notFound
	}
	body, err := parseGoogleHandoff(w, r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.budget(ctx, "google_finish"); err != nil {
		return err
	}
	var token string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var person string
		err := tx.QueryRow(ctx, `
			DELETE FROM google_handoffs WHERE code_hash=$1 AND device_challenge=$2 AND expires_at>now() AND link_session IS NULL
			RETURNING person_id::text`, digest(body.Code), digest(body.Verifier)).Scan(&person)
		if errors.Is(err, pgx.ErrNoRows) {
			return invalid("Google sign-in expired. Try again.")
		}
		if err != nil {
			return err
		}
		token, err = issueSession(ctx, tx, person)
		return err
	})
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, map[string]string{"token": token})
}

func (a *API) finishGoogleLink(w http.ResponseWriter, r *http.Request, viewer string) error {
	if a.config.Google == nil {
		return notFound
	}
	body, err := parseGoogleHandoff(w, r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.budget(ctx, "google_finish"); err != nil {
		return err
	}
	session := digest(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		// Match the password-reset lock order. A revoked session cannot finish a link.
		var locked string
		if err := tx.QueryRow(ctx, "SELECT id::text FROM people WHERE id=$1 FOR UPDATE", viewer).Scan(&locked); err != nil {
			return err
		}
		var subject, email string
		err := tx.QueryRow(ctx, `
			DELETE FROM google_handoffs h USING sessions s
			WHERE h.code_hash=$1 AND h.device_challenge=$2 AND h.expires_at>now() AND h.link_session=$3
				AND s.token_hash=h.link_session AND s.person_id=h.person_id AND h.person_id=$4 AND s.expires_at>now()
			RETURNING h.link_subject,h.link_email`, digest(body.Code), digest(body.Verifier), session, viewer).Scan(&subject, &email)
		if errors.Is(err, pgx.ErrNoRows) {
			return invalid("This Google connection expired. Start again from Settings.")
		}
		if err != nil {
			return err
		}
		res, err := tx.Exec(ctx, `
			UPDATE people SET google_subject=$2 WHERE id=$1 AND email=$3 AND google_subject IS NULL AND octet_length(password_hash)>0`,
			viewer, subject, email)
		if unique(err) {
			return conflict("That Google account is already connected.")
		}
		if err != nil {
			return err
		}
		if res.RowsAffected() != 1 {
			return conflict("Your account changed. Open Settings and try again.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
