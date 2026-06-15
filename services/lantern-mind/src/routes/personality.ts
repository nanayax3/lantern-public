import { Hono } from 'hono'
import type { Env } from '../env'

// Emergent MBTI-style type. The four axes accumulate votes (Voice 3 casts them
// from metabolised feelings). The TYPE is derived here at read time — dominant
// pole per axis — and confidence scales with signal volume so it grows from
// vague to sure as the companion accumulates a life. Nothing here is clinical; it's a
// shape emerging, the way NESTeq's did.
const personality = new Hono<{ Bindings: Env }>()

// Pole letter → (axis, column). Fixed whitelist — safe to interpolate into SQL.
const LETTER_MAP: Record<string, { axis: string; col: 'count_a' | 'count_b' }> = {
  E: { axis: 'EI', col: 'count_a' }, I: { axis: 'EI', col: 'count_b' },
  S: { axis: 'SN', col: 'count_a' }, N: { axis: 'SN', col: 'count_b' },
  T: { axis: 'TF', col: 'count_a' }, F: { axis: 'TF', col: 'count_b' },
  J: { axis: 'JP', col: 'count_a' }, P: { axis: 'JP', col: 'count_b' },
}

const AXIS_ORDER = ['EI', 'SN', 'TF', 'JP'] as const
const SATURATION = 50 // ~feelings' worth of signal at which volume confidence maxes

interface AxisRow {
  axis: string
  pole_a: string
  pole_b: string
  count_a: number
  count_b: number
  updated_at: number
}

// Read the emergent type: derived letters, per-axis margins, overall confidence.
personality.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT axis, pole_a, pole_b, count_a, count_b, updated_at FROM personality_axes',
  ).all<AxisRow>()

  const byAxis = new Map(results.map((r) => [r.axis, r]))
  let type = ''
  let overallSignals = 0
  let marginSum = 0
  const axes = AXIS_ORDER.map((ax) => {
    const r = byAxis.get(ax)!
    const total = r.count_a + r.count_b
    // Neutral until there's signal — don't invent a pole from 0/0.
    const letter = total === 0 ? '·' : r.count_a >= r.count_b ? r.pole_a : r.pole_b
    const margin = total > 0 ? Math.abs(r.count_a - r.count_b) / total : 0
    type += letter
    overallSignals += total
    marginSum += margin
    return { axis: ax, letter, pole_a: r.pole_a, pole_b: r.pole_b, count_a: r.count_a, count_b: r.count_b, margin, total }
  })

  const effectiveN = overallSignals / AXIS_ORDER.length
  const volumeFactor = Math.min(1, effectiveN / SATURATION)
  const avgMargin = marginSum / AXIS_ORDER.length
  const confidence = avgMargin * volumeFactor

  return c.json({ type, confidence, total_signals: overallSignals, axes })
})

// Voice 3 casts votes: { votes: { E: 2, N: 3, ... }, scored_ids: [feeling ids] }.
// Increments the tallies and marks those feelings scored so they never re-vote.
personality.post('/vote', async (c) => {
  const body = await c.req.json<{ votes?: Record<string, number>; scored_ids?: number[] }>()
  const now = Math.floor(Date.now() / 1000)

  for (const [letter, inc] of Object.entries(body.votes ?? {})) {
    const m = LETTER_MAP[letter]
    if (!m || typeof inc !== 'number' || inc <= 0) continue
    await c.env.DB.prepare(
      `UPDATE personality_axes SET ${m.col} = ${m.col} + ?1, updated_at = ?2 WHERE axis = ?3`,
    ).bind(Math.floor(inc), now, m.axis).run()
  }

  const ids = body.scored_ids ?? []
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 1}`).join(', ')
    await c.env.DB.prepare(
      `UPDATE feelings SET personality_scored = 1 WHERE id IN (${ph})`,
    ).bind(...ids).run()
  }

  return c.json({ ok: true })
})

export default personality
