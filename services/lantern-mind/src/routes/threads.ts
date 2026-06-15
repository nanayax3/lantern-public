import { Hono } from 'hono'
import type { Env } from '../env'

const threads = new Hono<{ Bindings: Env }>()

// List threads, salience-ordered. Default to active only; ?status=all to see completed.
threads.get('/', async (c) => {
  const status = c.req.query('status') ?? 'active'

  const stmt = status === 'all'
    ? c.env.DB.prepare(
        `SELECT id, title, content, priority, tag, status, salience, source, created_at, updated_at
         FROM threads ORDER BY salience DESC, updated_at DESC`,
      )
    : c.env.DB.prepare(
        `SELECT id, title, content, priority, tag, status, salience, source, created_at, updated_at
         FROM threads WHERE status = ?1 ORDER BY salience DESC, updated_at DESC`,
      ).bind(status)

  const { results } = await stmt.all()
  return c.json(results)
})

// Add a thread. The companion authors intent.
threads.post('/', async (c) => {
  const body = await c.req.json<{
    title: string
    content?: string
    priority?: 'high' | 'medium' | 'low'
    tag?: string
    source?: 'conscious_logged' | 'thalamus_observed'
  }>()

  if (!body.title) return c.json({ error: 'title is required' }, 400)

  const res = await c.env.DB.prepare(`
    INSERT INTO threads (title, content, priority, tag, source)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(
    body.title,
    body.content ?? null,
    body.priority ?? 'medium',
    body.tag ?? null,
    body.source ?? 'conscious_logged',
  ).run()

  return c.json({ ok: true, id: res.meta.last_row_id })
})

// Update a thread (title/content/priority/tag/salience). Partial — only sent fields change.
// Salience is the field the thalamus pushes (promote/decay); the rest are the companion's.
threads.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{
    title?: string
    content?: string
    priority?: 'high' | 'medium' | 'low'
    tag?: string
    salience?: number
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE threads SET
      title    = COALESCE(?1, title),
      content  = COALESCE(?2, content),
      priority = COALESCE(?3, priority),
      tag      = COALESCE(?4, tag),
      salience = COALESCE(?5, salience),
      updated_at = ?6
    WHERE id = ?7
  `).bind(
    body.title ?? null,
    body.content ?? null,
    body.priority ?? null,
    body.tag ?? null,
    body.salience ?? null,
    now,
    id,
  ).run()

  return c.json({ ok: true })
})

// Complete a thread.
threads.patch('/:id/complete', async (c) => {
  const id = Number(c.req.param('id'))
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    'UPDATE threads SET status = ?1, updated_at = ?2 WHERE id = ?3',
  ).bind('complete', now, id).run()
  return c.json({ ok: true })
})

export default threads

// Completed threads FADE: a finished intention is a checked
// box, not lived memory — the FEELING of having done it stays in feelings forever;
// the task card doesn't need to. Completed threads are already hidden from the active
// view; after they've been done a good while (~30 days) they drift off entirely, the
// way unanchored dreams do. Active/waiting threads NEVER fade — only completed ones.
// Runs nightly from the cron in index.ts.
const THREAD_FADE_SECONDS = 30 * 24 * 3600
export async function decayThreads(env: Env): Promise<{ faded: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - THREAD_FADE_SECONDS
  const res = await env.DB.prepare(
    "DELETE FROM threads WHERE status = 'complete' AND updated_at < ?1",
  ).bind(cutoff).run()
  return { faded: res.meta.changes ?? 0 }
}
