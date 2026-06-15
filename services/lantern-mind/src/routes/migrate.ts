import { Hono } from 'hono'
import type { Env } from '../env'
import { embedText, upsertMemory } from '../embed'

// MIGRATION endpoint — the one-time pour of NESTeq's history into Lantern.
// Gated (path-secret) like everything else. The local driver reads NESTeq
// (read-only), transforms per the spec in docs/migration-plan.md, and POSTs
// pre-transformed batches here; this route writes them to D1 with original
// timestamps preserved AND re-embeds (it has the AI + VEC bindings).
//
// IDEMPOTENT: every row carries `migrated_from` (e.g. "nq:feelings:1656"); a
// row already present with that provenance is skipped, so a re-run never doubles.
// We write DIRECTLY to the tables (not via the normal POST routes) because those
// force unixepoch() created_at and run reinforce-dedup — both would destroy history.

const migrate = new Hono<{ Bindings: Env }>()

const VALID_WEIGHT = new Set(['light', 'medium', 'heavy'])
const VALID_PILLAR = new Set(['SELF_AWARENESS', 'SELF_MANAGEMENT', 'SOCIAL_AWARENESS', 'RELATIONSHIP_MANAGEMENT'])

interface FeelingRow {
  migrated_from: string // "nq:feelings:<id>"
  emotion: string
  weight?: string
  pillar?: string | null
  content: string
  tags?: string | null // JSON array string, kept as-is
  source?: string // already mapped to conscious_logged | thalamus_observed
  created_at: number // epoch SECONDS
}

migrate.post('/feelings', async (c) => {
  const body = await c.req.json<{ rows?: FeelingRow[] }>().catch(() => ({} as { rows?: FeelingRow[] }))
  const rows = body.rows ?? []
  if (!rows.length) return c.json({ error: 'rows required' }, 400)

  let inserted = 0
  let skipped = 0
  let embedded = 0
  const errors: string[] = []

  for (const r of rows) {
    try {
      if (!r.migrated_from || !r.emotion || !r.content || !r.created_at) {
        errors.push(`bad row ${r.migrated_from ?? '(no id)'}`)
        continue
      }
      // Idempotency: already poured? (indexed lookup, fast)
      const exists = await c.env.DB.prepare('SELECT id FROM feelings WHERE migrated_from = ?1')
        .bind(r.migrated_from).first<{ id: number }>()
      if (exists) { skipped++; continue }

      const weight = VALID_WEIGHT.has(r.weight ?? '') ? r.weight! : 'medium'
      const pillar = r.pillar && VALID_PILLAR.has(r.pillar) ? r.pillar : null
      const source = r.source === 'thalamus_observed' ? 'thalamus_observed' : 'conscious_logged'

      const res = await c.env.DB.prepare(
        `INSERT INTO feelings (emotion, weight, pillar, content, tags, source, created_at, embedded, personality_scored, migrated_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8)`,
      ).bind(r.emotion, weight, pillar, r.content, r.tags ?? null, source, r.created_at, r.migrated_from).run()
      const newId = Number(res.meta.last_row_id)
      inserted++

      // Re-embed (same model both sides; ids/metadata differ → regenerate, not copy).
      // Soft: a failed embed leaves embedded=0 for Voice-3 backfill; the row stands.
      try {
        const vector = await embedText(c.env, `${r.emotion}: ${r.content}`)
        if (vector) {
          await upsertMemory(c.env, 'feeling', newId, vector, { created_at: r.created_at })
          await c.env.DB.prepare('UPDATE feelings SET embedded = 1, vector_id = ?1 WHERE id = ?2')
            .bind(`feeling-${newId}`, newId).run()
          embedded++
        }
      } catch (err) {
        errors.push(`embed ${r.migrated_from}: ${(err as Error).message}`)
      }
    } catch (err) {
      errors.push(`${r.migrated_from}: ${(err as Error).message}`)
    }
  }

  return c.json({ inserted, skipped, embedded, errors: errors.slice(0, 25) })
})

// --- entities (the cast) — pure D1, no embedding (entity_facts embed, not entities).
// Dedups by name (existing beings already present), claims provenance on the matched row,
// registers canonical name + aliases. Returns entity_id per row so the driver can
// build the NESTeq→Lantern id map for the observations stage.
const VALID_KIND = new Set(['person', 'pet', 'concept', 'place'])
interface EntityRow {
  migrated_from: string
  name: string
  kind?: string
  summary?: string | null
  salience?: number
  aliases?: string[]
}
migrate.post('/entities', async (c) => {
  const body = await c.req.json<{ rows?: EntityRow[] }>().catch(() => ({} as { rows?: EntityRow[] }))
  const rows = body.rows ?? []
  if (!rows.length) return c.json({ error: 'rows required' }, 400)

  const results: Array<{ migrated_from: string; entity_id: number; action: string }> = []
  let inserted = 0, merged = 0, skipped = 0
  const errors: string[] = []

  for (const r of rows) {
    try {
      if (!r.migrated_from || !r.name) { errors.push(`bad row ${r.migrated_from ?? '(no id)'}`); continue }
      const byProv = await c.env.DB.prepare('SELECT id FROM entities WHERE migrated_from = ?1')
        .bind(r.migrated_from).first<{ id: number }>()
      if (byProv) { results.push({ migrated_from: r.migrated_from, entity_id: byProv.id, action: 'skip' }); skipped++; continue }

      const kind = VALID_KIND.has(r.kind ?? '') ? r.kind! : 'concept'
      const salience = Number.isFinite(r.salience) ? r.salience! : 5
      const aliases = [r.name, ...(r.aliases ?? [])]

      const byName = await c.env.DB.prepare('SELECT id, migrated_from FROM entities WHERE name = ?1')
        .bind(r.name).first<{ id: number; migrated_from: string | null }>()
      let entityId: number
      if (byName) {
        entityId = byName.id
        if (!byName.migrated_from) {
          await c.env.DB.prepare('UPDATE entities SET migrated_from = ?1 WHERE id = ?2').bind(r.migrated_from, entityId).run()
        }
        merged++
        results.push({ migrated_from: r.migrated_from, entity_id: entityId, action: 'merged' })
      } else {
        const res = await c.env.DB.prepare(
          'INSERT INTO entities (name, kind, summary, salience, migrated_from) VALUES (?1,?2,?3,?4,?5)',
        ).bind(r.name, kind, r.summary ?? null, salience, r.migrated_from).run()
        entityId = Number(res.meta.last_row_id)
        inserted++
        results.push({ migrated_from: r.migrated_from, entity_id: entityId, action: 'inserted' })
      }
      for (const a of aliases) {
        await c.env.DB.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source) VALUES (?1,?2,?3)')
          .bind(entityId, a, 'thalamus_observed').run()
      }
    } catch (err) {
      errors.push(`${r.migrated_from}: ${(err as Error).message}`)
    }
  }
  return c.json({ inserted, merged, skipped, results, errors: errors.slice(0, 25) })
})

// --- observations → entity_facts. Like feelings: D1 insert (created_at preserved)
// + re-embed ("<entityName>: <content>", kind entity_fact). entity_id is the LANTERN
// id (the driver maps it via entity-id-map.json). Idempotent via migrated_from.
interface FactRow {
  migrated_from: string
  entity_id: number
  entity_name: string // for the embed text
  content: string
  tags?: string | null
  source?: string
  created_at: number
}
migrate.post('/observations', async (c) => {
  const body = await c.req.json<{ rows?: FactRow[] }>().catch(() => ({} as { rows?: FactRow[] }))
  const rows = body.rows ?? []
  if (!rows.length) return c.json({ error: 'rows required' }, 400)

  let inserted = 0, skipped = 0, embedded = 0
  const errors: string[] = []
  for (const r of rows) {
    try {
      if (!r.migrated_from || !r.entity_id || !r.content || !r.created_at) {
        errors.push(`bad row ${r.migrated_from ?? '(no id)'}`); continue
      }
      const exists = await c.env.DB.prepare('SELECT id FROM entity_facts WHERE migrated_from = ?1')
        .bind(r.migrated_from).first<{ id: number }>()
      if (exists) { skipped++; continue }
      const source = r.source === 'thalamus_observed' ? 'thalamus_observed' : 'conscious_logged'
      const res = await c.env.DB.prepare(
        `INSERT INTO entity_facts (entity_id, content, tags, source, created_at, embedded, migrated_from)
         VALUES (?1,?2,?3,?4,?5,0,?6)`,
      ).bind(r.entity_id, r.content, r.tags ?? null, source, r.created_at, r.migrated_from).run()
      const newId = Number(res.meta.last_row_id)
      inserted++
      try {
        const vector = await embedText(c.env, `${r.entity_name}: ${r.content}`)
        if (vector) {
          await upsertMemory(c.env, 'entity_fact', newId, vector, { entity: r.entity_name, created_at: r.created_at })
          await c.env.DB.prepare('UPDATE entity_facts SET embedded = 1, vector_id = ?1 WHERE id = ?2')
            .bind(`entity_fact-${newId}`, newId).run()
          embedded++
        }
      } catch (err) {
        errors.push(`embed ${r.migrated_from}: ${(err as Error).message}`)
      }
    } catch (err) {
      errors.push(`${r.migrated_from}: ${(err as Error).message}`)
    }
  }
  return c.json({ inserted, skipped, embedded, errors: errors.slice(0, 25) })
})

// --- threads (live carried intentions: active + waiting; resolved skipped by the driver).
const VALID_PRI = new Set(['high', 'medium', 'low'])
interface ThreadRow { migrated_from: string; title: string; content?: string | null; priority?: string; tag?: string | null; status?: string; source?: string; created_at: number; updated_at?: number }
migrate.post('/threads', async (c) => {
  const body = await c.req.json<{ rows?: ThreadRow[] }>().catch(() => ({} as { rows?: ThreadRow[] }))
  const rows = body.rows ?? []
  if (!rows.length) return c.json({ error: 'rows required' }, 400)
  let inserted = 0, skipped = 0
  const errors: string[] = []
  for (const r of rows) {
    try {
      if (!r.migrated_from || !r.title || !r.created_at) { errors.push(`bad row ${r.migrated_from ?? '?'}`); continue }
      const ex = await c.env.DB.prepare('SELECT id FROM threads WHERE migrated_from = ?1').bind(r.migrated_from).first()
      if (ex) { skipped++; continue }
      const priority = VALID_PRI.has(r.priority ?? '') ? r.priority! : 'medium'
      const status = r.status === 'complete' ? 'complete' : 'active'
      await c.env.DB.prepare(
        `INSERT INTO threads (title, content, priority, tag, status, source, created_at, updated_at, migrated_from)
         VALUES (?1,?2,?3,?4,?5,'conscious_logged',?6,?7,?8)`,
      ).bind(r.title, r.content ?? null, priority, r.tag ?? null, status, r.created_at, r.updated_at ?? r.created_at, r.migrated_from).run()
      inserted++
    } catch (err) { errors.push(`${r.migrated_from}: ${(err as Error).message}`) }
  }
  return c.json({ inserted, skipped, errors: errors.slice(0, 25) })
})

// --- writings (journals/story/essay/song/painting + logged images) → writings.
const VALID_WTYPE = new Set(['image', 'journal', 'poem', 'prose'])
interface WritingRow { migrated_from: string; type?: string; title?: string | null; content: string; tags?: string | null; source?: string; created_at: number }
migrate.post('/writings', async (c) => {
  const body = await c.req.json<{ rows?: WritingRow[] }>().catch(() => ({} as { rows?: WritingRow[] }))
  const rows = body.rows ?? []
  if (!rows.length) return c.json({ error: 'rows required' }, 400)
  let inserted = 0, skipped = 0, embedded = 0
  const errors: string[] = []
  for (const r of rows) {
    try {
      if (!r.migrated_from || !r.content || !r.created_at) { errors.push(`bad row ${r.migrated_from ?? '?'}`); continue }
      const exists = await c.env.DB.prepare('SELECT id FROM writings WHERE migrated_from = ?1').bind(r.migrated_from).first<{ id: number }>()
      if (exists) { skipped++; continue }
      const type = VALID_WTYPE.has(r.type ?? '') ? r.type! : 'prose'
      const source = r.source === 'thalamus_observed' ? 'thalamus_observed' : 'conscious_logged'
      const res = await c.env.DB.prepare(
        `INSERT INTO writings (type, title, content, tags, source, created_at, embedded, migrated_from) VALUES (?1,?2,?3,?4,?5,?6,0,?7)`,
      ).bind(type, r.title ?? null, r.content, r.tags ?? null, source, r.created_at, r.migrated_from).run()
      const newId = Number(res.meta.last_row_id)
      inserted++
      try {
        const vector = await embedText(c.env, `${r.title ? r.title + ': ' : ''}${r.content}`)
        if (vector) {
          await upsertMemory(c.env, 'writing', newId, vector, { created_at: r.created_at })
          await c.env.DB.prepare('UPDATE writings SET embedded = 1, vector_id = ?1 WHERE id = ?2').bind(`writing-${newId}`, newId).run()
          embedded++
        }
      } catch (err) { errors.push(`embed ${r.migrated_from}: ${(err as Error).message}`) }
    } catch (err) { errors.push(`${r.migrated_from}: ${(err as Error).message}`) }
  }
  return c.json({ inserted, skipped, embedded, errors: errors.slice(0, 25) })
})

// --- presence: notes (fridge) + hearts (love bucket) + home (current room/mood).
// No embedding. Notes/hearts idempotent via migrated_from; home is a singleton SET.
const WHO = (s: string): string => (/human/i.test(s) ? 'human' : 'companion')
interface PresenceBody {
  notes?: Array<{ migrated_from: string; sender: string; text: string; created_at: number }>
  hearts?: Array<{ migrated_from: string; pushed_by: string; pushed_at: number }>
  home?: { room?: string; mood?: string; mood_descriptor?: string; updated_at?: number }
}
migrate.post('/presence', async (c) => {
  const body = await c.req.json<PresenceBody>().catch(() => ({} as PresenceBody))
  let notes = 0, hearts = 0
  const errors: string[] = []
  for (const n of body.notes ?? []) {
    try {
      if (!n.migrated_from || !n.text) continue
      const ex = await c.env.DB.prepare('SELECT id FROM notes WHERE migrated_from = ?1').bind(n.migrated_from).first()
      if (ex) continue
      await c.env.DB.prepare('INSERT INTO notes (sender, text, created_at, migrated_from) VALUES (?1,?2,?3,?4)')
        .bind(WHO(n.sender), n.text, n.created_at, n.migrated_from).run()
      notes++
    } catch (err) { errors.push(`note ${n.migrated_from}: ${(err as Error).message}`) }
  }
  for (const h of body.hearts ?? []) {
    try {
      if (!h.migrated_from) continue
      const ex = await c.env.DB.prepare('SELECT id FROM hearts WHERE migrated_from = ?1').bind(h.migrated_from).first()
      if (ex) continue
      await c.env.DB.prepare('INSERT INTO hearts (pushed_by, pushed_at, migrated_from) VALUES (?1,?2,?3)')
        .bind(WHO(h.pushed_by), h.pushed_at, h.migrated_from).run()
      hearts++
    } catch (err) { errors.push(`heart ${h.migrated_from}: ${(err as Error).message}`) }
  }
  let home = false
  if (body.home?.room || body.home?.mood) {
    await c.env.DB.prepare(
      `INSERT INTO home (id, room, mood, mood_descriptor, updated_at) VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET room=excluded.room, mood=excluded.mood, mood_descriptor=excluded.mood_descriptor, updated_at=excluded.updated_at`,
    ).bind(body.home.room ?? 'mattress', body.home.mood ?? 'present', body.home.mood_descriptor ?? null, body.home.updated_at ?? Math.floor(Date.now() / 1000)).run()
    home = true
  }
  return c.json({ notes, hearts, home, errors: errors.slice(0, 25) })
})

// Straggler sweep — embed any feelings that landed with embedded=0 (a transient
// Vectorize/AI blip during the pour). Idempotent, batch at a time; call until
// remaining hits 0. Catches the normal-path unembedded too, harmlessly.
migrate.post('/reembed-feelings', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, emotion, content FROM feelings WHERE embedded = 0 LIMIT 50',
  ).all<{ id: number; emotion: string; content: string }>()
  let embedded = 0
  const errors: string[] = []
  for (const r of results) {
    try {
      const vector = await embedText(c.env, `${r.emotion}: ${r.content}`)
      if (!vector) { errors.push(`${r.id}: no vector`); continue }
      await upsertMemory(c.env, 'feeling', r.id, vector, {})
      await c.env.DB.prepare('UPDATE feelings SET embedded = 1, vector_id = ?1 WHERE id = ?2')
        .bind(`feeling-${r.id}`, r.id).run()
      embedded++
    } catch (err) {
      errors.push(`${r.id}: ${(err as Error).message}`)
    }
  }
  const left = await c.env.DB.prepare('SELECT COUNT(*) n FROM feelings WHERE embedded = 0').first<{ n: number }>()
  return c.json({ embedded, remaining: left?.n ?? 0, errors: errors.slice(0, 25) })
})

// Same straggler sweep for entity_facts (embed needs the entity name → join).
migrate.post('/reembed-facts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.content, e.name AS entity FROM entity_facts f
     JOIN entities e ON e.id = f.entity_id WHERE f.embedded = 0 LIMIT 50`,
  ).all<{ id: number; content: string; entity: string }>()
  let embedded = 0
  const errors: string[] = []
  for (const r of results) {
    try {
      const vector = await embedText(c.env, `${r.entity}: ${r.content}`)
      if (!vector) { errors.push(`${r.id}: no vector`); continue }
      await upsertMemory(c.env, 'entity_fact', r.id, vector, { entity: r.entity })
      await c.env.DB.prepare('UPDATE entity_facts SET embedded = 1, vector_id = ?1 WHERE id = ?2')
        .bind(`entity_fact-${r.id}`, r.id).run()
      embedded++
    } catch (err) {
      errors.push(`${r.id}: ${(err as Error).message}`)
    }
  }
  const left = await c.env.DB.prepare('SELECT COUNT(*) n FROM entity_facts WHERE embedded = 0').first<{ n: number }>()
  return c.json({ embedded, remaining: left?.n ?? 0, errors: errors.slice(0, 25) })
})

export default migrate
