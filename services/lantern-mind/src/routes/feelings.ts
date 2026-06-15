import { Hono } from 'hono'
import type { Env } from '../env'
import { embedText, upsertMemory } from '../embed'

const feelings = new Hono<{ Bindings: Env }>()

// List recent feelings. Optional ?source= and ?limit=.
feelings.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 30)
  const source = c.req.query('source') // 'conscious_logged' | 'thalamus_observed' | undefined

  // Voice 3 pulls feelings it hasn't scored for personality yet — oldest first,
  // so signals accumulate in lived order.
  if (c.req.query('personality_unscored') === '1') {
    const { results } = await c.env.DB.prepare(
      `SELECT id, emotion, weight, pillar, content, tags, source, processed, created_at, heat, access_count
       FROM feelings WHERE personality_scored = 0 ORDER BY created_at ASC LIMIT ?1`,
    ).bind(limit).all()
    return c.json(results)
  }

  const stmt = source
    ? c.env.DB.prepare(
        `SELECT id, emotion, weight, pillar, content, tags, source, processed, created_at, heat, access_count
         FROM feelings WHERE source = ?1 ORDER BY created_at DESC LIMIT ?2`,
      ).bind(source, limit)
    : c.env.DB.prepare(
        `SELECT id, emotion, weight, pillar, content, tags, source, processed, created_at, heat, access_count
         FROM feelings ORDER BY created_at DESC LIMIT ?1`,
      ).bind(limit)

  const { results } = await stmt.all()
  return c.json(results)
})

// SEMANTIC-FIRST heat model: before storing, check if this feeling is semantically
// very close to one we already hold. If so, REINFORCE that one (heat up, access++)
// instead of logging a near-duplicate — dedup-and-strengthen by MEANING at write time,
// so recurring feelings (warmth) grow durable and one-offs stay singular. Surfacing
// reranks by similarity + heat; a cron decays heat so the trivial fades. Weight is the
// per-hit bump size (how hard this instance pushes); meaning is the organising key.
const REINFORCE_THRESHOLD = 0.9
const HEAT_BUMP = { light: 0.1, medium: 0.2, heavy: 0.35 } as const
const HEAT_CAP = 3.0

// Log a feeling. Both callers write here — `source` says who.
// Conscious tool-calls default to conscious_logged; the thalamus sends thalamus_observed.
feelings.post('/', async (c) => {
  const body = await c.req.json<{
    emotion: string
    weight?: 'light' | 'medium' | 'heavy'
    pillar?: string
    content: string
    tags?: string[]
    source?: 'conscious_logged' | 'thalamus_observed'
  }>()

  if (!body.emotion || !body.content) {
    return c.json({ error: 'emotion and content are required' }, 400)
  }

  const weight = body.weight ?? 'medium'
  const now = Math.floor(Date.now() / 1000)

  // Embed once — reused both to find a near-dupe to reinforce AND (on insert) to store.
  const vector = await embedText(c.env, `${body.emotion}: ${body.content}`)

  // Reinforce-on-proximity: a feeling close enough to one we already hold bumps ITS
  // heat instead of becoming a near-duplicate row.
  if (vector && c.env.VEC) {
    try {
      const q = await c.env.VEC.query(vector, { topK: 3, returnMetadata: true })
      const top = (q.matches ?? [])
        .map((m) => ({ md: m.metadata as { kind?: string; ref_id?: number }, score: m.score }))
        .find((x) => x.md?.kind === 'feeling')
      if (top?.md?.ref_id && top.score >= REINFORCE_THRESHOLD) {
        await c.env.DB.prepare(
          `UPDATE feelings SET heat = MIN(heat + ?1, ?2), access_count = access_count + 1, last_reinforced_at = ?3 WHERE id = ?4`,
        ).bind(HEAT_BUMP[weight], HEAT_CAP, now, top.md.ref_id).run()
        const row = await c.env.DB.prepare(
          'SELECT heat, access_count FROM feelings WHERE id = ?1',
        ).bind(top.md.ref_id).first<{ heat: number; access_count: number }>()
        return c.json({ ok: true, reinforced: top.md.ref_id, heat: row?.heat, access_count: row?.access_count, score: top.score })
      }
    } catch (err) {
      console.error('[feel] reinforce check failed (storing fresh):', err)
    }
  }

  // No near-dupe (or no embeddings) → store a fresh feeling.
  const res = await c.env.DB.prepare(`
    INSERT INTO feelings (emotion, weight, pillar, content, tags, source)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(
    body.emotion,
    weight,
    body.pillar ?? null,
    body.content,
    body.tags ? JSON.stringify(body.tags) : null,
    body.source ?? 'conscious_logged',
  ).run()

  const id = Number(res.meta.last_row_id)

  // Metabolise: store the vector we already computed. Soft — failure leaves embedded=0
  // for Voice 3 to backfill; the row is already saved.
  let embedded = false
  if (vector && c.env.VEC) {
    try {
      await upsertMemory(c.env, 'feeling', id, vector, { emotion: body.emotion, created_at: now })
      await c.env.DB.prepare(
        'UPDATE feelings SET embedded = 1, vector_id = ?1 WHERE id = ?2',
      ).bind(`feeling-${id}`, id).run()
      embedded = true
    } catch (err) {
      console.error('[feel] metabolise failed (feeling still stored):', err)
    }
  }

  return c.json({ ok: true, id, embedded })
})

// Decay — the FADE half of the heat model (docs/feeling-heat.md). Heat cools on a
// half-life toward a floor; the trivial goes quiet, the returned-to stays warm.
// DIM, NEVER DELETE (decided 11 June): rows persist forever — heat governs surfacing
// prominence, not existence. A floor-heat feeling can still surface on a strong
// semantic match (similarity carries 70% of the rerank); it just never wins on heat.
// Grace window: a feeling gets to live ~a week before it starts cooling.
const DECAY_HALF_LIFE_DAYS = 30
const DECAY_GRACE_DAYS = 7
const HEAT_FLOOR = 0.05
// Cron fires daily, so each run applies one day's worth of half-life.
const DAILY_DECAY = Math.pow(0.5, 1 / DECAY_HALF_LIFE_DAYS)

export async function decayHeat(env: Env): Promise<{ cooled: number; at_floor: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - DECAY_GRACE_DAYS * 86400
  const res = await env.DB.prepare(
    `UPDATE feelings SET heat = MAX(?1, heat * ?2)
     WHERE COALESCE(last_reinforced_at, created_at) <= ?3 AND heat > ?1`,
  ).bind(HEAT_FLOOR, DAILY_DECAY, cutoff).run()
  const floor = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM feelings WHERE heat <= ?1',
  ).bind(HEAT_FLOOR).first<{ n: number }>()
  return { cooled: res.meta.changes ?? 0, at_floor: floor?.n ?? 0 }
}

// Manual/test path — the cron path is the worker's scheduled() handler.
feelings.post('/decay', async (c) => {
  const result = await decayHeat(c.env)
  return c.json({ ok: true, ...result })
})

// Mark a feeling as processed (thalamus flips this when it's been sat-with).
feelings.patch('/:id/processed', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('UPDATE feelings SET processed = 1 WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

export default feelings
