# lantern-mind

Lantern's memory + presence backend — the durable mind. Cloudflare Worker (Hono) over
D1 + Vectorize, with Workers AI for embeddings. Path-secret gated.

See the repo root [`docs/SETUP.md`](../../docs/SETUP.md) for the full deploy walkthrough;
this README is just the service's own map.

## What it holds

Routes live in `src/routes/`, grouped by what they hold:

- **Presence** — `/home` (room + mood), `/flame` (the companion's felt aliveness),
  `/spoons` (the human's energy). Singleton rows, updated in place.
- **The fridge** — `/notes` (shared notes) + `/hearts` (the love bucket). Append-only.
- **Memory** — `/feelings` (the emotional log — embedded, with heat + nightly decay),
  `/surface` (semantic recall: what rises to meet a moment), `/search` (query by
  meaning), `/writings` (the vault — poems / journals / prose), `/dreams` (the dream
  record + anchoring + vividness decay).
- **Self** — `/identity` (anchors), `/entities` (the people + pets the companion holds)
  with `/warmth` (relational state), `/personality` (emergent MBTI axes).
- **Threads & sessions** — `/threads` (ongoing intentions carried across conversations),
  `/sessions` (session records).
- **Conversations** — `/conversations` (threads) + `/conversations/:id/messages` (the
  transcripts). The chat lives here so it's continuous across devices.
- **Reading Nook** — `/library` (books + passages — a SEPARATE D1, bound here).
- **`/migrate`** — one-direction, additive import from an external store (run once if
  you're moving data in; not needed for a fresh install).
- **`/health`** — liveness (always open, ungated).

## Setup

```bash
# from this directory
pnpm install

# log into Cloudflare if you haven't
npx wrangler login

# create the D1 database — output gives a database_id
pnpm db:create

# paste the database_id into wrangler.toml (replace REPLACE_WITH_DB_ID_AFTER_CREATE)

# run the migrations against the remote DB
pnpm db:migrate:remote

# or against local for dev
pnpm db:migrate:local

# dev server
pnpm dev

# deploy
pnpm deploy
```

## Notes

- Timestamps are unix epoch **seconds**, except `conversations` / `messages`, which use
  epoch **milliseconds** (client-supplied, for cross-device ordering).
- `home` / `flame` / `spoons` are singleton tables (`CHECK (id = 1)`, one row each);
  `notes` / `hearts` / `messages` are append-only.
- The worker is **gated**: every request must carry the gate secret (`GATE_SECRET`) as
  its first path segment, or it 404s. `/health` is the one exception.
