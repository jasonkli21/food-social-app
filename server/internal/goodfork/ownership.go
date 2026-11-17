package goodfork

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (a *API) claimRestaurant(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	body.Email = strings.TrimSpace(body.Email)
	email, err := mail.ParseAddress(body.Email)
	if err != nil || email.Address != body.Email || len(body.Email) > 254 {
		return invalid("Enter a valid business email.")
	}
	switch body.Role {
	case "Owner", "General manager", "Authorized staff":
	default:
		return invalid("Choose your role at the restaurant.")
	}
	ctx, id := r.Context(), r.PathValue("id")
	if err := a.limit(ctx, "claim:"+viewer, 8, time.Hour); err != nil {
		return err
	}
	var claimID string
	var revision int64
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var place string
		if err := tx.QueryRow(ctx, "SELECT id::text FROM places WHERE id=$1 AND status='published' FOR NO KEY UPDATE", id).Scan(&place); err != nil {
			return err
		}
		var managed bool
		err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM restaurant_owners WHERE place_id=$1)", place).Scan(&managed)
		if err != nil {
			return err
		}
		if managed {
			return conflict("This listing already has a verified manager. Contact support for help.")
		}
		return tx.QueryRow(ctx, `
			INSERT INTO restaurant_claims(place_id,person_id,email,role,status) VALUES ($1,$2,$3,$4,'pending')
			ON CONFLICT (place_id,person_id) DO UPDATE SET email=excluded.email,role=excluded.role,
				status='pending',note='',updated_at=now(),
				revision=CASE WHEN restaurant_claims.status='pending'
					AND restaurant_claims.email=excluded.email AND restaurant_claims.role=excluded.role
					THEN restaurant_claims.revision ELSE restaurant_claims.revision+1 END
			RETURNING id::text, revision`, place, viewer, body.Email, body.Role).Scan(&claimID, &revision)
	})
	if err != nil {
		return err
	}
	return send(w, http.StatusCreated, map[string]any{"id": claimID, "status": "pending", "revision": revision})
}

func (a *API) myRestaurants(w http.ResponseWriter, r *http.Request, viewer string) error {
	return a.list(w, r, `
		SELECT jsonb_build_object('id',c.id,'place',gf_place(p,$1),'status',c.status,
			'role',c.role,'note',c.note,'updatedAt',c.updated_at,'revision',c.revision)
		FROM restaurant_claims c JOIN places p ON p.id=c.place_id
		WHERE c.person_id=$1 AND p.status='published'
		ORDER BY CASE WHEN c.status='approved' THEN 0 ELSE 1 END,c.updated_at DESC,c.id`, viewer)
}

type listingDetails struct {
	Revision    int64           `json:"revision"`
	Description string          `json:"description"`
	Price       *int16          `json:"price"`
	Dietary     []string        `json:"dietary"`
	Hours       []string        `json:"hours"`
	Website     string          `json:"website"`
	MenuURL     string          `json:"menuURL"`
	Phone       string          `json:"phone"`
	Schedule    json.RawMessage `json:"schedule"`
}

func (a *API) editListing(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body listingDetails
	if err := decode(w, r, &body); err != nil {
		return err
	}
	schedule, err := parseSchedule(body.Schedule)
	if err != nil {
		return err
	}
	if schedule != nil {
		body.Hours = schedule.legacyHours()
	}
	p := PlaceInput{Description: body.Description, Price: body.Price, Dietary: body.Dietary, Hours: body.Hours,
		Website: body.Website, MenuURL: body.MenuURL, Phone: body.Phone}
	if err := p.validateDetails(); err != nil {
		return err
	}
	if err := a.filter(strings.Join([]string{p.Description, strings.Join(p.Hours, " "), strings.Join(p.Dietary, " ")}, " ")); err != nil {
		return err
	}
	ctx, id := r.Context(), r.PathValue("id")
	if err := a.limit(ctx, "listing:"+viewer, 30, time.Hour); err != nil {
		return err
	}
	var updated json.RawMessage
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if err := lockPlace(ctx, tx, id); err != nil {
			return err
		}
		var current int64
		err := tx.QueryRow(ctx, `
			SELECT d.listing_revision FROM places d JOIN restaurant_owners o ON o.place_id=d.id
			WHERE d.id=$1 AND d.status='published' AND o.person_id=$2`, id, viewer).Scan(&current)
		if err != nil {
			return err
		}
		if current != body.Revision {
			return conflict("The listing changed. Load the latest version before trying again.")
		}
		updated, err = one(ctx, tx, `
			WITH changed AS (
				UPDATE places SET description=$3,price=$4,dietary=$5::text[],hours=$6::text[],website=$7,menu_url=$8,phone=$9,
					schedule=CASE WHEN $10::text IS NULL THEN schedule ELSE nullif($10::jsonb,'null'::jsonb) END,
					listing_revision=listing_revision+1,listing_updated_at=now()
				WHERE id=$1 RETURNING *
			) SELECT gf_place(changed,$2) FROM changed`,
			id, viewer, p.Description, p.Price, p.Dietary, p.Hours, p.Website, p.MenuURL, p.Phone, optionalJSON(body.Schedule))
		if err != nil {
			return err
		}
		return audit(ctx, tx, "restaurant_manager", "edit-listing", id, strconv.FormatInt(current+1, 10))
	})
	if err != nil {
		return err
	}
	return send(w, http.StatusOK, updated)
}

func lockPlace(ctx context.Context, tx pgx.Tx, id string) error {
	var place string
	return tx.QueryRow(ctx, "SELECT id::text FROM places WHERE id=$1 FOR NO KEY UPDATE", id).Scan(&place)
}

func lockPostPlace(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	var place string
	if err := tx.QueryRow(ctx, "SELECT place_id::text FROM posts WHERE id=$1", id).Scan(&place); err != nil {
		return "", err
	}
	return place, lockPlace(ctx, tx, place)
}

const eligibleOwnerReview = `
	FROM posts p JOIN places d ON d.id=p.place_id JOIN restaurant_owners o ON o.place_id=d.id
	WHERE p.id=$1 AND o.person_id=$2 AND p.author_id<>$2 AND p.status='published'
	AND d.status='published' AND gf_visible($2,p.author_id)`

type replyInput struct {
	Text     string `json:"text"`
	Revision string `json:"revision"`
}

func currentReply(ctx context.Context, tx pgx.Tx, id, viewer string) (string, error) {
	if _, err := lockPostPlace(ctx, tx, id); err != nil {
		return "", err
	}
	var revision string
	err := tx.QueryRow(ctx, `SELECT coalesce((SELECT b.revision::text FROM restaurant_replies b WHERE b.post_id=p.id),'')`+
		eligibleOwnerReview, id, viewer).Scan(&revision)
	return revision, err
}

func (a *API) replyToReview(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body replyInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if body.Revision != "" && !uuid.MatchString(body.Revision) {
		return invalid("Reload the review before editing its response.")
	}
	text, err := tidy(body.Text, 1, 1000, "Response")
	if err != nil {
		return err
	}
	if err := a.filter(text); err != nil {
		return err
	}
	ctx, id := r.Context(), r.PathValue("id")
	if err := a.limit(ctx, "reply:"+viewer, 40, time.Hour); err != nil {
		return err
	}
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		current, err := currentReply(ctx, tx, id, viewer)
		if err != nil {
			return err
		}
		if current != body.Revision {
			return conflict("The restaurant response changed. Reopen this review to load its latest version.")
		}
		var revision string
		err = tx.QueryRow(ctx, `
			INSERT INTO restaurant_replies(post_id,author_id,text) VALUES ($1,$2,$3)
			ON CONFLICT(post_id) DO UPDATE SET author_id=excluded.author_id,text=excluded.text,updated_at=now(),revision=gen_random_uuid()
			RETURNING revision::text`, id, viewer, text).Scan(&revision)
		if err != nil {
			return err
		}
		return audit(ctx, tx, "restaurant_manager", "publish-reply", id, revision)
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) deleteReply(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Revision string `json:"revision"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if !uuid.MatchString(body.Revision) {
		return invalid("Reload the review before removing its response.")
	}
	ctx, id := r.Context(), r.PathValue("id")
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		current, err := currentReply(ctx, tx, id, viewer)
		if err != nil || current == "" {
			return err
		}
		if current != body.Revision {
			return conflict("The restaurant response changed. Reopen the review before removing it.")
		}
		if _, err := tx.Exec(ctx, "DELETE FROM restaurant_replies WHERE post_id=$1", id); err != nil {
			return err
		}
		return audit(ctx, tx, "restaurant_manager", "delete-reply", id, current)
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func moderateOwnership(ctx context.Context, db *pgxpool.Pool, action, id, version string) error {
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if action == "revoke-owner" {
			if err := lockPlace(ctx, tx, id); err != nil {
				return err
			}
			res, err := tx.Exec(ctx, "DELETE FROM restaurant_owners WHERE place_id=$1", id)
			if err := existsResult(err, res.RowsAffected() > 0); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE restaurant_claims SET status='revoked',note='Contact support about your listing access.',updated_at=now(),revision=revision+1
				WHERE place_id=$1 AND status='approved'`, id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM restaurant_replies b USING posts p WHERE p.id=b.post_id AND p.place_id=$1", id); err != nil {
				return err
			}
			return audit(ctx, tx, "operator", action, id, "")
		}
		requested, err := strconv.ParseInt(version, 10, 64)
		if err != nil || requested < 1 {
			return invalid("Pass the claim revision shown in the queue.")
		}
		var place, person, status string
		var revision int64
		if err := tx.QueryRow(ctx, "SELECT place_id::text FROM restaurant_claims WHERE id=$1", id).Scan(&place); err != nil {
			return err
		}
		if err := lockPlace(ctx, tx, place); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			SELECT c.person_id::text,c.revision,c.status FROM restaurant_claims c JOIN places p ON p.id=c.place_id
			WHERE c.id=$1 AND p.status='published' FOR UPDATE OF c`, id).Scan(&person, &revision, &status); err != nil {
			return err
		}
		if requested != revision || status != "pending" {
			return conflict("This claim has changed. Review the current queue entry.")
		}
		if action == "decline-claim" {
			if _, err := tx.Exec(ctx, `
				UPDATE restaurant_claims SET status='declined',email='',revision=revision+1,
				note='We could not verify this request. Contact support or resubmit with current business details.',updated_at=now()
				WHERE id=$1`, id); err != nil {
				return err
			}
			return audit(ctx, tx, "operator", action, id, version)
		}
		_, err = tx.Exec(ctx, "INSERT INTO restaurant_owners(place_id,person_id) VALUES ($1,$2)", place, person)
		if unique(err) {
			return conflict("This restaurant already has a manager.")
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE restaurant_claims SET status='approved',note='',email='',updated_at=now(),revision=revision+1 WHERE id=$1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE restaurant_claims SET status='declined',note='This listing now has a verified manager.',email='',updated_at=now(),revision=revision+1
			WHERE place_id=$1 AND id<>$2 AND status='pending'`, place, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE posts SET status='hidden',ownership_conflict=true,revision=gen_random_uuid() WHERE place_id=$1 AND author_id=$2`, place, person); err != nil {
			return err
		}
		return audit(ctx, tx, "operator", action, id, version)
	})
}

func ownerConflict(ctx context.Context, q querier, place, viewer string) error {
	var owner bool
	err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM restaurant_owners WHERE place_id=$1 AND person_id=$2)", place, viewer).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound
	}
	if err != nil {
		return err
	}
	if owner {
		return conflict("You manage this restaurant. Use Restaurant tools to respond to diners.")
	}
	return nil
}
