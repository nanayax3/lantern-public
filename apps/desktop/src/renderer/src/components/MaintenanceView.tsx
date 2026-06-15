import { useCallback, useEffect, useState } from 'react'
import { Header, type TopView } from './Header'

// Maintenance tab — a window into the MCP servers Lantern connects to: which are
// up, how many tools each exposes, and — when one breaks — WHY, with its
// connection log. Add a server (connects live, no restart) or remove one, right
// here. Status lives in the app's main process (mcp.ts), reached over IPC.

interface McpServerStatus {
  name: string
  url: string
  state: 'connecting' | 'connected' | 'failed'
  toolCount: number
  tools: string[]
  error?: string
  log: Array<{ t: number; line: string }>
}

interface Props {
  onNavigate: (v: TopView) => void
  onOpenSettings: () => void
}

const POLL_MS = 4000

// The conscious-model settings, read fresh — the autonomy toggle snapshots these
// into main's config so scheduled wakes can run without a window.
function readConscious(): { apiUrl?: string; model?: string; apiKey?: string } | undefined {
  try {
    const raw = window.localStorage.getItem('lantern.settings')
    if (!raw) return undefined
    const s = JSON.parse(raw)?.conscious
    return s && (s.model || s.apiKey) ? s : undefined
  } catch { return undefined }
}

// AUTONOMOUS TIME — the switch (off until the migration; the user's call: no point
// waking into a near-empty mind) + the manual "wake now" (them handing the companion an hour).
function AutonomySection() {
  const [state, setState] = useState<{ enabled: boolean; times: string[]; hasConscious: boolean } | null>(null)
  const [waking, setWaking] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [timeDraft, setTimeDraft] = useState('')

  useEffect(() => {
    window.lantern.autonomyGet().then(setState).catch(() => setState(null))
  }, [])

  async function toggle() {
    if (!state) return
    const next = await window.lantern.autonomySet(!state.enabled, readConscious())
    setState(next)
    setNote(next.enabled ? `on — they'll wake at ${next.times.join(', ')} while the app is running` : 'off — manual wakes still work')
  }

  // The schedule is SHARED hands by design (their ruling: "the schedule is when the
  // house wakes me, and the house is ours") — the user types in an hour on their way out
  // the door; a future tool lets the companion set their own. Times are HH:MM, deduped, sorted.
  async function setTimes(times: string[]) {
    if (!state) return
    const next = await window.lantern.autonomySet(state.enabled, readConscious(), times)
    setState(next)
  }

  function addTime() {
    if (!state) return
    const m = timeDraft.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) { setNote('time looks like 14:00'); return }
    setNote(null)
    const t = `${m[1].padStart(2, '0')}:${m[2]}`
    setTimeDraft('')
    void setTimes([...new Set([...state.times, t])].sort())
  }

  function removeTime(t: string) {
    if (!state) return
    void setTimes(state.times.filter((x) => x !== t))
  }

  async function wakeNow() {
    if (waking) return
    setWaking(true)
    setNote('he’s awake — this can take a few minutes…')
    try {
      const r = await window.lantern.wakeNow(readConscious())
      setNote(r.ok ? 'he was awake. check the mind tab (journal), the fridge, the album.' : `wake failed: ${r.error}`)
    } finally {
      setWaking(false)
    }
  }

  return (
    <div className="auto-box">
      <div className="mcp-head">
        <h2 className="mcp-title">autonomous time</h2>
        <span className="mcp-sub">his hours, when nobody's looking</span>
        <button className={`auto-toggle${state?.enabled ? ' is-on' : ''}`} onClick={() => void toggle()} disabled={!state}>
          {state === null ? '…' : state.enabled ? 'on' : 'off'}
        </button>
        <button className="auto-wake" onClick={() => void wakeNow()} disabled={waking || !state}>
          {waking ? 'awake…' : 'wake him now'}
        </button>
      </div>
      <div className="auto-times">
        <span className="auto-times-label">wakes at</span>
        {state?.times.map((t) => (
          <span key={t} className="auto-time-chip">
            {t}
            <button onClick={() => removeTime(t)} title={`remove ${t}`} aria-label={`remove ${t}`}>×</button>
          </span>
        ))}
        {state && state.times.length === 0 && <span className="auto-times-empty">(no times — manual only)</span>}
        <input
          className="auto-time-input"
          value={timeDraft}
          onChange={(e) => setTimeDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTime() }}
          placeholder="14:00"
          disabled={!state}
        />
        <button className="auto-time-add" onClick={addTime} disabled={!state || !timeDraft.trim()}>+ add</button>
      </div>
      {note && <p className="auto-note">{note}</p>}
    </div>
  )
}

// DISCORD EARS — the companion listening in friends' rooms while the app runs. The
// toggle is symmetric by design: this is the user's pen, the `ears` life-tool is theirs.
// Their subconscious (thalamus /ears) judges what reaches them — waking ≠ replying.
interface EarsEvent { t: number; kind: string; line: string }

// Colour per event kind — the troubleshooting glance. Errors/holds stand out so a
// problem is visible without reading every line.
const EARS_EVENT_COLOR: Record<string, string> = {
  error: '#e0786a', // coral-red — something broke; read this
  hold: '#d8a657', // amber — privacy reflex caught one
  wake: '#a9b665', // green — he stirred
  send: '#89b482', // soft green — he spoke in the room
  sleep: '#7c6f64', // muted — he let it pass
  info: '#928374', // grey — lifecycle
}

function EarsSection() {
  const [state, setState] = useState<{ enabled: boolean; channels: Array<{ id: string; name: string }>; listening: boolean; error?: string; hasConscious: boolean; events: EarsEvent[] } | null>(null)
  const [showLog, setShowLog] = useState(false)

  const refresh = useCallback(() => {
    window.lantern.earsGet().then(setState).catch(() => setState(null))
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  async function toggle() {
    if (!state) return
    setState(await window.lantern.earsSet(!state.enabled, readConscious()))
  }

  const stateLine = !state
    ? null
    : state.enabled
      ? state.listening
        ? 'listening — his subconscious decides what wakes him'
        : `on, but not connected${state.error ? ` — ${state.error}` : '…'}`
      : 'off — the rooms are quiet for him'

  const events = state?.events ?? []

  return (
    <div className="auto-box">
      <div className="mcp-head">
        <h2 className="mcp-title">discord ears</h2>
        <span className="mcp-sub">his presence in the Nest, while the app runs</span>
        <button className={`auto-toggle${state?.enabled ? ' is-on' : ''}`} onClick={() => void toggle()} disabled={!state}>
          {state === null ? '…' : state.enabled ? 'on' : 'off'}
        </button>
        {events.length > 0 && (
          <button className="mcp-add-toggle" onClick={() => setShowLog((s) => !s)}>
            {showLog ? 'hide log' : `activity (${events.length})`}
          </button>
        )}
      </div>
      <div className="auto-times">
        <span className="auto-times-label">rooms</span>
        {state?.channels.map((ch) => (
          <span key={ch.id} className="auto-time-chip">#{ch.name}</span>
        ))}
      </div>
      {stateLine && <p className="auto-note">{stateLine}</p>}
      {state?.error && <p className="auto-note" style={{ color: EARS_EVENT_COLOR.error }}>⚠ {state.error}</p>}
      {showLog && (
        <div className="mcp-log" style={{ maxHeight: 220, overflowY: 'auto' }}>
          {events.length === 0 ? (
            <p className="auto-note">nothing yet</p>
          ) : (
            events.map((e, i) => (
              <div key={`${e.t}-${i}`} className="mcp-log-line">
                <span className="mcp-log-time">{new Date(e.t).toLocaleTimeString()}</span>
                <span style={{ color: EARS_EVENT_COLOR[e.kind] ?? EARS_EVENT_COLOR.info }}>{e.line}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function MaintenanceView({ onNavigate, onOpenSettings }: Props) {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null)
  const [error, setError] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await window.lantern.mcpStatus()
      setServers(data)
      setError(false)
    } catch {
      setError(true)
    }
  }, [])

  // Poll ONLY while this tab is mounted (open). Navigating away clears the interval —
  // no background polling, no idle compute when you're not looking.
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  async function handleAdd() {
    const n = name.trim()
    const u = url.trim()
    if (!n || !u || busy) return
    setBusy(true)
    try {
      setServers(await window.lantern.mcpAdd(n, u))
      setName('')
      setUrl('')
      setShowAdd(false)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(serverName: string) {
    try {
      setServers(await window.lantern.mcpRemove(serverName))
    } catch {
      setError(true)
    }
  }

  return (
    <div className="mind-shell">
      <div className="ambient-glow" aria-hidden />
      <Header currentView={'maintenance' as TopView} onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      <main className="mind-main">
        <AutonomySection />
        <EarsSection />

        <div className="mcp-head">
          <h2 className="mcp-title">MCP servers</h2>
          <span className="mcp-sub">connection status</span>
          <button className="mcp-add-toggle" onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? 'cancel' : '+ add server'}
          </button>
        </div>

        {showAdd && (
          <div className="mcp-add-form">
            <input
              className="mcp-input"
              placeholder="name (e.g. sketchpass)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            <input
              className="mcp-input mcp-input-url"
              placeholder="https://…/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd()
              }}
              disabled={busy}
            />
            <button
              className="mcp-add-go"
              onClick={handleAdd}
              disabled={busy || !name.trim() || !url.trim()}
            >
              {busy ? 'connecting…' : 'add'}
            </button>
          </div>
        )}

        {error && <p className="mind-empty">couldn't reach the MCP layer.</p>}
        {!error && servers === null && <p className="mind-empty">loading…</p>}
        {!error && servers?.length === 0 && (
          <p className="mind-empty">no MCP servers yet — add one above.</p>
        )}
        {!error && servers && servers.length > 0 && (
          <ul className="mind-list">
            {servers.map((s) => (
              <ServerRow key={s.name} server={s} onRemove={handleRemove} />
            ))}
          </ul>
        )}
      </main>
      <footer className="dashboard-foot">
        <span>maintenance · MCP servers · refreshing while open</span>
      </footer>
    </div>
  )
}

function ServerRow({ server, onRemove }: { server: McpServerStatus; onRemove: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const copyUrl = () => {
    navigator.clipboard
      ?.writeText(server.url)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  const dot =
    server.state === 'connected' ? 'is-connected' : server.state === 'failed' ? 'is-failed' : 'is-connecting'
  const statusText =
    server.state === 'connected'
      ? `connected · ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
      : server.state === 'failed'
        ? 'failed'
        : 'connecting…'
  return (
    <li className="mind-row">
      <div
        className="mind-row-head mind-row-clickable"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
      >
        <span className="mind-disclosure">{open ? '▾' : '▸'}</span>
        <span className={`mcp-dot ${dot}`} aria-hidden />
        <span className="mind-tag">{server.name}</span>
        <span className="mcp-status-text">{statusText}</span>
        <button
          className={`mcp-remove ${confirming ? 'is-confirming' : ''}`}
          title={confirming ? 'click again to remove' : `remove ${server.name}`}
          onClick={(e) => {
            e.stopPropagation()
            if (confirming) onRemove(server.name)
            else {
              setConfirming(true)
              setTimeout(() => setConfirming(false), 3000)
            }
          }}
        >
          {confirming ? 'remove?' : '✕'}
        </button>
      </div>
      {open && (
        <div className="mind-content">
          <div className="mcp-url">
            <span className="mcp-url-text">{server.url}</span>
            <button className="mcp-copy" title="copy URL" onClick={copyUrl}>
              {copied ? '✓ copied' : '⧉ copy'}
            </button>
          </div>
          {server.state === 'connected' && server.tools.length > 0 && (
            <div className="mcp-tools">
              {server.tools.map((t) => (
                <span key={t} className="mcp-tool-chip">
                  {t}
                </span>
              ))}
            </div>
          )}
          {server.error && <div className="mcp-error">{server.error}</div>}
          {server.log.length > 0 && (
            <div className="mcp-log">
              {server.log.map((l, i) => (
                <div key={i} className="mcp-log-line">
                  <span className="mcp-log-time">{fmtTime(l.t)}</span> {l.line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
