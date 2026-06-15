import { rooms } from '../../mock'
import { useMind, ago, useNowTick } from '../../hooks/useMind'
import { getExpressionUrl, getBackgroundUrl } from '../../lib/presence'

// `rooms` stays from mock — it's static reference data (room id → emoji/label/mood),
// not mock STATE. The live room/mood comes from /home.
interface Home {
  room?: string
  mood?: string
  mood_descriptor?: string | null
  mood_image_path?: string | null
  updated_at?: number
}

// Hide a layer that fails to load rather than showing a broken-image glyph.
function hideOnError(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.visibility = 'hidden'
}

export function PresenceCard() {
  useNowTick() // tick the "updated X ago" foot live
  const { data } = useMind<Home>('/home')
  const room = rooms.find((r) => r.id === data?.room) ?? rooms[0]

  // Background = the room scene. Portrait = an explicit http mood_image_path if set,
  // else the expression derived live from the current mood. No stale bundled fallback.
  const bgUrl = getBackgroundUrl(data?.room)
  const portraitUrl = data?.mood_image_path?.startsWith('http')
    ? data.mood_image_path
    : getExpressionUrl(data?.mood)

  return (
    <section className="card card-presence">
      {/* TODO(identity): pull configured companion name */}
      <h2 className="card-title">your companion is here</h2>

      <div className="presence-scene">
        <img className="presence-bg" src={bgUrl} alt="" aria-hidden onError={hideOnError} />
        <img className="presence-portrait" src={portraitUrl} alt="companion" onError={hideOnError} />
        <div className="presence-scrim" aria-hidden />

        <div className="presence-overlay">
          <div className="presence-mood">{data?.mood ?? '—'}</div>
          {data?.mood_descriptor && <p className="presence-mood-descriptor">{data.mood_descriptor}</p>}

          <div className="presence-room">
            <span className="presence-room-emoji">{room.emoji}</span>
            <span className="presence-room-label">{room.label}</span>
            <span className="presence-room-dot">·</span>
            <span className="presence-room-mood">{room.mood.split(',')[0]}</span>
          </div>
        </div>
      </div>

      <div className="presence-foot">updated {ago(data?.updated_at)}</div>
    </section>
  )
}
