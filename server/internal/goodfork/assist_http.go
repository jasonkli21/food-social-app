package goodfork

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// HTTPAssist uses one narrow JSON protocol for model gateways. Operator configuration controls routing.
type HTTPAssist struct {
	endpoint, model, token string
	client                 *http.Client
	pausedUntil            atomic.Int64
}

func NewHTTPAssist(endpoint, model, token string) (*HTTPAssist, error) {
	location, err := url.Parse(endpoint)
	if err != nil || location.Scheme != "https" || location.Hostname() == "" || location.User != nil ||
		location.RawQuery != "" || location.Fragment != "" || location.Opaque != "" ||
		strings.TrimSpace(model) == "" || len(model) > 128 {
		return nil, errors.New("configure an HTTPS assist endpoint and a model identifier")
	}
	return &HTTPAssist{endpoint: location.String(), model: model, token: token, client: &http.Client{
		Timeout:       2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (h *HTTPAssist) InterpretDiningIntent(ctx context.Context, data diningSignals) (diningChoice, error) {
	var result diningChoice
	err := h.call(ctx, "dining", data, &result)
	if err == nil && !validDiningChoice(data, result) {
		h.cooldown()
		return diningChoice{}, errors.New("provider returned an unsupported dining selection")
	}
	return result, err
}

func (h *HTTPAssist) DraftOwnerReply(ctx context.Context, data replySignals) (replyChoice, error) {
	var result replyChoice
	err := h.call(ctx, "owner_reply", data, &result)
	if err == nil && !validReplyChoice(data, result) {
		h.cooldown()
		return replyChoice{}, errors.New("provider returned an unsupported response plan")
	}
	return result, err
}

func (h *HTTPAssist) cooldown() {
	h.pausedUntil.Store(time.Now().Add(30 * time.Second).UnixNano())
}

func (h *HTTPAssist) call(ctx context.Context, operation string, input, output any) error {
	if time.Now().UnixNano() < h.pausedUntil.Load() {
		return errors.New("assist provider cooling down")
	}
	request, err := json.Marshal(struct {
		Operation string `json:"operation"`
		Model     string `json:"model"`
		Input     any    `json:"input"`
	}{operation, h.model, input})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint, bytes.NewReader(request))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		h.cooldown()
		return errors.New("assist provider transport did not complete")
	}
	defer resp.Body.Close()
	const responseLimit = 8192
	ctype, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if resp.StatusCode != http.StatusOK || ctype != "application/json" {
		h.cooldown()
		return errors.New("assist provider returned an unavailable response")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil || len(body) > responseLimit {
		h.cooldown()
		return errors.New("assist provider response exceeded the contract")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil || decoder.Decode(new(any)) != io.EOF {
		h.cooldown()
		return errors.New("assist provider response was invalid")
	}
	return nil
}
