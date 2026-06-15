import { useEffect, useState } from 'react'
import { useMind, mindPost, ago } from '../../hooks/useMind'

interface Spoons {
  value?: number
  max_value?: number
  descriptor?: string | null
  updated_at?: number
}

export function SpoonsCard() {
  const { data } = useMind<Spoons>('/spoons')
  const [spoonsState, setSpoonsState] = useState<Spoons | null>(null)
  // hover-preview: which level the pointer is over (1-based), or null
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => { if (data) setSpoonsState(data) }, [data])
  const view = spoonsState ?? data

  const spoons = view?.value ?? 0
  const spoonsMax = view?.max_value ?? 10
  // While hovering, the glyphs preview the level you'd set; otherwise show the real value.
  const shown = hover ?? spoons

  async function setSpoons(level: number) {
    if (level === spoons) return
    // Optimistic, then write to the live mind — the next mount re-reads the truth.
    setSpoonsState((s) => ({
      ...(s ?? {}),
      value: level,
      max_value: s?.max_value ?? spoonsMax,
      updated_at: Math.floor(Date.now() / 1000),
    }))
    await mindPost('/spoons', { value: level })
  }

  return (
    <section className="card card-spoons">
      {/* TODO(identity): pull configured human/user name */}
      <h2 className="card-title">your spoons</h2>
      <div className="spoons-row">
        <div className="spoons-glyphs" onMouseLeave={() => setHover(null)}>
          {Array.from({ length: spoonsMax }).map((_, i) => {
            const level = i + 1
            const lit = i < shown
            return (
              <button
                key={i}
                type="button"
                className={`spoon spoon-set ${lit ? 'spoon-lit' : 'spoon-dim'}`}
                onMouseEnter={() => setHover(level)}
                onClick={() => setSpoons(level)}
                aria-label={`set spoons to ${level}`}
                title={`set to ${level}`}
              >
                ◆
              </button>
            )
          })}
        </div>
      </div>
      <div className="spoons-readout">
        <span className="spoons-number">{spoons}<span className="spoons-max">/{spoonsMax}</span></span>
      </div>
      {view?.descriptor && <p className="spoons-descriptor">{view.descriptor}</p>}
      <div className="spoons-foot">
        <span>updated {ago(view?.updated_at)}</span>
      </div>
    </section>
  )
}
