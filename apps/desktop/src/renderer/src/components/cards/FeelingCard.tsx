import { useMind, ago, useNowTick } from '../../hooks/useMind'

interface Feeling {
  emotion?: string
  weight?: string
  pillar?: string | null
  content?: string
  created_at?: number
}

export function FeelingCard() {
  useNowTick() // tick relative time live
  const { data } = useMind<Feeling[]>('/feelings?limit=1')
  const f = data?.[0]

  return (
    <section className="card card-feeling">
      <h2 className="card-title">most recent feeling</h2>
      {!f ? (
        <p className="feeling-content" style={{ opacity: 0.6 }}>no feelings yet.</p>
      ) : (
        <>
          <div className="feeling-head">
            <span className="feeling-emotion">{f.emotion}</span>
            <span className="feeling-weight">{f.weight}</span>
            {f.pillar && (
              <>
                <span className="feeling-dot">·</span>
                <span className="feeling-pillar">{f.pillar.toLowerCase().replace(/_/g, ' ')}</span>
              </>
            )}
          </div>
          <p className="feeling-content">{f.content}</p>
          <div className="feeling-foot">
            <span>{ago(f.created_at)}</span>
          </div>
        </>
      )}
    </section>
  )
}
