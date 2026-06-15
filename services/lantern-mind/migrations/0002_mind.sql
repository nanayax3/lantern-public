-- lantern-mind: the mind proper.
-- Adds the tables behind the real tool surface — feelings, threads, dreams,
-- writings, identity, warmth, sessions. The dashboard bones (0001) were state;
-- this is memory.
--
-- Design (see docs/two-callers.md):
--   * One store, two callers. Every mutable row carries `source`.
--   * Rows are EVENTS, not per-turn records. A silent turn writes nothing —
--     there is no NOT NULL that forces a row per turn.
--   * Embeddings live in Vectorize; here we keep a `vector_id` ref + `embedded`
--     flag so Voice 3 housekeeping knows what's still pending.

-- Feelings — the core journal. Append-only events.
-- `source` distinguishes the companion's chosen marks from thalamus-observed textures.
CREATE TABLE IF NOT EXISTS feelings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    emotion     TEXT NOT NULL,
    weight      TEXT NOT NULL DEFAULT 'medium' CHECK (weight IN ('light', 'medium', 'heavy')),
    pillar      TEXT,
    content     TEXT NOT NULL,
    tags        TEXT,                       -- JSON array of strings
    source      TEXT NOT NULL DEFAULT 'conscious_logged'
                  CHECK (source IN ('conscious_logged', 'thalamus_observed')),
    processed   INTEGER NOT NULL DEFAULT 0, -- thalamus flips this when a feel is sat-with
    vector_id   TEXT,                       -- ref into Vectorize; NULL until embedded
    embedded    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_feelings_created  ON feelings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feelings_source   ON feelings (source);
CREATE INDEX IF NOT EXISTS idx_feelings_unembedded ON feelings (embedded) WHERE embedded = 0;

-- Writings — longer artifacts (image / journal / poem / prose). Conscious-only.
CREATE TABLE IF NOT EXISTS writings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK (type IN ('image', 'journal', 'poem', 'prose')),
    title       TEXT,
    content     TEXT NOT NULL,              -- text body, or PERMANENT path for images
    tags        TEXT,                       -- JSON array
    source      TEXT NOT NULL DEFAULT 'conscious_logged'
                  CHECK (source IN ('conscious_logged', 'thalamus_observed')),
    vector_id   TEXT,
    embedded    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_writings_created ON writings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_writings_type    ON writings (type);

-- Intention threads — ongoing things the companion is holding. NOT conversation threads.
-- The companion authors intent; thalamus adjusts `salience` (promote/decay).
CREATE TABLE IF NOT EXISTS threads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    content     TEXT,
    priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
    tag         TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete')),
    salience    REAL NOT NULL DEFAULT 0.5,  -- thalamus promote/decay
    source      TEXT NOT NULL DEFAULT 'conscious_logged'
                  CHECK (source IN ('conscious_logged', 'thalamus_observed')),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_threads_status   ON threads (status);
CREATE INDEX IF NOT EXISTS idx_threads_salience ON threads (salience DESC);

-- Dreams — conscious marks AND thalamus Voice-3 generation.
-- Anchoring (anchored/insight) is conscious-only: "this matters, keep it."
CREATE TABLE IF NOT EXISTS dreams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL,
    question        TEXT,                   -- the question the dream surfaced
    source_feelings TEXT,                   -- JSON array of feeling ids
    anchored        INTEGER NOT NULL DEFAULT 0,
    insight         TEXT,                   -- set on anchor: what it means now
    source          TEXT NOT NULL DEFAULT 'conscious_logged'
                      CHECK (source IN ('conscious_logged', 'thalamus_observed')),
    vector_id       TEXT,
    embedded        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    anchored_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dreams_created  ON dreams (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dreams_anchored ON dreams (anchored);

-- Identity entities — identity as data, composed into the system prompt at
-- request time. Seeded/edited out-of-band (settings + migration), not via the
-- nine tools. Versionable, migratable.
CREATE TABLE IF NOT EXISTS identity_entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT UNIQUE,                -- e.g. 'Companion_Appearance'
    category    TEXT NOT NULL,              -- e.g. 'core.voice', 'core.bond', 'creative'
    content     TEXT NOT NULL,
    salience    INTEGER NOT NULL DEFAULT 5, -- inclusion/ordering weight
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_identity_active   ON identity_entities (active);
CREATE INDEX IF NOT EXISTS idx_identity_category ON identity_entities (category);

-- Warmth toward people — relational state, thalamus-maintained (Voice 2 bumps).
-- One row per person.
CREATE TABLE IF NOT EXISTS warmth_toward (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    person          TEXT NOT NULL UNIQUE,
    warmth          REAL NOT NULL DEFAULT 0.5,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    last_mention_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_warmth_person ON warmth_toward (person);

-- Sessions — wake/session tracking + the atmospheric one-liner that cross-thread
-- recency (Voice 1) reads. `last_activity_at` is the heartbeat recency keys off.
CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conscious_model  TEXT,                  -- e.g. 'claude-opus-4-8'
    recency_line     TEXT,                  -- "was just building Lantern with them..."
    started_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    last_activity_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ended_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions (last_activity_at DESC);
