package goodfork

import (
	"context"
	"errors"
	"math"
	"net/http"
	"time"
)

type throttled struct {
	until time.Time
}

func (t throttled) Error() string { return slowDown.message }
func (t throttled) Unwrap() error { return slowDown }

func retrySeconds(err error) int {
	var limit throttled
	if errors.As(err, &limit) {
		return max(1, int(math.Ceil(time.Until(limit.until).Seconds())))
	}
	if errors.Is(err, slowDown) {
		return 1
	}
	return 0
}

// DefaultBudgets are shared through Postgres. Identity-specific limits are applied separately.
func DefaultBudgets() map[string]int {
	return map[string]int{"signup": 24, "login": 120, "verify": 120, "recover": 24,
		"google_start": 60, "google_finish": 90, "mail": 120, "ai_local": 120, "ai_remote": 24}
}

func (a *API) budget(ctx context.Context, action string) error {
	period := time.Minute
	if action == "mail" {
		period = time.Hour
	}
	a.quotaMu.Lock()
	until := a.quotaClosed[action]
	a.quotaMu.Unlock()
	if time.Now().Before(until) {
		return throttled{until}
	}
	err := a.limit(ctx, "shared:"+action, a.config.Budgets[action], period)
	var limit throttled
	if errors.As(err, &limit) {
		a.quotaMu.Lock()
		a.quotaClosed[action] = limit.until
		a.quotaMu.Unlock()
	}
	return err
}

func (a *API) deliverCode(ctx context.Context, email, code string) error {
	if err := a.config.Mailer.SendVerification(ctx, email, code); err != nil {
		a.log.Warn("verification mail could not be queued")
		return apiError{http.StatusServiceUnavailable, "We could not send a verification code. Try again shortly."}
	}
	return nil
}

func (a *API) emailBudget(ctx context.Context, email string) error {
	if err := a.limit(ctx, privateKey("mail", email), 6, time.Hour); err != nil {
		return err
	}
	return a.budget(ctx, "mail")
}
