package goodfork

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Queue(ctx context.Context, db *pgxpool.Pool) ([]json.RawMessage, error) {
	pending, err := many(ctx, db, `
		SELECT jsonb_build_object('type','post','id',p.id,'author',a.handle,'place',d.name,
			'text',p.text,'objectId',p.object_id,'contentType',o.content_type,'submittedAt',p.created_at,'revision',p.revision)
		FROM posts p JOIN people a ON a.id=p.author_id JOIN places d ON d.id=p.place_id
		LEFT JOIN objects o ON o.id=p.object_id WHERE p.status='pending'
		ORDER BY p.created_at LIMIT 100`)
	if err != nil {
		return nil, err
	}
	places, err := many(ctx, db, `
		SELECT jsonb_build_object('type','place','id',p.id,'details',gf_place(p,null),'submittedAt',p.created_at)
		FROM places p WHERE p.status='pending' ORDER BY p.created_at LIMIT 100`)
	if err != nil {
		return nil, err
	}
	reports, err := many(ctx, db, `
		SELECT jsonb_build_object('type','report','id',r.id,'targetType',r.target_type,'targetId',r.target_id,
			'reason',r.reason,'submittedAt',r.created_at,'revision',r.target_version,
			'legacyEvidence',r.content_evidence IS NULL AND r.reply_evidence IS NULL,
			'currentRevision',CASE r.target_type WHEN 'post' THEN (SELECT p.revision::text FROM posts p WHERE p.id=r.target_id)
			WHEN 'place' THEN (SELECT p.listing_revision::text FROM places p WHERE p.id=r.target_id) END,
			'content',coalesce(r.content_evidence,to_jsonb(r.reply_evidence),CASE r.target_type
				WHEN 'post' THEN (SELECT jsonb_build_object('text',p.text,'status',p.status,'objectId',p.object_id)
					FROM posts p WHERE p.id=r.target_id)
				WHEN 'reply' THEN to_jsonb(r.reply_evidence)
				WHEN 'comment' THEN (SELECT to_jsonb(c.text) FROM comments c WHERE c.id=r.target_id)
				WHEN 'person' THEN (SELECT jsonb_build_object('name',p.name,'bio',p.bio,'handle',p.handle) FROM people p WHERE p.id=r.target_id)
				WHEN 'place' THEN (SELECT gf_place(p,null) FROM places p WHERE p.id=r.target_id) END))
		FROM reports r WHERE r.resolved_at IS NULL ORDER BY r.created_at LIMIT 100`)
	if err != nil {
		return nil, err
	}
	claims, err := many(ctx, db, `
		SELECT jsonb_build_object('type','claim','id',c.id,'placeId',p.id,'restaurant',p.name,'website',p.website,
			'phone',p.phone,'address',p.address,'applicant',a.handle,'email',c.email,'role',c.role,'submittedAt',c.updated_at,'revision',c.revision)
		FROM restaurant_claims c JOIN places p ON p.id=c.place_id JOIN people a ON a.id=c.person_id
		WHERE c.status='pending' AND p.status='published' ORDER BY c.updated_at LIMIT 100`)
	if err != nil {
		return nil, err
	}
	return append(append(append(pending, places...), reports...), claims...), nil
}

type actorKey string

const managerActorKey actorKey = "manager"
const operatorActorKey actorKey = "operator"

func WithOperatorPrincipal(ctx context.Context, principal string) context.Context {
	return context.WithValue(ctx, operatorActorKey, principal)
}

func audit(ctx context.Context, tx pgx.Tx, actor, action, id, version string) error {
	var person any
	principal, _ := ctx.Value(operatorActorKey).(string)
	if actor == "restaurant_manager" {
		value, _ := ctx.Value(managerActorKey).(string)
		person = nullable(value)
		principal = "authenticated manager"
	}
	if principal == "" {
		if err := tx.QueryRow(ctx, "SELECT 'database:'||session_user").Scan(&principal); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, "INSERT INTO audit_events(actor_class,action,target_id,version,actor_person,actor_principal) VALUES ($1,$2,$3,$4,$5,$6)",
		actor, action, id, version, person, principal)
	return err
}

func AuditEvents(ctx context.Context, db *pgxpool.Pool) ([]json.RawMessage, error) {
	return many(ctx, db, `
		SELECT jsonb_build_object('actorClass',actor_class,'actorId',actor_person,'principal',actor_principal,'action',action,'targetId',target_id,'revision',version,'at',created_at)
		FROM audit_events ORDER BY created_at DESC,id DESC LIMIT 200`)
}

func Moderate(ctx context.Context, db *pgxpool.Pool, action, id string, versions ...string) error {
	if strings.HasPrefix(action, "hide-reported-") {
		return moderateReport(ctx, db, action, id)
	}
	if !uuid.MatchString(id) {
		return invalid("Enter a valid target ID.")
	}
	version := ""
	if len(versions) == 1 {
		version = versions[0]
	}
	switch action {
	case "approve-claim", "decline-claim", "revoke-owner":
		return moderateOwnership(ctx, db, action, id, version)
	}
	if (action == "publish-post" || action == "restore-post" || action == "remove-reply") && !uuid.MatchString(version) {
		return invalid("Pass the revision shown in the current queue entry or review.")
	}
	actions := map[string]struct {
		query  string
		target string
	}{
		"publish-post": {`UPDATE posts p SET status='published' FROM places d
			WHERE p.id=$1 AND p.revision=$2 AND p.status='pending' AND NOT p.ownership_conflict
			AND p.place_id=d.id AND d.status='published'
			AND NOT EXISTS(SELECT 1 FROM restaurant_owners o WHERE o.place_id=p.place_id AND o.person_id=p.author_id)`, "post"},
		"restore-post": {`UPDATE posts p SET status='published',ownership_conflict=false FROM places d
			WHERE p.id=$1 AND p.revision=$2 AND p.status='hidden'
			AND p.place_id=d.id AND d.status='published'
			AND NOT EXISTS(SELECT 1 FROM restaurant_owners o WHERE o.place_id=p.place_id AND o.person_id=p.author_id)`, "post"},
		"hide-post":      {"UPDATE posts SET status='hidden',revision=gen_random_uuid() WHERE id=$1", "post"},
		"publish-place":  {"UPDATE places SET status='published',listing_revision=listing_revision+1 WHERE id=$1 AND status<>'published'", "place"},
		"hide-place":     {"UPDATE places SET status='hidden',listing_revision=listing_revision+1 WHERE id=$1", "place"},
		"remove-reply":   {"DELETE FROM restaurant_replies WHERE post_id=$1 AND revision=$2", "reply"},
		"remove-comment": {"DELETE FROM comments WHERE id=$1", "comment"},
		"remove-person":  {"DELETE FROM people WHERE id=$1", "person"},
		"dismiss-report": {"UPDATE reports SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL", ""},
	}
	command, ok := actions[action]
	if !ok {
		return invalid("Unknown moderation action.")
	}
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if command.target == "post" || command.target == "reply" {
			if _, err := lockPostPlace(ctx, tx, id); err != nil {
				return err
			}
		}
		if command.target == "place" {
			if err := lockPlace(ctx, tx, id); err != nil {
				return err
			}
		}
		args := []any{id}
		actedVersion := version
		versionQueries := map[string]string{
			"post":    "SELECT revision::text FROM posts WHERE id=$1",
			"place":   "SELECT listing_revision::text FROM places WHERE id=$1",
			"comment": "SELECT id::text FROM comments WHERE id=$1",
			"person":  "SELECT md5(jsonb_build_array(name,handle,bio)::text) FROM people WHERE id=$1",
		}
		if actedVersion == "" && versionQueries[command.target] != "" {
			if err := tx.QueryRow(ctx, versionQueries[command.target], id).Scan(&actedVersion); err != nil {
				return err
			}
		}
		if action == "publish-post" || action == "restore-post" || action == "remove-reply" {
			args = append(args, version)
		}
		res, err := tx.Exec(ctx, command.query, args...)
		if err != nil {
			return err
		}
		if res.RowsAffected() == 0 && len(args) > 1 {
			return conflict("The item or its eligibility changed. Review its current version.")
		}
		if res.RowsAffected() == 0 {
			return notFound
		}
		if command.target != "" {
			_, err = tx.Exec(ctx, `
				UPDATE reports SET resolved_at=now() WHERE target_type=$1 AND target_id=$2 AND (target_version=$3 OR target_version='') AND resolved_at IS NULL`,
				command.target, id, actedVersion)
			if err != nil {
				return err
			}
		}
		return audit(ctx, tx, "operator", action, id, actedVersion)
	})
}

func DownloadMedia(ctx context.Context, store MediaStore, id string, dest io.Writer) error {
	if !uuid.MatchString(id) {
		return invalid("Enter a valid media object ID.")
	}
	source, err := store.Open(ctx, id, 0)
	if err != nil {
		return err
	}
	defer source.Close()
	_, err = io.Copy(dest, source)
	return err
}

func ClearExpired(ctx context.Context, db *pgxpool.Pool) error {
	_, err1 := db.Exec(ctx, "DELETE FROM sessions WHERE expires_at < now()")
	_, err2 := db.Exec(ctx, "DELETE FROM limits WHERE bucket < extract(epoch FROM now()-interval '2 days')")
	_, err3 := db.Exec(ctx, "DELETE FROM registrations WHERE expires_at<now()")
	_, err4 := db.Exec(ctx, "DELETE FROM google_flows WHERE expires_at<now()")
	_, err5 := db.Exec(ctx, "DELETE FROM google_handoffs WHERE expires_at<now()")
	_, err6 := db.Exec(ctx, "DELETE FROM reports WHERE created_at<now()-interval '90 days'")
	_, err7 := db.Exec(ctx, "DELETE FROM audit_events WHERE created_at<now()-interval '365 days'")
	return errors.Join(err1, err2, err3, err4, err5, err6, err7)
}
