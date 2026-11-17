package goodfork

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"time"
)

type Mailer interface {
	SendVerification(context.Context, string, string) error
}

type SMTP struct {
	Host, Port, User, Password, From string
}

func (s SMTP) SendVerification(ctx context.Context, email, code string) error {
	addr := net.JoinHostPort(s.Host, s.Port)
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline := time.Now().Add(12 * time.Second)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	client, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.StartTLS(&tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}); err != nil {
		return err
	}
	if err := client.Auth(smtp.PlainAuth("", s.User, s.Password, s.Host)); err != nil {
		return err
	}
	if err := client.Mail(s.From); err != nil {
		return err
	}
	if err := client.Rcpt(email); err != nil {
		return err
	}
	body, err := client.Data()
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(body, "From: Goodfork <%s>\r\nTo: %s\r\nSubject: Verify your Goodfork account\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour Goodfork verification code is %s. It expires in 15 minutes.\r\n", s.From, email, code)
	if err != nil {
		return err
	}
	// Closing DATA is the acknowledgement that the relay queued the message.
	return body.Close()
}

type LocalMail struct{ Log *slog.Logger }

func (m LocalMail) SendVerification(_ context.Context, _ string, code string) error {
	m.Log.Info("local email verification", "code", code)
	return nil
}
