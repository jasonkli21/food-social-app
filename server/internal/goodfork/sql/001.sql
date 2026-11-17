CREATE TABLE people (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle text UNIQUE NOT NULL CHECK (handle ~ '^[a-z0-9_]{3,24}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
    bio text NOT NULL DEFAULT '',
    password_hash bytea NOT NULL,
    password_salt bytea NOT NULL,
    recovery_hash bytea NOT NULL,
    activity_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_person ON sessions(person_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE limits (
    scope text NOT NULL,
    bucket bigint NOT NULL,
    hits integer NOT NULL CHECK (hits > 0),
    PRIMARY KEY (scope, bucket)
);

CREATE TABLE places (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submitted_by uuid REFERENCES people ON DELETE SET NULL,
    name text NOT NULL,
    cuisine text NOT NULL,
    area text NOT NULL DEFAULT '',
    city text NOT NULL,
    address text NOT NULL,
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    price smallint CHECK (price BETWEEN 1 AND 4),
    description text NOT NULL DEFAULT '',
    dietary text[] NOT NULL DEFAULT '{}',
    hours text[] NOT NULL DEFAULT '{}',
    website text NOT NULL DEFAULT '',
    phone text NOT NULL DEFAULT '',
    cover_url text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('pending', 'published', 'hidden')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX places_identity ON places(lower(name), lower(address), lower(city));
CREATE INDEX places_status_coords ON places(status, lat, lng);
CREATE INDEX places_city ON places(lower(city));

CREATE TABLE objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type text NOT NULL,
    size bigint NOT NULL CHECK (size BETWEEN 1 AND 16777216),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL,
    author_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    place_id uuid NOT NULL REFERENCES places ON DELETE CASCADE,
    object_id uuid UNIQUE REFERENCES objects,
    score numeric(3,1) NOT NULL CHECK (score BETWEEN 1 AND 10),
    text text NOT NULL,
    dish text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('pending', 'published', 'hidden')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (author_id, request_id),
    UNIQUE (author_id, place_id)
);
CREATE INDEX posts_feed ON posts(created_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX posts_place ON posts(place_id, created_at DESC);
CREATE INDEX posts_author ON posts(author_id, created_at DESC);

CREATE TABLE saves (
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    place_id uuid NOT NULL REFERENCES places ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, place_id)
);
CREATE INDEX saves_person_recent ON saves(person_id, created_at DESC);

CREATE TABLE likes (
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    post_id uuid NOT NULL REFERENCES posts ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, post_id)
);
CREATE INDEX likes_post ON likes(post_id);

CREATE TABLE comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL,
    post_id uuid NOT NULL REFERENCES posts ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (author_id, request_id)
);
CREATE INDEX comments_post ON comments(post_id, created_at, id);

CREATE TABLE follows (
    follower_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    followed_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followed_id),
    CHECK (follower_id <> followed_id)
);
CREATE INDEX follows_incoming ON follows(followed_id, created_at DESC);

CREATE TABLE blocks (
    person_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    blocked_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, blocked_id),
    CHECK (person_id <> blocked_id)
);
CREATE INDEX blocks_incoming ON blocks(blocked_id);

CREATE TABLE reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id uuid NOT NULL REFERENCES people ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('post', 'comment', 'person', 'place')),
    target_id uuid NOT NULL,
    reason text NOT NULL,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX reports_open ON reports(created_at) WHERE resolved_at IS NULL;

CREATE FUNCTION gf_visible(viewer uuid, other uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM blocks
        WHERE (person_id = viewer AND blocked_id = other)
           OR (blocked_id = viewer AND person_id = other)
    )
$$;

CREATE FUNCTION gf_person(p people, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', p.id, 'name', p.name, 'handle', p.handle, 'bio', p.bio,
        'followers', (SELECT count(*) FROM follows WHERE followed_id = p.id),
        'following', (SELECT count(*) FROM follows WHERE follower_id = p.id),
        'reviewCount', (SELECT count(*) FROM posts r JOIN places d ON d.id = r.place_id
            WHERE r.author_id = p.id AND r.status = 'published' AND d.status = 'published'),
        'isFollowing', EXISTS (SELECT 1 FROM follows WHERE follower_id = viewer AND followed_id = p.id)
    )
$$;

CREATE FUNCTION gf_place(p places, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', p.id, 'name', p.name, 'cuisine', p.cuisine, 'area', p.area, 'city', p.city,
        'address', p.address, 'lat', p.lat, 'lng', p.lng, 'price', p.price, 'description', p.description,
        'dietary', p.dietary, 'hours', p.hours, 'website', p.website, 'phone', p.phone,
        'status', p.status,
        'cover', CASE WHEN p.cover_url = '' THEN NULL ELSE jsonb_build_object('kind','photo','source',p.cover_url) END,
        'score', stats.score, 'ratingCount', stats.n,
        'saved', EXISTS (SELECT 1 FROM saves WHERE person_id = viewer AND place_id = p.id)
    )
    FROM (
        SELECT round(avg(score),1) AS score, count(*) AS n
        FROM posts WHERE place_id = p.id AND status = 'published'
    ) stats
$$;

CREATE FUNCTION gf_post(r posts, d places, a people, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', r.id, 'author', gf_person(a, viewer), 'restaurant', gf_place(d, viewer),
        'score', r.score, 'text', r.text, 'dish', r.dish, 'status', r.status, 'createdAt', r.created_at,
        'likes', (SELECT count(*) FROM likes WHERE post_id = r.id AND gf_visible(viewer, person_id)),
        'comments', (SELECT count(*) FROM comments WHERE post_id = r.id AND gf_visible(viewer, author_id)),
        'liked', EXISTS (SELECT 1 FROM likes WHERE post_id = r.id AND person_id = viewer),
        'media', CASE WHEN r.status = 'hidden' THEN NULL ELSE (
            SELECT jsonb_build_object('kind', CASE WHEN content_type LIKE 'video/%' THEN 'video' ELSE 'photo' END,
                                      'source', '/v1/media/' || o.id)
            FROM objects o WHERE o.id = r.object_id
        ) END
    )
$$;

CREATE FUNCTION gf_comment(c comments, a people, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('id', c.id, 'text', c.text, 'author', gf_person(a, viewer),
                              'createdAt', c.created_at)
$$;
