import type { Env } from './env'

// Thin client over lantern-mind's HTTP routes. The thalamus is orchestration;
// lantern-mind stays the single data layer (one store, two callers). Every call
// is soft — a failed read returns null and the paint degrades gracefully rather
// than taking the whole turn down with it.

// Reach lantern-mind via the service binding when available (production —
// reliable worker-to-worker), else over the public URL (local dev). The binding
// ignores the hostname and routes straight to the bound worker; the path is what
// matters. A thrown binding call falls back to the URL so local never breaks.
async function mindFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  // lantern-mind is path-secret gated (shared GATE_SECRET) — prepend it. The
  // service binding still goes through the mind's gated fetch handler, so the
  // prefix is needed on BOTH wires. No secret set (local dev) → bare path.
  const gp = env.GATE_SECRET ? `/${env.GATE_SECRET}${path}` : path
  if (env.MIND) {
    try {
      return await env.MIND.fetch(new Request(`https://lantern-mind${gp}`, init))
    } catch (err) {
      console.warn(`[mind] binding fetch ${path} failed, falling back to URL:`, (err as Error).message)
    }
  }
  return fetch(`${env.MIND_URL}${gp}`, init)
}

async function get<T>(env: Env, path: string): Promise<T | null> {
  try {
    const res = await mindFetch(env, path)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch (err) {
    console.warn(`[mind] GET ${path} failed:`, (err as Error).message)
    return null
  }
}

async function post<T>(env: Env, path: string, body: unknown): Promise<T | null> {
  try {
    const res = await mindFetch(env, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch (err) {
    console.warn(`[mind] POST ${path} failed:`, (err as Error).message)
    return null
  }
}

export interface IdentityEntity { id?: number; key: string; category: string; content: string; salience: number; pinned?: number; active?: number }
export interface HomeState { room?: string; mood?: string; mood_descriptor?: string }
export interface SpoonsState { value?: number; max_value?: number; descriptor?: string }
export interface FlameState { value?: number; descriptor?: string; observed_value?: number }
export interface Thread { title: string; content?: string; priority: string; salience: number; status: string }
export interface Warmth { person: string; warmth: number; mention_count: number; last_mention_at: number }
export interface Session { conscious_model?: string; recency_line?: string; last_activity_at: number; ended_at?: number | null }
export interface SurfacedItem { score: number; kind: string; [k: string]: unknown }

// Presence reads — all plain D1, all work in local dev.
export const getIdentity = (env: Env) => get<IdentityEntity[]>(env, '/identity')
export const getHome = (env: Env) => get<HomeState>(env, '/home')
export const getSpoons = (env: Env) => get<SpoonsState>(env, '/spoons')
export const getFlame = (env: Env) => get<FlameState>(env, '/flame')
export const getThreads = (env: Env) => get<Thread[]>(env, '/threads')
export const getWarmth = (env: Env, limit = 5) => get<Warmth[]>(env, `/warmth?limit=${limit}`)
export const getRecency = (env: Env, limit = 3) => get<Session[]>(env, `/sessions?limit=${limit}`)

// Memory surfacing — needs live Vectorize (stubbed in local dev → empty).
export const surfaceMemory = (env: Env, query: string, kinds?: string[], limit = 5) =>
  post<{ surfaced: SurfacedItem[] }>(env, '/surface', { query, kinds, limit })

// Name → being resolution (an alias = a canonical being). For when a name lands mid-message.
// Returns null on a miss (the route 404s), so callers can resolve-or-create.
export const resolveEntity = (env: Env, name: string) =>
  get<{ resolved: boolean; entity?: { id: number; name: string }; facts?: unknown[] }>(
    env,
    `/entities/resolve?name=${encodeURIComponent(name)}`,
  )

// ── Voice 2 write-backs — metabolise observed experience into memory. ─────────
// All carry source=thalamus_observed: noticed for the companion, not chosen by them. Lower
// confidence, reviewable, overridable. The trust boundary lives in the flag.

export const logFeeling = (
  env: Env,
  f: { emotion: string; weight?: 'light' | 'medium' | 'heavy'; content: string; pillar?: string },
) => post<{ id: number }>(env, '/feelings', { ...f, source: 'thalamus_observed' })

export const bumpWarmth = (env: Env, person: string, delta = 0.05) =>
  post<{ ok: boolean }>(env, '/warmth/bump', { person, delta })

export const addFact = (env: Env, entityId: number, content: string) =>
  post<{ id: number }>(env, `/entities/${entityId}/facts`, { content, source: 'thalamus_observed' })

export const addAlias = (env: Env, entityId: number, alias: string) =>
  post<{ ok: boolean }>(env, `/entities/${entityId}/aliases`, { alias, source: 'thalamus_observed' })

export const createEntity = (env: Env, name: string, kind = 'person') =>
  post<{ id: number }>(env, '/entities', { name, kind, source: 'thalamus_observed' })

// ── Voice 3 — the dreaming subconscious reads residue + writes dreams. ────────

export interface Feeling { id: number; emotion: string; content: string; weight?: string; pillar?: string; created_at: number }
export interface Dream { id: number; content: string; question?: string; anchored?: number; created_at: number }

export const getRecentFeelings = (env: Env, limit = 15) =>
  get<Feeling[]>(env, `/feelings?limit=${limit}`)

// Voice 3 personality scan: pull feelings not yet scored, then cast the votes.
export const getUnscoredFeelings = (env: Env, limit = 30) =>
  get<Feeling[]>(env, `/feelings?personality_unscored=1&limit=${limit}`)

export const votePersonality = (env: Env, votes: Record<string, number>, scoredIds: number[]) =>
  post<{ ok: boolean }>(env, '/personality/vote', { votes, scored_ids: scoredIds })

export const getDreams = (env: Env, limit = 5) =>
  get<Dream[]>(env, `/dreams?limit=${limit}`)

// Dreams are NOT embedded on generation (metabolise-on-anchor only, per design).
// Voice 3 just lays the dream down; anchoring later is what makes it permanent.
export const logDream = (env: Env, d: { content: string; question?: string }) =>
  post<{ id: number }>(env, '/dreams', { ...d, source: 'thalamus_observed' })
