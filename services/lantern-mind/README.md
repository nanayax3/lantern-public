# lantern-mind

Lantern's primary mind backend — memory, presence, threads, flame, spoons, notes, hearts.

Cloudflare Worker + D1. Stays separate from NESTeq (see `../../docs/architecture.md`).

## Endpoints (current)

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/`         | service identity |
| GET    | `/health`   | liveness check |
| GET    | `/home`     | the companion's current room/mood |
| POST   | `/home`     | update room/mood |
| GET    | `/flame`    | the companion's flame reading |
| POST   | `/flame`    | update flame |
| GET    | `/spoons`   | the human's spoons reading |
| POST   | `/spoons`   | update spoons |
| GET    | `/notes`    | recent fridge notes (`?limit=5`) |
| POST   | `/notes`    | add a note (`{sender, text}`) |
| GET    | `/hearts`   | love bucket count + last push |
| POST   | `/hearts`   | push a heart (`{pushed_by}`) |

## To come

- `/feels` — feelings log
- `/threads` — active intentions
- `/identity` — anchors and appearance entities
- `/dreams` — dream record
- thalamus integration (will live in `services/lantern-thalamus`)

## Setup

```bash
# from this directory
pnpm install

# log into Cloudflare if you haven't
npx wrangler login

# create the D1 database — output gives a database_id
pnpm db:create

# paste the database_id into wrangler.toml (replace REPLACE_WITH_DB_ID_AFTER_CREATE)

# run the migration against the remote DB
pnpm db:migrate:remote

# or against local for dev
pnpm db:migrate:local

# dev server (http://localhost:8787)
pnpm dev

# deploy
pnpm deploy
```

## Notes

- All timestamps are unix epoch seconds (integer).
- `home`, `flame`, `spoons` are singleton tables — one row each, updated in place. The `CHECK (id = 1)` enforces it.
- `notes` and `hearts` are append-only.
- CORS is wide open for now — tighten when we have a real deploy.
