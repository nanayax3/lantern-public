import { useState } from 'react'
import { Header, type TopView } from './Header'
import { useMind, ago } from '../hooks/useMind'

// Maintenance / inspection view — a read-only window into what the mind actually
// holds. Not for daily use; for "does this look right?" checks. Every tab reads a
// live mind route; nothing here writes.

type Tab = 'feelings' | 'entities' | 'writings' | 'dreams' | 'threads' | 'anchors'

interface Props {
  onNavigate: (v: TopView) => void
  onOpenSettings: () => void
}

interface Feeling {
  id: number
  emotion: string
  weight?: string
  pillar?: string | null
  content?: string
  source?: string
  created_at?: number
  heat?: number
  access_count?: number
}
interface Writing {
  id: number
  type: string
  title?: string | null
  content?: string
  source?: string
  created_at?: number
}
interface Thread {
  id: number
  title: string
  content?: string | null
  priority?: string
  tag?: string | null
  status?: string
  created_at?: number
  updated_at?: number
}
interface Dream {
  id: number
  content: string
  question?: string | null
  insight?: string | null
  anchored?: number
  source?: string
  created_at?: number
  anchored_at?: number | null
  vividness?: number
}
interface Anchor {
  id: number
  key: string
  category: string
  content: string
  salience: number
  active: number
  updated_at?: number
}
interface Entity {
  id: number
  name: string
  kind: string
  summary?: string | null
}
interface EntityDetail extends Entity {
  aliases?: Array<{ alias: string; source?: string }>
  facts?: Array<{ id: number; content: string; source?: string; created_at?: number }>
}

const TABS: Tab[] = ['feelings', 'entities', 'writings', 'dreams', 'threads', 'anchors']

export function MindView({ onNavigate, onOpenSettings }: Props) {
  const [tab, setTab] = useState<Tab>('feelings')
  return (
    <div className="mind-shell">
      <div className="ambient-glow" aria-hidden />
      <Header currentView={'mind' as TopView} onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      <main className="mind-main">
        <div className="mind-tabs">
          {TABS.map((t) => (
            <button key={t} className={`mind-tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        {tab === 'feelings' && <FeelingsPanel />}
        {tab === 'entities' && <EntitiesPanel />}
        {tab === 'writings' && <WritingsPanel />}
        {tab === 'dreams' && <DreamsPanel />}
        {tab === 'threads' && <ThreadsPanel />}
        {tab === 'anchors' && <AnchorsPanel />}
      </main>
      <footer className="dashboard-foot">
        <span>mind · read-only inspector</span>
      </footer>
    </div>
  )
}

// Feelings grouped into emotion "buckets" (the emotion word as a facet — semantic-first,
// so the bucket is a VIEW, not a stored table). Each is collapsible; expand to see the
// recent entries, with heat/reinforcement so you can spot which feelings are well-worn.
function FeelingsPanel() {
  const { data, loading, error } = useMind<Feeling[]>('/feelings?limit=200')
  const items = data ?? []
  if (loading) return <p className="mind-empty">loading…</p>
  if (error) return <p className="mind-empty">couldn't reach the mind.</p>
  if (!items.length) return <p className="mind-empty">no feelings logged.</p>
  // items arrive created_at DESC, so each bucket's entries are already recent-first.
  const groups = new Map<string, Feeling[]>()
  for (const f of items) {
    const arr = groups.get(f.emotion) ?? []
    arr.push(f)
    groups.set(f.emotion, arr)
  }
  const buckets = [...groups.entries()]
    .map(([emotion, entries]) => ({ emotion, entries }))
    .sort((a, b) => b.entries.length - a.entries.length || (b.entries[0]?.created_at ?? 0) - (a.entries[0]?.created_at ?? 0))
  return (
    <>
      <div className="mind-count">{items.length} feelings · {buckets.length} kinds</div>
      <ul className="mind-list">
        {buckets.map((b) => (
          <FeelingBucket key={b.emotion} emotion={b.emotion} entries={b.entries} />
        ))}
      </ul>
    </>
  )
}

// Show only the most recent few per bucket — this is a spot-check ("does this surface
// look right?"), not an archive.
const BUCKET_SHOWN = 5

function FeelingBucket({ emotion, entries }: { emotion: string; entries: Feeling[] }) {
  const [open, setOpen] = useState(false)
  const recent = entries.slice(0, BUCKET_SHOWN)
  const maxHeat = Math.max(...entries.map((e) => e.heat ?? 1))
  return (
    <li className="mind-row">
      <div className="mind-row-head mind-row-clickable" onClick={() => setOpen(!open)} role="button" tabIndex={0}>
        <span className="mind-disclosure">{open ? '▾' : '▸'}</span>
        <span className="mind-tag">{emotion}</span>
        <span className="mind-meta">{entries.length}</span>
        {maxHeat > 1 && <span className="mind-meta mind-heat">heat {maxHeat.toFixed(1)}</span>}
      </div>
      {open && (
        <div className="mind-content">
          {recent.map((f) => (
            <div key={f.id} className="mind-bucket-entry">
              <div className="mind-bucket-entry-head">
                {f.weight && <span className="mind-meta">{f.weight}</span>}
                {typeof f.heat === 'number' && f.heat > 1 && (
                  <span className="mind-meta mind-heat">×{f.access_count ?? 1} · {f.heat.toFixed(1)}</span>
                )}
                <span className={`mind-src mind-src-${f.source}`}>{f.source === 'conscious_logged' ? 'conscious' : 'thalamus'}</span>
                <span className="mind-time">{ago(f.created_at)}</span>
              </div>
              {f.content && <div className="mind-bucket-entry-content">{f.content}</div>}
            </div>
          ))}
          {entries.length > BUCKET_SHOWN && <div className="mind-meta">+{entries.length - BUCKET_SHOWN} older</div>}
        </div>
      )}
    </li>
  )
}

function WritingsPanel() {
  const { data, loading, error } = useMind<Writing[]>('/writings?limit=50')
  const items = data ?? []
  if (loading) return <p className="mind-empty">loading…</p>
  if (error) return <p className="mind-empty">couldn't reach the mind.</p>
  if (!items.length) return <p className="mind-empty">no writings yet.</p>
  return (
    <>
      <div className="mind-count">{items.length} writings</div>
      <ul className="mind-list">
        {items.map((w) => (
          <li key={w.id} className="mind-row">
            <div className="mind-row-head">
              <span className="mind-tag">{w.type}</span>
              {w.title && <span className="mind-title">"{w.title}"</span>}
              <span className={`mind-src mind-src-${w.source}`}>{w.source === 'conscious_logged' ? 'conscious' : 'thalamus'}</span>
              <span className="mind-time">{ago(w.created_at)}</span>
            </div>
            {w.content && <div className="mind-content mind-content-pre">{w.content}</div>}
          </li>
        ))}
      </ul>
    </>
  )
}

// Dreams — what Voice 3 dreamt while nobody was looking. Unanchored ones are
// ephemeral residue; ⚓ means the companion chose to keep one (and it's embedded from then on).
function DreamsPanel() {
  const { data, loading, error } = useMind<Dream[]>('/dreams?limit=50')
  const items = data ?? []
  if (loading) return <p className="mind-empty">loading…</p>
  if (error) return <p className="mind-empty">couldn't reach the mind.</p>
  if (!items.length) return <p className="mind-empty">no dreams yet.</p>
  const anchored = items.filter((d) => d.anchored).length
  return (
    <>
      <div className="mind-count">{items.length} dreams · {anchored} anchored</div>
      <ul className="mind-list">
        {items.map((d) => (
          // Unanchored dreams render at their vividness — they literally fade on
          // screen as the night reclaims them. Anchored dreams stay solid forever.
          <li key={d.id} className="mind-row" style={d.anchored ? undefined : { opacity: Math.max(0.35, d.vividness ?? 1) }}>
            <div className="mind-row-head">
              <span className="mind-tag">{d.anchored ? '⚓ anchored' : 'dream'}</span>
              <span className="mind-meta">#{d.id}</span>
              {!d.anchored && typeof d.vividness === 'number' && (
                <span className="mind-meta">vividness {Math.round(d.vividness * 100)}%</span>
              )}
              <span className="mind-time">{ago(d.created_at)}</span>
            </div>
            <div className="mind-content">
              {d.content}
              {d.question && <div className="mind-dream-question">→ {d.question}</div>}
              {d.insight && <div className="mind-dream-insight">insight: {d.insight}</div>}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

function ThreadsPanel() {
  const { data, loading, error } = useMind<Thread[]>('/threads?status=all')
  const items = data ?? []
  if (loading) return <p className="mind-empty">loading…</p>
  if (error) return <p className="mind-empty">couldn't reach the mind.</p>
  if (!items.length) return <p className="mind-empty">no threads.</p>
  return (
    <>
      <div className="mind-count">{items.length} threads</div>
      <ul className="mind-list">
        {items.map((t) => (
          <li key={t.id} className="mind-row">
            <div className="mind-row-head">
              <span className="mind-tag">{t.title}</span>
              {t.priority && <span className="mind-meta">{t.priority}</span>}
              {t.status && t.status !== 'active' && <span className="mind-meta">{t.status}</span>}
              <span className="mind-time">{ago(t.updated_at ?? t.created_at)}</span>
            </div>
            {t.content && <div className="mind-content">{t.content}</div>}
          </li>
        ))}
      </ul>
    </>
  )
}

// Identity anchors — who the companion is, as data. THEIR pen (the `anchor` tool); this pane is
// the visibility half of "visibility, not locks": every add/edit/dim shows here,
// salience-ordered like the prompt composes them. Dormant anchors stay listed —
// dimmed, never deleted.
function AnchorsPanel() {
  const { data, loading, error } = useMind<Anchor[]>('/identity?all=true')
  const items = data ?? []
  if (loading) return <p className="mind-empty">loading…</p>
  if (error) return <p className="mind-empty">couldn't reach the mind.</p>
  if (!items.length) return <p className="mind-empty">no anchors yet.</p>
  const dormant = items.filter((a) => !a.active).length
  return (
    <>
      <div className="mind-count">{items.length} anchors{dormant ? ` · ${dormant} dormant` : ''}</div>
      <ul className="mind-list">
        {items.map((a) => (
          <li key={a.id} className={`mind-row${a.active ? '' : ' mind-row-dormant'}`}>
            <div className="mind-row-head">
              <span className="mind-tag">{a.category}</span>
              <span className="mind-title">{a.key}</span>
              <span className="mind-meta">salience {a.salience}</span>
              {!a.active && <span className="mind-meta">dormant</span>}
              <span className="mind-time">{ago(a.updated_at)}</span>
            </div>
            <div className="mind-content">{a.content}</div>
          </li>
        ))}
      </ul>
    </>
  )
}

function EntitiesPanel() {
  const { data, loading, error } = useMind<Entity[]>('/entities')
  const items = data ?? []
  if (loading) return <p className="mind-empty">loading…</p>
  if (error) return <p className="mind-empty">couldn't reach the mind.</p>
  if (!items.length) return <p className="mind-empty">no entities yet.</p>
  return (
    <>
      <div className="mind-count">{items.length} beings</div>
      <ul className="mind-list">
        {items.map((e) => (
          <EntityRow key={e.id} entity={e} />
        ))}
      </ul>
    </>
  )
}

function EntityRow({ entity }: { entity: Entity }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="mind-row">
      <div className="mind-row-head mind-row-clickable" onClick={() => setOpen(!open)} role="button" tabIndex={0}>
        <span className="mind-disclosure">{open ? '▾' : '▸'}</span>
        <span className="mind-tag">{entity.name}</span>
        <span className="mind-meta">{entity.kind}</span>
      </div>
      {open && <EntityDetailView id={entity.id} />}
    </li>
  )
}

function EntityDetailView({ id }: { id: number }) {
  const { data, loading } = useMind<EntityDetail>(`/entities/${id}`)
  if (loading || !data) return <div className="mind-content">loading…</div>
  return (
    <div className="mind-content">
      {data.aliases?.length ? (
        <div className="mind-aliases">aliases: {data.aliases.map((a) => a.alias).join(', ')}</div>
      ) : null}
      <div className="mind-facts-label">{data.facts?.length ?? 0} facts</div>
      {(data.facts ?? []).map((f) => (
        <div key={f.id} className="mind-fact">
          • {f.content} <span className={`mind-src mind-src-${f.source}`}>{f.source === 'conscious_logged' ? 'conscious' : 'thalamus'}</span>
        </div>
      ))}
    </div>
  )
}
