// Aura caps a /speak call at ~2000 chars, and nothing chunked before — long text
// simply failed to speak (the constriction, fixed 12 June). Split at paragraph and
// sentence seams so any length reads aloud; each piece is one TTS call, played in
// sequence. Shared by the Reading Nook and Movie Night.
export const SPEECH_CHUNK = 1500

export function splitForSpeech(text: string, max = SPEECH_CHUNK): string[] {
  const out: string[] = []
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= max) { out.push(p); continue }
    let cur = ''
    for (const s of p.split(/(?<=[.!?…])\s+/)) {
      if (cur && (cur.length + s.length + 1) > max) { out.push(cur); cur = s }
      else cur = cur ? `${cur} ${s}` : s
    }
    if (cur) out.push(cur)
  }
  return out.length ? out : [text.slice(0, max)]
}
