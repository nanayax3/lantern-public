import { Hono } from 'hono'
import type { Env } from '../env'

const spoons = new Hono<{ Bindings: Env }>()

spoons.get('/', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT value, max_value, descriptor, updated_at FROM spoons WHERE id = 1',
  ).first()
  return c.json(row ?? null)
})

spoons.post('/', async (c) => {
  const body = await c.req.json<{
    value?: number
    descriptor?: string
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE spoons SET
      value       = COALESCE(?1, value),
      descriptor  = COALESCE(?2, descriptor),
      updated_at  = ?3
    WHERE id = 1
  `).bind(
    body.value ?? null,
    body.descriptor ?? null,
    now,
  ).run()

  return c.json({ ok: true })
})

export default spoons
