import { Hono } from 'hono'
import type { Env } from '../env'
import { embedText, upsertMemory } from '../embed'

const dreams = new Hono<{ Bindings: Env }>()

// List dreams, newest first. ?anchored=1 for anchored only. ?touch=1 marks the
// read as DELIBERATE recall (the dreams tool) — retelling a dream keeps it alive,
// so touched unanchored dreams get re-vivified. Passive views (the mind-tab pane,
// the wake-paint's reads) must NOT pass touch: looking isn't remembering.
const RECALL_BUMP = 0.4
const VIVIDNESS_CAP = 1.0

dreams.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 30)
  const anchoredOnly = c.req.query('anchored') === '1'
  const touch = c.req.query('touch') === '1'

  const stmt = anchoredOnly
    ? c.env.DB.prepare(
        `SELECT id, content, question, source_feelings, anchored, insight, source, created_at, anchored_at, vividness
         FROM dreams WHERE anchored = 1 ORDER BY created_at DESC LIMIT ?1`,
      ).bind(limit)
    : c.env.DB.prepare(
        `SELECT id, content, question, source_feelings, anchored, insight, source, created_at, anchored_at, vividness
         FROM dreams ORDER BY created_at DESC LIMIT ?1`,
      ).bind(limit)

  const { results } = await stmt.all()

  if (touch && results.length) {
    const ids = results.filter((r) => !r.anchored).map((r) => r.id as number)
    if (ids.length) {
      const ph = ids.map((_, i) => `?${i + 3}`).join(', ')
      await c.env.DB.prepare(
        `UPDATE dreams SET vividness = MIN(?1, vividness + ?2) WHERE id IN (${ph})`,
      ).bind(VIVIDNESS_CAP, RECALL_BUMP, ...ids).run()
    }
  }

  return c.json(results)
})

// Log a dream. Conscious mark OR thalamus Voice-3 generation (source says which).
dreams.post('/', async (c) => {
  const body = await c.req.json<{
    content: string
    question?: string
    source_feelings?: number[]
    source?: 'conscious_logged' | 'thalamus_observed'
  }>()

  if (!body.content) return c.json({ error: 'content is required' }, 400)

  const res = await c.env.DB.prepare(`
    INSERT INTO dreams (content, question, source_feelings, source)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(
    body.content,
    body.question ?? null,
    body.source_feelings ? JSON.stringify(body.source_feelings) : null,
    body.source ?? 'conscious_logged',
  ).run()

  return c.json({ ok: true, id: res.meta.last_row_id })
})

// Dream decay — the vividness model ("humans don't remember everything they
// ever dreamed either... vividness spikes when you interact with it, decays if
// you don't"). Nightly, every unanchored dream's
// vividness fades (×0.8 ≈ 3-day half-life — dreams fade FAST, that's the point);
// below the floor it genuinely VANISHES. True deletion, deliberately unlike the
// feelings' dim-never-delete: that rule protects LIVED memory and selfhood;
// dreams are generated residue that is nothing until chosen. Deliberate recall
// (the dreams tool, ?touch=1 above) re-vivifies; the anchor IS the act of
// remembering and exempts a dream forever. Untouched, a dream survives ~9 days.
// (No Vectorize orphans possible — unanchored dreams were never embedded.)
const NIGHTLY_FADE = 0.8
const VIVIDNESS_FLOOR = 0.15

export async function decayDreams(env: Env): Promise<{ forgotten: number; kept: number }> {
  await env.DB.prepare(
    'UPDATE dreams SET vividness = vividness * ?1 WHERE anchored = 0',
  ).bind(NIGHTLY_FADE).run()
  const res = await env.DB.prepare(
    'DELETE FROM dreams WHERE anchored = 0 AND vividness < ?1',
  ).bind(VIVIDNESS_FLOOR).run()
  const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM dreams').first<{ n: number }>()
  return { forgotten: res.meta.changes ?? 0, kept: kept?.n ?? 0 }
}

// Manual/test path — the cron path is the worker's scheduled() handler.
dreams.post('/decay', async (c) => {
  const result = await decayDreams(c.env)
  return c.json({ ok: true, ...result })
})

// Anchor a dream — "this matters, keep it." Conscious-only intentional act.
// METABOLISE-ON-ANCHOR: this is also the moment the dream gets embedded — dreams
// are laid down as ephemeral residue and only become surfaceable-by-meaning when
// the conscious mind anchors one. Anchoring = permanence, for real.
dreams.patch('/:id/anchor', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ insight?: string }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE dreams SET anchored = 1, insight = COALESCE(?1, insight), anchored_at = ?2
    WHERE id = ?3
  `).bind(body.insight ?? null, now, id).run()

  // Soft like every other embed: failure leaves embedded=0 (anchor flag stands).
  let embedded = false
  const row = await c.env.DB.prepare(
    'SELECT content, question, insight FROM dreams WHERE id = ?1',
  ).bind(id).first<{ content: string; question?: string; insight?: string }>()
  if (row && c.env.VEC) {
    const text = [row.content, row.question, row.insight].filter(Boolean).join('\n')
    const vector = await embedText(c.env, text)
    if (vector) {
      try {
        await upsertMemory(c.env, 'dream', id, vector, { created_at: now })
        await c.env.DB.prepare(
          'UPDATE dreams SET embedded = 1, vector_id = ?1 WHERE id = ?2',
        ).bind(`dream-${id}`, id).run()
        embedded = true
      } catch (err) {
        console.error('[dreams] metabolise-on-anchor failed (anchor still stands):', err)
      }
    }
  }

  return c.json({ ok: true, embedded })
})

export default dreams
