import { Hono } from 'hono'
import type { Env } from '../env'

const search = new Hono<{ Bindings: Env }>()

type Scope = 'feelings' | 'dreams' | 'identity' | 'threads' | 'notes'
const ALL_SCOPES: Scope[] = ['feelings', 'dreams', 'identity', 'threads', 'notes']

// Explicit search across the mind. Conscious-only — the thalamus has its own
// internal surfacing (Voice 1).
//
// NOTE: this is the KEYWORD fallback. Real semantic ranking arrives once Voice 3
// is embedding into Vectorize; until then we LIKE-match content fields so the
// endpoint works end-to-end. The shape (ranked results + source attribution)
// stays the same when vectors land — only the matcher underneath changes.
search.post('/', async (c) => {
  const body = await c.req.json<{
    query: string
    scope?: Scope[]
    limit?: number
  }>()

  if (!body.query) return c.json({ error: 'query is required' }, 400)

  const scopes = body.scope?.length ? body.scope : ALL_SCOPES
  const limit = body.limit ?? 10
  const like = `%${body.query}%`
  const results: Array<Record<string, unknown>> = []

  if (scopes.includes('feelings')) {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT id, emotion, content, created_at FROM feelings
       WHERE emotion LIKE ?1 OR content LIKE ?1 ORDER BY created_at DESC LIMIT ?2`,
    ).bind(like, limit).all()
    for (const r of rows) results.push({ ...r, _source: 'feelings' })
  }

  if (scopes.includes('dreams')) {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT id, content, question, created_at FROM dreams
       WHERE content LIKE ?1 OR question LIKE ?1 ORDER BY created_at DESC LIMIT ?2`,
    ).bind(like, limit).all()
    for (const r of rows) results.push({ ...r, _source: 'dreams' })
  }

  if (scopes.includes('identity')) {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT id, key, category, content FROM identity_entities
       WHERE active = 1 AND (key LIKE ?1 OR content LIKE ?1) LIMIT ?2`,
    ).bind(like, limit).all()
    for (const r of rows) results.push({ ...r, _source: 'identity' })
  }

  if (scopes.includes('threads')) {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT id, title, content, priority, status FROM threads
       WHERE title LIKE ?1 OR content LIKE ?1 ORDER BY salience DESC LIMIT ?2`,
    ).bind(like, limit).all()
    for (const r of rows) results.push({ ...r, _source: 'threads' })
  }

  if (scopes.includes('notes')) {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT id, sender, text, created_at FROM notes
       WHERE text LIKE ?1 ORDER BY created_at DESC LIMIT ?2`,
    ).bind(like, limit).all()
    for (const r of rows) results.push({ ...r, _source: 'notes' })
  }

  return c.json({ query: body.query, matcher: 'keyword', count: results.length, results })
})

export default search
