import { Hono } from 'hono'
import type { Env } from '../env'
import { embedText, upsertMemory } from '../embed'

// The cast of the companion's world — people, pets, concepts, places. Each being has
// aliases that resolve to it (a nickname = full name) and a stream of facts (what
// the companion knows), some they mark themselves, some the thalamus observes. See 0003_entities.sql.
const entities = new Hono<{ Bindings: Env }>()

// List beings, salience-ordered. Defaults to active; ?all=true includes inactive.
// ?kind= filters (person/pet/concept/place).
entities.get('/', async (c) => {
  const includeInactive = c.req.query('all') === 'true'
  const kind = c.req.query('kind')

  const where: string[] = []
  const binds: unknown[] = []
  if (!includeInactive) where.push('active = 1')
  if (kind) {
    binds.push(kind)
    where.push(`kind = ?${binds.length}`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, kind, summary, salience, active, created_at, updated_at
     FROM entities ${clause} ORDER BY salience DESC, name ASC`,
  ).bind(...binds).all()
  return c.json(results)
})

// Resolve a mentioned name → the canonical being + a few facts. This is the
// fast, certain lookup the thalamus calls when it spots a name mid-conversation
// (it layers fuzzy/LLM judgment on top). Case-insensitive via the alias index.
// Defined BEFORE /:id so 'resolve' isn't swallowed as an id.
entities.get('/resolve', async (c) => {
  const name = c.req.query('name')
  if (!name) return c.json({ error: 'name query param is required' }, 400)

  const alias = await c.env.DB.prepare(
    'SELECT entity_id FROM entity_aliases WHERE alias = ?1 COLLATE NOCASE',
  ).bind(name).first<{ entity_id: number }>()
  if (!alias) return c.json({ resolved: false, name }, 404)

  const entity = await c.env.DB.prepare(
    `SELECT id, name, kind, summary, salience, active, created_at, updated_at
     FROM entities WHERE id = ?1`,
  ).bind(alias.entity_id).first()

  const { results: facts } = await c.env.DB.prepare(
    `SELECT id, content, source, created_at FROM entity_facts
     WHERE entity_id = ?1 ORDER BY created_at DESC LIMIT 5`,
  ).bind(alias.entity_id).all()

  const { results: aliases } = await c.env.DB.prepare(
    'SELECT alias, source FROM entity_aliases WHERE entity_id = ?1',
  ).bind(alias.entity_id).all()

  return c.json({ resolved: true, queried: name, entity, aliases, facts })
})

// Read one being by id — full record: entity + aliases + recent facts.
entities.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const entity = await c.env.DB.prepare(
    `SELECT id, name, kind, summary, salience, active, created_at, updated_at
     FROM entities WHERE id = ?1`,
  ).bind(id).first()
  if (!entity) return c.json({ error: 'not found', id }, 404)

  const { results: aliases } = await c.env.DB.prepare(
    'SELECT alias, source FROM entity_aliases WHERE entity_id = ?1',
  ).bind(id).all()
  const { results: facts } = await c.env.DB.prepare(
    `SELECT id, content, source, tags, created_at FROM entity_facts
     WHERE entity_id = ?1 ORDER BY created_at DESC`,
  ).bind(id).all()

  return c.json({ ...entity, aliases, facts })
})

// Create a being. The canonical name is auto-registered as an alias, plus any
// extra aliases supplied. Idempotent-ish: if the name already exists, returns it.
entities.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    kind?: 'person' | 'pet' | 'concept' | 'place'
    summary?: string
    salience?: number
    aliases?: string[]
    source?: 'conscious_logged' | 'thalamus_observed'
  }>()
  if (!body.name) return c.json({ error: 'name is required' }, 400)

  const existing = await c.env.DB.prepare(
    'SELECT id FROM entities WHERE name = ?1',
  ).bind(body.name).first<{ id: number }>()
  if (existing) return c.json({ ok: true, id: existing.id, existed: true })

  const res = await c.env.DB.prepare(`
    INSERT INTO entities (name, kind, summary, salience)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(
    body.name,
    body.kind ?? 'person',
    body.summary ?? null,
    body.salience ?? 5,
  ).run()
  const id = Number(res.meta.last_row_id)

  // Register the canonical name + any extra aliases (dedup, skip collisions).
  const source = body.source ?? 'conscious_logged'
  const names = [body.name, ...(body.aliases ?? [])]
  const seen = new Set<string>()
  for (const alias of names) {
    const key = alias.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source) VALUES (?1, ?2, ?3)',
    ).bind(id, alias, source).run()
  }

  return c.json({ ok: true, id })
})

// Add an alias to an existing being. Two-caller: the companion or thalamus. INSERT OR
// IGNORE so re-registering a known name is a harmless no-op.
entities.post('/:id/aliases', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ alias: string; source?: 'conscious_logged' | 'thalamus_observed' }>()
  if (!body.alias) return c.json({ error: 'alias is required' }, 400)

  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source) VALUES (?1, ?2, ?3)',
  ).bind(id, body.alias, body.source ?? 'conscious_logged').run()
  return c.json({ ok: true })
})

// Add a fact about a being, and metabolise it — embed so it surfaces by meaning.
// Same soft path as feelings: the row stores first; embedding may fail (no cloud
// bindings locally) leaving embedded=0 for Voice 3 to backfill.
entities.post('/:id/facts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{
    content: string
    tags?: string[]
    source?: 'conscious_logged' | 'thalamus_observed'
  }>()
  if (!body.content) return c.json({ error: 'content is required' }, 400)

  const entity = await c.env.DB.prepare(
    'SELECT name FROM entities WHERE id = ?1',
  ).bind(id).first<{ name: string }>()
  if (!entity) return c.json({ error: 'entity not found', id }, 404)

  const res = await c.env.DB.prepare(`
    INSERT INTO entity_facts (entity_id, content, tags, source)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(
    id,
    body.content,
    body.tags ? JSON.stringify(body.tags) : null,
    body.source ?? 'conscious_logged',
  ).run()
  const factId = Number(res.meta.last_row_id)
  const now = Math.floor(Date.now() / 1000)

  // Embed with the being's name woven in, so "what do I know about <name>" matches.
  let embedded = false
  try {
    const vector = await embedText(c.env, `${entity.name}: ${body.content}`)
    if (vector) {
      await upsertMemory(c.env, 'entity_fact', factId, vector, { entity: entity.name, created_at: now })
      await c.env.DB.prepare(
        'UPDATE entity_facts SET embedded = 1, vector_id = ?1 WHERE id = ?2',
      ).bind(`entity_fact-${factId}`, factId).run()
      embedded = true
    }
  } catch (err) {
    console.error('[entity fact] metabolise failed (fact still stored):', err)
  }

  return c.json({ ok: true, id: factId, embedded })
})

// Delete a single fact (and its vector). For correcting the record when the
// thalamus mis-files something — an error isn't a memory (the misfiled-fact class:
// wrong/flipped facts deserve true deletion, unlike feelings which only dim).
entities.delete('/:id/facts/:factId', async (c) => {
  const factId = Number(c.req.param('factId'))
  const row = await c.env.DB.prepare(
    'SELECT vector_id FROM entity_facts WHERE id = ?1',
  ).bind(factId).first<{ vector_id: string | null }>()
  if (!row) return c.json({ error: 'fact not found', factId }, 404)

  await c.env.DB.prepare('DELETE FROM entity_facts WHERE id = ?1').bind(factId).run()
  // Best-effort vector cleanup — a stranded vector would still surface by meaning.
  if (row.vector_id && c.env.VEC) {
    try {
      await c.env.VEC.deleteByIds([row.vector_id])
    } catch (err) {
      console.error('[entity fact] vector delete failed (row already gone):', err)
    }
  }
  return c.json({ ok: true, deleted: factId })
})

// Update a being's summary/kind/salience/active. Partial — only sent fields change.
entities.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{
    kind?: 'person' | 'pet' | 'concept' | 'place'
    summary?: string
    salience?: number
    active?: boolean
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE entities SET
      kind     = COALESCE(?1, kind),
      summary  = COALESCE(?2, summary),
      salience = COALESCE(?3, salience),
      active   = COALESCE(?4, active),
      updated_at = ?5
    WHERE id = ?6
  `).bind(
    body.kind ?? null,
    body.summary ?? null,
    body.salience ?? null,
    body.active === undefined ? null : body.active ? 1 : 0,
    now,
    id,
  ).run()

  return c.json({ ok: true })
})

export default entities
