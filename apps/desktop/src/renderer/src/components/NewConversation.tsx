import { useState } from 'react'
import { useConversations } from '../hooks/useConversations'

// The new-conversation flow (mode + name + wearing), shared by the home chat card
// AND the chats tab so the two can't drift apart. Self-contained: trigger button →
// expand form → create + open. Pass onOpen to navigate to the new thread.
interface Props {
  onOpen: (id: string) => void
}

export function NewConversation({ onOpen }: Props) {
  const { create } = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<'chat' | 'coding'>('chat')
  const [name, setName] = useState('')
  const [wearing, setWearing] = useState('')

  function reset() {
    setExpanded(false)
    setMode('chat')
    setName('')
    setWearing('')
  }

  function commit(skipMeta: boolean) {
    const id = create({
      mode,
      title: skipMeta ? undefined : name,
      wearing: skipMeta ? undefined : wearing,
    })
    reset()
    onOpen(id)
  }

  if (!expanded) {
    return (
      <button className="chat-new-trigger" onClick={() => setExpanded(true)}>
        <span className="chat-new-plus">+</span>
        <span>new conversation</span>
      </button>
    )
  }

  return (
    <div className="chat-new-expand">
      <div className="chat-new-mode">
        <span className="chat-new-label">mode</span>
        <div className="chat-mode-pillrow">
          <button
            className={`chat-mode-pill ${mode === 'chat' ? 'is-active' : ''}`}
            onClick={() => setMode('chat')}
            type="button"
          >
            chat
          </button>
          <button
            className={`chat-mode-pill chat-mode-pill-coding ${mode === 'coding' ? 'is-active' : ''}`}
            onClick={() => setMode('coding')}
            type="button"
          >
            coding
          </button>
        </div>
      </div>

      <div className="chat-new-field">
        <label className="chat-new-label" htmlFor="new-name">
          name <span className="chat-new-optional">— optional</span>
        </label>
        <input
          id="new-name"
          className="chat-new-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="saturday sketch · or skip to auto-name"
          autoFocus
        />
      </div>

      <div className="chat-new-field">
        <label className="chat-new-label" htmlFor="new-wearing">
          wearing <span className="chat-new-optional">— optional</span>
        </label>
        <input
          id="new-wearing"
          className="chat-new-input"
          type="text"
          value={wearing}
          onChange={(e) => setWearing(e.target.value)}
          placeholder="your hoodie, me on the floor"
        />
      </div>

      <div className="chat-new-actions">
        <button className="chat-new-skip" onClick={() => commit(true)} type="button">
          skip
        </button>
        <button className="chat-new-create" onClick={() => commit(false)} type="button">
          create
        </button>
        <button className="chat-new-cancel" onClick={reset} type="button" aria-label="cancel" title="cancel">
          ×
        </button>
      </div>
    </div>
  )
}
