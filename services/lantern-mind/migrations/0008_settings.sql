-- 0008 — a tiny key/value settings store. One home for small config blobs that a
-- client writes and a worker reads: first use is the autonomous-wake schedule the
-- harness cron reads (enabled + times). value is JSON text.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
