import { Hono } from 'hono'
import type { Env } from '../env'
import { embedText, upsertMemory } from '../embed'

const writings = new Hono<{ Bindings: Env }>()

// List writings, newest first. Optional ?type= filter.
writings.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 30)
  const type = c.req.query('type') // image | journal | poem | prose | undefined

  const stmt = type
    ? c.env.DB.prepare(
        `SELECT id, type, title, content, tags, source, created_at
         FROM writings WHERE type = ?1 ORDER BY created_at DESC LIMIT ?2`,
      ).bind(type, limit)
    : c.env.DB.prepare(
        `SELECT id, type, title, content, tags, source, created_at
         FROM writings ORDER BY created_at DESC LIMIT ?1`,
      ).bind(limit)

  const { results } = await stmt.all()
  return c.json(results)
})

// Store a writing — image / journal / poem / prose. Conscious-only act.
// For images, `content` MUST be a permanent path (no ephemeral upload paths).
writings.post('/', async (c) => {
  const body = await c.req.json<{
    type: 'image' | 'journal' | 'poem' | 'prose'
    title?: string
    content: string
    tags?: string[]
  }>()

  if (!body.type || !body.content) {
    return c.json({ error: 'type and content are required' }, 400)
  }

  const res = await c.env.DB.prepare(`
    INSERT INTO writings (type, title, content, tags)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(
    body.type,
    body.title ?? null,
    body.content,
    body.tags ? JSON.stringify(body.tags) : null,
  ).run()

  const id = Number(res.meta.last_row_id)
  const now = Math.floor(Date.now() / 1000)

  // Metabolise — same soft path as feel. For images we embed title + tags (the
  // description), never the file path: a path carries no meaning to surface on.
  let embedded = false
  try {
    const textToEmbed = body.type === 'image'
      ? [body.title, ...(body.tags ?? [])].filter(Boolean).join(' ')
      : `${body.title ? body.title + ': ' : ''}${body.content}`

    if (textToEmbed.trim()) {
      const vector = await embedText(c.env, textToEmbed)
      if (vector) {
        await upsertMemory(c.env, 'writing', id, vector, { wtype: body.type, created_at: now })
        await c.env.DB.prepare(
          'UPDATE writings SET embedded = 1, vector_id = ?1 WHERE id = ?2',
        ).bind(`writing-${id}`, id).run()
        embedded = true
      }
    }
  } catch (err) {
    console.error('[write] metabolise failed (writing still stored):', err)
  }

  return c.json({ ok: true, id, embedded })
})

export default writings
