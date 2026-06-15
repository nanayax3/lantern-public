# Setup

Getting Lantern running from this template. Plan for ~30–45 minutes the first time —
most of it is Cloudflare provisioning, done once.

For what you're signing up for and what it costs, read [`accounts.md`](./accounts.md)
first. The short version: **Cloudflare** is required; **OpenRouter** is strongly
recommended (the conscious model + images); two free-tier keys are optional extras.

---

## 0. Prerequisites

- **Node 18+** and **pnpm** (`npm install -g pnpm`)
- A **Cloudflare account** (Workers Paid recommended — see accounts.md)
- The **wrangler** CLI is bundled; you'll authenticate it below
- *(recommended)* an **OpenRouter** account with a little credit

```bash
git clone https://github.com/nanayax3/lantern-public.git lantern
cd lantern
pnpm install
```

## 1. Authenticate wrangler

Either log in interactively:

```bash
npx wrangler login
```

…or, more reliably for deploys/D1/Vectorize, create a **scoped API token** in the
Cloudflare dashboard (`Workers Scripts:Edit` + `D1:Edit` + `Vectorize:Edit` +
`Workers AI:Edit` + `Account:Read`) and export it:

```bash
export CLOUDFLARE_API_TOKEN=your_token_here   # PowerShell: $env:CLOUDFLARE_API_TOKEN="..."
```

## 2. Provision Cloudflare resources

**The mind database (required):**

```bash
cd services/lantern-mind
pnpm db:create                 # = wrangler d1 create lantern-mind-db
```

Copy the `database_id` it prints into `services/lantern-mind/wrangler.toml`, replacing
`REPLACE_WITH_DB_ID_AFTER_CREATE` (the `DB` binding).

**The Vectorize index (required — semantic memory):**

```bash
npx wrangler vectorize create lantern-feelings --dimensions=768 --metric=cosine
```

**Apply the mind's schema:**

```bash
pnpm db:migrate:remote         # applies migrations/ to lantern-mind-db
```

**The Reading Nook (optional — books + audio):** only if you want to read together.

```bash
npx wrangler d1 create lantern-library     # paste its id into the LIBRARY binding in wrangler.toml
npx wrangler d1 execute lantern-library --remote --file=../lantern-library/migrations/0001_library.sql
npx wrangler r2 bucket create lantern-library-files
```

## 3. Set the worker secrets

The two workers share one **gate secret** — pick a long random string and use the SAME
value for both:

```bash
# in services/lantern-mind
npx wrangler secret put GATE_SECRET

cd ../lantern-thalamus
npx wrangler secret put GATE_SECRET          # same value as above
```

For hosted conscious models + image generation, add your OpenRouter key to the thalamus
(skip this to fall back to open-weight Workers-AI models):

```bash
# still in services/lantern-thalamus
npx wrangler secret put OPENROUTER_API_KEY
```

## 4. Name the companion in the thalamus

Edit `services/lantern-thalamus/wrangler.toml` → `[vars]`:

```toml
MIND_URL = "https://lantern-mind.YOUR-SUBDOMAIN.workers.dev"   # your deployed mind URL
COMPANION_NAME = "Aria"     # match your seed (step 7)
HUMAN_NAME = "Sam"          # your name
```

## 5. Deploy the workers

Deploy the **mind first** (the thalamus binds to it by name):

```bash
cd services/lantern-mind && pnpm deploy
cd ../lantern-thalamus  && pnpm deploy
```

Each prints its `https://….workers.dev` URL — you'll need them next.

## 6. App config + secrets file

From the repo root:

```bash
cp lantern.config.example.json lantern.config.json
cp .lantern-secrets.example.json .lantern-secrets.json
```

- In **`lantern.config.json`** set `workers.mindUrl` and `workers.thalamusUrl` to the
  two deployed URLs, and `paths.albumDir` to where images/voice clips should save
  (leave `""` to use `./album`).
- In **`.lantern-secrets.json`** set `lanternGateSecret` to the **same value** you used
  for `GATE_SECRET`, and `cloudflareApiToken` to your scoped token. The other keys are
  optional.

## 7. Make the companion yours

```bash
cp seed/companion.example.json seed/companion.json
```

Edit `seed/companion.json` — the only required fields are `companionName` and
`humanName`; everything else is optional and documented inside the file. Then, if you
like:
- tune the system prompt in **`seed/scaffold.md`** (keep it first-person — see the
  README's *first-person principle*),
- give the companion starter identity anchors in
  **`services/lantern-mind/seed/identity.json`** (or let them author their own later via
  the `anchor` tool).

> Leave the seed unfilled and Lantern still boots — as a friendly generic placeholder
> that tells you to come back here and fill it in.

## 8. Run

```bash
pnpm dev
```

The desktop app launches. Say hello.

---

## Troubleshooting

- **Everything 404s / "couldn't reach the mind":** the workers 404 every request that
  doesn't carry the gate secret. Check `lanternGateSecret` (config) === `GATE_SECRET`
  (both workers), and that `workers.mindUrl` / `thalamusUrl` are correct.
- **D1 / Vectorize "unauthorized" on deploy:** use the scoped **API token** (step 1),
  not the OAuth `wrangler login` session.
- **The companion has no name / generic replies:** the seed isn't filled in, or
  `COMPANION_NAME`/`HUMAN_NAME` on the thalamus don't match — set both.
- **Thalamus can't reach the mind:** deploy the mind **before** the thalamus so the
  service binding resolves.
