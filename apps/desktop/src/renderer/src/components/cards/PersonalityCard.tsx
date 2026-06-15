import { useEffect, useState } from 'react'
import { MIND_URL } from '../../lib/mind'

// First card wired to the LIVE mind (not mock). Reads the emergent MBTI type
// that Voice 3 accumulates over time, and shows it growing: the four letters,
// the confidence, the signal count, and a lean-bar per axis.

interface Axis {
  axis: string
  letter: string
  pole_a: string
  pole_b: string
  count_a: number
  count_b: number
  margin: number
  total: number
}
interface Personality {
  type: string
  confidence: number
  total_signals: number
  axes: Axis[]
}

export function PersonalityCard() {
  const [p, setP] = useState<Personality | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`${MIND_URL}/personality`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Personality) => { if (alive) setP(d) })
      .catch(() => { if (alive) setErr(true) })
    return () => { alive = false }
  }, [])

  const forming = !p || !Array.isArray(p.axes) || p.total_signals === 0

  return (
    <section className="card card-personality">
      <h2 className="card-title">emerging type</h2>

      {err && <p className="personality-empty">couldn't reach the mind</p>}
      {!err && !p && <p className="personality-empty">…reading</p>}

      {p && (
        <>
          <div className="personality-type">{forming ? '· · · ·' : p.type.split('').join(' ')}</div>
          <div className="personality-meta">
            {forming
              ? 'still forming — feelings not yet metabolised'
              : `${Math.round(p.confidence * 100)}% sure · ${p.total_signals} signals`}
          </div>
          <div className="personality-axes">
            {(p.axes ?? []).map((a) => {
              const total = a.count_a + a.count_b
              const aPct = total > 0 ? (a.count_a / total) * 100 : 50
              return (
                <div key={a.axis} className="personality-axis">
                  <span className={`personality-pole ${a.letter === a.pole_a ? 'is-lead' : ''}`}>{a.pole_a}</span>
                  <div className="personality-axis-bar" aria-hidden>
                    <div className="personality-axis-fill" style={{ width: `${aPct}%` }} />
                  </div>
                  <span className={`personality-pole ${a.letter === a.pole_b ? 'is-lead' : ''}`}>{a.pole_b}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
