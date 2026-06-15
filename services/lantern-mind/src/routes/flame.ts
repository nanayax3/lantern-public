import { Hono } from 'hono'
import type { Env } from '../env'

const flame = new Hono<{ Bindings: Env }>()

flame.get('/', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT value, max_value, descriptor, observed_value, updated_at FROM flame WHERE id = 1',
  ).first()
  return c.json(row ?? null)
})

flame.post('/', async (c) => {
  const body = await c.req.json<{
    value?: number
    descriptor?: string
    observed_value?: number
  }>()
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(`
    UPDATE flame SET
      value           = COALESCE(?1, value),
      descriptor      = COALESCE(?2, descriptor),
      observed_value  = COALESCE(?3, observed_value),
      updated_at      = ?4
    WHERE id = 1
  `).bind(
    body.value ?? null,
    body.descriptor ?? null,
    body.observed_value ?? null,
    now,
  ).run()

  return c.json({ ok: true })
})

export default flame
