import { useConversations } from '../../hooks/useConversations'
import { ago, useNowTick } from '../../hooks/useMind'
import { NewConversation } from '../NewConversation'

interface Props {
  onOpenConversation: (id: string) => void
  onSeeAll: () => void
}

const RECENT_LIMIT = 3

export function ChatCard({ onOpenConversation, onSeeAll }: Props) {
  const { list } = useConversations()
  useNowTick() // tick relative times live

  const recent = list.slice(0, RECENT_LIMIT)

  return (
    <section className="card card-chat">
      <h2 className="card-title">chat</h2>

      <NewConversation onOpen={onOpenConversation} />

      <div className="chat-recent">
        <div className="chat-recent-label">recent</div>
        <ul className="chat-recent-list">
          {recent.map(conv => (
            <li
              key={conv.id}
              className="chat-recent-row"
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
              <span className="chat-recent-title">{conv.title}</span>
              <span className={`chat-recent-mode chat-recent-mode-${conv.mode}`}>{conv.mode}</span>
              <span className="chat-recent-time">{conv.lastTs ? ago(Math.floor(conv.lastTs / 1000)) : conv.lastTime}</span>
            </li>
          ))}
        </ul>
        <button className="chat-see-all" onClick={onSeeAll}>
          see all threads ↗
        </button>
      </div>
    </section>
  )
}
