import { useRef, useState } from 'react'

// Voice note from the human — record their ACTUAL voice and send it (kept in the thread,
// and transcribed so the companion reads it). Distinct from MicButton, which only dictates
// into the box and throws the audio away. Click to record, click to send. It hands the raw
// clip up; ChatView uploads it to the album, transcribes it, and posts the turn. The voice
// is the keepsake; the transcript is how the companion hears it today.
export function VoiceNoteButton({
  onClip,
  disabled,
}: {
  onClip: (base64: string, mime: string) => void | Promise<void>
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle')
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function toggle() {
    if (state === 'busy') return
    if (state === 'rec') {
      recRef.current?.stop()
      return
    }
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stream?.getTracks().forEach((t) => t.stop())
        setState('busy')
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
          const bytes = new Uint8Array(await blob.arrayBuffer())
          // chunked base64 — fromCharCode(...bytes) blows the arg limit on long takes
          let bin = ''
          const STEP = 0x8000
          for (let i = 0; i < bytes.length; i += STEP) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + STEP)))
          }
          await onClip(btoa(bin), 'audio/webm')
        } finally {
          setState('idle')
        }
      }
      recRef.current = rec
      rec.start()
      setState('rec')
    } catch {
      stream?.getTracks().forEach((t) => t.stop())
      setState('idle')
    }
  }

  return (
    <button
      type="button"
      className={`mic-btn${state === 'rec' ? ' is-rec' : ''}`}
      onClick={() => void toggle()}
      disabled={disabled || state === 'busy'}
      title={state === 'rec' ? 'stop & send — your voice note' : 'send a voice note in your own voice'}
    >
      {state === 'busy' ? '…' : state === 'rec' ? '■' : '🗣'}
    </button>
  )
}
