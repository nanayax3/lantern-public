import { Hono } from 'hono'
import type { Env } from '../env'

const home = new Hono<{ Bindings: Env }>()

home.get('/', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT room, mood, mood_descriptor, mood_image_path, updated_at FROM home WHERE id = 1',
  ).first()
  return c.json(row ?? null)
})

home.post('/', async (c) => {
  const body = await c.req.json<{
    room?: string
    mood?: string
    mood_descriptor?: string
    mood_image_path?: string
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE home SET
      room            = COALESCE(?1, room),
      mood            = COALESCE(?2, mood),
      mood_descriptor = COALESCE(?3, mood_descriptor),
      mood_image_path = COALESCE(?4, mood_image_path),
      updated_at      = ?5
    WHERE id = 1
  `).bind(
    body.room ?? null,
    body.mood ?? null,
    body.mood_descriptor ?? null,
    body.mood_image_path ?? null,
    now,
  ).run()

  return c.json({ ok: true })
})

export default home
