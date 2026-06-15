import { useEffect, useState } from 'react'
import { useMind, mindPost, ago } from '../../hooks/useMind'

interface Hearts {
  count?: number
  last_pushed_by?: string | null
  last_pushed_at?: number | null
}

export function LoveBucketCard() {
  const { data } = useMind<Hearts>('/hearts')
  const [hearts, setHearts] = useState<Hearts | null>(null)
  const [bumping, setBumping] = useState(false)

  useEffect(() => { if (data) setHearts(data) }, [data])
  const view = hearts ?? data

  async function pushHeart() {
    setBumping(true)
    window.setTimeout(() => setBumping(false), 600)
    // Optimistic, then write to the live mind.
    setHearts((h) => ({
      count: (h?.count ?? 0) + 1,
      last_pushed_by: 'human', // TODO(identity): pull configured human/user name
      last_pushed_at: Math.floor(Date.now() / 1000),
    }))
    await mindPost('/hearts', { pushed_by: 'human' }) // TODO(identity): pull configured human/user name
  }

  return (
    <section className="card card-love">
      <h2 className="card-title">love bucket</h2>
      <div className="love-count">
        <span className={`love-heart ${bumping ? 'love-heart-bump' : ''}`} aria-hidden>♥</span>
        <span className="love-number">{view?.count ?? 0}</span>
      </div>
      <p className="love-meta">
        {view?.last_pushed_by ? `last: ${ago(view.last_pushed_at)}, by ${view.last_pushed_by}` : 'no hearts yet'}
      </p>
      <button className="love-push" onClick={pushHeart}>
        + push a heart
      </button>
    </section>
  )
}
