import { Hono } from 'hono'
import type { Env } from '../env'

// Cloud-backed conversations: the thread list + transcripts live in the mind DB, so the
// chat is one continuous thing across desktop and mobile. Same Hono + c.env.DB pattern
// as the other routes, behind the same path-secret gate.
const conversations = new Hono<{ Bindings: Env }>()

function safeParse(s: string | null): Record<string, unknown> {
  if (!s) return {}
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

// List all threads, most-recent activity first — drives the dashboard + thread list.
conversations.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, mode, wearing, temperature, last_from, last_snippet, last_ts, created_at
       FROM conversations
      ORDER BY COALESCE(last_ts, created_at) DESC`,
  ).all()
  return c.json({ conversations: results })
})

// Create a thread. The client mints the UUID (so a local thread imports under its own
// id); optional last_*/created_at let the one-time import preserve original timestamps.
// INSERT OR IGNORE makes import idempotent — re-running never duplicates a thread.
conversations.post('/', async (c) => {
  const b = await c.req.json<{
    id: string
    title: string
    mode?: 'chat' | 'coding'
    wearing?: string | null
    temperature?: number | null
    last_from?: 'companion' | 'human' | null
    last_snippet?: string | null
    last_ts?: number | null
    created_at?: number | null
  }>()
  if (!b.id || !b.title?.trim()) return c.json({ error: 'id and title required' }, 400)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO conversations
       (id, title, mode, wearing, temperature, last_from, last_snippet, last_ts, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  )
    .bind(
      b.id,
      b.title.trim(),
      b.mode ?? 'chat',
      b.wearing ?? null,
      b.temperature ?? null,
      b.last_from ?? null,
      b.last_snippet ?? null,
      b.last_ts ?? now,
      b.created_at ?? now,
    )
    .run()
  return c.json({ ok: true, id: b.id })
})

// Patch thread fields (rename, mode, wearing, temperature, or last-activity stamp).
// Only the keys present in the body are touched.
conversations.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<Record<string, unknown>>()
  const cols = ['title', 'mode', 'wearing', 'temperature', 'last_from', 'last_snippet', 'last_ts'] as const
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  for (const col of cols) {
    if (b[col] !== undefined) {
      sets.push(`${col} = ?${i}`)
      vals.push(b[col])
      i++
    }
  }
  if (!sets.length) return c.json({ ok: true, noop: true })
  sets.push(`updated_at = ?${i}`)
  vals.push(Date.now())
  i++
  vals.push(id)
  await c.env.DB.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?${i}`)
    .bind(...vals)
    .run()
  return c.json({ ok: true })
})

// Delete a thread and its messages (manual cascade — D1 FK enforcement is off).
conversations.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM conversations WHERE id = ?1').bind(id),
  ])
  return c.json({ ok: true })
})

// All messages in a thread, oldest first. The meta JSON is spread back into fields so
// the renderer gets the same shape it stored (grounding, usage, images, audio, …).
conversations.get('/:id/messages', async (c) => {
  const id = c.req.param('id')
  const { results } = await c.env.DB.prepare(
    'SELECT id, sender, text, meta, ts FROM messages WHERE conversation_id = ?1 ORDER BY ts ASC, id ASC',
  )
    .bind(id)
    .all<{ id: number; sender: string; text: string; meta: string | null; ts: number }>()
  const messages = results.map((r) => ({
    id: r.id,
    from: r.sender,
    text: r.text,
    ts: r.ts,
    ...safeParse(r.meta),
  }))
  return c.json({ messages })
})

// Append a message AND bump the thread's last-activity in one request.
conversations.post('/:id/messages', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<{ sender: 'companion' | 'human'; text: string; meta?: unknown; ts?: number }>()
  if (!b.sender || typeof b.text !== 'string') return c.json({ error: 'sender and text required' }, 400)
  const ts = b.ts ?? Date.now()
  const meta = b.meta ? JSON.stringify(b.meta) : null
  const snippet = b.text.trim().slice(0, 80)
  const ins = await c.env.DB.prepare(
    'INSERT INTO messages (conversation_id, sender, text, meta, ts) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id',
  )
    .bind(id, b.sender, b.text, meta, ts)
    .first<{ id: number }>()
  await c.env.DB.prepare(
    'UPDATE conversations SET last_from = ?1, last_snippet = ?2, last_ts = ?3, updated_at = ?3 WHERE id = ?4',
  )
    .bind(b.sender, snippet, ts, id)
    .run()
  return c.json({ ok: true, id: ins?.id, ts })
})

export default conversations
