package goodfork

import (
	"bytes"
	"html/template"
	"net/http"
)

var sharedPage = template.Must(template.New("share").Parse(`<!DOCTYPE html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · Goodfork</title>
<meta property="og:title" content="{{.Title}} · Goodfork"><meta property="og:description" content="{{.Description}}">
<style>body{margin:0;padding:56px 24px;font:18px system-ui,sans-serif;color:#251e19;background:#f9f6ef}main{margin:auto;max-width:34rem}h1{font:3rem Georgia,serif;margin:22px 0}p{line-height:1.6;white-space:pre-wrap}a{display:inline-block;margin-top:12px;padding:12px 22px;color:inherit;text-decoration:none;font-weight:700;border-radius:999px;background:#f7cc57}</style>
<main><strong>Goodfork</strong><h1>{{.Title}}</h1><p>{{.Description}}</p><a href="{{.Link}}">Open in Goodfork</a></main></html>`))

func sharePage(w http.ResponseWriter, data sharedContent) error {
	var body bytes.Buffer
	doc := struct {
		Title, Description string
		Link               template.URL
	}{data.Title, data.Description, template.URL(data.Link)} // Link is a server-generated scheme and validated UUID.
	if err := sharedPage.Execute(&body, doc); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
	_, _ = w.Write(body.Bytes())
	return nil
}
