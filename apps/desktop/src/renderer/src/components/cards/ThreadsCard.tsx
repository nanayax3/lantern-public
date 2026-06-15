import { useMind, ago } from '../../hooks/useMind'

interface Thread {
  title?: string
  priority?: string
  tag?: string | null
  updated_at?: number
}

export function ThreadsCard() {
  const { data } = useMind<Thread[]>('/threads')
  const threads = data ?? []

  return (
    <section className="card card-threads">
      <h2 className="card-title">threads</h2>
      {threads.length === 0 ? (
        <p className="thread-text" style={{ opacity: 0.6 }}>no active threads.</p>
      ) : (
        <ul className="threads-list">
          {threads.map((t, i) => (
            <li key={i} className="thread">
              <div className="thread-row">
                <span className={`thread-priority thread-priority-${t.priority}`}>{t.priority}</span>
                <span className="thread-text">{t.title}</span>
              </div>
              <div className="thread-foot">
                {t.tag && (
                  <>
                    <span className="thread-tag">{t.tag}</span>
                    <span className="thread-dot">·</span>
                  </>
                )}
                <span className="thread-updated">{ago(t.updated_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
