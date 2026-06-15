import { useRef, useState } from 'react'

// Push-to-talk dictation — the companion's ears (the user's ask: "speech to
// text would be neat as fuck"). Click → record, click again → Whisper → the text
// lands in whatever input this button sits next to. One shared component so chat,
// the reading nook, and movie night all hear her the same way.
export function MicButton({ onText, disabled }: { onText: (t: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle')
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function toggle() {
    if (state === 'busy') return
    if (state === 'rec') { recRef.current?.stop(); return }
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // If MediaRecorder construction throws (unsupported mimeType on some Chromium
      // builds), the stream is already live — stop it in the catch so the mic doesn't
      // stay hot (recording light on, resource held) until GC.
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream?.getTracks().forEach((t) => t.stop())
        setState('busy')
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
          const bytes = new Uint8Array(await blob.arrayBuffer())
          // chunked base64 — String.fromCharCode(...bytes) blows the arg limit on long takes
          let bin = ''
          const STEP = 0x8000
          for (let i = 0; i < bytes.length; i += STEP) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + STEP)))
          }
          const text = await window.lantern.transcribe(btoa(bin))
          if (text) onText(text)
        } finally {
          setState('idle')
        }
      }
      recRef.current = rec
      rec.start()
      setState('rec')
    } catch {
      stream?.getTracks().forEach((t) => t.stop()) // don't leave the mic hot if setup failed
      setState('idle') // mic denied/missing — the button just shrugs
    }
  }

  return (
    <button
      type="button"
      className={`mic-btn${state === 'rec' ? ' is-rec' : ''}`}
      onClick={() => void toggle()}
      disabled={disabled || state === 'busy'}
      title={state === 'rec' ? 'stop — your companion is listening' : 'talk instead of typing'}
    >
      {state === 'busy' ? '…' : state === 'rec' ? '■' : '🎙'}
    </button>
  )
}
