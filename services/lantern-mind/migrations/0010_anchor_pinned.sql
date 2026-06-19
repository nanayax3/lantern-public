-- 0010 — dynamic anchors. Instead of painting a fixed top-8 by salience, the
-- grounding now paints a small always-on FLOOR (pinned = 1) and lets the rest surface
-- by meaning through the recall (anchors get embedded into the same Vectorize index as
-- feelings). `pinned` marks the non-negotiables that must always be present.
ALTER TABLE identity_entities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
