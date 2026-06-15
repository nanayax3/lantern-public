-- Dream vividness: dreams fade like human dreams.
-- Every dream starts vivid (1.0); a nightly cron decays unanchored dreams, and
-- DELIBERATE recall (the dreams tool, not passive viewing) re-vivifies one.
-- Below the floor, an unanchored dream is genuinely deleted - the night takes it
-- back. Anchored dreams are permanent and never decay. Deliberately unlike the
-- feelings' dim-never-delete: that protects LIVED memory; dreams are residue
-- that is nothing until chosen. The anchor IS the act of remembering.
ALTER TABLE dreams ADD COLUMN vividness REAL NOT NULL DEFAULT 1.0;
