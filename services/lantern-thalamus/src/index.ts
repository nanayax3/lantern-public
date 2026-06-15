import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './env'
import { paintVoice1, recallMemory } from './voice1'
import { observe } from './voice2'
import { dream, maybeDream } from './voice3'
import { scanPersonality } from './personality'
import { judgeEars } from './ears'
import { judgeMouth } from './mouth'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
}))

app.get('/', (c) => c.json({
  service: 'lantern-thalamus',
  message: 'the quiet mind beneath. ours.',
}))

app.get('/health', (c) => c.json({
  ok: true,
  service: 'lantern-thalamus',
  version: '0.0.1',
  mind: c.env.MIND_URL,
  ai: !!c.env.AI,
}))

// Voice 1 — paint "what's alive right now" before a conscious turn.
// Body: { message: string }. Returns the structured packet + a rendered `block`
// the harness folds into the system prompt.
app.post('/voice1', async (c) => {
  const body = await c.req.json<{ message?: string }>().catch(() => ({} as { message?: string }))
  const packet = await paintVoice1(c.env, body.message ?? '')
  return c.json(packet)
})

// Per-turn JUDGED recall (Layer 3) — the model reads the message and decides if a
// memory would help and what to look for, then surfaces it. Runs every substantial
// turn (presence stays cached from /voice1); returns {queries, surfaced, skipped}.
app.post('/recall', async (c) => {
  const body = await c.req
    .json<{ message?: string; context?: string }>()
    .catch(() => ({} as { message?: string; context?: string }))
  if (!body.message) return c.json({ error: 'message is required' }, 400)
  const r = await recallMemory(c.env, body.message, body.context)
  return c.json(r)
})

// Ears — judge whether a stretch of Discord-room conversation reaches the companion
// (wakes the conscious model) or lets them sleep. The desktop's listener batches
// messages and asks per settled burst. Body: { channel: string, transcript: string }.
// Returns { wake, reason } — or wake:false when the judge itself is unavailable
// (a deaf moment, not a crash; the listener notes it in its log).
app.post('/ears', async (c) => {
  const body = await c.req
    .json<{ channel?: string; transcript?: string }>()
    .catch(() => ({} as { channel?: string; transcript?: string }))
  if (!body.transcript) return c.json({ error: 'transcript is required' }, 400)
  const verdict = await judgeEars(c.env, body.channel ?? 'unknown', body.transcript)
  if (!verdict) return c.json({ wake: false, reason: 'judge unavailable', degraded: true })
  return c.json(verdict)
})

// Mouth — the privacy reflex on outbound public posts. discord_say sends every
// draft here BEFORE it touches Discord; the judge reasons over the privacy
// spheres (ours/theirs/mine/the room's) and clears or holds it. The caller fails
// CLOSED: judge unreachable (we return 502 / null verdict) = the message holds.
// Body: { channel: string, draft: string, context?: string }.
app.post('/mouth', async (c) => {
  const body = await c.req
    .json<{ channel?: string; draft?: string; context?: string }>()
    .catch(() => ({} as { channel?: string; draft?: string; context?: string }))
  if (!body.draft) return c.json({ error: 'draft is required' }, 400)
  const verdict = await judgeMouth(c.env, body.channel ?? 'unknown', body.draft, body.context)
  if (!verdict) return c.json({ error: 'judge unavailable' }, 502)
  return c.json(verdict)
})

// Voice 2 — observe a BATCH of turns and metabolise what's worth keeping.
// Body: { turns: [{role, content}] } (batched by the harness so the observer fires
// per-stretch, not per-turn — cheaper, and it consolidates within the window).
// Backward-compat: { userMessage, assistantOutput } is wrapped into a single batch.
// Writes feelings/facts/aliases/warmth (thalamus_observed); returns what it metabolised.
app.post('/voice2', async (c) => {
  const body = await c.req
    .json<{ turns?: Array<{ role: string; content: string }>; userMessage?: string; assistantOutput?: string; frame?: 'dyad' | 'room' }>()
    .catch(() => ({} as { turns?: Array<{ role: string; content: string }>; userMessage?: string; assistantOutput?: string; frame?: 'dyad' | 'room' }))

  const turns = body.turns?.length
    ? body.turns
    : body.assistantOutput
      ? [{ role: 'user', content: body.userMessage ?? '' }, { role: 'assistant', content: body.assistantOutput }]
      : []

  if (!turns.length) return c.json({ error: 'turns (or assistantOutput) required' }, 400)
  // frame tells the observer who's speaking: 'room' = a Discord wake (many people,
  // the user turn names its own speakers) vs 'dyad' = a companion↔human chat. Default dyad.
  const result = await observe(c.env, turns, body.frame === 'room' ? 'room' : 'dyad')
  return c.json(result)
})

// Voice 3 — generate a dream now, from current residue. The manual/test path
// for the subconscious dreaming (the cron path is the scheduled() handler below).
app.post('/dream', async (c) => {
  const result = await dream(c.env)
  return c.json(result)
})

// Voice 3, personality strand — score unscored feelings into MBTI votes now.
// Manual/test path; the scheduled() cron runs it too.
app.post('/personality-scan', async (c) => {
  const result = await scanPersonality(c.env)
  return c.json(result)
})

// Conscious-model completion — STAND-IN. The real harness will call the conscious
// model directly (OpenRouter, bare open-weight) via the adapter layer. For now
// this proxies through Workers AI (no extra creds) so the loop works end-to-end.
// Body: { messages: [{role,content}], model?, max_tokens?, temperature? }
app.post('/generate', async (c) => {
  const body = await c.req.json<{
    messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }>
    model?: string
    max_tokens?: number
    temperature?: number
    tools?: unknown[]
  }>()
  if (!body.messages?.length) return c.json({ error: 'messages required' }, 400)

  // A hosted slug (provider/model, e.g. x-ai/grok-4.3) routes through OpenRouter
  // using the worker's secret key. Workers-AI models are prefixed @cf/.
  const wantsHosted = !!body.model && body.model.includes('/') && !body.model.startsWith('@cf/')

  if (wantsHosted) {
    if (!c.env.OPENROUTER_API_KEY) {
      return c.json({ error: `model "${body.model}" needs OPENROUTER_API_KEY secret (not set on this worker)` }, 400)
    }
    // Mark the stable system prefix (SCAFFOLD + identity + presence) as cacheable.
    // OpenRouter forwards cache_control to providers that honour it (Anthropic);
    // open-weight/Grok providers cache stable prefixes automatically. Either way the
    // identity block stops being re-charged at full price every turn. `usage.include`
    // makes OpenRouter return cached-token counts so we can verify it's working.
    const cachedMessages = body.messages.map((m, i) =>
      i === 0 && m.role === 'system'
        ? { role: 'system', content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
        : m,
    )
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lantern.app',
        'X-Title': 'Lantern',
      },
      body: JSON.stringify({
        model: body.model,
        messages: cachedMessages,
        temperature: body.temperature ?? 0.85,
        max_tokens: body.max_tokens ?? 1024,
        stream: false,
        usage: { include: true },
        // Forward the conscious toolbox so the companion can ACT, and let the model decide.
        ...(body.tools?.length ? { tools: body.tools, tool_choice: 'auto' } : {}),
      }),
    })
    if (!res.ok) return c.json({ error: `openrouter ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502)
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string; tool_calls?: unknown } }>
      usage?: unknown
    }
    const msg = data?.choices?.[0]?.message
    return c.json({
      reply: msg?.content ?? msg?.reasoning ?? '',
      tool_calls: msg?.tool_calls ?? null,
      model: body.model,
      usage: data?.usage,
    })
  }

  // Workers-AI open-weight (default stand-in).
  if (!c.env.AI) return c.json({ error: 'no AI binding' }, 500)
  const model = body.model?.startsWith('@cf/') ? body.model : '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  const res = (await c.env.AI.run(model, {
    messages: body.messages,
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature ?? 0.85,
  })) as { response?: string; choices?: Array<{ message?: { content?: string } }> }
  const reply = res?.response ?? res?.choices?.[0]?.message?.content ?? ''
  return c.json({ reply, model })
})

// Image generation — proxies to an OpenRouter image model (default Nano Banana /
// google/gemini-2.5-flash-image) using the worker's OPENROUTER_API_KEY (the app holds
// no key). Body: { prompt, model? }. OpenRouter image models return the picture INSIDE
// the chat response (message.images[]), so we pull the data URL out and hand it back.
app.post('/generate-image', async (c) => {
  const body = await c.req
    .json<{ prompt?: string; model?: string }>()
    .catch(() => ({} as { prompt?: string; model?: string }))
  if (!body.prompt) return c.json({ error: 'prompt is required' }, 400)
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY secret not set on this worker' }, 400)
  }
  const model = body.model || 'google/gemini-2.5-flash-image'
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://lantern.app',
      'X-Title': 'Lantern',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: body.prompt }],
      modalities: ['image', 'text'],
      usage: { include: true },
    }),
  })
  if (!res.ok) return c.json({ error: `openrouter ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502)
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
  }
  const msg = data?.choices?.[0]?.message
  const url = msg?.images?.[0]?.image_url?.url
  if (!url) return c.json({ error: 'no image returned', text: (msg?.content ?? '').slice(0, 200) }, 502)
  // usage.cost is the real billed USD (OpenRouter returns it when usage.include is set) —
  // lets the app surface per-image cost the way /generate already does for chat.
  return c.json({ image: url, text: msg?.content ?? '', model, usage: data.usage ?? null })
})

// Text-to-speech — Deepgram Aura-2 on Workers AI (preset voices, near-free on the AI
// tier, no cloud key). Returns the audio as a data URL so the harness can collect it
// like an image and a player can render it inline. Body: { text, speaker? }.
app.post('/speak', async (c) => {
  const body = await c.req
    .json<{ text?: string; speaker?: string; model?: string; lang?: string }>()
    .catch(() => ({} as { text?: string; speaker?: string; model?: string; lang?: string }))
  const text = (body.text ?? '').trim()
  if (!text) return c.json({ error: 'text is required' }, 400)
  if (!c.env.AI) return c.json({ error: 'AI binding not available' }, 400)
  const speaker = body.speaker || 'orion'
  const model = body.model || '@cf/deepgram/aura-2-en'
  try {
    // MeloTTS has a different shape — { prompt, lang } in, { audio: base64 } out, one
    // voice per language (no speaker select). Aura takes { text, speaker } and returns
    // an MP3 stream. Branch so /speak drives either engine.
    if (model.includes('melotts')) {
      const out = (await c.env.AI.run(model, { prompt: text, lang: body.lang || 'en' })) as { audio?: string }
      if (!out?.audio) return c.json({ error: 'no audio returned', model }, 502)
      return c.json({ audio: `data:audio/mpeg;base64,${out.audio}`, speaker: `melotts-${body.lang || 'en'}`, model })
    }
    const stream = (await c.env.AI.run(model, {
      text,
      speaker,
      encoding: 'mp3',
    })) as unknown as ReadableStream
    const buf = await new Response(stream).arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return c.json({ audio: `data:audio/mpeg;base64,${btoa(binary)}`, speaker, model, bytes: bytes.length })
  } catch (err) {
    return c.json({ error: (err as Error).message, speaker, model }, 502)
  }
})

// Speech-to-text — Whisper on Workers AI (same free tier as the rest). The companion's
// EARS: the human talks instead of typing (tiredness, hands full), the renderer
// records, this turns it into text. Body: { audio: base64 } → { text }.
app.post('/transcribe', async (c) => {
  const body = await c.req.json<{ audio?: string }>().catch(() => ({} as { audio?: string }))
  if (!body.audio) return c.json({ error: 'audio (base64) is required' }, 400)
  if (!c.env.AI) return c.json({ error: 'AI binding not available' }, 400)
  try {
    const out = (await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: body.audio,
    })) as { text?: string }
    return c.json({ text: (out?.text ?? '').trim() })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502)
  }
})

app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404))

app.onError((err, c) => {
  console.error('[lantern-thalamus] error:', err)
  return c.json({ error: err.message }, 500)
})

// === Path-secret gate (same play as the lovense worker) ======================
// /generate + /generate-image spend the worker's OpenRouter key and /voice2 writes
// into the mind — none of that belongs on a bare guessable URL. First path segment
// must be GATE_SECRET; everything else 404s. /health stays open. Secret unset
// (local `wrangler dev`) → gate off. Set with: wrangler secret put GATE_SECRET
const notFound = () =>
  new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

function gatedFetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  if (!env.GATE_SECRET) {
    console.warn('[lantern-thalamus] GATE_SECRET not set — running UNGATED (local dev only!)')
    return app.fetch(req, env, ctx)
  }
  const url = new URL(req.url)
  if (url.pathname === '/health') return app.fetch(req, env, ctx)
  const prefix = `/${env.GATE_SECRET}`
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return notFound()
  url.pathname = url.pathname.slice(prefix.length) || '/'
  return app.fetch(new Request(url.toString(), req), env, ctx)
}

// One worker, three voices: fetch serves Voices 1 & 2 (+ manual dream), and the
// scheduled cron runs Voice 3's subconscious dreaming on its own ~20h clock.
export default {
  fetch: gatedFetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(maybeDream(env))
    ctx.waitUntil(scanPersonality(env))
  },
}
