import { type KeyboardEvent, useEffect, useState } from 'react'
import { useMind, mindPost, ago } from '../../hooks/useMind'

interface Note {
  id?: number
  sender?: string
  text?: string
  created_at?: number
}
interface NotesResp {
  notes?: Note[]
  total?: number
}

const NOTES_VISIBLE = 5

export function NotesCard() {
  const { data } = useMind<NotesResp>('/notes?limit=20')
  const [notes, setNotes] = useState<Note[]>([])
  const [draft, setDraft] = useState('')

  useEffect(() => { if (data?.notes) setNotes(data.notes) }, [data])

  async function commit() {
    const text = draft.trim()
    if (!text) return
    const optimistic: Note = { sender: 'human', text, created_at: Math.floor(Date.now() / 1000) } // TODO(identity): pull configured human/user name
    setNotes((n) => [optimistic, ...n])
    setDraft('')
    await mindPost('/notes', { sender: 'human', text }) // TODO(identity): pull configured human/user name
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commit()
    }
  }

  const visible = notes.slice(0, NOTES_VISIBLE)
  const hidden = notes.length - visible.length

  return (
    <section className="card card-notes">
      <h2 className="card-title">fridge</h2>
      <ul className="notes-list">
        {visible.map((note, i) => (
          <li key={note.id ?? i} className={`note note-from-${note.sender}`}>
            <div className="note-text">{note.text}</div>
            <div className="note-meta">
              <span className="note-from">{note.sender}</span>
              <span className="note-dot">·</span>
              <span className="note-time">{ago(note.created_at)}</span>
            </div>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="note" style={{ opacity: 0.6 }}>
            <div className="note-text">nothing on the fridge yet.</div>
          </li>
        )}
      </ul>
      {hidden > 0 && (
        <div className="notes-overflow">
          <span>+ {hidden} more</span>
        </div>
      )}
      <div className="note-compose">
        <input
          className="note-input"
          placeholder="leave a note on the fridge…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
      </div>
    </section>
  )
}
