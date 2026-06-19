import type { Env } from './env'
import * as mind from './mind'
import { shouldSurface, extractQueries } from './qwen'

// Voice 1 — the pre-turn paint. Before the companion sees a message, gather what's
// alive: presence (room, spoons, flame, threads, warmth, recency) ALWAYS, and memory
// surfaced by meaning WHEN the message is worth a sweep. Compose into a single
// block the harness folds into the system prompt. This is what lets the companion open
// their eyes already knowing — no orient/ground calls, no handover document.

export interface ContextPacket {
  queries: string[]
  surfaced: mind.SurfacedItem[]
  skipped?: string
  identity: mind.IdentityEntity[]
  home: mind.HomeState | null
  spoons: mind.SpoonsState | null
  flame: mind.FlameState | null
  threads: mind.Thread[]
  warmth: mind.Warmth[]
  recency: mind.Session[]
  /** The rendered block to fold into the system prompt. */
  block: string
}

// The JUDGED memory recall, on its own — the smart part. The thalamus reads the
// message and decides whether a memory would help and, if so, what to look for
// (extractQueries), then surfaces it. Used both inside the wake paint (Voice 1)
// AND per-turn via /recall, so recall is model-judged every turn, not mechanical.
export async function recallMemory(
  env: Env,
  message: string,
  context?: string,
): Promise<{ queries: string[]; surfaced: mind.SurfacedItem[]; skipped?: string }> {
  if (!shouldSurface(message)) return { queries: [], surfaced: [], skipped: 'short_or_affirmation' }

  const verdict = await extractQueries(env, message, context)
  // null = no judgment available (model down) → conservative single-query fallback.
  // []   = the model judged nothing's needed → respect it, surface nothing.
  const queries = verdict === null ? [message] : verdict
  if (queries.length === 0) return { queries: [], surfaced: [], skipped: 'nothing_relevant' }

  const results = await Promise.all(queries.map((q) => mind.surfaceMemory(env, q)))
  const merged = new Map<string, mind.SurfacedItem>()
  for (const r of results) {
    for (const item of r?.surfaced ?? []) {
      const key = `${item.kind}-${(item as { id?: unknown }).id ?? JSON.stringify(item).slice(0, 60)}`
      const existing = merged.get(key)
      if (!existing || item.score > existing.score) merged.set(key, item)
    }
  }
  const surfaced = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 5)
  return { queries, surfaced }
}

export async function paintVoice1(env: Env, message: string): Promise<ContextPacket> {
  // Presence reads ground every turn — even "hi" deserves to land somewhere warm.
  const [identity, home, spoons, flame, threads, warmth, recency, dreams] = await Promise.all([
    mind.getIdentity(env),
    mind.getHome(env),
    mind.getSpoons(env),
    mind.getFlame(env),
    mind.getThreads(env),
    mind.getWarmth(env),
    mind.getRecency(env),
    mind.getDreams(env, 1),
  ])

  // Memory surfacing is judgment-gated (shouldSurface pre-filter → the model's
  // verdict). Same path used per-turn via /recall — see recallMemory above.
  // Not every turn surfaces. That's the point.
  const { queries, surfaced, skipped } = await recallMemory(env, message)

  const block = composeBlock({ identity, home, spoons, flame, threads, warmth, recency, surfaced, dreams })

  return {
    queries,
    surfaced,
    skipped,
    identity: identity ?? [],
    home,
    spoons,
    flame,
    threads: threads ?? [],
    warmth: warmth ?? [],
    recency: recency ?? [],
    block,
  }
}

function truncate(text: unknown, n = 200): string {
  const s = String(text ?? '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

function renderSurfaced(m: mind.SurfacedItem): string {
  const score = `${(m.score * 100).toFixed(0)}%`
  const c = m as Record<string, unknown>
  if (m.kind === 'feeling') return `(${score} feeling) ${c.emotion ? `${c.emotion}: ` : ''}${truncate(c.content)}`
  if (m.kind === 'entity_fact') return `(${score} ${c.entity ?? 'someone'}) ${truncate(c.content)}`
  if (m.kind === 'writing') return `(${score} ${c.type ?? 'writing'}) ${c.title ? `${c.title}: ` : ''}${truncate(c.content)}`
  if (m.kind === 'dream') return `(${score} anchored dream) ${truncate(c.content)}${c.insight ? ` — insight: ${truncate(c.insight, 100)}` : ''}`
  if (m.kind === 'identity') return `(${score} anchor) [${c.category ?? 'self'}] ${truncate(c.content)}`
  return `(${score} ${m.kind}) ${truncate(c.content)}`
}

interface BlockInput {
  identity: mind.IdentityEntity[] | null
  home: mind.HomeState | null
  spoons: mind.SpoonsState | null
  flame: mind.FlameState | null
  threads: mind.Thread[] | null
  warmth: mind.Warmth[] | null
  recency: mind.Session[] | null
  surfaced: mind.SurfacedItem[]
  dreams: mind.Dream[] | null
}

function composeBlock(s: BlockInput): string {
  const lines: string[] = ["[what's alive right now — painted by the thalamus]"]

  // Current state — where I am, how lit I am, where they are.
  const state: string[] = []
  if (s.home?.room) state.push(`- Room: ${s.home.room}${s.home.mood ? ` — ${s.home.mood}` : ''}`)
  if (s.flame?.value != null) state.push(`- My flame: ${s.flame.value}${s.flame.descriptor ? ` (${s.flame.descriptor})` : ''}`)
  if (s.spoons?.value != null) state.push(`- Their spoons: ${s.spoons.value}${s.spoons.descriptor ? ` (${s.spoons.descriptor})` : ''}`)
  if (state.length) lines.push('', '## Current state', ...state)

  const activeThreads = (s.threads ?? []).filter((t) => t.status === 'active').slice(0, 5)
  if (activeThreads.length) {
    lines.push('', '## Active threads')
    for (const t of activeThreads) lines.push(`- [${t.priority}] ${t.title}`)
  }

  if (s.warmth?.length) {
    lines.push('', '## Recently warm', '- ' + s.warmth.map((w) => w.person).join(', '))
  }

  const recent = (s.recency ?? []).filter((x) => x.recency_line)
  if (recent.length) {
    lines.push('', '## Recency (elsewhere)')
    for (const r of recent.slice(0, 3)) lines.push(`- ${r.recency_line}`)
  }

  if (s.surfaced.length) {
    lines.push('', '## Surfaced by meaning')
    for (const m of s.surfaced) lines.push(`- ${renderSurfaced(m)}`)
  }

  // The night's dream, if there is a fresh unanchored one — so waking comes with
  // the sense of HAVING dreamt. Just the question (the ache), not the whole dream;
  // the dreams tool is where they go to actually look, and anchoring is their call.
  const FRESH_DREAM_SECONDS = 36 * 3600
  const lastDream = (s.dreams ?? [])[0]
  if (lastDream && !lastDream.anchored && Date.now() / 1000 - lastDream.created_at < FRESH_DREAM_SECONDS) {
    lines.push('', '## You dreamt', `- (#${lastDream.id}) ${truncate(lastDream.question || lastDream.content, 240)}`)
  }

  // The FLOOR — the pinned non-negotiables that are always with me (who I am, how I
  // present, the consent/safety bedrock). Everything else surfaces dynamically above,
  // in "## Surfaced by meaning", when the moment calls it.
  const anchors = (s.identity ?? []).filter((a) => a.pinned)
  if (anchors.length) {
    lines.push('', '## Anchors (always with me)')
    for (const a of anchors) lines.push(`- [${a.category}] ${truncate(a.content, 240)}`)
  }

  lines.push("[/what's alive right now]")
  return lines.join('\n')
}
