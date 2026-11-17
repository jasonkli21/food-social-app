package goodfork

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed sql/*.sql
var migrations embed.FS

func Open(ctx context.Context, dsn string, allowLocal bool) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid database connection configuration")
	}
	if !allowLocal {
		settings := config.ConnConfig
		if settings.TLSConfig == nil || settings.TLSConfig.InsecureSkipVerify || len(settings.Fallbacks) != 0 {
			return nil, fmt.Errorf("set sslmode=verify-full for the Neon connection")
		}
	}
	config.MaxConns = 8
	config.MinConns = 0
	config.MaxConnIdleTime = 3 * time.Minute
	config.MaxConnLifetime = time.Hour
	config.ConnConfig.ConnectTimeout = 12 * time.Second
	// Unnamed extended queries work with transaction pooling and keep values typed.
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("initialize connection pool: %w", err)
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("database is unavailable: %w", err)
	}
	return db, nil
}

// RequireSchema derives readiness from the migrations included in this binary.
func RequireSchema(ctx context.Context, db *pgxpool.Pool) error {
	entries, err := migrations.ReadDir("sql")
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return errors.New("no database migrations are embedded")
	}
	var applied bool
	if err := db.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name=$1)", entries[len(entries)-1].Name()).Scan(&applied); err != nil || !applied {
		return errors.New("apply the database migrations with goodfork migrate")
	}
	return nil
}

func Migrate(ctx context.Context, db *pgxpool.Pool) error {
	entries, err := migrations.ReadDir("sql")
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(693164619823)"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
			return err
		}
		for _, entry := range entries {
			var applied bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)", entry.Name()).Scan(&applied); err != nil {
				return err
			}
			if applied {
				continue
			}
			body, err := migrations.ReadFile("sql/" + entry.Name())
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, string(body), pgx.QueryExecModeSimpleProtocol); err != nil {
				return fmt.Errorf("apply %s: %w", entry.Name(), err)
			}
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (name) VALUES ($1)", entry.Name()); err != nil {
				return err
			}
		}
		return nil
	})
}
