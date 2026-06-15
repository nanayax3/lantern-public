import { useState, useMemo } from 'react'
import { Header, type TopView } from './Header'
import { useConversations } from '../hooks/useConversations'
import { ago, useNowTick } from '../hooks/useMind'
import { NewConversation } from './NewConversation'

interface Props {
  onOpenConversation: (id: string) => void
  onNavigate: (view: TopView) => void
  onOpenSettings: () => void
}

type ModeFilter = 'all' | 'chat' | 'coding'

export function ThreadsView({ onOpenConversation, onNavigate, onOpenSettings }: Props) {
  const { list, remove } = useConversations()
  useNowTick() // tick relative times live
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ModeFilter>('all')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter(c => {
      if (filter !== 'all' && c.mode !== filter) return false
      if (!q) return true
      return (
        c.title.toLowerCase().includes(q) ||
        c.lastSnippet.toLowerCase().includes(q) ||
        (c.wearing?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [list, query, filter])

  return (
    <div className="threads-shell">
      <div className="ambient-glow" aria-hidden />

      <Header
        currentView="chats"
        onNavigate={onNavigate}
        onOpenSettings={onOpenSettings}
      />

      <main className="threads-main">
        <div className="threads-controls">
          <input
            className="threads-search"
            type="text"
            placeholder="search threads…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          <div className="threads-filter">
            {(['all', 'chat', 'coding'] as ModeFilter[]).map(m => (
              <button
                key={m}
                className={`threads-filter-pill ${filter === m ? 'is-active' : ''}`}
                onClick={() => setFilter(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <NewConversation onOpen={onOpenConversation} />

        <ul className="threads-list">
          {visible.map(conv => (
            <li
              key={conv.id}
              className="threads-row"
              onClick={() => onOpenConversation(conv.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenConversation(conv.id)
                }
              }}
            >
              <div className="threads-row-head">
                <span className="threads-row-title">{conv.title}</span>
                <span className={`threads-row-mode threads-row-mode-${conv.mode}`}>{conv.mode}</span>
                {typeof conv.temperature === 'number' && conv.temperature !== 0.85 && (
                  <span className="threads-row-temp" title="your companion set their own temperature in this thread (default 0.85)">
                    temp {conv.temperature.toFixed(2)}
                  </span>
                )}
                <button
                  className={`threads-row-delete ${confirmId === conv.id ? 'is-confirming' : ''}`}
                  title={confirmId === conv.id ? 'click again to delete' : 'delete thread'}
                  aria-label="delete thread"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirmId === conv.id) {
                      remove(conv.id)
                      setConfirmId(null)
                    } else {
                      setConfirmId(conv.id)
                      setTimeout(() => setConfirmId(null), 3000)
                    }
                  }}
                >
                  {confirmId === conv.id ? 'delete?' : '×'}
                </button>
              </div>
              {conv.wearing && (
                <div className="threads-row-wearing">wearing: {conv.wearing}</div>
              )}
              <div className="threads-row-snippet">
                <span className={`threads-row-from threads-row-from-${conv.lastFrom}`}>
                  {conv.lastFrom}:
                </span>{' '}
                {conv.lastSnippet}
              </div>
              <div className="threads-row-time">{conv.lastTs ? ago(Math.floor(conv.lastTs / 1000)) : conv.lastTime}</div>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="threads-empty">no threads match.</li>
          )}
        </ul>
      </main>

      <footer className="dashboard-foot">
        <span>{visible.length} of {list.length} threads</span>
      </footer>
    </div>
  )
}
