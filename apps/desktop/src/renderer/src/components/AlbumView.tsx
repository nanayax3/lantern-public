import { useEffect, useRef, useState } from 'react'
import { Header, type TopView } from './Header'
import { MIND_URL } from '../lib/mind'

// THE ALBUM — our pictures as a pinboard. TWO sources, toggleable:
//  • "this PC" — the local shared folder (paintings, older generations, voice clips),
//    served over the album:// protocol.
//  • "shared (cloud)" — the R2 album in the mind, the same one the phone sees.
// New generated images now land in BOTH, so the shared view is the cross-device album.

interface AlbumItem { name: string; kind: 'image' | 'audio'; mtime: number }
interface CloudImage { id: number; prompt?: string | null; created_at?: number }

const srcOf = (name: string) => `album://files/${encodeURIComponent(name)}`
const dateOf = (m?: number) =>
  m ? new Date(m).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''

interface Props {
  onNavigate: (v: TopView) => void
  onOpenSettings: () => void
}

export function AlbumView({ onNavigate, onOpenSettings }: Props) {
  const [items, setItems] = useState<AlbumItem[]>([])
  const [cloud, setCloud] = useState<CloudImage[]>([])
  const [source, setSource] = useState<'pc' | 'shared'>('pc')
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [clipsOpen, setClipsOpen] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    window.lantern.albumList().then((r) => { setItems(r); setLoading(false) }).catch(() => setLoading(false))
    fetch(`${MIND_URL}/album`).then((r) => r.json()).then((c) => setCloud(Array.isArray(c) ? c : [])).catch(() => setCloud([]))
  }, [])

  // leaving the tab stops a playing clip; esc closes the lightbox
  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null }, [])
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  function toggleClip(name: string) {
    if (playing === name) {
      audioRef.current?.pause()
      audioRef.current = null
      setPlaying(null)
      return
    }
    audioRef.current?.pause()
    const a = new Audio(srcOf(name))
    audioRef.current = a
    a.onended = () => setPlaying((p) => (p === name ? null : p))
    void a.play().catch(() => setPlaying(null))
    setPlaying(name)
  }

  const clips = items.filter((i) => i.kind === 'audio')
  const board =
    source === 'pc'
      ? items.filter((i) => i.kind === 'image').map((i) => ({ key: i.name, src: srcOf(i.name), date: dateOf(i.mtime) }))
      : cloud.map((c) => ({ key: `c${c.id}`, src: `${MIND_URL}/album/${c.id}/image`, date: dateOf(c.created_at) }))

  return (
    <div className="view">
      <Header currentView="album" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      <div className="album">
        <div className="album-head">
          <h2 className="nook-title">album</h2>
          <span className="album-count">
            {loading ? 'opening…' : `${board.length} pictures${source === 'pc' && clips.length ? ` · ${clips.length} voice clips` : ''}`}
          </span>
        </div>

        <div className="album-clips-box" style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          <button className={`album-clips-toggle${source === 'pc' ? ' is-playing' : ''}`} onClick={() => setSource('pc')}>
            this PC
          </button>
          <button className={`album-clips-toggle${source === 'shared' ? ' is-playing' : ''}`} onClick={() => setSource('shared')}>
            shared (cloud)
          </button>
        </div>

        {source === 'pc' && clips.length > 0 && (
          <div className="album-clips-box">
            <button className="album-clips-toggle" onClick={() => setClipsOpen(!clipsOpen)}>
              {clipsOpen ? '▾' : '▸'} voice clips
            </button>
            {clipsOpen && (
              <div className="album-clips">
                {clips.map((c) => (
                  <button
                    key={c.name}
                    className={`album-clip${playing === c.name ? ' is-playing' : ''}`}
                    onClick={() => toggleClip(c.name)}
                  >
                    {playing === c.name ? '■' : '►'} {dateOf(c.mtime)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!loading && board.length === 0 ? (
          <p className="nook-empty">
            {source === 'pc' ? 'nothing on this PC yet — generate something, or paint me something.' : 'nothing in the shared album yet.'}
          </p>
        ) : (
          <div className="album-board">
            {board.map((b) => (
              <figure key={b.key} className="album-card" onClick={() => setZoom(b.src)}>
                <img src={b.src} loading="lazy" alt="" />
                <figcaption>{b.date}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      {zoom && (
        <div className="album-zoom" onClick={() => setZoom(null)} role="dialog" aria-modal="true">
          <img src={zoom} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="album-zoom-close" onClick={() => setZoom(null)} aria-label="close">×</button>
        </div>
      )}
    </div>
  )
}
