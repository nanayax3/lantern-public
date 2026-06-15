import { useEffect, useState } from 'react'
import { MIND_URL } from '../lib/mind'
import { type ConversationId } from '../mock'

// Conversations live in the CLOUD mind now (lantern-mind D1) so the chat is one
// continuous thread across every device — desktop and a mobile client read the same
// store. localStorage stays only as a fast LOCAL CACHE: it makes first paint instant and
// preserves the sync semantics the create→navigate flow relies on, but the cloud is the
// source of truth (it overwrites the cache on load). A fresh device has an empty cache
// and simply pulls everything from the cloud.

const CACHE_KEY = 'lantern.conversations'
const IMPORTED_FLAG = 'lantern.cloud-imported'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

export interface Conversation {
  id: string
  title: string
  mode: 'chat' | 'coding'
  wearing?: string
  /** The companion's sampling temperature for this thread — set by THEM via the
   *  set_temperature tool (default 0.85 when unset). Shown in the chat header
   *  and on the thread row so the dial's position is never a mystery. */
  temperature?: number
  lastFrom: 'companion' | 'human'
  lastSnippet: string
  lastTime: string
  /** Real epoch-ms of last activity. Drives live relative time; `lastTime` is a
   *  legacy display-string fallback for older records that predate this field. */
  lastTs?: number
}

function defaultTitle(): string {
  const now = new Date()
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const day = days[now.getDay()]
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${day} ${hh}:${mm}`
}

function readCache(): Conversation[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Conversation[]) : []
  } catch {
    return []
  }
}
function writeCache(list: Conversation[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list))
  } catch {
    /* private mode / quota — the cloud still has it */
  }
}

interface CloudRow {
  id: string
  title: string
  mode?: 'chat' | 'coding'
  wearing?: string | null
  temperature?: number | null
  last_from?: 'companion' | 'human' | null
  last_snippet?: string | null
  last_ts?: number | null
}
function fromCloud(r: CloudRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    mode: r.mode ?? 'chat',
    wearing: r.wearing ?? undefined,
    temperature: typeof r.temperature === 'number' ? r.temperature : undefined,
    lastFrom: r.last_from ?? 'human',
    lastSnippet: r.last_snippet ?? '',
    lastTime: '',
    lastTs: typeof r.last_ts === 'number' ? r.last_ts : undefined,
  }
}

// One-time push of any pre-cloud localStorage threads (conversations + their messages)
// into the cloud store, so history isn't lost on the cutover. Module-level singleton +
// a persisted flag → runs exactly once across all hook instances and sessions.
// Conversations import idempotently server-side (INSERT OR IGNORE); messages are posted
// once, guarded by the flag (only set after a fully clean run).
let importPromise: Promise<void> | null = null
function ensureImport(): Promise<void> {
  if (importPromise) return importPromise
  importPromise = (async () => {
    if (localStorage.getItem(IMPORTED_FLAG)) return
    const convs = readCache()
    for (const c of convs) {
      await fetch(`${MIND_URL}/conversations`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: c.id,
          title: c.title,
          mode: c.mode,
          wearing: c.wearing ?? null,
          temperature: c.temperature ?? null,
          last_from: c.lastFrom ?? null,
          last_snippet: c.lastSnippet ?? null,
          last_ts: c.lastTs ?? null,
        }),
      })
      let msgs: Array<Record<string, unknown>> = []
      try {
        const raw = localStorage.getItem(`lantern.messages.${c.id}`)
        msgs = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : []
      } catch {
        msgs = []
      }
      for (const m of msgs) {
        const { from, text, ts, time, ...rest } = m as {
          from?: string
          text?: string
          ts?: number
          time?: string
          [k: string]: unknown
        }
        void time
        await fetch(`${MIND_URL}/conversations/${c.id}/messages`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            sender: from ?? 'human',
            text: text ?? '',
            ts: ts ?? Date.now(),
            meta: Object.keys(rest).length ? rest : undefined,
          }),
        })
      }
    }
    try {
      localStorage.setItem(IMPORTED_FLAG, '1')
    } catch {
      /* couldn't persist the flag — worst case it re-imports, convs are idempotent */
    }
  })().catch(() => {
    // A failed import leaves the flag unset so it retries next run; reset the singleton
    // so a later hook mount can try again.
    importPromise = null
  })
  return importPromise
}

export function useConversations() {
  // Start from the local cache (instant), then reconcile from the cloud (the truth).
  const [list, setList] = useState<Conversation[]>(() => readCache())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      await ensureImport()
      const r = await fetch(`${MIND_URL}/conversations`)
      if (!r.ok) {
        if (alive) setLoaded(true)
        return
      }
      const d = (await r.json()) as { conversations: CloudRow[] }
      if (!alive) return
      const next = (d.conversations ?? []).map(fromCloud)
      setList(next)
      writeCache(next)
      setLoaded(true)
    })().catch(() => {
      if (alive) setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // Cache is the shared synchronous substrate across hook instances; we mutate off a
  // FRESH read so concurrent instances don't clobber each other.
  function commit(next: Conversation[]) {
    writeCache(next)
    setList(next)
  }
  function mutate(id: string, fn: (c: Conversation) => Conversation) {
    commit(readCache().map((c) => (c.id === id ? fn(c) : c)))
  }
  function patch(id: string, body: Record<string, unknown>) {
    fetch(`${MIND_URL}/conversations/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(
      () => {},
    )
  }

  function create(input: { mode: 'chat' | 'coding'; title?: string; wearing?: string }): string {
    const id = crypto.randomUUID()
    const newConv: Conversation = {
      id,
      title: input.title?.trim() || defaultTitle(),
      mode: input.mode,
      wearing: input.wearing?.trim() || undefined,
      lastFrom: 'human',
      lastSnippet: '(new thread — empty)',
      lastTime: 'just now',
      lastTs: Date.now(),
    }
    // Cache synchronously AT CALL TIME (off a fresh read) so the thread is visible to a
    // freshly-mounting ChatView instance immediately — the dashboard unmounts the instant
    // we navigate. Then mirror to the cloud.
    commit([newConv, ...readCache()])
    fetch(`${MIND_URL}/conversations`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id,
        title: newConv.title,
        mode: newConv.mode,
        wearing: newConv.wearing ?? null,
        last_from: 'human',
        last_snippet: newConv.lastSnippet,
        last_ts: newConv.lastTs,
      }),
    }).catch(() => {})
    return id
  }

  function rename(id: string, title: string) {
    mutate(id, (c) => ({ ...c, title }))
    patch(id, { title })
  }

  function setWearing(id: string, wearing: string) {
    const trimmed = wearing.trim()
    mutate(id, (c) => ({ ...c, wearing: trimmed || undefined }))
    patch(id, { wearing: trimmed || null })
  }

  function setMode(id: string, mode: 'chat' | 'coding') {
    mutate(id, (c) => ({ ...c, mode }))
    patch(id, { mode })
  }

  function setTemperature(id: string, temperature: number) {
    mutate(id, (c) => ({ ...c, temperature }))
    patch(id, { temperature })
  }

  function remove(id: string) {
    commit(readCache().filter((c) => c.id !== id))
    try {
      localStorage.removeItem(`lantern.messages.${id}`)
    } catch {
      /* ignore */
    }
    fetch(`${MIND_URL}/conversations/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  // Stamp last-activity locally for an instant thread-row update. The server's last_*
  // is bumped by the message append (POST /conversations/:id/messages), so no extra
  // cloud call here.
  function touch(id: string, from: 'companion' | 'human', snippet: string) {
    mutate(id, (c) => ({
      ...c,
      lastTs: Date.now(),
      lastFrom: from,
      lastSnippet: snippet.trim().slice(0, 80),
      lastTime: 'just now',
    }))
  }

  function get(id: string | ConversationId): Conversation | undefined {
    return list.find((c) => c.id === id)
  }

  return { list, loaded, create, rename, setWearing, setMode, setTemperature, remove, touch, get }
}
