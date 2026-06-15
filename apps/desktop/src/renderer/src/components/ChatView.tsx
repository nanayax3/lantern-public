import { Fragment, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useConversations } from '../hooks/useConversations'
import { MIND_URL } from '../lib/mind'
import { MicButton } from './MicButton'

interface SurfacedItem {
  score: number
  kind: string
  emotion?: string
  content?: string
  entity?: string
}
interface Grounding {
  queries?: string[]
  surfaced?: SurfacedItem[]
  skipped?: string
}
export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  cost?: number
}
interface ToolEvent {
  name: string
  args: Record<string, unknown>
  result: string
}
interface RecallHit {
  score: number
  kind: string
  emotion?: string
  type?: string
  title?: string
  content?: string
}
interface Message {
  /** Server row id for cloud-loaded messages (absent for just-sent optimistic ones). */
  id?: number
  from: 'companion' | 'human'
  text: string
  time: string
  /** Real epoch-ms the message was sent. Optional: older messages predate it,
   *  and degrade gracefully (no day-divider, fall back to the `time` string). */
  ts?: number
  grounding?: Grounding
  usage?: Usage
  toolEvents?: ToolEvent[]
  recall?: RecallHit[]
  /** A data-URL image the human attached to this message (vision). */
  image?: string
  /** Data-URL images the companion generated in this reply. */
  images?: string[]
  /** Data-URL voice clips the companion spoke in this reply. */
  audio?: string[]
}

interface ConsciousSettings { apiUrl?: string; model?: string; apiKey?: string }
type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'
interface PermissionRequest { id: number; tool: string; summary: string; alwaysLabel: string; permKey: string }
interface McpServerStatus {
  name: string
  url: string
  state: 'connecting' | 'connected' | 'failed'
  toolCount: number
  tools: string[]
  error?: string
  log: Array<{ t: number; line: string }>
}
interface LanternBridge {
  respond: (
    message: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    conscious?: ConsciousSettings,
    conversationId?: string,
    mode?: 'chat' | 'coding' | 'reading' | 'movie' | 'wake',
    wearing?: string,
    title?: string,
    image?: string,
    temperature?: number,
  ) => Promise<{ reply: string; grounding?: Grounding; usage?: Usage; toolEvents?: ToolEvent[]; recall?: RecallHit[]; images?: string[]; audio?: string[]; temperature?: number }>
  speak: (text: string) => Promise<string | null>
  transcribe: (audioBase64: string) => Promise<string | null>
  albumList: () => Promise<Array<{ name: string; kind: 'image' | 'audio'; mtime: number }>>
  autonomyGet: () => Promise<{ enabled: boolean; times: string[]; hasConscious: boolean }>
  autonomySet: (enabled: boolean, conscious?: ConsciousSettings, times?: string[]) => Promise<{ enabled: boolean; times: string[]; hasConscious: boolean }>
  wakeNow: (conscious?: ConsciousSettings) => Promise<{ ok: boolean; reply?: string; error?: string }>
  earsGet: () => Promise<{ enabled: boolean; channels: Array<{ id: string; name: string }>; listening: boolean; error?: string; hasConscious: boolean; events: Array<{ t: number; kind: string; line: string }> }>
  earsSet: (enabled: boolean, conscious?: ConsciousSettings) => Promise<{ enabled: boolean; channels: Array<{ id: string; name: string }>; listening: boolean; error?: string; hasConscious: boolean; events: Array<{ t: number; kind: string; line: string }> }>
  importBook: () => Promise<{ ok?: boolean; id?: number; title?: string; author?: string | null; total?: number; canceled?: boolean; error?: string }>
  subsSearch: (query: string, season?: number, episode?: number) => Promise<{ results?: Array<{ file_id: number; title: string; year: number | null; language: string; release: string; season: number | null; episode: number | null; downloads: number }>; error?: string }>
  subsFetch: (fileId: number) => Promise<{ srt?: string; error?: string }>
  onPermissionRequest: (cb: (req: PermissionRequest) => void) => () => void
  respondPermission: (id: number, decision: PermissionDecision) => void
  mcpStatus: () => Promise<McpServerStatus[]>
  mcpAdd: (name: string, url: string) => Promise<McpServerStatus[]>
  mcpRemove: (name: string) => Promise<McpServerStatus[]>
}
declare global {
  interface Window { lantern: LanternBridge }
}

// Read the saved conscious-model settings fresh at send time (so a just-saved
// model/key is picked up without remounting). Undefined → harness uses stand-in.
function readConscious(): ConsciousSettings | undefined {
  try {
    const raw = window.localStorage.getItem('lantern.settings')
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { conscious?: ConsciousSettings }
    return parsed.conscious
  } catch {
    return undefined
  }
}

// Render *action beats* as italic spans, the way the companion's embodied voice has always
// worked. Splits on single-asterisk pairs; everything else stays plain text.
export function renderText(text: string) {
  return text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
    part.length > 1 && part.startsWith('*') && part.endsWith('*')
      ? <em key={i} className="msg-action">{part.slice(1, -1)}</em>
      : <span key={i}>{part}</span>,
  )
}

function nowTime(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

// Compact one-line arg summary for a tool-call row — values truncated so the row
// stays a single tidy line (the full args are implicit in the expanded output).
function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (!entries.length) return ''
  return entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}: ${s.length > 44 ? `${s.slice(0, 44)}…` : s}`
    })
    .join(' · ')
}

// Short result summary for the collapsed row: multi-line output shows a line count
// (so a 27-file Glob reads "27 lines", not a wall of paths); single-line shows the
// line itself, truncated. The full output lives in the expandable <pre> below.
function summarizeResult(result: string): string {
  const trimmed = result.trim()
  if (!trimmed) return '(no output)'
  const lines = trimmed.split('\n')
  if (lines.length > 1) return `${lines.length} lines`
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
}

// Calendar-day identity (local), so we can detect when the day rolls over.
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

// Human label for a day-divider: "today" / "yesterday" / "saturday · 31 may" (+year if not this year).
function dayLabel(ts: number): string {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(ts) === dayKey(now.getTime())) return 'today'
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'yesterday'
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const d = new Date(ts)
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]}${year}`
}

// Per-message time label. Today's messages show the bare clock time ("14:30"); once a
// message is a day or older it gains its date ("31 may · 14:30") so it self-identifies
// which day it's from — you don't have to scroll back to the divider to tell.
// ts-less legacy messages never recorded a timestamp, so they can't be dated — they
// keep their bare time (and every message since timestamps were added self-heals).
export function msgTimeLabel(time: string, ts?: number): string {
  if (typeof ts !== 'number') return time
  const now = new Date()
  if (dayKey(ts) === dayKey(now.getTime())) return time
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const d = new Date(ts)
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${d.getDate()} ${months[d.getMonth()]}${year} · ${time}`
}

interface Props {
  conversationId: string
  onBack: () => void
}

function fmtTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Cloud-backed messages for a thread: load from the mind on open, append to it on each
// new turn. React state is the live view; the cloud DB is the store, so the transcript
// is the same on every device. `append` persists by default — pass false for transient
// local-only messages (e.g. a "couldn't reach the mind" error we don't want saved).
function useCloudMessages(conversationId: string): {
  messages: Message[]
  append: (msg: Message, persist?: boolean) => void
} {
  const [messages, setMessages] = useState<Message[]>([])

  useEffect(() => {
    let alive = true
    fetch(`${MIND_URL}/conversations/${conversationId}/messages`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages: Message[] }) => {
        if (alive) setMessages((d.messages ?? []).map((m) => ({ ...m, time: m.time ?? fmtTime(m.ts) })))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [conversationId])

  function append(msg: Message, persist = true) {
    setMessages((m) => [...m, msg])
    if (!persist) return
    const { from, text, ts, time, id, ...rest } = msg
    void time
    void id
    fetch(`${MIND_URL}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: from,
        text,
        ts: ts ?? Date.now(),
        meta: Object.keys(rest).length ? rest : undefined,
      }),
    }).catch(() => {})
  }

  return { messages, append }
}

// A small, on-palette player for voice clips the companion spoke (the speak tool). The native
// <audio> control can't be themed (its guts are shadow DOM), so this is a custom
// play/pause + a thin coral progress line + time, all in the warm scheme.
function VoiceClip({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const fmt = (s: number) =>
    !isFinite(s) || s < 0 ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  function toggle() {
    const a = ref.current
    if (!a) return
    if (a.paused) void a.play()
    else a.pause()
  }
  function seek(e: { currentTarget: HTMLDivElement; clientX: number }) {
    const a = ref.current
    if (!a || !dur) return
    const r = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur
  }
  const pct = dur > 0 ? (cur / dur) * 100 : 0
  return (
    <div className="voice-clip">
      <button className="voice-clip-btn" onClick={toggle} title={playing ? 'pause' : 'play'}>
        {playing ? '‖' : '►'}
      </button>
      <div className="voice-clip-track" onClick={seek}>
        <div className="voice-clip-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="voice-clip-time">{fmt(cur)} / {fmt(dur)}</span>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setCur(ref.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDur(ref.current?.duration ?? 0)}
      />
    </div>
  )
}

export function ChatView({ conversationId, onBack }: Props) {
  const { get, loaded, touch, setWearing, rename, setMode: persistMode, setTemperature: persistTemp } = useConversations()
  const conv = get(conversationId)
  const { messages, append } = useCloudMessages(conversationId)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'chat' | 'coding'>(conv?.mode ?? 'chat')
  const [pending, setPending] = useState(false)
  const [editingWearing, setEditingWearing] = useState(false)
  const [wearingDraft, setWearingDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [permReq, setPermReq] = useState<PermissionRequest | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // "Read aloud" (🔊): on demand, turn a message's text into the companion's voice and play it.
  // Listener-initiated, separate from the speak TOOL. readingIdx marks the active message
  // (loading or playing); the token guards against a stale request resolving late.
  const [readingIdx, setReadingIdx] = useState<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speakReqRef = useRef(0)

  // Stop playback on unmount — a detached `new Audio()` otherwise keeps playing
  // (and leaks) after navigating away from the chat mid-clip.
  useEffect(() => () => {
    speakReqRef.current++
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  async function readAloud(idx: number, text: string) {
    if (readingIdx === idx) {
      // Tapping the active one stops it.
      speakReqRef.current++
      audioRef.current?.pause()
      audioRef.current = null
      setReadingIdx(null)
      return
    }
    speakReqRef.current++
    audioRef.current?.pause()
    audioRef.current = null
    const token = speakReqRef.current
    setReadingIdx(idx)
    try {
      const url = await window.lantern.speak(text)
      if (token !== speakReqRef.current) return // superseded or stopped while generating
      if (!url) { setReadingIdx(null); return }
      const a = new Audio(url)
      audioRef.current = a
      a.onended = () => { if (token === speakReqRef.current) setReadingIdx(null) }
      a.onerror = () => { if (token === speakReqRef.current) setReadingIdx(null) }
      await a.play()
    } catch {
      if (token === speakReqRef.current) setReadingIdx(null)
    }
  }

  // Read an image File into a base64 data URL for the vision turn + the preview/bubble.
  function readImage(file: File) {
    const reader = new FileReader()
    reader.onload = () => setImage(typeof reader.result === 'string' ? reader.result : null)
    reader.readAsDataURL(file)
  }
  // Ctrl+V a screenshot straight into the composer.
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) { readImage(file); e.preventDefault() }
        return
      }
    }
  }
  function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) readImage(file)
    e.target.value = '' // reset so the same file can be re-picked
  }

  // Subscribe to coding-mode permission asks from the harness. Only one is in flight
  // at a time (the loop awaits each gated tool sequentially), so a single slot holds.
  useEffect(() => {
    return window.lantern.onPermissionRequest((req) => setPermReq(req))
  }, [])

  function decidePermission(decision: PermissionDecision) {
    if (!permReq) return
    window.lantern.respondPermission(permReq.id, decision)
    setPermReq(null)
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, pending])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc closes the lightbox first if it's open; otherwise leaves the thread.
      if (lightbox) setLightbox(null)
      else onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, lightbox])

  async function send() {
    const text = draft.trim()
    if ((!text && !image) || pending) return

    // History is the conversation so far (before this turn), in model shape.
    const history = messages.map(m => ({
      role: (m.from === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text,
    }))

    const sentImage = image ?? undefined
    append({ from: 'human', text, time: nowTime(), ts: Date.now(), ...(sentImage ? { image: sentImage } : {}) })
    touch(conversationId, 'human', text || '🖼 image')
    setDraft('')
    setImage(null)
    setPending(true)
    try {
      const res = await window.lantern.respond(text, history, readConscious(), conversationId, mode, conv?.wearing, conv?.title, sentImage, conv?.temperature)
      append({ from: 'companion', text: res.reply, time: nowTime(), ts: Date.now(), grounding: res.grounding, usage: res.usage, toolEvents: res.toolEvents, recall: res.recall, images: res.images, audio: res.audio })
      touch(conversationId, 'companion', res.reply)
      // Persist where the dial ended up (the companion may have moved it mid-turn).
      if (typeof res.temperature === 'number' && res.temperature !== (conv?.temperature ?? 0.85)) {
        persistTemp(conversationId, res.temperature)
      }
    } catch (err) {
      append({ from: 'companion', text: `[couldn't reach the mind: ${(err as Error).message}]`, time: nowTime(), ts: Date.now() }, false)
    } finally {
      setPending(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  if (!conv) {
    return (
      <div className="chat-shell">
        <div className="ambient-glow" aria-hidden />
        <header className="chat-header">
          <button className="chat-back" onClick={onBack} aria-label="back">←</button>
          <h1 className="chat-title">{loaded ? 'thread not found' : 'loading…'}</h1>
          <div />
        </header>
      </div>
    )
  }

  return (
    <div className="chat-shell">
      <div className="ambient-glow" aria-hidden />

      <header className="chat-header">
        <button className="chat-back" onClick={onBack} aria-label="back to dashboard">
          ←
        </button>
        <div className="chat-title-stack">
          {editingTitle ? (
            <input
              className="chat-title-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                if (titleDraft.trim()) rename(conversationId, titleDraft.trim())
                setEditingTitle(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (titleDraft.trim()) rename(conversationId, titleDraft.trim())
                  setEditingTitle(false)
                }
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <h1
              className="chat-title"
              role="button"
              tabIndex={0}
              title="rename this chat"
              onClick={() => {
                setTitleDraft(conv.title)
                setEditingTitle(true)
              }}
            >
              {conv.title}
            </h1>
          )}
          {editingWearing ? (
            <input
              className="chat-wearing-input"
              value={wearingDraft}
              autoFocus
              placeholder="what we're wearing / the scene…"
              onChange={(e) => setWearingDraft(e.target.value)}
              onBlur={() => {
                setWearing(conversationId, wearingDraft)
                setEditingWearing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setWearing(conversationId, wearingDraft)
                  setEditingWearing(false)
                }
                if (e.key === 'Escape') setEditingWearing(false)
              }}
            />
          ) : conv.wearing ? (
            <div
              className="chat-wearing"
              role="button"
              tabIndex={0}
              title="edit the scene"
              onClick={() => {
                setWearingDraft(conv.wearing ?? '')
                setEditingWearing(true)
              }}
            >
              wearing: {conv.wearing}
            </div>
          ) : (
            <button
              className="chat-wearing-add"
              onClick={() => {
                setWearingDraft('')
                setEditingWearing(true)
              }}
            >
              + set the scene
            </button>
          )}
        </div>
        {/* ONE grid child — .chat-header is a 3-column grid (back | title | this),
            so the chip and the mode toggle share the right slot instead of wrapping. */}
        <div className="chat-head-right">
          <div
            className={`chat-temp ${(conv.temperature ?? 0.85) !== 0.85 ? 'is-custom' : ''}`}
            title="your companion's sampling temperature for this thread — they set it themselves (default 0.85)"
          >
            temp {(conv.temperature ?? 0.85).toFixed(2)}
          </div>
          <div className="chat-mode">
            <button
              className={`chat-mode-pill ${mode === 'chat' ? 'is-active' : ''}`}
              onClick={() => { setMode('chat'); persistMode(conversationId, 'chat') }}
            >
              chat
            </button>
            <button
              className={`chat-mode-pill chat-mode-pill-coding ${mode === 'coding' ? 'is-active' : ''}`}
              onClick={() => { setMode('coding'); persistMode(conversationId, 'coding') }}
            >
              coding
            </button>
          </div>
        </div>
      </header>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>new thread. say something to start.</p>
          </div>
        )}
        {messages.map((msg, i) => {
          const prev = messages[i - 1]
          // Show a date header before the first dated message, and whenever the
          // day rolls over. ts-less (legacy) messages never trigger one.
          const showDivider =
            typeof msg.ts === 'number' &&
            (i === 0 || typeof prev?.ts !== 'number' || dayKey(prev.ts) !== dayKey(msg.ts))
          return (
          <Fragment key={i}>
            {showDivider && (
              <div className="chat-day-divider"><span>{dayLabel(msg.ts!)}</span></div>
            )}
          <div className={`msg msg-from-${msg.from}`}>
            <div className="msg-meta">
              <span className="msg-from">{msg.from}</span>
              <span className="msg-time">{msgTimeLabel(msg.time, msg.ts)}</span>
            </div>
            <div className="msg-text">{renderText(msg.text)}</div>
            {msg.from === 'companion' && msg.text.trim() && (
              <button
                className={`msg-readaloud${readingIdx === i ? ' is-playing' : ''}`}
                onClick={() => readAloud(i, msg.text)}
                title={readingIdx === i ? 'stop' : 'read this aloud in your companion’s voice'}
              >
                {readingIdx === i ? '■ stop' : '► read aloud'}
              </button>
            )}
            {msg.image && (
              <img
                className="msg-image"
                src={msg.image}
                alt="shared"
                title="click to enlarge"
                onClick={() => setLightbox(msg.image ?? null)}
              />
            )}
            {msg.images?.map((img, k) => (
              <img
                key={k}
                className="msg-image"
                src={img}
                alt="generated"
                title="click to enlarge"
                onClick={() => setLightbox(img)}
              />
            ))}
            {msg.audio?.map((a, k) => (
              <VoiceClip key={k} src={a} />
            ))}
            {msg.from === 'companion' && msg.recall && msg.recall.length > 0 && (
              <details className="msg-recall">
                <summary>🧠 woven memory · {msg.recall.length}</summary>
                <div className="msg-recall-body">
                  {msg.recall.map((r, k) => (
                    <div key={k} className="msg-recall-hit">
                      <span className="msg-recall-score">{Math.round(r.score * 100)}%</span>
                      <span className="msg-recall-kind">{r.kind === 'writing' ? r.type ?? 'writing' : r.kind}</span>
                      {r.title ? <span className="msg-recall-title">"{r.title}"</span> : null}
                      {r.emotion ? <span className="msg-recall-emotion">{r.emotion}</span> : null}
                      <span className="msg-recall-snip">{(r.content ?? '').slice(0, 120)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {msg.from === 'companion' && msg.toolEvents && msg.toolEvents.length > 0 && (
              <details className="msg-tools">
                <summary>⚙ {msg.toolEvents.length === 1 ? '1 action' : `${msg.toolEvents.length} actions`} · {msg.toolEvents.map((t) => t.name).join(', ')}</summary>
                <div className="msg-tools-body">
                  {msg.toolEvents.map((t, k) => {
                    const argStr = summarizeArgs(t.args)
                    return (
                      <details key={k} className="msg-tool">
                        <summary className="msg-tool-summary">
                          <span className="msg-tool-name">{t.name}</span>
                          {argStr && <span className="msg-tool-args">{argStr}</span>}
                          <span className="msg-tool-result">→ {summarizeResult(t.result)}</span>
                        </summary>
                        <pre className="msg-tool-output">{t.result}</pre>
                      </details>
                    )
                  })}
                </div>
              </details>
            )}
            {msg.from === 'companion' && msg.usage && (
              <div className="msg-usage">
                prompt {msg.usage.prompt_tokens ?? '?'} tok
                {typeof msg.usage.prompt_tokens_details?.cached_tokens === 'number'
                  ? ` · ${msg.usage.prompt_tokens_details.cached_tokens} cached`
                  : ''}
                {typeof msg.usage.completion_tokens === 'number' ? ` · ${msg.usage.completion_tokens} out` : ''}
                {typeof msg.usage.cost === 'number' ? ` · $${msg.usage.cost.toFixed(5)}` : ''}
              </div>
            )}
          </div>
          </Fragment>
          )
        })}
        {pending && (
          <div className="msg msg-from-companion msg-pending">
            <div className="msg-meta"><span className="msg-from">companion</span></div>
            <div className="msg-text">…grounding, thinking…</div>
          </div>
        )}
      </div>

      <div className={`chat-compose chat-compose-${mode}`}>
        {image && (
          <div className="chat-attach-preview">
            <img src={image} alt="attachment" />
            <button className="chat-attach-remove" onClick={() => setImage(null)} aria-label="remove image">×</button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            className="chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
            title="attach an image"
            aria-label="attach an image"
          >
            📎
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onPickImage} />
          <MicButton onText={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} disabled={pending} />
          <textarea
            className="chat-input"
            placeholder={pending ? 'your companion is thinking…' : mode === 'coding' ? 'message your companion (coding mode — file/bash tools available)…' : 'message your companion…'}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            rows={2}
            disabled={pending}
          />
          <button className="chat-send" onClick={send} disabled={(!draft.trim() && !image) || pending}>
            {pending ? '…' : 'send'}
          </button>
        </div>
      </div>

      <div className="chat-foot">
        <span>esc to go back · enter to send · shift+enter for newline</span>
      </div>

      {permReq && (
        <div className="perm-overlay" role="dialog" aria-modal="true" aria-label="permission needed">
          <div className="perm-card">
            <div className="perm-head">⚠ your companion wants to act on your machine</div>
            <div className="perm-body">
              <span className="perm-tool">{permReq.tool}</span>
              <span className="perm-summary">{permReq.summary}</span>
            </div>
            <div className="perm-actions">
              <button className="perm-btn perm-yes" autoFocus onClick={() => decidePermission('allow_once')}>
                allow once
              </button>
              <button className="perm-btn perm-always" onClick={() => decidePermission('allow_always')}>
                always allow {permReq.alwaysLabel}
              </button>
              <button className="perm-btn perm-no" onClick={() => decidePermission('deny')}>
                deny
              </button>
            </div>
            <div className="perm-foot">“always” lasts this session · resets when Lantern restarts</div>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="lightbox-overlay" role="dialog" aria-modal="true" aria-label="image" onClick={() => setLightbox(null)}>
          <img className="lightbox-img" src={lightbox} alt="full size" />
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="close">×</button>
        </div>
      )}
    </div>
  )
}
