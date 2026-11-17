ALTER TABLE places ADD COLUMN menu_url text NOT NULL DEFAULT '';

CREATE TABLE restaurant_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    place_id uuid NOT NULL REFERENCES places ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('Owner', 'General manager', 'Authorized staff')),
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'revoked')),
    note text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (place_id, person_id)
);
CREATE INDEX restaurant_claims_person ON restaurant_claims(person_id, updated_at DESC);
CREATE INDEX restaurant_claims_queue ON restaurant_claims(updated_at) WHERE status = 'pending';

CREATE TABLE restaurant_owners (
    place_id uuid PRIMARY KEY REFERENCES places ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restaurant_owners_person ON restaurant_owners(person_id, place_id);

CREATE TABLE restaurant_replies (
    post_id uuid PRIMARY KEY REFERENCES posts ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restaurant_replies_author ON restaurant_replies(author_id);

ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('post', 'comment', 'person', 'place', 'reply'));

CREATE OR REPLACE FUNCTION gf_place(p places, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', p.id, 'name', p.name, 'cuisine', p.cuisine, 'area', p.area, 'city', p.city,
        'address', p.address, 'lat', p.lat, 'lng', p.lng, 'price', p.price, 'description', p.description,
        'dietary', p.dietary, 'hours', p.hours, 'website', p.website, 'phone', p.phone,
        'status', p.status, 'menuURL', p.menu_url,
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
        'score', r.score, 'text', r.text, 'dish', r.dish, 'status', r.status, 'createdAt', r.created_at,
        'likes', (SELECT count(*) FROM likes WHERE post_id = r.id AND gf_visible(viewer, person_id)),
        'comments', (SELECT count(*) FROM comments WHERE post_id = r.id AND gf_visible(viewer, author_id)),
        'liked', EXISTS (SELECT 1 FROM likes WHERE post_id = r.id AND person_id = viewer),
        'ownerReply', (
            SELECT jsonb_build_object('text', b.text, 'updatedAt', b.updated_at)
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
