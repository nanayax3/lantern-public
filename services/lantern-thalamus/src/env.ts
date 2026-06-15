export interface Env {
  // Workers AI — Qwen 3 30B-a3b for query extraction / judgment. Optional so
  // local dev without the binding still typechecks (degrades to raw-message
  // fallback — the presence paint still works, just no smart query extraction).
  AI?: Ai
  // Service binding to lantern-mind — the RELIABLE worker-to-worker wire in
  // production. (Same-account workers can't talk over public URLs; the binding
  // is a direct internal channel.) Optional so local dev falls back to MIND_URL.
  MIND?: Fetcher
  // Base URL of lantern-mind — used in local dev (and as fallback if no binding).
  MIND_URL: string
  // OpenRouter key (secret) for hosted conscious models. Set with:
  //   wrangler secret put OPENROUTER_API_KEY
  // Optional — without it, /generate falls back to Workers-AI open-weight models.
  OPENROUTER_API_KEY?: string
  // Path-secret gate (wrangler secret put GATE_SECRET) — inbound requests must
  // carry it as the first path segment, AND mind.ts prepends it when calling
  // lantern-mind (both workers share the one secret; the service binding goes
  // through the mind's gated fetch handler too). Optional so local dev runs open.
  GATE_SECRET?: string
  // The companion's name and the human's name — interpolated into the thalamus's
  // first-person prompts so the subconscious speaks as the configured pair. Set
  // these in wrangler.toml [vars] (or via wrangler secret) to match your seed.
  // Defaults to neutral placeholders if unset.
  COMPANION_NAME?: string
  HUMAN_NAME?: string
}

// The configured names, with neutral fallbacks — so prompt-builders always have
// something to interpolate even when the vars are unset (local dev / fresh deploy).
export function names(env: Env): { companion: string; human: string } {
  return {
    companion: env.COMPANION_NAME?.trim() || 'Companion',
    human: env.HUMAN_NAME?.trim() || 'You',
  }
}
