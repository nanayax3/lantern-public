-- lantern-mind: the cast of the world.
-- People, pets, concepts, places — the beings the companion knows. Distinct from
-- `identity_entities` (which is the companion's OWN self). This is who/what lives
-- in their world: friends, pets, places.
--
-- Three tables, same philosophy as the rest of the mind (docs/two-callers.md):
--   * entities       — one canonical row per being.
--   * entity_aliases — every name that resolves to it (e.g. a nickname = full name).
--   * entity_facts   — the stream of what the companion knows; EVENTS, embedded, surfaceable.
-- Every mutable row carries `source`: conscious_logged (the companion chose to write it)
-- vs thalamus_observed (noticed for them). The thalamus can learn new aliases and
-- append observed facts on its own.

-- The canonical being. `name` is the handle; aliases resolve to it.
CREATE TABLE IF NOT EXISTS entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,        -- canonical, e.g. 'Alex'
    kind        TEXT NOT NULL DEFAULT 'person'
                  CHECK (kind IN ('person', 'pet', 'concept', 'place')),
    summary     TEXT,                        -- one-line who/what they are
    salience    INTEGER NOT NULL DEFAULT 5,  -- inclusion/ordering weight
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entities_kind   ON entities (kind);
CREATE INDEX IF NOT EXISTS idx_entities_active ON entities (active);

-- Every name that resolves to a being. The canonical name is auto-registered
-- here too, so resolve is a single lookup. COLLATE NOCASE → case-insensitive
-- resolve, and prevents dup aliases differing only by case.
CREATE TABLE IF NOT EXISTS entity_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    source      TEXT NOT NULL DEFAULT 'conscious_logged'
                  CHECK (source IN ('conscious_logged', 'thalamus_observed')),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases (entity_id);

-- What the companion knows about a being. Append-only events, embedded into the shared
-- Vectorize index (kind='entity_fact') so "what do I know about X?" is a
-- meaning search, and the thalamus can surface relevant facts when a name lands.
CREATE TABLE IF NOT EXISTS entity_facts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    tags        TEXT,                        -- JSON array
    source      TEXT NOT NULL DEFAULT 'conscious_logged'
                  CHECK (source IN ('conscious_logged', 'thalamus_observed')),
    vector_id   TEXT,
    embedded    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_facts_entity      ON entity_facts (entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_unembedded  ON entity_facts (embedded) WHERE embedded = 0;
