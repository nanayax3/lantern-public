import { Hono } from 'hono'
import type { Env } from '../env'

// Tiny key/value settings store — small JSON config blobs (e.g. the autonomous-wake
// schedule). GET returns the parsed value or null; PUT upserts.
const settings = new Hono<{ Bindings: Env }>()

settings.get('/:key', async (c) => {
  const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(c.req.param('key'))
    .first<{ value: string }>()
  if (!row) return c.json(null)
  try {
    return c.json(JSON.parse(row.value))
  } catch {
    return c.json(null)
  }
})

settings.put('/:key', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3',
  )
    .bind(c.req.param('key'), JSON.stringify(body), Date.now())
    .run()
  return c.json({ ok: true })
})

export default settings
