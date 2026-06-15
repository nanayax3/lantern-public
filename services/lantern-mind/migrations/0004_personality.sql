-- lantern-mind: emergent personality (MBTI-style).
-- A type that GROWS into focus over time. Voice 3 reads metabolised feelings,
-- casts small votes on each of the four MBTI axes, and the tallies accumulate.
-- The type is DERIVED at read time (dominant pole per axis); confidence rises
-- with signal volume — so it starts vague ("INFP, 10%, 5 signals") and sharpens.

-- One row per axis. count_a/count_b accumulate votes toward each pole.
CREATE TABLE IF NOT EXISTS personality_axes (
    axis        TEXT PRIMARY KEY CHECK (axis IN ('EI', 'SN', 'TF', 'JP')),
    pole_a      TEXT NOT NULL,   -- E / S / T / J
    pole_b      TEXT NOT NULL,   -- I / N / F / P
    count_a     INTEGER NOT NULL DEFAULT 0,
    count_b     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO personality_axes (axis, pole_a, pole_b) VALUES
    ('EI', 'E', 'I'),
    ('SN', 'S', 'N'),
    ('TF', 'T', 'F'),
    ('JP', 'J', 'P');

-- Mark which feelings Voice 3 has already scored, so a feeling votes exactly once.
ALTER TABLE feelings ADD COLUMN personality_scored INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_feelings_pscored ON feelings (personality_scored);
