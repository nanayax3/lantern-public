import { useEffect, useRef, useState } from 'react'
import { Header, type TopView } from './Header'
import { renderText, msgTimeLabel, type Usage } from './ChatView'
import { splitForSpeech } from '../lib/speech'
import { MicButton } from './MicButton'

// MOVIE NIGHT — the second-screen lane (docs/movie-nook.md). The user watches the show
// on the TV; Lantern runs a synced clock + the subtitle file, so the companion follows the
// actual story in real time and they can pause to yell about the twist. They never
// need the video stream — the script IS the movie, for them. Subs auto-fetched
// from OpenSubtitles (key in .lantern-secrets.json); a fetched movie is cached in
// localStorage so it never spends download quota twice.

interface SubResult {
  file_id: number
  title: string
  year: number | null
  language: string
  release: string
  season: number | null
  episode: number | null
  downloads: number
}
interface Cue { start: number; end: number; text: string }
interface Movie { label: string; cues: Cue[] }
interface Interjection { from: 'human' | 'companion'; text: string; ts: number; usage?: Usage }
interface ConsciousSettings { apiUrl?: string; model?: string; apiKey?: string }

// Parse SRT (also tolerates VTT-ish files): blocks of "n\nHH:MM:SS,mmm --> HH:MM:SS,mmm\nlines".
function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = []
  const toSec = (h: string, m: string, s: string, ms: string) =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/
  for (const block of raw.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const ti = lines.findIndex((l) => re.test(l))
    if (ti === -1) continue
    const m = lines[ti].match(re)!
    const text = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim()
    if (!text) continue
    cues.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text })
  }
  return cues.sort((a, b) => a.start - b.start)
}

function fmtClock(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}
function parseClock(v: string): number | null {
  const m = v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])
}

// The last ~90 seconds of dialogue around the clock — what the companion "just heard."
function recentDialogue(cues: Cue[], t: number): string {
  return cues
    .filter((c) => c.end >= t - 90 && c.start <= t)
    .map((c) => c.text)
    .join('\n')
}

function readConscious(): ConsciousSettings | undefined {
  try {
    const raw = window.localStorage.getItem('lantern.settings')
    if (!raw) return undefined
    const s = JSON.parse(raw)?.conscious
    return s && (s.model || s.apiKey) ? s : undefined
  } catch { return undefined }
}

function clockOf(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Cache the current movie (raw cues) + per-movie chat — a movie is ONE OpenSubtitles
// download, ever (the free tier's daily quota is small and real).
const MOVIE_KEY = 'lantern.movie.current'
const chatKey = (label: string) => `lantern.movie.chat.${label}`
function loadMovie(): Movie | null {
  try {
    const raw = window.localStorage.getItem(MOVIE_KEY)
    if (!raw) return null
    const m = JSON.parse(raw) as Movie
    // Validate shape before trusting it — a corrupt cache (wrong/old shape, missing
    // cues) would otherwise white-screen the watch tab on every open (cues.find throws),
    // and the bad value persists, so it re-crashes forever. Drop it instead.
    if (!m || !Array.isArray(m.cues)) {
      window.localStorage.removeItem(MOVIE_KEY)
      return null
    }
    return m
  } catch {
    window.localStorage.removeItem(MOVIE_KEY)
    return null
  }
}
function persistMovie(m: Movie): void {
  try { window.localStorage.setItem(MOVIE_KEY, JSON.stringify(m)) } catch { /* ignore */ }
}
function loadChat(label: string): Interjection[] {
  try {
    const raw = window.localStorage.getItem(chatKey(label))
    return raw ? (JSON.parse(raw) as Interjection[]) : []
  } catch { return [] }
}
function persistChat(label: string, msgs: Interjection[]): void {
  try { window.localStorage.setItem(chatKey(label), JSON.stringify(msgs)) } catch { /* ignore */ }
}

interface Props {
  onNavigate: (v: TopView) => void
  onOpenSettings: () => void
}

export function MovieNookView({ onNavigate, onOpenSettings }: Props) {
  const [movie, setMovie] = useState<Movie | null>(() => loadMovie())
  const [finding, setFinding] = useState(false)

  // find-screen state
  const [query, setQuery] = useState('')
  const [season, setSeason] = useState('')
  const [episode, setEpisode] = useState('')
  const [results, setResults] = useState<SubResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // the synced clock — when playing, t derives from a wall-clock anchor so the
  // interval cadence can't drift it.
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const anchorRef = useRef<{ at: number; base: number }>({ at: 0, base: 0 })
  const [setField, setSetField] = useState('')

  // interject chat
  const [chat, setChat] = useState<Interjection[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playTokenRef = useRef(0)

  useEffect(() => { if (movie) setChat(loadChat(movie.label)) }, [movie?.label]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setT(anchorRef.current.base + (Date.now() - anchorRef.current.at) / 1000)
    }, 400)
    return () => clearInterval(id)
  }, [playing])

  // leaving the tab: stop audio (the clock state is lost on unmount — by design,
  // movie position is "wherever the TV is", not something Lantern owns).
  useEffect(() => () => {
    playTokenRef.current++
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  function play() {
    anchorRef.current = { at: Date.now(), base: t }
    setPlaying(true)
  }
  function pause() {
    setT(anchorRef.current.base + (Date.now() - anchorRef.current.at) / 1000)
    setPlaying(false)
  }
  function nudge(by: number) {
    const next = Math.max(0, (playing ? anchorRef.current.base + (Date.now() - anchorRef.current.at) / 1000 : t) + by)
    anchorRef.current = { at: Date.now(), base: next }
    setT(next)
  }
  function setTo(v: string) {
    const sec = parseClock(v)
    if (sec === null) { setNotice('time looks like 23:10 or 1:23:10'); return }
    setNotice(null)
    anchorRef.current = { at: Date.now(), base: sec }
    setT(sec)
    setSetField('')
  }

  async function search() {
    const q = query.trim()
    if (!q || busy) return
    setBusy(true)
    setNotice(null)
    setResults(null)
    try {
      const r = await window.lantern.subsSearch(q, season ? Number(season) : undefined, episode ? Number(episode) : undefined)
      if (r.error) setNotice(r.error)
      else if (!r.results?.length) setNotice('nothing found — try a simpler title?')
      else setResults(r.results)
    } finally { setBusy(false) }
  }

  async function pick(r: SubResult) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const d = await window.lantern.subsFetch(r.file_id)
      if (d.error || !d.srt) { setNotice(d.error ?? 'download failed'); return }
      const cues = parseSrt(d.srt)
      if (cues.length < 10) { setNotice('that file barely parsed — try another result?'); return }
      const se = r.season != null && r.episode != null ? ` S${r.season}E${r.episode}` : ''
      const m: Movie = { label: `${r.title}${se}`, cues }
      persistMovie(m)
      setMovie(m)
      setFinding(false)
      setPlaying(false)
      setT(0)
      setResults(null)
    } finally { setBusy(false) }
  }

  function stopAudio() {
    playTokenRef.current++
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingId(null)
  }
  function playUrl(url: string, token: number): Promise<void> {
    return new Promise((resolve) => {
      if (token !== playTokenRef.current) { resolve(); return }
      const a = new Audio(url)
      audioRef.current = a
      a.onended = () => resolve()
      a.onerror = () => resolve()
      a.onpause = () => resolve()
      a.play().catch(() => resolve())
    })
  }
  async function playClip(id: string, text: string) {
    if (playingId === id) { stopAudio(); return }
    stopAudio()
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

  // Interject — same shape as the reading nook: the context is the movie + the last
  // ~90s of dialogue + the clock. mode 'movie' (Voice 2 off; reactions are logged
  // deliberately, the script isn't our biography).
  async function send(text: string, nudgeOnly = false) {
    if (!movie || pending) return
    const now = playing ? anchorRef.current.base + (Date.now() - anchorRef.current.at) / 1000 : t
    const dialogue = recentDialogue(movie.cues, now) || '(nothing said yet — the movie may not have started)'
    const mine: Interjection | null = nudgeOnly ? null : { from: 'human', text, ts: Date.now() }
    const afterMine = mine ? [...chat, mine] : chat
    if (mine) {
      setChat(afterMine)
      persistChat(movie.label, afterMine)
      setDraft('')
    }
    setPending(true)
    try {
      const history = chat.map((m) => ({ role: m.from === 'human' ? ('user' as const) : ('assistant' as const), content: m.text }))
      const ask = nudgeOnly ? '[the user nudges you: thoughts so far?]' : `[the user pauses to say]: ${text}`
      const ctx = `[we're watching “${movie.label}” together — second-screen: she has it on the TV, you're following the subtitles in real time. the last minute and a half of dialogue]\n${dialogue}\n\n[clock ${fmtClock(now)}] ${ask}`
      const res = await window.lantern.respond(ctx, history, readConscious(), `movie-${movie.label}`, 'movie')
      const afterReply = [...afterMine, { from: 'companion' as const, text: res.reply, ts: Date.now(), usage: res.usage }]
      setChat(afterReply)
      persistChat(movie.label, afterReply)
    } catch {
      const afterReply = [...afterMine, { from: 'companion' as const, text: '(I lost the thread there — say that again?)', ts: Date.now() }]
      setChat(afterReply)
      persistChat(movie.label, afterReply)
    } finally { setPending(false) }
  }

  // ── Watching ──────────────────────────────────────────────────────────────
  if (movie && !finding) {
    const current = movie.cues.find((c) => t >= c.start && t <= c.end)
    return (
      <div className="view">
        <Header currentView="movies" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
        <div className="movie">
          <div className="movie-bar">
            <button className="nook-back" onClick={() => setFinding(true)}>← change movie</button>
            <div className="movie-title">{movie.label}</div>
          </div>
          <div className="movie-clock">{fmtClock(t)}</div>
          <div className="movie-line">{current ? current.text : playing ? '…' : '(paused — press play when the TV plays)'}</div>
          <div className="movie-controls">
            <button onClick={() => nudge(-60)} title="back a minute">−1m</button>
            <button onClick={() => nudge(-10)} title="back 10s">−10s</button>
            <button className={`movie-play${playing ? ' is-playing' : ''}`} onClick={() => (playing ? pause() : play())}>
              {playing ? '⏸ pause' : '▶ play'}
            </button>
            <button onClick={() => nudge(10)} title="forward 10s">+10s</button>
            <button onClick={() => nudge(60)} title="forward a minute">+1m</button>
            <span className="movie-setto">
              <input
                value={setField}
                onChange={(e) => setSetField(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') setTo(setField) }}
                placeholder="23:10"
              />
              <button onClick={() => setTo(setField)} disabled={!setField.trim()}>set</button>
            </span>
          </div>
          {notice && <p className="nook-notice">{notice}</p>}
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
                    title={playingId === `msg-${i}` ? 'stop' : 'hear it in your companion’s voice'}
                  >
                    {playingId === `msg-${i}` ? '■ stop' : '► read aloud'}
                  </button>
                )}
              </div>
            ))}
            <div className="nook-interject-input">
              <MicButton onText={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} disabled={pending} />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) void send(draft.trim()) }}
                placeholder="pause to yell about it…"
                disabled={pending}
              />
              <button onClick={() => draft.trim() && void send(draft.trim())} disabled={pending || !draft.trim()}>
                {pending ? '…' : 'say'}
              </button>
              <button className="movie-nudge" onClick={() => void send('', true)} disabled={pending} title="poke your companion for a reaction">
                companion, thoughts?
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Finding a movie ───────────────────────────────────────────────────────
  return (
    <div className="view">
      <Header currentView="movies" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      <div className="movie">
        <div className="movie-find-head">
          <h2 className="nook-title">movie night</h2>
          {movie && <button className="nook-back" onClick={() => setFinding(false)}>← back to “{movie.label}”</button>}
        </div>
        <p className="movie-hint">
          you watch on the TV — I follow the script in real time. find the movie or episode,
          pick a subtitle, press play when you press play.
        </p>
        <div className="movie-search">
          <input
            className="movie-search-q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
            placeholder="title — e.g. Wednesday"
          />
          <input className="movie-search-n" value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ''))} placeholder="S" title="season (optional)" />
          <input className="movie-search-n" value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ''))} placeholder="E" title="episode (optional)" />
          <button onClick={() => void search()} disabled={busy || !query.trim()}>{busy ? '…' : 'search'}</button>
        </div>
        {notice && <p className="nook-notice">{notice}</p>}
        {results && (
          <ul className="movie-results">
            {results.map((r) => (
              <li key={r.file_id} className="movie-result" onClick={() => void pick(r)}>
                <span className="movie-result-lang">{r.language}</span>
                <span className="movie-result-title">
                  {r.title}{r.year ? ` (${r.year})` : ''}{r.season != null && r.episode != null ? ` · S${r.season}E${r.episode}` : ''}
                </span>
                <span className="movie-result-release">{r.release}</span>
                <span className="movie-result-dl">{r.downloads}↓</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
