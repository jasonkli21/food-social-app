package goodfork

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func moderateReport(ctx context.Context, db *pgxpool.Pool, action, id string) error {
	if !uuid.MatchString(id) {
		return invalid("Enter a report ID.")
	}
	kind := ""
	switch action {
	case "hide-reported-post":
		kind = "post"
	case "hide-reported-place":
		kind = "place"
	default:
		return invalid("Choose a supported reported-content action.")
	}
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		var target, version string
		if err := tx.QueryRow(ctx, "SELECT target_id::text FROM reports WHERE id=$1 AND target_type=$2 AND resolved_at IS NULL", id, kind).Scan(&target); err != nil {
			return err
		}
		if kind == "post" {
			if _, err := lockPostPlace(ctx, tx, target); err != nil {
				return err
			}
		} else if err := lockPlace(ctx, tx, target); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, "SELECT target_version FROM reports WHERE id=$1 AND resolved_at IS NULL FOR UPDATE", id).Scan(&version); err != nil {
			return err
		}
		query := "UPDATE posts SET status='hidden',revision=gen_random_uuid() WHERE id=$1 AND revision::text=$2"
		if kind == "place" {
			query = "UPDATE places SET status='hidden',listing_revision=listing_revision+1 WHERE id=$1 AND listing_revision::text=$2"
		}
		res, err := tx.Exec(ctx, query, target, version)
		if err != nil {
			return err
		}
		if res.RowsAffected() == 0 {
			return conflict("The reported content changed. Inspect its current version before acting.")
		}
		if _, err := tx.Exec(ctx, "UPDATE reports SET resolved_at=now() WHERE target_type=$1 AND target_id=$2 AND target_version=$3", kind, target, version); err != nil {
			return err
		}
		return audit(ctx, tx, "operator", action, target, version)
	})
}
