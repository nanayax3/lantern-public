import { Hono } from 'hono'
import type { Env } from '../env'

// The Album — generated images, cloud-stored. Bytes live in R2 (LIBRARY_FILES bucket,
// album/<id>); metadata in D1. Visible from phone AND desktop. See migration 0009.
const album = new Hono<{ Bindings: Env }>()

// List the album, newest first (metadata only — the bytes are fetched per image).
album.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, prompt, content_type, source, created_at FROM album ORDER BY created_at DESC LIMIT 300',
  ).all()
  return c.json(results)
})

// Store an image. Body: { image: dataURL | base64, prompt?, title?, source?, content_type? }.
album.post('/', async (c) => {
  if (!c.env.LIBRARY_FILES) return c.json({ error: 'R2 not bound (local dev)' }, 501)
  type Body = { image?: string; prompt?: string; title?: string; source?: string; content_type?: string }
  const b = await c.req.json<Body>().catch(() => ({}) as Body)
  if (!b.image) return c.json({ error: 'image required' }, 400)

  let ct = b.content_type ?? 'image/png'
  let b64 = b.image
  const m = b.image.match(/^data:([^;]+);base64,(.*)$/s)
  if (m) {
    ct = m[1]
    b64 = m[2]
  }
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

  const now = Date.now()
  const ins = await c.env.DB.prepare(
    'INSERT INTO album (title, prompt, r2_key, content_type, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id',
  )
    .bind(b.title ?? null, b.prompt ?? null, 'pending', ct, b.source ?? null, now)
    .first<{ id: number }>()
  const id = ins!.id
  const key = `album/${id}`
  await c.env.LIBRARY_FILES.put(key, bytes, { httpMetadata: { contentType: ct } })
  await c.env.DB.prepare('UPDATE album SET r2_key = ?1 WHERE id = ?2').bind(key, id).run()
  return c.json({ ok: true, id })
})

// Serve one image's bytes from R2 — this is the <img src> the apps point at.
album.get('/:id/image', async (c) => {
  if (!c.env.LIBRARY_FILES) return c.json({ error: 'R2 not bound' }, 501)
  const row = await c.env.DB.prepare('SELECT r2_key, content_type FROM album WHERE id = ?1')
    .bind(Number(c.req.param('id')))
    .first<{ r2_key: string; content_type: string }>()
  if (!row) return c.json({ error: 'not found' }, 404)
  const obj = await c.env.LIBRARY_FILES.get(row.r2_key)
  if (!obj) return c.json({ error: 'no image stored' }, 404)
  return new Response(obj.body, {
    headers: { 'Content-Type': row.content_type, 'Cache-Control': 'public, max-age=31536000' },
  })
})

// Remove an image (metadata + R2 object).
album.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT r2_key FROM album WHERE id = ?1').bind(id).first<{ r2_key: string }>()
  if (row && c.env.LIBRARY_FILES) await c.env.LIBRARY_FILES.delete(row.r2_key).catch(() => {})
  await c.env.DB.prepare('DELETE FROM album WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

export default album
