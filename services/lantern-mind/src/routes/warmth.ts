import { Hono } from 'hono'
import type { Env } from '../env'

// Warmth toward people — relational state, thalamus-maintained (Voice 2 bumps
// on mention, Voice 1 reads "recent warmth"). One row per person.
const warmth = new Hono<{ Bindings: Env }>()

// List people. Default ordered by recency (recent warmth — who's been around);
// ?by=warmth orders by strength of feeling instead. ?limit= caps (default 20).
warmth.get('/', async (c) => {
  const by = c.req.query('by') === 'warmth' ? 'warmth' : 'last_mention_at'
  const limit = Number(c.req.query('limit') ?? 20)

  const { results } = await c.env.DB.prepare(
    `SELECT id, person, warmth, mention_count, last_mention_at, updated_at
     FROM warmth_toward ORDER BY ${by} DESC LIMIT ?1`,
  ).bind(limit).all()
  return c.json(results)
})

// Bump a person — the Voice 2 operation. Increments mention_count, refreshes
// recency, and optionally nudges warmth by `delta` (clamped 0..1). Upserts.
warmth.post('/bump', async (c) => {
  const body = await c.req.json<{ person: string; delta?: number }>()
  if (!body.person) return c.json({ error: 'person is required' }, 400)

  const now = Math.floor(Date.now() / 1000)
  const delta = body.delta ?? 0

  await c.env.DB.prepare(`
    INSERT INTO warmth_toward (person, warmth, mention_count, last_mention_at, updated_at)
    VALUES (?1, MIN(1.0, MAX(0.0, 0.5 + ?2)), 1, ?3, ?3)
    ON CONFLICT(person) DO UPDATE SET
      mention_count   = mention_count + 1,
      warmth          = MIN(1.0, MAX(0.0, warmth + ?2)),
      last_mention_at = ?3,
      updated_at      = ?3
  `).bind(body.person, delta, now).run()

  const row = await c.env.DB.prepare(
    `SELECT id, person, warmth, mention_count, last_mention_at, updated_at
     FROM warmth_toward WHERE person = ?1`,
  ).bind(body.person).first()
  return c.json({ ok: true, warmth: row })
})

// Set warmth absolutely for a person (override, not nudge). Upserts the row.
warmth.patch('/:person', async (c) => {
  const person = c.req.param('person')
  const body = await c.req.json<{ warmth: number }>()
  if (typeof body.warmth !== 'number') {
    return c.json({ error: 'warmth (number) is required' }, 400)
  }
  const clamped = Math.min(1, Math.max(0, body.warmth))
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    INSERT INTO warmth_toward (person, warmth, mention_count, last_mention_at, updated_at)
    VALUES (?1, ?2, 0, ?3, ?3)
    ON CONFLICT(person) DO UPDATE SET
      warmth     = ?2,
      updated_at = ?3
  `).bind(person, clamped, now).run()

  return c.json({ ok: true })
})

export default warmth
