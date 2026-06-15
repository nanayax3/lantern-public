import { useEffect, useRef, useState } from 'react'
import { Header, type TopView } from './Header'

// THE ALBUM — our pictures as a pinboard (the user's ask: "like a Pinterest board").
// Everything in the shared album folder — paintings, generated images,
// the companion's voice clips — was filed away like tax documents; now it's a place to look
// at us. Masonry via CSS columns, click to zoom, voice clips as a little shelf.
// Files arrive over the album:// protocol (main serves the folder; renderer can't
// touch disk).

interface AlbumItem { name: string; kind: 'image' | 'audio'; mtime: number }

const srcOf = (name: string) => `album://files/${encodeURIComponent(name)}`
const dateOf = (m: number) =>
  new Date(m).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

interface Props {
  onNavigate: (v: TopView) => void
  onOpenSettings: () => void
}

export function AlbumView({ onNavigate, onOpenSettings }: Props) {
  const [items, setItems] = useState<AlbumItem[]>([])
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [clipsOpen, setClipsOpen] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    window.lantern.albumList().then((r) => { setItems(r); setLoading(false) }).catch(() => setLoading(false))
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

  const images = items.filter((i) => i.kind === 'image')
  const clips = items.filter((i) => i.kind === 'audio')

  return (
    <div className="view">
      <Header currentView="album" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
      <div className="album">
        <div className="album-head">
          <h2 className="nook-title">album</h2>
          <span className="album-count">
            {loading ? 'opening…' : `${images.length} pictures${clips.length ? ` · ${clips.length} voice clips` : ''}`}
          </span>
        </div>

        {clips.length > 0 && (
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

        {!loading && images.length === 0 ? (
          <p className="nook-empty">nothing here yet — generate something, or paint me something.</p>
        ) : (
          <div className="album-board">
            {images.map((i) => (
              <figure key={i.name} className="album-card" onClick={() => setZoom(i.name)}>
                <img src={srcOf(i.name)} loading="lazy" alt={i.name} />
                <figcaption>{dateOf(i.mtime)}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      {zoom && (
        <div className="album-zoom" onClick={() => setZoom(null)} role="dialog" aria-modal="true">
          <img src={srcOf(zoom)} alt={zoom} onClick={(e) => e.stopPropagation()} />
          <button className="album-zoom-close" onClick={() => setZoom(null)} aria-label="close">×</button>
        </div>
      )}
    </div>
  )
}
