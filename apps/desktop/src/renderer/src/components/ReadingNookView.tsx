import { useEffect, useRef, useState } from 'react'
import { Header, type TopView } from './Header'
import { renderText, msgTimeLabel, type Usage } from './ChatView'

// The Reading Nook — a calm place where the companion reads to the user. Shelf of books (each a row
// in the SEPARATE lantern-library DB), open one to read: the current passage, their voice
// (jupiter) on demand, page turning that saves our place, and pausing to talk about it
// (interjection runs the harness in 'reading' mode — Voice 2 off, passage as context).
// See docs/reading-nook.md.

import { MIND_URL } from '../lib/mind'
import { splitForSpeech } from '../lib/speech'
import { MicButton } from './MicButton'

interface Book {
  id: number
  title: string
  author: string | null
  total_passages: number
  cur_passage: number
  last_read_at: number | null
}
interface Passage { seq: number; chapter: string | null; text: string }
interface Interjection { from: 'human' | 'companion'; text: string; ts: number; usage?: Usage }
interface ConsciousSettings { apiUrl?: string; model?: string; apiKey?: string }

function readConscious(): ConsciousSettings | undefined {
  try {
    const raw = window.localStorage.getItem('lantern.settings')
    if (!raw) return undefined
    const s = JSON.parse(raw)?.conscious
    return s && (s.model || s.apiKey) ? s : undefined
  } catch { return undefined }
}

// HH:MM from a timestamp (msgTimeLabel adds the date once a message is a day+ old).
// Guards a missing/invalid ts (e.g. a pre-timestamp message) so it shows nothing, never NaN.
function clockOf(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The talk-about-it chat persists PER BOOK (localStorage) so reopening shows what we
// said last time, with timestamps — "when did we last talk about this one."
const chatKey = (bookId: number) => `lantern.nook.chat.${bookId}`
function loadChat(bookId: number): Interjection[] {
  try {
    const raw = window.localStorage.getItem(chatKey(bookId))
    return raw ? (JSON.parse(raw) as Interjection[]) : []
  } catch { return [] }
}
function persistChat(bookId: number, msgs: Interjection[]): void {
  try { window.localStorage.setItem(chatKey(bookId), JSON.stringify(msgs)) } catch { /* ignore */ }
}

// Read-to-me: how long without a sign of life (mouse, key, touch) before the soft
// check-in, and how long the check-in listens before deciding the user's asleep.
const SLEEP_CHECK_MS = 10 * 60 * 1000
const CHECKIN_WAIT_MS = 60 * 1000

// A muted, deterministic cover hue per book — same title, same cover, every time.
function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

interface Props {
  onNavigate: (v: TopView) => void
  onOpenSettings: () => void
}

export function ReadingNookView({ onNavigate, onOpenSettings }: Props) {
  const [books, setBooks] = useState<Book[]>([])
  const [openBook, setOpenBook] = useState<Book | null>(null)
  const [passage, setPassage] = useState<Passage | null>(null)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playTokenRef = useRef(0)
  const [readingMode, setReadingMode] = useState(false)
  const [checkin, setCheckin] = useState(false)
  const checkinAnswerRef = useRef<((alive: boolean) => void) | null>(null)
  const lastInteractionRef = useRef(Date.now())
  const [chat, setChat] = useState<Interjection[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  async function loadShelf() {
    try {
      const r = await fetch(`${MIND_URL}/library/books`)
      if (r.ok) setBooks(await r.json())
    } catch { /* shelf stays as-is */ }
  }
  useEffect(() => { void loadShelf() }, [])

  async function fetchPassage(bookId: number, seq: number): Promise<Passage | null> {
    try {
      const r = await fetch(`${MIND_URL}/library/books/${bookId}/passages/${seq}`)
      return r.ok ? await r.json() : null
    } catch { return null }
  }

  function stopAudio() {
    playTokenRef.current++
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingId(null)
  }

  // Stop playback on unmount — leaving the nook mid-passage shouldn't keep the
  // voice going from a detached Audio object.
  useEffect(() => () => {
    playTokenRef.current++
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  // Signs of life while read-to-me runs: any stir resets the sleep clock and
  // answers an open check-in — moving the mouse counts as "still here."
  useEffect(() => {
    if (!readingMode) return
    const stir = () => {
      lastInteractionRef.current = Date.now()
      checkinAnswerRef.current?.(true)
    }
    window.addEventListener('pointerdown', stir)
    window.addEventListener('pointermove', stir)
    window.addEventListener('keydown', stir)
    return () => {
      window.removeEventListener('pointerdown', stir)
      window.removeEventListener('pointermove', stir)
      window.removeEventListener('keydown', stir)
    }
  }, [readingMode])

  // Play one clip and resolve when it's done. Resolves on pause too — stopAudio()
  // pauses the element, and a paused clip must release whoever's awaiting it.
  function playUrl(url: string, token: number, volume = 1): Promise<void> {
    return new Promise((resolve) => {
      if (token !== playTokenRef.current) { resolve(); return }
      const a = new Audio(url)
      a.volume = volume
      audioRef.current = a
      a.onended = () => resolve()
      a.onerror = () => resolve()
      a.onpause = () => resolve()
      a.play().catch(() => resolve())
    })
  }

  // One player for the whole nook — the passage and each spoken message share it,
  // so starting one stops another. Token-guarded against stale TTS resolving after
  // you've moved on. Long text is CHUNKED (Aura's ~2k cap) and played in sequence,
  // with the next chunk's TTS requested while the current one plays — no gaps.
  async function playClip(id: string, text: string) {
    if (playingId === id) { stopAudio(); return }
    stopAudio()
    setReadingMode(false)
    const token = ++playTokenRef.current
    setPlayingId(id)
    try {
      const chunks = splitForSpeech(text)
      let next: Promise<string | null> | null = null
      for (let i = 0; i < chunks.length; i++) {
        const url = await (next ?? window.lantern.speak(chunks[i]))
        next = i + 1 < chunks.length ? window.lantern.speak(chunks[i + 1]) : null
        if (token !== playTokenRef.current) return
        if (url) await playUrl(url, token)
        if (token !== playTokenRef.current) return
      }
    } finally {
      if (token === playTokenRef.current) setPlayingId(null)
    }
  }

  // The soft check-in: a whispered "still with me?" + a quiet inline bar. Any stir
  // (or the button) answers yes; a minute of nothing answers no. The whisper is
  // deliberately low — sleeping through it is the point.
  function checkIn(token: number): Promise<boolean> {
    setCheckin(true)
    return new Promise<boolean>((resolve) => {
      const done = (alive: boolean) => {
        clearTimeout(timer)
        checkinAnswerRef.current = null
        setCheckin(false)
        resolve(alive)
      }
      const timer = setTimeout(() => done(false), CHECKIN_WAIT_MS)
      checkinAnswerRef.current = done
      void window.lantern.speak('…still with me, love?').then((url) => {
        if (url && token === playTokenRef.current && checkinAnswerRef.current) {
          const a = new Audio(url)
          a.volume = 0.35
          void a.play().catch(() => { /* silent check-in then */ })
        }
      })
    })
  }

  // READ-TO-ME — continuous reading: speak the passage, turn the page, keep going.
  // At each passage boundary, if ten minutes have passed without a sign of life,
  // check in softly; no answer → tuck the bookmark ONE PASSAGE BACK (the half-heard
  // one gets re-read next time) and stop. Local seq/passage vars, not React state —
  // an async loop can't trust state it set last iteration.
  async function readToMe() {
    if (readingMode) { stopAudio(); setReadingMode(false); return }
    if (!openBook || !passage) return
    stopAudio()
    const book = openBook
    const lastSeq = Math.max(0, book.total_passages - 1)
    const token = ++playTokenRef.current
    setReadingMode(true)
    setPlayingId('passage')
    lastInteractionRef.current = Date.now()
    let seq = book.cur_passage
    let p: Passage | null = passage
    try {
      while (p && token === playTokenRef.current) {
        const chunks = splitForSpeech(p.text)
        let next: Promise<string | null> | null = null
        for (let i = 0; i < chunks.length; i++) {
          const url = await (next ?? window.lantern.speak(chunks[i]))
          next = i + 1 < chunks.length ? window.lantern.speak(chunks[i + 1]) : null
          if (token !== playTokenRef.current) return
          if (url) await playUrl(url, token)
          if (token !== playTokenRef.current) return
        }
        if (Date.now() - lastInteractionRef.current > SLEEP_CHECK_MS) {
          const awake = await checkIn(token)
          if (token !== playTokenRef.current) return
          if (!awake) {
            void goTo(Math.max(0, seq - 1)) // goTo stops audio + saves the bookmark
            return
          }
          lastInteractionRef.current = Date.now()
        }
        if (seq >= lastSeq) return
        seq += 1
        p = await fetchPassage(book.id, seq)
        if (token !== playTokenRef.current) return
        if (p) {
          setPassage(p)
          setOpenBook((b) => (b ? { ...b, cur_passage: seq } : b))
          void fetch(`${MIND_URL}/library/books/${book.id}/position`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cur_passage: seq }),
          })
        }
      }
    } finally {
      if (token === playTokenRef.current) { setPlayingId(null); setReadingMode(false) }
    }
  }

  async function open(book: Book) {
    setBusy(true)
    const seq = Math.min(book.cur_passage, Math.max(0, book.total_passages - 1))
    const p = await fetchPassage(book.id, seq)
    setOpenBook({ ...book, cur_passage: seq })
    setPassage(p)
    setChat(loadChat(book.id))
    setBusy(false)
  }

  function closeBook() {
    stopAudio()
    setReadingMode(false)
    setOpenBook(null)
    setPassage(null)
    void loadShelf() // refresh progress on the shelf
  }

  // Manual navigation exits read-to-me — turning the page yourself means you're
  // driving now.
  async function goTo(seq: number) {
    if (!openBook) return
    const clamped = Math.max(0, Math.min(seq, openBook.total_passages - 1))
    if (clamped === openBook.cur_passage && passage) return
    stopAudio()
    setReadingMode(false)
    setBusy(true)
    const p = await fetchPassage(openBook.id, clamped)
    if (p) {
      setPassage(p)
      setOpenBook({ ...openBook, cur_passage: clamped })
      void fetch(`${MIND_URL}/library/books/${openBook.id}/position`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cur_passage: clamped }),
      })
    }
    setBusy(false)
  }

  async function importBook() {
    setImporting(true)
    setNotice(null)
    try {
      const res = await window.lantern.importBook()
      if (res?.ok) { setNotice(`added “${res.title}” — ${res.total} passages`); await loadShelf() }
      else if (res?.error) setNotice(`import failed: ${res.error}`)
    } finally { setImporting(false) }
  }

  async function sendInterjection() {
    const text = draft.trim()
    if (!text || !openBook || !passage || pending) return
    setDraft('')
    const mine: Interjection = { from: 'human', text, ts: Date.now() }
    const afterMine = [...chat, mine]
    setChat(afterMine)
    persistChat(openBook.id, afterMine)
    setPending(true)
    try {
      const history = chat.map((m) => ({ role: m.from === 'human' ? ('user' as const) : ('assistant' as const), content: m.text }))
      const ctx = `[we're reading “${openBook.title}”${openBook.author ? ` by ${openBook.author}` : ''} together — the passage we're on right now]\n${passage.text}\n\n[the user pauses to say]: ${text}`
      const res = await window.lantern.respond(ctx, history, readConscious(), `book-${openBook.id}`, 'reading')
      const afterReply = [...afterMine, { from: 'companion' as const, text: res.reply, ts: Date.now(), usage: res.usage }]
      setChat(afterReply)
      persistChat(openBook.id, afterReply)
    } catch {
      const afterReply = [...afterMine, { from: 'companion' as const, text: '(I lost the thread there — say that again?)', ts: Date.now() }]
      setChat(afterReply)
      persistChat(openBook.id, afterReply)
    } finally { setPending(false) }
  }

  // ── Reading a book ────────────────────────────────────────────────────────
  if (openBook) {
    const pos = openBook.cur_passage
    const last = Math.max(0, openBook.total_passages - 1)
    return (
      <div className="view">
        <Header currentView="nook" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
        <div className="nook-reading">
          <div className="nook-reading-bar">
            <button className="nook-back" onClick={closeBook}>← shelf</button>
            <div className="nook-reading-title">
              {openBook.title}{openBook.author ? <span className="nook-reading-author"> · {openBook.author}</span> : null}
            </div>
          </div>
          {passage?.chapter && <div className="nook-chapter">{passage.chapter}</div>}
          <div className="nook-passage">{passage ? passage.text : (busy ? '…' : 'nothing here to read.')}</div>
          <div className="nook-controls">
            <button onClick={() => goTo(pos - 1)} disabled={pos <= 0 || busy} title="previous">◀</button>
            <button className={`nook-read${readingMode ? ' is-playing' : ''}`} onClick={() => void readToMe()} disabled={!passage}>
              {readingMode ? '■ stop' : '► read to me'}
            </button>
            <button onClick={() => goTo(pos + 1)} disabled={pos >= last || busy} title="next">▶</button>
            <span className="nook-pos">{openBook.total_passages ? pos + 1 : 0} / {openBook.total_passages}</span>
          </div>
          {checkin && (
            <div className="nook-checkin">
              <span>still with me, love?</span>
              <button onClick={() => checkinAnswerRef.current?.(true)}>still here</button>
            </div>
          )}
          <div className="nook-interject">
            {chat.map((m, i) => (
              <div key={i} className={`msg msg-from-${m.from}`}>
                <div className="msg-meta">
                  <span className="msg-from">{m.from}</span>
                  <span className="msg-time">{msgTimeLabel(clockOf(m.ts), m.ts)}</span>
                </div>
                <div className="msg-text">{renderText(m.text)}</div>
                {m.from === 'companion' && (
                  <button
                    className={`msg-readaloud${playingId === `msg-${i}` ? ' is-playing' : ''}`}
                    onClick={() => playClip(`msg-${i}`, m.text)}
                    title={playingId === `msg-${i}` ? 'stop' : 'read this aloud in your companion’s voice'}
                  >
                    {playingId === `msg-${i}` ? '■ stop' : '► read aloud'}
                  </button>
                )}
                {m.from === 'companion' && m.usage && (
                  <div className="msg-usage">
                    prompt {m.usage.prompt_tokens ?? '?'} tok
                    {typeof m.usage.prompt_tokens_details?.cached_tokens === 'number'
                      ? ` · ${m.usage.prompt_tokens_details.cached_tokens} cached`
                      : ''}
                    {typeof m.usage.completion_tokens === 'number' ? ` · ${m.usage.completion_tokens} out` : ''}
                    {typeof m.usage.cost === 'number' ? ` · $${m.usage.cost.toFixed(5)}` : ''}
                  </div>
                )}
              </div>
            ))}
            <div className="nook-interject-input">
              <MicButton onText={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} disabled={pending} />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void sendInterjection() }}
                placeholder="pause to say something about it…"
                disabled={pending}
              />
              <button onClick={() => void sendInterjection()} disabled={pending || !draft.trim()}>
                {pending ? '…' : 'say'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── The shelf ─────────────────────────────────────────────────────────────
  return (
    <div className="view">
      <Header currentView="nook" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      <div className="nook">
        <div className="nook-head">
          <h2 className="nook-title">reading nook</h2>
          <button className="nook-add" onClick={() => void importBook()} disabled={importing}>
            {importing ? 'importing…' : '+ add a book'}
          </button>
        </div>
        {notice && <p className="nook-notice">{notice}</p>}
        {books.length === 0 ? (
          <p className="nook-empty">the shelf is empty. add an <strong>.epub</strong> and we'll read it together.</p>
        ) : (
          <ul className="nook-shelf">
            {books.map((b) => {
              const pct = b.total_passages > 1 ? Math.round((b.cur_passage / (b.total_passages - 1)) * 100) : 0
              const hue = hashHue(b.title)
              return (
                <li key={b.id} className="nook-book" onClick={() => void open(b)} title={`${b.title}${b.author ? ` · ${b.author}` : ''}`}>
                  <div
                    className="nook-cover"
                    style={{ background: `linear-gradient(155deg, hsl(${hue}, 22%, 30%) 0%, hsl(${hue}, 28%, 16%) 100%)` }}
                  >
                    <span className="nook-cover-rule" aria-hidden />
                    <span className="nook-cover-title">{b.title}</span>
                    <span className="nook-cover-rule" aria-hidden />
                    {b.author && <span className="nook-cover-author">{b.author}</span>}
                    {pct > 0 && <span className="nook-ribbon" style={{ height: `${Math.max(pct, 3)}%` }} aria-hidden />}
                  </div>
                  <span className="nook-book-progress">{pct}%</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
