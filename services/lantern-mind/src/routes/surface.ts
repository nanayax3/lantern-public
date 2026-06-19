import { Hono } from 'hono'
import type { Env } from '../env'
import { querySimilar, type MemoryKind } from '../embed'

const surface = new Hono<{ Bindings: Env }>()

// Surface memory by meaning, across kinds. The conscious `search` tool's deep
// path AND the thalamus's Voice 1 ambient paint both call this. Optional `kinds`
// narrows the sweep (e.g. just feelings); default is everything embedded.
surface.post('/', async (c) => {
  const body = await c.req.json<{
    query: string
    kinds?: MemoryKind[]
    limit?: number
  }>()
  if (!body.query) return c.json({ error: 'query is required' }, 400)

  const hits = await querySimilar(c.env, body.query, body.limit ?? 5, body.kinds)
  if (!hits.length) {
    return c.json({ query: body.query, surfaced: [], note: 'nothing surfaced (no embedded memory matched, or cloud bindings absent)' })
  }

  // Fetch each kind's rows in one query per table, then stitch back together in
  // similarity order so the caller gets a single ranked list.
  const rows = new Map<string, Record<string, unknown>>() // key: `${kind}-${id}`

  const feelingIds = hits.filter((h) => h.kind === 'feeling').map((h) => h.ref_id)
  if (feelingIds.length) {
    const ph = feelingIds.map((_, i) => `?${i + 1}`).join(', ')
    const { results } = await c.env.DB.prepare(
      `SELECT id, emotion, weight, pillar, content, source, created_at, heat FROM feelings WHERE id IN (${ph})`,
    ).bind(...feelingIds).all()
    for (const r of results) rows.set(`feeling-${r.id}`, { kind: 'feeling', ...r })
  }

  const writingIds = hits.filter((h) => h.kind === 'writing').map((h) => h.ref_id)
  if (writingIds.length) {
    const ph = writingIds.map((_, i) => `?${i + 1}`).join(', ')
    const { results } = await c.env.DB.prepare(
      `SELECT id, type, title, content, source, created_at FROM writings WHERE id IN (${ph})`,
    ).bind(...writingIds).all()
    for (const r of results) rows.set(`writing-${r.id}`, { kind: 'writing', ...r })
  }

  const factIds = hits.filter((h) => h.kind === 'entity_fact').map((h) => h.ref_id)
  if (factIds.length) {
    const ph = factIds.map((_, i) => `?${i + 1}`).join(', ')
    const { results } = await c.env.DB.prepare(
      `SELECT f.id, f.content, f.source, f.created_at, e.name AS entity, e.kind AS entity_kind
       FROM entity_facts f JOIN entities e ON e.id = f.entity_id
       WHERE f.id IN (${ph})`,
    ).bind(...factIds).all()
    for (const r of results) rows.set(`entity_fact-${r.id}`, { kind: 'entity_fact', ...r })
  }

  // Identity anchors — surfaced by meaning (the dynamic half; the floor is painted
  // separately by voice1). An anchor that matches this moment rises like any memory.
  const anchorIds = hits.filter((h) => h.kind === 'identity').map((h) => h.ref_id)
  if (anchorIds.length) {
    const ph = anchorIds.map((_, i) => `?${i + 1}`).join(', ')
    const { results } = await c.env.DB.prepare(
      `SELECT id, key, category, content, salience FROM identity_entities WHERE id IN (${ph}) AND active = 1 AND pinned = 0`,
    ).bind(...anchorIds).all()
    for (const r of results) rows.set(`identity-${r.id}`, { kind: 'identity', ...r })
  }

  // Dreams — only anchored ones are ever embedded (metabolise-on-anchor), so a
  // dream surfacing here always carries its insight: it's one the conscious chose.
  const dreamIds = hits.filter((h) => h.kind === 'dream').map((h) => h.ref_id)
  if (dreamIds.length) {
    const ph = dreamIds.map((_, i) => `?${i + 1}`).join(', ')
    const { results } = await c.env.DB.prepare(
      `SELECT id, content, question, insight, source, created_at FROM dreams WHERE id IN (${ph})`,
    ).bind(...dreamIds).all()
    for (const r of results) rows.set(`dream-${r.id}`, { kind: 'dream', ...r })
  }

  // Rerank: similarity (0.7) + heat (0.3). A reinforced feeling rises and persists;
  // non-feeling kinds carry neutral heat (1.0). Similarity still dominates — heat is a
  // boost for what's been re-felt, not an override.
  const HEAT_CAP = 3.0
  const surfaced = hits
    .map((h) => {
      const row = rows.get(`${h.kind}-${h.ref_id}`)
      return row ? { score: h.score, ...row } : null
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => {
      const heat = typeof (s as { heat?: number }).heat === 'number' ? (s as { heat?: number }).heat! : 1.0
      return { ...s, rank: s.score * 0.7 + Math.min(heat / HEAT_CAP, 1) * 0.3 }
    })
    .sort((a, b) => b.rank - a.rank)

  return c.json({ query: body.query, surfaced })
})

export default surface
