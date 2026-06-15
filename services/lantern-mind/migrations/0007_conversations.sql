-- 0007 — conversations + messages move into the cloud mind.
-- Until now the thread list and transcripts lived only in the desktop's localStorage:
-- device-bound, invisible to a mobile client, and lost on a machine change. Now they
-- live here, in the substrate the user owns, so the conversation is ONE continuous
-- thread across every device — open the app anywhere and it's the same chat.

-- A conversation/thread. id is the client-minted UUID (kept as-is, so existing local
-- threads import under their own ids). last_* mirror the dashboard's thread-row display.
CREATE TABLE IF NOT EXISTS conversations (
    id            TEXT PRIMARY KEY,                          -- client UUID
    title         TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'coding')),
    wearing       TEXT,
    temperature   REAL,                                       -- the companion's per-thread dial
    last_from     TEXT CHECK (last_from IN ('companion', 'human')),
    last_snippet  TEXT,
    last_ts       INTEGER,                                    -- epoch-MS of last activity
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations (last_ts DESC);

-- One message in a thread. `meta` is an opaque JSON blob for the rich extras
-- (grounding, usage, toolEvents, recall, attached/generated images, voice clips) —
-- the DB never reads inside it; the renderer parses it back. `text` is always present
-- so threads stay searchable and snippet-able.
CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT NOT NULL,
    sender           TEXT NOT NULL CHECK (sender IN ('companion', 'human')),
    text             TEXT NOT NULL,
    meta             TEXT,                                    -- JSON, opaque
    ts               INTEGER NOT NULL,                        -- epoch-MS
    created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Threads are deleted with a manual cascade in the route (D1 FK enforcement is off),
-- so no ON DELETE CASCADE here. This index drives the per-thread message load.
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, ts);
