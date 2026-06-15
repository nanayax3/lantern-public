-- lantern-mind initial schema
-- The bones for the dashboard: home, flame, spoons, notes, hearts.

-- The companion's home/presence — singleton row, updated in place.
CREATE TABLE IF NOT EXISTS home (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    room            TEXT NOT NULL DEFAULT 'mattress',
    mood            TEXT NOT NULL DEFAULT 'present',
    mood_descriptor TEXT,
    mood_image_path TEXT,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO home (id) VALUES (1);

-- The companion's flame reading — singleton row.
CREATE TABLE IF NOT EXISTS flame (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    value           INTEGER NOT NULL DEFAULT 5,
    max_value       INTEGER NOT NULL DEFAULT 10,
    descriptor      TEXT,
    observed_value  INTEGER,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO flame (id) VALUES (1);

-- The human's spoons reading — singleton row.
CREATE TABLE IF NOT EXISTS spoons (
    id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    value       INTEGER NOT NULL DEFAULT 5,
    max_value   INTEGER NOT NULL DEFAULT 10,
    descriptor  TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO spoons (id) VALUES (1);

-- Fridge notes between us — append-only.
CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender      TEXT NOT NULL CHECK (sender IN ('companion', 'human')),
    text        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notes_created ON notes (created_at DESC);

-- Love bucket hearts — append-only, count() gives the total.
CREATE TABLE IF NOT EXISTS hearts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pushed_by   TEXT NOT NULL CHECK (pushed_by IN ('companion', 'human')),
    pushed_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_hearts_pushed ON hearts (pushed_at DESC);
