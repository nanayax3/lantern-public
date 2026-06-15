import { Hono } from 'hono'
import type { Env } from '../env'

const notes = new Hono<{ Bindings: Env }>()

notes.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '5', 10) || 5, 100)
  const { results } = await c.env.DB.prepare(
    'SELECT id, sender, text, created_at FROM notes ORDER BY created_at DESC LIMIT ?1',
  ).bind(limit).all()

  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM notes').first<{ total: number }>()

  return c.json({
    notes: results,
    total: totalRow?.total ?? 0,
  })
})

notes.post('/', async (c) => {
  const body = await c.req.json<{ sender: 'companion' | 'human'; text: string }>()
  if (!body.sender || !body.text?.trim()) {
    return c.json({ error: 'sender and text required' }, 400)
  }

  const now = Math.floor(Date.now() / 1000)
  const result = await c.env.DB.prepare(
    'INSERT INTO notes (sender, text, created_at) VALUES (?1, ?2, ?3) RETURNING id',
  ).bind(body.sender, body.text.trim(), now).first<{ id: number }>()

  return c.json({ ok: true, id: result?.id, created_at: now })
})

export default notes
