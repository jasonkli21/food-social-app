CREATE TABLE private_visits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    place_id uuid REFERENCES places ON DELETE SET NULL,
    place_name text NOT NULL CHECK (char_length(place_name) BETWEEN 1 AND 100),
    request_id uuid NOT NULL,
    visit_date date NOT NULL,
    note text NOT NULL DEFAULT '' CHECK (char_length(note)<=1500),
    dish text NOT NULL DEFAULT '' CHECK (char_length(dish)<=160),
    score numeric(3,1) CHECK (score BETWEEN 1 AND 10),
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(person_id,request_id)
);
CREATE INDEX visits_person_date ON private_visits(person_id,visit_date DESC,id DESC);
CREATE INDEX visits_person_place_date ON private_visits(person_id,place_id,visit_date DESC,id DESC);
ALTER TABLE places ADD COLUMN schedule jsonb CHECK (schedule IS NULL OR
    (jsonb_typeof(schedule)='object' AND jsonb_typeof(schedule->'week')='array'
    AND jsonb_array_length(schedule->'week')=7 AND jsonb_typeof(schedule->'exceptions')='array'));
ALTER TABLE reports ADD COLUMN content_evidence jsonb;
ALTER TABLE audit_events ADD COLUMN actor_person uuid REFERENCES people ON DELETE SET NULL;
ALTER TABLE audit_events ADD COLUMN actor_principal text NOT NULL DEFAULT 'legacy actor unknown';

-- Exceptions replace an entire local date, including overnight carry-in.
CREATE FUNCTION gf_is_open(schedule jsonb, instant timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
    WITH local AS (
        SELECT instant AT TIME ZONE (schedule->>'timezone') AS t
    ), clock AS (
        SELECT t::date AS day,extract(dow FROM t)::int AS dow,
               extract(hour FROM t)::int*60+extract(minute FROM t)::int AS minute FROM local
    ), chosen AS (
        SELECT c.*,
            (SELECT x->'periods' FROM jsonb_array_elements(schedule->'exceptions') x
                WHERE x->>'date'=c.day::text LIMIT 1) AS today,
            (SELECT x->'periods' FROM jsonb_array_elements(schedule->'exceptions') x
                WHERE x->>'date'=(c.day-1)::text LIMIT 1) AS yesterday
        FROM clock c
    )
    SELECT CASE WHEN schedule IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM chosen c,
        LATERAL jsonb_array_elements(coalesce(c.today,schedule->'week'->c.dow)) p
        WHERE c.minute >= (p->>'start')::int AND c.minute < (p->>'end')::int
        UNION ALL
        SELECT 1 FROM chosen c,
        LATERAL jsonb_array_elements(coalesce(c.yesterday,schedule->'week'->((c.dow+6)%7))) p
        WHERE c.today IS NULL AND c.minute+1440 >= (p->>'start')::int AND c.minute+1440 < (p->>'end')::int
    ) END
$$;

ALTER FUNCTION gf_place(places,uuid) RENAME TO gf_place_base;
CREATE FUNCTION gf_place(p places, viewer uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT gf_place_base(p,viewer) || jsonb_build_object(
        'schedule',p.schedule,
        'hoursStatus',jsonb_build_object(
            'state',CASE gf_is_open(p.schedule,statement_timestamp()) WHEN true THEN 'open' WHEN false THEN 'closed' ELSE 'unknown' END,
            'timezone',p.schedule->>'timezone','asOf',statement_timestamp()))
$$;
