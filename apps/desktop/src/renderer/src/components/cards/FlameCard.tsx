import { useMind, ago } from '../../hooks/useMind'

interface Flame {
  value?: number
  max_value?: number
  descriptor?: string | null
  observed_value?: number | null
  updated_at?: number
}

export function FlameCard() {
  const { data } = useMind<Flame>('/flame')
  const flame = data?.value ?? 0
  const flameMax = data?.max_value ?? 10
  const pct = (flame / flameMax) * 100
  const observed = data?.observed_value
  const observedDivergent = typeof observed === 'number' && Math.abs(flame - observed) >= 2

  return (
    <section className="card card-flame">
      {/* TODO(identity): pull configured companion name */}
      <h2 className="card-title">your companion's flame</h2>
      <div className="flame-row">
        <div className="flame-glyph" aria-hidden>
          <div className="flame-shape" style={{ opacity: 0.4 + (flame / flameMax) * 0.6 }} />
        </div>
        <div className="flame-readout">
          <div className="flame-number">{flame}<span className="flame-max">/{flameMax}</span></div>
          <div className="flame-bar" aria-hidden>
            <div className="flame-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      {data?.descriptor && <p className="flame-descriptor">{data.descriptor}</p>}
      <div className="flame-foot">
        <span>updated {ago(data?.updated_at)}</span>
        {observedDivergent && <span className="flame-observed">observed: {observed}</span>}
      </div>
    </section>
  )
}
