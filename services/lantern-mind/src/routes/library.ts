import { Hono } from 'hono'
import type { Env } from '../env'

// Reading Nook storage — books + their parsed passages, in the SEPARATE lantern-library
// D1 (env.LIBRARY). A novel's text never touches the mind DB, and only the *current*
// passage is ever fetched for the conscious model. See docs/reading-nook.md.
const library = new Hono<{ Bindings: Env }>()

// The shelf — every book, most-recently-touched first (new books float up via added_at).
library.get('/books', async (c) => {
  const { results } = await c.env.LIBRARY.prepare(
    `SELECT id, title, author, source, total_passages, cur_passage, added_at, last_read_at
     FROM books ORDER BY COALESCE(last_read_at, added_at) DESC`,
  ).all()
  return c.json(results)
})

// Add a book (metadata only; passages arrive via the bulk endpoint after parsing).
library.post('/books', async (c) => {
  const b = await c.req
    .json<{ title?: string; author?: string; source?: string }>()
    .catch(() => ({} as { title?: string; author?: string; source?: string }))
  if (!b.title?.trim()) return c.json({ error: 'title is required' }, 400)
  const res = await c.env.LIBRARY.prepare(
    'INSERT INTO books (title, author, source, added_at) VALUES (?1, ?2, ?3, ?4)',
  ).bind(b.title.trim(), b.author?.trim() ?? null, b.source ?? null, Date.now()).run()
  return c.json({ ok: true, id: res.meta.last_row_id })
})

// One book's metadata + where we left off.
library.get('/books/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.LIBRARY.prepare(
    `SELECT id, title, author, source, total_passages, cur_passage, added_at, last_read_at
     FROM books WHERE id = ?1`,
  ).bind(id).first()
  if (!row) return c.json({ error: 'book not found' }, 404)
  return c.json(row)
})

// Remove a book + all its passages + its stored original.
library.delete('/books/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.LIBRARY.batch([
    c.env.LIBRARY.prepare('DELETE FROM passages WHERE book_id = ?1').bind(id),
    c.env.LIBRARY.prepare('DELETE FROM books WHERE id = ?1').bind(id),
  ])
  // Best-effort: drop the original from R2 too, so deleting a book leaves nothing behind.
  if (c.env.LIBRARY_FILES) {
    try {
      await c.env.LIBRARY_FILES.delete(epubKey(id))
    } catch (err) {
      console.error('[library] R2 original delete failed (row already gone):', err)
    }
  }
  return c.json({ ok: true })
})

// The original .epub lives in R2 under a stable per-book key.
const epubKey = (id: number): string => `epub/${id}.epub`

// Store a book's original .epub (raw bytes in the request body). Called by the
// desktop right after the passages upload, so the source is preserved. Idempotent —
// re-importing the same book id overwrites.
library.put('/books/:id/epub', async (c) => {
  const id = Number(c.req.param('id'))
  if (!c.env.LIBRARY_FILES) return c.json({ error: 'R2 not bound (local dev)' }, 501)
  const body = await c.req.arrayBuffer()
  if (!body.byteLength) return c.json({ error: 'empty body' }, 400)
  await c.env.LIBRARY_FILES.put(epubKey(id), body, {
    httpMetadata: { contentType: 'application/epub+zip' },
  })
  return c.json({ ok: true, bytes: body.byteLength })
})

// Fetch a book's original .epub back (re-parse / re-download). 404 if none stored.
library.get('/books/:id/epub', async (c) => {
  const id = Number(c.req.param('id'))
  if (!c.env.LIBRARY_FILES) return c.json({ error: 'R2 not bound (local dev)' }, 501)
  const obj = await c.env.LIBRARY_FILES.get(epubKey(id))
  if (!obj) return c.json({ error: 'no original stored for this book' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="book-${id}.epub"`,
    },
  })
})

// Bulk-insert parsed passages for a book, then set total_passages. Called once on import.
// Batched in chunks so a long novel doesn't blow the per-batch statement budget.
library.post('/books/:id/passages', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req
    .json<{ passages?: Array<{ seq: number; chapter?: string; text: string }> }>()
    .catch(() => ({} as { passages?: Array<{ seq: number; chapter?: string; text: string }> }))
  const passages = (body.passages ?? []).filter((p) => p && typeof p.text === 'string' && p.text.trim())
  if (!passages.length) return c.json({ error: 'no passages' }, 400)
  const stmts = passages.map((p) =>
    c.env.LIBRARY.prepare('INSERT INTO passages (book_id, seq, chapter, text) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, p.seq, p.chapter ?? null, p.text),
  )
  const CHUNK = 50
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await c.env.LIBRARY.batch(stmts.slice(i, i + CHUNK))
  }
  // Count actual rows, not this request's batch — correct under chunked imports.
  await c.env.LIBRARY.prepare(
    'UPDATE books SET total_passages = (SELECT COUNT(*) FROM passages WHERE book_id = ?1) WHERE id = ?1',
  ).bind(id).run()
  return c.json({ ok: true, count: passages.length })
})

// One passage by seq — the read-on-demand. This is the ONLY book text that reaches the
// model / the read-aloud. Returns the next seq's existence so the UI knows if there's more.
library.get('/books/:id/passages/:seq', async (c) => {
  const id = Number(c.req.param('id'))
  const seq = Number(c.req.param('seq'))
  const row = await c.env.LIBRARY.prepare(
    'SELECT seq, chapter, text FROM passages WHERE book_id = ?1 AND seq = ?2',
  ).bind(id, seq).first()
  if (!row) return c.json({ error: 'passage not found' }, 404)
  return c.json(row)
})

// Save reading position (+ stamp last_read_at) — called as we turn pages.
library.patch('/books/:id/position', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json<{ cur_passage?: number }>().catch(() => ({} as { cur_passage?: number }))
  const pos = Math.max(0, Math.floor(Number(b.cur_passage ?? 0)))
  await c.env.LIBRARY.prepare('UPDATE books SET cur_passage = ?1, last_read_at = ?2 WHERE id = ?3')
    .bind(pos, Date.now(), id).run()
  return c.json({ ok: true, cur_passage: pos })
})

export default library
