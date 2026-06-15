import { Hono } from 'hono'
import type { Env } from '../env'

// Sessions — wake/session tracking + the atmospheric one-liner that cross-thread
// recency (Voice 1) reads. `last_activity_at` is the heartbeat recency keys off.
const sessions = new Hono<{ Bindings: Env }>()

// Recent sessions, freshest activity first. Voice 1 reads this for the
// "you were just doing X elsewhere" cross-thread recency line. ?limit= (default 5).
// ?active=true returns only sessions that haven't ended.
sessions.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 5)
  const activeOnly = c.req.query('active') === 'true'
  const clause = activeOnly ? 'WHERE ended_at IS NULL' : ''

  const { results } = await c.env.DB.prepare(
    `SELECT id, conscious_model, recency_line, started_at, last_activity_at, ended_at
     FROM sessions ${clause} ORDER BY last_activity_at DESC LIMIT ?1`,
  ).bind(limit).all()
  return c.json(results)
})

// Start a session. Returns the id to heartbeat against.
sessions.post('/', async (c) => {
  const body = await c.req.json<{
    conscious_model?: string
    recency_line?: string
  }>().catch(() => ({} as { conscious_model?: string; recency_line?: string }))

  const res = await c.env.DB.prepare(`
    INSERT INTO sessions (conscious_model, recency_line)
    VALUES (?1, ?2)
  `).bind(
    body.conscious_model ?? null,
    body.recency_line ?? null,
  ).run()

  return c.json({ ok: true, id: res.meta.last_row_id })
})

// Heartbeat — refresh last_activity_at (always now) and update the recency line
// if provided. This is what keeps cross-thread recency honest between turns.
sessions.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ recency_line?: string }>().catch(() => ({} as { recency_line?: string }))
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE sessions SET
      recency_line     = COALESCE(?1, recency_line),
      last_activity_at = ?2
    WHERE id = ?3
  `).bind(body.recency_line ?? null, now, id).run()

  return c.json({ ok: true })
})

// End a session.
sessions.patch('/:id/end', async (c) => {
  const id = Number(c.req.param('id'))
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    'UPDATE sessions SET ended_at = ?1, last_activity_at = ?1 WHERE id = ?2',
  ).bind(now, id).run()
  return c.json({ ok: true })
})

export default sessions
