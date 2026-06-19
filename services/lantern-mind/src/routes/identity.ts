import { Hono } from 'hono'
import type { Env } from '../env'
import { embedText, upsertMemory } from '../embed'

// Identity entities — identity as DATA, composed into the system prompt at request
// time. The thalamus reads this (Voice 1): a small always-on FLOOR (pinned = 1) plus
// the rest surfaced by meaning through the recall — so anchors are embedded into the
// shared Vectorize index, the same way feelings are.
const identity = new Hono<{ Bindings: Env }>()

// Embed an anchor's content into the shared index (kind 'identity') so the recall can
// surface it by meaning. Best-effort — a failed embed never blocks the write.
async function embedAnchor(env: Env, id: number, category: string, content: string): Promise<void> {
  try {
    const vec = await embedText(env, content)
    if (vec) await upsertMemory(env, 'identity', id, vec, { category })
  } catch (err) {
    console.error('[identity] embed failed:', err)
  }
}

// List entities, salience-ordered (the order they'd compose into a prompt).
// Defaults to active only; ?all=true includes deactivated. ?category= filters.
identity.get('/', async (c) => {
  const includeInactive = c.req.query('all') === 'true'
  const category = c.req.query('category')

  const where: string[] = []
  const binds: unknown[] = []
  if (!includeInactive) where.push('active = 1')
  if (category) {
    binds.push(category)
    where.push(`category = ?${binds.length}`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { results } = await c.env.DB.prepare(
    `SELECT id, key, category, content, salience, active, pinned, created_at, updated_at
     FROM identity_entities ${clause}
     ORDER BY salience DESC, id ASC`,
  ).bind(...binds).all()
  return c.json(results)
})

// Re-embed every active anchor into the index. Backfill / one-time after enabling
// dynamic anchors (and safe to re-run). MUST be declared before /:key.
identity.post('/reembed', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, category, content FROM identity_entities WHERE active = 1',
  ).all<{ id: number; category: string; content: string }>()
  let n = 0
  for (const a of results) {
    await embedAnchor(c.env, a.id, a.category, a.content)
    n++
  }
  return c.json({ ok: true, embedded: n })
})

// Read one entity by key (e.g. 'Companion_Appearance').
identity.get('/:key', async (c) => {
  const key = c.req.param('key')
  const row = await c.env.DB.prepare(
    `SELECT id, key, category, content, salience, active, pinned, created_at, updated_at
     FROM identity_entities WHERE key = ?1`,
  ).bind(key).first()
  if (!row) return c.json({ error: 'not found', key }, 404)
  return c.json(row)
})

// Upsert by key. Seeding/editing identity. Key is the stable handle.
identity.post('/', async (c) => {
  const body = await c.req.json<{
    key: string
    category: string
    content: string
    salience?: number
    active?: boolean
    pinned?: boolean
  }>()

  if (!body.key) return c.json({ error: 'key is required' }, 400)
  if (!body.category) return c.json({ error: 'category is required' }, 400)
  if (!body.content) return c.json({ error: 'content is required' }, 400)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(`
    INSERT INTO identity_entities (key, category, content, salience, active, pinned, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(key) DO UPDATE SET
      category   = excluded.category,
      content    = excluded.content,
      salience   = excluded.salience,
      active     = excluded.active,
      pinned     = excluded.pinned,
      updated_at = excluded.updated_at
  `).bind(
    body.key,
    body.category,
    body.content,
    body.salience ?? 5,
    body.active === false ? 0 : 1,
    body.pinned ? 1 : 0,
    now,
  ).run()

  const row = await c.env.DB.prepare('SELECT id FROM identity_entities WHERE key = ?1').bind(body.key).first<{ id: number }>()
  if (row?.id) await embedAnchor(c.env, row.id, body.category, body.content)
  return c.json({ ok: true, id: row?.id })
})

// Partial update by id — content/category/salience/active/pinned. Only sent fields
// change; re-embeds when the content changes.
identity.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{
    category?: string
    content?: string
    salience?: number
    active?: boolean
    pinned?: boolean
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE identity_entities SET
      category   = COALESCE(?1, category),
      content    = COALESCE(?2, content),
      salience   = COALESCE(?3, salience),
      active     = COALESCE(?4, active),
      pinned     = COALESCE(?5, pinned),
      updated_at = ?6
    WHERE id = ?7
  `).bind(
    body.category ?? null,
    body.content ?? null,
    body.salience ?? null,
    body.active === undefined ? null : body.active ? 1 : 0,
    body.pinned === undefined ? null : body.pinned ? 1 : 0,
    now,
    id,
  ).run()

  // Re-embed when the content changed (so the recall stays accurate).
  if (body.content) {
    const row = await c.env.DB.prepare('SELECT category, content FROM identity_entities WHERE id = ?1')
      .bind(id)
      .first<{ category: string; content: string }>()
    if (row) await embedAnchor(c.env, id, row.category, row.content)
  }
  return c.json({ ok: true })
})

export default identity
