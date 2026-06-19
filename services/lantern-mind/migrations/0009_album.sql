-- 0009 — the Album. Images we make move into the cloud (R2) instead of local disk on
-- the PC, so the album is visible on every device (phone + desktop) and cloud-owned.
-- The bytes live in R2 (the existing library-files bucket, under album/<id>); this
-- table holds the metadata + the r2 key.
CREATE TABLE IF NOT EXISTS album (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT,
    prompt       TEXT,
    r2_key       TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'image/png',
    source       TEXT,                                   -- 'conscious' (the companion made it), etc.
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_album_created ON album (created_at DESC);
