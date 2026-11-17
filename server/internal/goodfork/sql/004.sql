ALTER TABLE people ADD COLUMN email text;
CREATE UNIQUE INDEX people_email ON people(email) WHERE email IS NOT NULL;
ALTER TABLE people ADD COLUMN google_subject text UNIQUE;
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE registrations (
    id_hash bytea PRIMARY KEY,
    email text NOT NULL,
    handle text NOT NULL,
    name text NOT NULL,
    password_hash bytea NOT NULL,
    password_salt bytea NOT NULL,
    code_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX registrations_expiry ON registrations(expires_at);

CREATE TABLE google_flows (
    state_hash bytea PRIMARY KEY,
    device_challenge bytea NOT NULL,
    provider_verifier text NOT NULL,
    nonce text NOT NULL,
    target text NOT NULL CHECK (target IN ('native', 'web')),
    expires_at timestamptz NOT NULL
);
CREATE INDEX google_flows_expiry ON google_flows(expires_at);

CREATE TABLE google_handoffs (
    code_hash bytea PRIMARY KEY,
    device_challenge bytea NOT NULL,
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX google_handoffs_expiry ON google_handoffs(expires_at);
