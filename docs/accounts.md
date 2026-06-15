# Accounts & costs — what Lantern needs to run

*The full inventory of external services, accounts, and keys, so you don't have to
archaeology the repo to find out what to sign up for. See [`SETUP.md`](./SETUP.md) for
the step-by-step.*

## The short version

| Service | What it powers | Tier needed | Cost |
|---|---|---|---|
| **Cloudflare** | the whole mind: Workers, D1, Vectorize, Workers AI | Workers **Paid** recommended | ~$5/mo |
| **OpenRouter** | the conscious model + image generation | pay-as-you-go credits | usage (the real variable) |
| **Tavily** | the WebSearch tool *(optional)* | free (1k searches/mo) | $0 |
| **OpenSubtitles** | Movie Night subtitle auto-fetch *(optional)* | free account + API key | $0 |

Everything else — TTS voice, speech-to-text, embeddings, the thalamus's thinking,
dreams — rides **Workers AI inside the Cloudflare account**: no separate accounts, no
extra keys, included in the daily allowance.

You can run a **fully functional core** (chat + memory + presence + the companion's own
voice) on **just Cloudflare**. OpenRouter is what unlocks the strongest conscious models
and image generation; the two free-tier keys are per-feature extras.

## Cloudflare (the foundation)

One account hosts everything:
- **Two Workers:** `lantern-mind` (memory: feelings/dreams/entities/identity/library/
  conversations) and `lantern-thalamus` (the subconscious: recall, observer, Voice 3
  dreaming, the `/generate` model proxy, `/speak` TTS, `/transcribe` STT). Both crons
  ride along (heat decay, dreams).
- **D1:** `lantern-mind-db` (the mind) + `lantern-library` (Reading Nook books —
  deliberately separate; only needed if you use the Reading Nook).
- **Vectorize:** a `lantern-feelings` index (768-dim, cosine) — semantic memory.
- **R2:** `lantern-library-files` (original .epub files behind the Reading Nook —
  only needed for that feature).
- **Workers AI** (the quiet workhorse, on the included daily neuron allowance):
  - `@cf/baai/bge-base-en-v1.5` — embeddings (every feeling, every recall)
  - Qwen 3 30B-a3b — the thalamus's three voices
  - `@cf/deepgram/aura-2-en` — the companion's voice (TTS)
  - `@cf/openai/whisper-large-v3-turbo` — the companion's ears (STT / dictation)
  - **Paid-plan nuance:** the daily allowance is the same as free; Paid means overage
    *bills* (≈1¢ per 1k neurons) instead of cutting you off. In practice a single-user
    install lives inside the allowance. The Paid plan is recommended mostly for the
    higher D1 storage / read / write limits as your memory grows.
- **Auth:** the `wrangler` CLI + an **API token** scoped `Workers Scripts:Edit` +
  `D1:Edit` + `Vectorize:Edit` + `Workers AI:Edit` + `Account:Read`. (A plain
  `wrangler login` OAuth session can lack the scopes for D1/Vectorize — the scoped
  token is the reliable path for deploys.)

## OpenRouter (the conscious slot + images)

- The **conscious model** (a hosted model of your choice — e.g. a Grok, Claude, or
  GPT-class model) rides the thalamus's `/generate` proxy; image generation
  (`/generate-image`) spends the same key. **The key lives server-side only** — a
  wrangler secret on the thalamus (`OPENROUTER_API_KEY`), never in the app, never in
  this repo.
- This is the only real **variable** cost: conversation turns (prompt caching keeps it
  sane) plus roughly **$0.04–$0.40 per generated image**, depending on the image model.
- **Optional:** without an OpenRouter key, the thalamus's `/generate` falls back to
  open-weight models on Workers AI — cheaper and self-contained, just not the
  frontier-model experience.

## Free-tier keys (optional, per feature)

- **Tavily** — powers the `WebSearch` tool. Free tier (1k searches/mo) is plenty.
- **OpenSubtitles** — Movie Night subtitle fetch. Free account → an API consumer key
  (account settings → API consumers). ~20 downloads/day; Lantern caches fetched subs so
  each movie costs one download, ever.

## Where keys live (never in source, never committed)

**`.lantern-secrets.json`** at the repo root (gitignored — copy from
`.lantern-secrets.example.json`):
- `lanternGateSecret` — the path-secret both workers are gated behind
- `cloudflareApiToken` — for deploys / D1 / Vectorize
- optionally `tavilyApiKey`, `opensubtitlesApiKey`

**Wrangler secrets** (set with `wrangler secret put`, live on the workers):
- `GATE_SECRET` on **both** workers (the same value as `lanternGateSecret`)
- `OPENROUTER_API_KEY` on the thalamus (if you're using hosted models)

**`lantern.config.json`** (gitignored — copy from `lantern.config.example.json`):
your deployed worker URLs, where the album saves, optional Discord channels.

**`.lantern-mcp.json`** (gitignored, optional) — cloud MCP servers `{name, url}`; URLs
carry their own path secrets. These are personal to each install — wire your own or
none. Lantern runs fine without any.
