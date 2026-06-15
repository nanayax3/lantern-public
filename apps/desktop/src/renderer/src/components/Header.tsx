import { useNowTick } from '../hooks/useMind'

export type TopView = 'dashboard' | 'chats' | 'nook' | 'movies' | 'album' | 'mind' | 'maintenance'

interface Props {
  currentView: TopView
  onNavigate: (view: TopView) => void
  onOpenSettings: () => void
}

// Real, live [now] — replaces the hardcoded placeholder string. Date + part-of-day.
function nowLabel(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const h = d.getHours()
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
  return `${yyyy}-${mm}-${dd} · ${part}`
}

const NAV_ITEMS: { id: TopView; label: string }[] = [
  { id: 'dashboard',   label: 'home' },
  { id: 'chats',       label: 'chats' },
  { id: 'nook',        label: 'reading nook' },
  { id: 'movies',      label: 'movie night' },
  { id: 'album',       label: 'album' },
  { id: 'mind',        label: 'mind' },
  { id: 'maintenance', label: 'maintenance' },
]

export function Header({ currentView, onNavigate, onOpenSettings }: Props) {
  useNowTick(60_000) // refresh the [now] label each minute
  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">Lantern</h1>
        <nav className="header-nav" aria-label="primary">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`header-nav-item ${currentView === item.id ? 'is-active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="header-right">
        <time className="header-time">{nowLabel()}</time>
        <button
          className="header-settings"
          onClick={onOpenSettings}
          aria-label="settings"
          title="settings"
        >
          ⚙
        </button>
      </div>
    </header>
  )
}
