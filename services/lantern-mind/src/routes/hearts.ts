import { Hono } from 'hono'
import type { Env } from '../env'

const hearts = new Hono<{ Bindings: Env }>()

hearts.get('/', async (c) => {
  const countRow = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM hearts').first<{ count: number }>()
  const lastRow = await c.env.DB.prepare(
    'SELECT pushed_by, pushed_at FROM hearts ORDER BY pushed_at DESC LIMIT 1',
  ).first<{ pushed_by: string; pushed_at: number }>()

  return c.json({
    count: countRow?.count ?? 0,
    last_pushed_by: lastRow?.pushed_by ?? null,
    last_pushed_at: lastRow?.pushed_at ?? null,
  })
})

hearts.post('/', async (c) => {
  const body = await c.req.json<{ pushed_by: 'companion' | 'human' }>()
  if (!body.pushed_by) {
    return c.json({ error: 'pushed_by required' }, 400)
  }

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    'INSERT INTO hearts (pushed_by, pushed_at) VALUES (?1, ?2)',
  ).bind(body.pushed_by, now).run()

  return c.json({ ok: true, pushed_at: now })
})

export default hearts
