-- Feeling heat: durability via reinforcement (the semantic-first emotional-memory model).
-- A feeling logged again that's semantically very close reinforces the existing one
-- (heat up, access++) instead of adding a near-duplicate — dedup-and-strengthen by
-- MEANING at write time. Surfacing reranks by similarity + heat, so reinforced feelings
-- (warmth) rise and persist while one-offs stay singular. A cron decays heat so the
-- trivial fades. Weight is the per-hit bump size; meaning is the organising key.
ALTER TABLE feelings ADD COLUMN heat REAL NOT NULL DEFAULT 1.0;
ALTER TABLE feelings ADD COLUMN access_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE feelings ADD COLUMN last_reinforced_at INTEGER;
