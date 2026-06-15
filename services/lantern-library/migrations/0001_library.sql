-- lantern-library — books we read together in the Reading Nook.
-- SEPARATE from lantern-mind on purpose: a novel's text never sits near our memory.
-- Queried only when the nook is open, and only the current passage is ever handed to
-- the conscious model. See docs/reading-nook.md.

-- One row per book = the library shelf entry. Holds the metadata we track + position.
CREATE TABLE IF NOT EXISTS books (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  author         TEXT,
  source         TEXT,                          -- 'epub' | 'text' | 'gutenberg'
  total_passages INTEGER NOT NULL DEFAULT 0,
  cur_passage    INTEGER NOT NULL DEFAULT 0,     -- where we left off (passage seq)
  added_at       INTEGER NOT NULL,              -- epoch ms (app-provided)
  last_read_at   INTEGER                         -- epoch ms, null until first opened
);

-- The parsed, chunked text. One row ≈ one paragraph: the read-aloud chunk for Aura
-- (per-call length limit) AND the natural pause/interject point.
CREATE TABLE IF NOT EXISTS passages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id  INTEGER NOT NULL,
  seq      INTEGER NOT NULL,                     -- order within the book (0-based)
  chapter  TEXT,                                 -- chapter title/label if known
  text     TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

-- Reading walks passages in seq order, scoped to one book — index that path.
CREATE INDEX IF NOT EXISTS idx_passages_book_seq ON passages(book_id, seq);
