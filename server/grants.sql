-- Run as the migration role. Substitute the three named roles if they differ in your database.
GRANT USAGE ON SCHEMA public TO goodfork_runtime, goodfork_cleanup, goodfork_operator;

GRANT SELECT ON schema_migrations, restaurant_owners TO goodfork_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON people, posts, registrations, restaurant_replies TO goodfork_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON private_visits TO goodfork_runtime;
GRANT SELECT, INSERT, DELETE ON sessions, google_flows, google_handoffs, saves, likes, comments, follows, blocks TO goodfork_runtime;
GRANT SELECT, INSERT, UPDATE ON places, limits, restaurant_claims TO goodfork_runtime;
GRANT SELECT, INSERT ON objects TO goodfork_runtime;
GRANT INSERT ON reports, audit_events TO goodfork_runtime;

GRANT SELECT ON posts TO goodfork_cleanup;
GRANT UPDATE (created_at) ON objects TO goodfork_cleanup;
GRANT SELECT, DELETE ON objects, sessions, limits, registrations, google_flows, google_handoffs, reports, audit_events TO goodfork_cleanup;

GRANT SELECT (id, handle, name, bio), DELETE ON people TO goodfork_operator;
GRANT SELECT, DELETE ON comments, restaurant_replies TO goodfork_operator;
GRANT SELECT, INSERT, UPDATE ON places, restaurant_owners TO goodfork_operator;
GRANT DELETE ON restaurant_owners TO goodfork_operator;
GRANT SELECT, UPDATE ON posts, reports, restaurant_claims TO goodfork_operator;
GRANT SELECT ON saves, objects TO goodfork_operator;
GRANT SELECT, INSERT ON audit_events TO goodfork_operator;
