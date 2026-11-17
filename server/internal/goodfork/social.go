package goodfork

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *API) me(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.resource(w, r, "SELECT gf_person(p,$1) || jsonb_build_object('email',p.email,'hasPassword',octet_length(p.password_hash)>0,'googleLinked',p.google_subject IS NOT NULL) FROM people p WHERE id=$1", viewer)
}

func (a *API) editProfile(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Name string `json:"name"`
		Bio  string `json:"bio"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	name, err := tidy(body.Name, 1, 48, "Name")
	if err != nil {
		return err
	}
	bio, err := tidy(body.Bio, 0, 180, "Bio")
	if err != nil {
		return err
	}
	if err := a.filter(name + " " + bio); err != nil {
		return err
	}
	return a.resource(w, r, `
		WITH edited AS (UPDATE people SET name=$2,bio=$3 WHERE id=$1 RETURNING *)
		SELECT gf_person(edited,$1) FROM edited`, viewer, name, bio)
}

func (a *API) people(w http.ResponseWriter, r *http.Request, viewer string) error {
	search, err := tidy(r.URL.Query().Get("q"), 0, 80, "Search")
	if err != nil {
		return err
	}
	return a.list(w, r, `
		SELECT gf_person(p,$1) FROM people p
		WHERE p.id IS DISTINCT FROM $1 AND gf_visible($1,p.id)
		  AND strpos(lower(p.name || ' ' || p.handle),lower($2)) > 0
		ORDER BY (p.handle=lower($2)) DESC, p.created_at DESC,p.id`,
		nullable(viewer), strings.TrimPrefix(search, "@"))
}

func (a *API) person(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.resource(w, r, `SELECT gf_person(p,$1) FROM people p WHERE id=$2 AND gf_visible($1,p.id)`,
		nullable(viewer), r.PathValue("id"))
}

func (a *API) personReviews(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.list(w, r, `
		SELECT gf_post(p,d,a,$1) FROM posts p JOIN places d ON d.id=p.place_id JOIN people a ON a.id=p.author_id
		WHERE a.id=$2 AND d.status='published' AND (p.status='published' OR p.author_id=$1) AND gf_visible($1,p.author_id)
		ORDER BY p.created_at DESC,p.id DESC`, nullable(viewer), r.PathValue("id"))
}

func lockPair(ctx context.Context, tx pgx.Tx, a, b string) error {
	_, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended(least($1::text,$2::text)||':'||greatest($1::text,$2::text),0))`, a, b)
	return err
}

func (a *API) follow(w http.ResponseWriter, r *http.Request, viewer string) error {
	active, err := activeValue(w, r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	if id == viewer {
		return invalid("Choose another diner to follow.")
	}
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if err := lockPair(ctx, tx, viewer, id); err != nil {
			return err
		}
		if !active {
			_, err := tx.Exec(ctx, "DELETE FROM follows WHERE follower_id=$1 AND followed_id=$2", viewer, id)
			return err
		}
		var visible bool
		err := tx.QueryRow(ctx, `
			WITH added AS (
				INSERT INTO follows(follower_id,followed_id)
				SELECT $1,id FROM people WHERE id=$2 AND gf_visible($1,id) ON CONFLICT DO NOTHING
			)
			SELECT EXISTS(SELECT 1 FROM people WHERE id=$2 AND gf_visible($1,id))`, viewer, id).Scan(&visible)
		return existsResult(err, visible)
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) block(w http.ResponseWriter, r *http.Request, viewer string) error {
	active, err := activeValue(w, r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	if id == viewer {
		return invalid("Choose another diner to block.")
	}
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if err := lockPair(ctx, tx, viewer, id); err != nil {
			return err
		}
		if !active {
			_, err := tx.Exec(ctx, "DELETE FROM blocks WHERE person_id=$1 AND blocked_id=$2", viewer, id)
			return err
		}
		var target bool
		err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM people WHERE id=$1)", id).Scan(&target)
		if err := existsResult(err, target); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO blocks(person_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING", viewer, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "DELETE FROM follows WHERE (follower_id=$1 AND followed_id=$2) OR (follower_id=$2 AND followed_id=$1)", viewer, id)
		return err
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) blocked(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.list(w, r, `SELECT gf_person(p,$1) FROM blocks b JOIN people p ON p.id=b.blocked_id
		WHERE b.person_id=$1 ORDER BY b.created_at DESC,p.id`, viewer)
}

func (a *API) activity(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.list(w, r, `
		WITH events AS (
			SELECT 'follow:'||follower_id AS id, follower_id AS actor, 'follow' AS kind, null::uuid AS post_id, created_at
			FROM follows WHERE followed_id=$1
			UNION ALL
			SELECT 'like:'||l.person_id||':'||p.id, l.person_id, 'like', p.id, l.created_at
			FROM likes l JOIN posts p ON p.id=l.post_id JOIN places d ON d.id=p.place_id
			WHERE p.author_id=$1 AND p.status='published' AND d.status='published'
			UNION ALL
			SELECT 'comment:'||c.id, c.author_id, 'comment', p.id, c.created_at
			FROM comments c JOIN posts p ON p.id=c.post_id JOIN places d ON d.id=p.place_id
			WHERE p.author_id=$1 AND p.status='published' AND d.status='published'
		)
		SELECT jsonb_build_object('id',e.id,'actor',gf_person(p,$1),'kind',e.kind,
			'postId',e.post_id,'createdAt',e.created_at,'read',e.created_at<=m.activity_seen_at)
		FROM events e JOIN people p ON p.id=e.actor JOIN people m ON m.id=$1
		WHERE e.actor<>$1 AND gf_visible($1,e.actor)
		ORDER BY e.created_at DESC,e.id`, viewer)
}

func (a *API) readActivity(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Through time.Time `json:"through"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if body.Through.IsZero() {
		return invalid("Choose a valid activity date.")
	}
	if _, err := a.db.Exec(r.Context(), "UPDATE people SET activity_seen_at=greatest(activity_seen_at,least(now(),$2)) WHERE id=$1", viewer, body.Through); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) report(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		TargetType string `json:"targetType"`
		TargetID   string `json:"targetId"`
		Reason     string `json:"reason"`
		Revision   string `json:"revision,omitempty"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	reason, err := tidy(body.Reason, 3, 320, "Reason")
	if err != nil {
		return err
	}
	if !uuid.MatchString(body.TargetID) {
		return notFound
	}
	ctx := r.Context()
	if err := a.limit(ctx, "report:"+viewer, 12, time.Hour); err != nil {
		return err
	}
	if body.TargetType == "reply" {
		if !uuid.MatchString(body.Revision) {
			return invalid("Open the current restaurant response before reporting it.")
		}
		if err := a.reportReply(ctx, viewer, body.TargetID, body.Revision, reason); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	queries := map[string]string{
		"post": `SELECT p.revision::text,jsonb_build_object('text',p.text,'dish',p.dish,'score',p.score,'objectId',p.object_id),p.author_id::text FROM posts p JOIN places d ON d.id=p.place_id WHERE p.id=$1 AND p.author_id<>$2
			AND p.status='published' AND d.status='published' AND gf_visible($2,p.author_id)`,
		"comment": `SELECT c.id::text,jsonb_build_object('text',c.text),c.author_id::text FROM comments c JOIN posts p ON p.id=c.post_id JOIN places d ON d.id=p.place_id
			WHERE c.id=$1 AND c.author_id<>$2 AND p.status='published' AND d.status='published'
			AND gf_visible($2,c.author_id) AND gf_visible($2,p.author_id)`,
		"person": `SELECT md5(jsonb_build_array(name,handle,bio)::text),jsonb_build_object('name',name,'handle',handle,'bio',bio),id::text FROM people WHERE id=$1 AND id<>$2 AND gf_visible($2,id)`,
		"place": `SELECT p.listing_revision::text,jsonb_build_object('name',p.name,'description',p.description,'address',p.address,'hours',p.hours,'schedule',p.schedule,'phone',p.phone,'website',p.website,'menuURL',p.menu_url,'dietary',p.dietary,'price',p.price),
		    coalesce((SELECT o.person_id::text FROM restaurant_owners o WHERE o.place_id=p.id),p.submitted_by::text,'')
		    FROM places p WHERE p.id=$1 AND p.status='published' AND $2::uuid IS NOT NULL`,
	}
	query, ok := queries[body.TargetType]
	if !ok {
		return invalid("Choose an item to report.")
	}
	var version, author string
	var evidence json.RawMessage
	err = a.db.QueryRow(ctx, query, body.TargetID, viewer).Scan(&version, &evidence, &author)
	if err != nil {
		return err
	}
	if body.Revision != "" && body.Revision != version {
		return conflict("This content changed. Open its current version before reporting.")
	}
	res, err := a.db.Exec(ctx, `INSERT INTO reports(reporter_id,target_type,target_id,reason,target_version,content_evidence,evidence_author)
	    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`, viewer, body.TargetType, body.TargetID, reason, version, string(evidence), nullable(author))
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return conflict("You have already reported this version.")
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) reportReply(ctx context.Context, viewer, postID, version, reason string) error {
	return pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := lockPostPlace(ctx, tx, postID); err != nil {
			return err
		}
		var current, text, author string
		err := tx.QueryRow(ctx, `
			SELECT b.revision::text,b.text,b.author_id::text FROM restaurant_replies b
			JOIN posts p ON p.id=b.post_id JOIN places d ON d.id=p.place_id
			JOIN restaurant_owners o ON o.place_id=d.id AND o.person_id=b.author_id
			WHERE b.post_id=$1 AND b.author_id<>$2 AND p.status='published' AND d.status='published'
			AND gf_visible($2,b.author_id) AND gf_visible($2,p.author_id)`, postID, viewer).Scan(&current, &text, &author)
		if err != nil {
			return err
		}
		if current != version {
			return conflict("The restaurant response changed. Open the current version to report it.")
		}
		res, err := tx.Exec(ctx, `
			INSERT INTO reports(reporter_id,target_type,target_id,reason,target_version,reply_evidence,evidence_author)
			VALUES ($1,'reply',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, viewer, postID, reason, version, text, author)
		if err != nil {
			return err
		}
		if res.RowsAffected() == 0 {
			return conflict("You have already reported this response.")
		}
		return nil
	})
}

func (a *API) comments(w http.ResponseWriter, r *http.Request, viewer string) error {
	id := r.PathValue("id")
	return a.list(w, r, `
		SELECT gf_comment(c,a,$1) FROM comments c JOIN people a ON a.id=c.author_id
		JOIN posts p ON p.id=c.post_id JOIN places d ON d.id=p.place_id
		WHERE p.id=$2 AND p.status='published' AND d.status='published'
		  AND gf_visible($1,p.author_id) AND gf_visible($1,c.author_id)
		ORDER BY c.created_at,c.id`, nullable(viewer), id)
}

func (a *API) addComment(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Text      string `json:"text"`
		RequestID string `json:"requestId"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !uuid.MatchString(body.RequestID) {
		return invalid("This comment has an invalid request ID.")
	}
	text, err := tidy(body.Text, 1, 600, "Comment")
	if err != nil {
		return err
	}
	if err := a.filter(text); err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.limit(ctx, "comment:"+viewer, 45, time.Hour); err != nil {
		return err
	}
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var author string
		id := r.PathValue("id")
		if err := tx.QueryRow(ctx, `SELECT p.author_id::text FROM posts p JOIN places d ON d.id=p.place_id
			WHERE p.id=$1 AND p.status='published' AND d.status='published'`, id).Scan(&author); err != nil {
			return err
		}
		if err := lockPair(ctx, tx, viewer, author); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO comments(request_id,post_id,author_id,text)
			SELECT $4,p.id,$2,$3 FROM posts p JOIN places d ON d.id=p.place_id
			WHERE p.id=$1 AND p.status='published' AND d.status='published' AND gf_visible($2,p.author_id)
			ON CONFLICT (author_id,request_id) DO NOTHING`, id, viewer, text, body.RequestID)
		return err
	})
	if err != nil {
		return err
	}
	return a.resource(w, r, `
		SELECT gf_comment(c,a,$1) FROM comments c JOIN people a ON a.id=c.author_id
		JOIN posts p ON p.id=c.post_id JOIN places d ON d.id=p.place_id
		WHERE c.author_id=$1 AND c.request_id=$2 AND c.post_id=$3
			AND p.status='published' AND d.status='published' AND gf_visible($1,p.author_id)`, viewer, body.RequestID, r.PathValue("id"))
}

func (a *API) deleteComment(w http.ResponseWriter, r *http.Request, viewer string) error {
	result, err := a.db.Exec(r.Context(), "DELETE FROM comments WHERE id=$1 AND author_id=$2", r.PathValue("id"), viewer)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return notFound
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) like(w http.ResponseWriter, r *http.Request, viewer string) error {
	active, err := activeValue(w, r)
	if err != nil {
		return err
	}
	ctx, id := r.Context(), r.PathValue("id")
	if active {
		err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
			var author string
			if err := tx.QueryRow(ctx, "SELECT author_id::text FROM posts WHERE id=$1 AND status='published'", id).Scan(&author); err != nil {
				return err
			}
			if err := lockPair(ctx, tx, viewer, author); err != nil {
				return err
			}
			var visible bool
			err := tx.QueryRow(ctx, `
				WITH available AS (
					SELECT p.id FROM posts p JOIN places d ON d.id=p.place_id
					WHERE p.id=$2 AND p.status='published' AND d.status='published' AND gf_visible($1,p.author_id)
				), added AS (
					INSERT INTO likes(person_id,post_id) SELECT $1,id FROM available ON CONFLICT DO NOTHING
				)
				SELECT EXISTS(SELECT 1 FROM available)`, viewer, id).Scan(&visible)
			return existsResult(err, visible)
		})
	} else {
		_, err = a.db.Exec(ctx, "DELETE FROM likes WHERE person_id=$1 AND post_id=$2", viewer, id)
	}
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
