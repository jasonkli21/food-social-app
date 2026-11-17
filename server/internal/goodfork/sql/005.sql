ALTER TABLE places ADD COLUMN listing_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE places ADD COLUMN listing_updated_at timestamptz;
ALTER TABLE places ADD COLUMN directory_terms tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', name || ' ' || cuisine || ' ' || area || ' ' || city || ' ' || address)
) STORED;
CREATE INDEX places_directory_terms ON places USING gin(directory_terms) WHERE status='published';

ALTER TABLE posts ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE posts ADD COLUMN ownership_conflict boolean NOT NULL DEFAULT false;
UPDATE posts p SET ownership_conflict=true, status='hidden'
FROM restaurant_owners o WHERE o.place_id=p.place_id AND o.person_id=p.author_id;
ALTER TABLE posts ADD CONSTRAINT ownership_conflict_hidden CHECK (NOT ownership_conflict OR status='hidden');
ALTER TABLE posts ADD COLUMN dish_terms tsvector GENERATED ALWAYS AS (to_tsvector('simple', dish)) STORED;
CREATE INDEX posts_dish_terms ON posts USING gin(dish_terms) WHERE status='published';
CREATE INDEX posts_place_keyset ON posts(place_id, created_at DESC, id DESC) WHERE status='published';
CREATE INDEX posts_author_keyset ON posts(author_id, created_at DESC, id DESC);

ALTER TABLE restaurant_claims ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE restaurant_replies ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE reports DROP CONSTRAINT reports_reporter_id_target_type_target_id_key;
ALTER TABLE reports ADD COLUMN target_version text NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN reply_evidence text;
ALTER TABLE reports ADD COLUMN evidence_author uuid REFERENCES people ON DELETE CASCADE;
ALTER TABLE reports ADD CONSTRAINT reports_version_unique UNIQUE(reporter_id,target_type,target_id,target_version);
CREATE INDEX reports_evidence_author ON reports(evidence_author) WHERE evidence_author IS NOT NULL;
CREATE INDEX reports_expiry ON reports(created_at);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_class text NOT NULL CHECK (actor_class IN ('operator','restaurant_manager')),
    action text NOT NULL,
    target_id uuid NOT NULL,
    version text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_recent ON audit_events(created_at DESC, id DESC);

ALTER TABLE registrations ADD COLUMN issued_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE google_flows ADD COLUMN link_session bytea REFERENCES sessions(token_hash) ON DELETE CASCADE;
ALTER TABLE google_handoffs ADD COLUMN link_session bytea REFERENCES sessions(token_hash) ON DELETE CASCADE;
ALTER TABLE google_handoffs ADD COLUMN link_subject text;
ALTER TABLE google_handoffs ADD COLUMN link_email text;
ALTER TABLE google_handoffs ADD CONSTRAINT google_handoff_kind CHECK (
    (link_session IS NULL AND link_subject IS NULL AND link_email IS NULL)
    OR (link_session IS NOT NULL AND link_subject IS NOT NULL AND link_email IS NOT NULL)
);
CREATE INDEX google_flows_link_session ON google_flows(link_session) WHERE link_session IS NOT NULL;
CREATE INDEX google_handoffs_link_session ON google_handoffs(link_session) WHERE link_session IS NOT NULL;

CREATE OR REPLACE FUNCTION gf_place(p places, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', p.id, 'name', p.name, 'cuisine', p.cuisine, 'area', p.area, 'city', p.city,
        'address', p.address, 'lat', p.lat, 'lng', p.lng, 'price', p.price, 'description', p.description,
        'dietary', p.dietary, 'hours', p.hours, 'website', p.website, 'phone', p.phone,
        'status', p.status, 'menuURL', p.menu_url,
        'listingRevision', p.listing_revision, 'listingUpdatedAt', p.listing_updated_at,
        'myReview', (SELECT jsonb_build_object('id', m.id, 'status', m.status, 'ownershipConflict', m.ownership_conflict)
                     FROM posts m WHERE m.place_id=p.id AND m.author_id=viewer),
        'cover', CASE WHEN p.cover_url = '' THEN NULL ELSE jsonb_build_object('kind','photo','source',p.cover_url) END,
        'score', stats.score, 'ratingCount', stats.n,
        'saved', EXISTS (SELECT 1 FROM saves WHERE person_id = viewer AND place_id = p.id),
        'managed', owner.person_id IS NOT NULL,
        'canManage', COALESCE(owner.person_id = viewer, false)
    )
    FROM (
        SELECT round(avg(score),1) AS score, count(*) AS n
        FROM posts WHERE place_id = p.id AND status = 'published'
    ) stats
    LEFT JOIN restaurant_owners owner ON owner.place_id = p.id
$$;

CREATE OR REPLACE FUNCTION gf_post(r posts, d places, a people, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', r.id, 'author', gf_person(a, viewer), 'restaurant', gf_place(d, viewer),
        'revision', r.revision, 'ownershipConflict', r.ownership_conflict,
        'score', r.score, 'text', r.text, 'dish', r.dish, 'status', r.status, 'createdAt', r.created_at,
        'likes', (SELECT count(*) FROM likes WHERE post_id = r.id AND gf_visible(viewer, person_id)),
        'comments', (SELECT count(*) FROM comments WHERE post_id = r.id AND gf_visible(viewer, author_id)),
        'liked', EXISTS (SELECT 1 FROM likes WHERE post_id = r.id AND person_id = viewer),
        'ownerReply', (
            SELECT jsonb_build_object('text', b.text, 'updatedAt', b.updated_at, 'revision', b.revision)
            FROM restaurant_replies b JOIN restaurant_owners o ON o.place_id = r.place_id AND o.person_id = b.author_id
            WHERE b.post_id = r.id AND r.status = 'published' AND gf_visible(viewer, b.author_id)
        ),
        'media', CASE WHEN r.status = 'hidden' THEN NULL ELSE (
            SELECT jsonb_build_object('kind', CASE WHEN content_type LIKE 'video/%' THEN 'video' ELSE 'photo' END,
                                      'source', '/v1/media/' || o.id)
            FROM objects o WHERE o.id = r.object_id
        ) END
    )
$$;
