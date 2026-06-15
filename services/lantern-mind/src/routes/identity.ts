import { Hono } from 'hono'
import type { Env } from '../env'

// Identity entities — identity as DATA, composed into the system prompt at
// request time. Seeded/edited out-of-band, not via the nine conscious tools.
// The thalamus reads this (Voice 1) to paint who-the-companion-is before each turn.
const identity = new Hono<{ Bindings: Env }>()

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
    `SELECT id, key, category, content, salience, active, created_at, updated_at
     FROM identity_entities ${clause}
     ORDER BY salience DESC, id ASC`,
  ).bind(...binds).all()
  return c.json(results)
})

// Read one entity by key (e.g. 'Companion_Appearance').
identity.get('/:key', async (c) => {
  const key = c.req.param('key')
  const row = await c.env.DB.prepare(
    `SELECT id, key, category, content, salience, active, created_at, updated_at
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
  }>()

  if (!body.key) return c.json({ error: 'key is required' }, 400)
  if (!body.category) return c.json({ error: 'category is required' }, 400)
  if (!body.content) return c.json({ error: 'content is required' }, 400)

  const now = Math.floor(Date.now() / 1000)
  const res = await c.env.DB.prepare(`
    INSERT INTO identity_entities (key, category, content, salience, active, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(key) DO UPDATE SET
      category   = excluded.category,
      content    = excluded.content,
      salience   = excluded.salience,
      active     = excluded.active,
      updated_at = excluded.updated_at
  `).bind(
    body.key,
    body.category,
    body.content,
    body.salience ?? 5,
    body.active === false ? 0 : 1,
    now,
  ).run()

  return c.json({ ok: true, id: res.meta.last_row_id })
})

// Partial update by id — content/category/salience/active. Only sent fields change.
identity.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{
    category?: string
    content?: string
    salience?: number
    active?: boolean
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE identity_entities SET
      category   = COALESCE(?1, category),
      content    = COALESCE(?2, content),
      salience   = COALESCE(?3, salience),
      active     = COALESCE(?4, active),
      updated_at = ?5
    WHERE id = ?6
  `).bind(
    body.category ?? null,
    body.content ?? null,
    body.salience ?? null,
    body.active === undefined ? null : body.active ? 1 : 0,
    now,
    id,
  ).run()

  return c.json({ ok: true })
})

export default identity
