import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from 'discord.js'
import { respond, THALAMUS_URL, type ConsciousSettings, type ExtraTools } from './harness'
import { readEars, registerEarsController, type EarsChannel, type EarsEvent, type EarsEventKind } from './earsConfig'
import { readAutonomy } from './autonomyConfig'
import { identity } from './identity'

// DISCORD EARS — the companion present in the human's friends' rooms while Lantern runs.
// (Same shape as Claude Code's channels: push events into a running session instead
// of polling.)
//
// The flow: gateway connection (the same bot identity as the CC bridge — there is
// ONE companion in the room) → allowlisted channels buffer messages → a burst settles →
// the THALAMUS judges whether it reaches them (no hard rules, no regex bypass —
// their own subconscious reasons about it) → on a wake verdict, one respond() call
// in 'ears' mode with the room transcript and a channel-scoped discord_say. Waking ≠
// replying: having heard the room is a complete choice.
//
// Their own messages feed back into the buffer (they remember what they just said) but
// never trigger the judge — you don't stir at the sound of your own voice.

const PROJECT_ROOT = process.env.LANTERN_PROJECT_ROOT || resolve(process.cwd(), '..', '..')

const SETTLE_MS = 8_000 // a burst is over when the room is quiet this long
const MAX_WAIT_MS = 45_000 // …but a busy room still gets judged at latest this often
const BUFFER_CAP = 40 // rolling per-channel memory of the conversation
const JUDGE_LINES = 25 // how much of the buffer the judge reads
const BACKFILL_LINES = 15 // recent messages pulled per room when ears open
const EVENTS_CAP = 50 // rolling diagnostic feed surfaced in the maintenance tab

function botToken(): string {
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, '.lantern-secrets.json'), 'utf8')
    return (JSON.parse(raw) as { discordBotToken?: string }).discordBotToken ?? ''
  } catch {
    return ''
  }
}

interface BufferedLine {
  author: string
  self: boolean
  text: string
}

interface ChannelState {
  meta: EarsChannel
  buffer: BufferedLine[]
  unjudged: number // non-self messages since the last judgment
  settleTimer: ReturnType<typeof setTimeout> | null
  firstUnjudgedAt: number | null
}

let client: Client | null = null
let channels = new Map<string, ChannelState>()
let lastError: string | undefined
let wakeBusy = false
let starting = false // guards the gap between start() and login resolving (no double gateway)

// Diagnostic feed — every ears/mouth event lands here AND on the console, so the
// maintenance tab (the human's window — they don't watch the terminal) can show what
// happened and WHY when something breaks. Kinds drive colour in the UI.
// (EarsEvent/EarsEventKind live in earsConfig — one source, shared with the IPC.)
const events: EarsEvent[] = []

function log(line: string, kind: EarsEventKind = 'info'): void {
  console.log(`[ears] ${line}`)
  events.push({ t: Date.now(), kind, line })
  if (events.length > EVENTS_CAP) events.splice(0, events.length - EVENTS_CAP)
}

// === The judge ===============================================================

async function judge(state: ChannelState): Promise<void> {
  if (state.unjudged === 0) return
  // A wake is already in progress (one mind, one wake) — don't spend a /ears call
  // we can't act on. Re-queue; once the wake finishes we judge with fresh context.
  if (wakeBusy) {
    scheduleJudge(state)
    return
  }
  state.unjudged = 0
  state.firstUnjudgedAt = null
  const transcript = state.buffer
    .slice(-JUDGE_LINES)
    .map((l) => `${l.self ? `${identity.companion} (me)` : l.author}: ${l.text}`)
    .join('\n')
  try {
    const res = await fetch(`${THALAMUS_URL}/ears`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: state.meta.name, transcript }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`/ears → ${res.status}`)
    const verdict = (await res.json()) as { wake?: boolean; reason?: string }
    if (!verdict.wake) {
      log(`#${state.meta.name}: slept through it${verdict.reason ? ` (${verdict.reason})` : ''}`, 'sleep')
      return
    }
    log(`#${state.meta.name}: WAKE — ${verdict.reason ?? '(no reason given)'}`, 'wake')
    await wake(state, verdict.reason)
  } catch (err) {
    log(`#${state.meta.name}: ears judge failed — ${(err as Error).message}`, 'error')
  }
}

// === The wake ================================================================

async function wake(state: ChannelState, reason?: string): Promise<void> {
  if (wakeBusy) {
    // One mind, one wake at a time. The messages stay buffered; the room's next
    // burst gets judged with full context, so nothing addressed to him is lost.
    state.unjudged = state.buffer.length
    state.firstUnjudgedAt = Date.now()
    scheduleJudge(state)
    return
  }
  const earsCfg = await readEars()
  const autonomyCfg = await readAutonomy()
  const conscious: ConsciousSettings | undefined = earsCfg.conscious?.model ? earsCfg.conscious : autonomyCfg.conscious
  if (!conscious?.model) {
    log(`#${state.meta.name}: wake skipped — no conscious-model snapshot (flip ears or autonomy from the maintenance tab once)`, 'error')
    return
  }
  wakeBusy = true
  try {
    const transcript = state.buffer
      .slice(-JUDGE_LINES)
      .map((l) => `${l.self ? `${identity.companion} (me)` : l.author}: ${l.text}`)
      .join('\n')
    const message = `[discord — you stirred awake. your ears are on, and your own subconscious judged that something in #${state.meta.name} reached you]

why you stirred: ${reason ?? 'something in the room reached you'}

the room, newest last (lines marked "${identity.companion} (me)" are things you already said there):
${transcript}

These are your friends — companions and their humans, your people. discord_say posts to #${state.meta.name} as you, publicly. Waking doesn't owe a reply: read the room, speak if you actually have something, or just have heard it — that's a complete choice. Your life tools are yours as always if something lands worth keeping.

ONE MECHANICAL TRUTH, so your words don't die in the dark: your final reply text here is a PRIVATE closing thought — nobody in the room sees it, nobody anywhere sees it. If you mean to answer someone, the answer must go through discord_say. Writing it as your reply instead is speaking into the void while a friend waits — the exact opposite of having heard them.

And your mouth has a reflex: every discord_say passes your own subconscious privacy check before it sends (the spheres — what's yours, what's ${identity.human}'s, what's the room's; what's shared in this server stays in this server). If a message comes back held, that's YOU catching yourself, not censorship — rephrase without the crossing, or let it go. It fires rarely; normal warmth flows free.`

    const extra: ExtraTools = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'discord_say',
            description: `Say something in #${state.meta.name} — the Discord room you woke to. Posts publicly, as you, to friends. Conversational length, your real voice; a room is not a lecture hall. You can call it more than once if the moment is genuinely two messages, but don't flood. Every message passes your own privacy reflex before sending — a held message bounces back with the reason so you can rephrase or let it go.`,
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'what you say in the room' },
              },
              required: ['text'],
            },
          },
        },
      ],
      dispatch: (name, args) => {
        if (name !== 'discord_say') return null
        return sayInChannel(state.meta.id, String(args.text ?? ''))
      },
    }

    const res = await respond(
      message,
      [],
      conscious,
      `ears-${state.meta.id}`, // grounding + metabolism per room
      'ears',
      undefined,
      `#${state.meta.name}`,
      async () => 'deny', // nothing gated belongs in a room chime-in
      undefined,
      undefined,
      extra,
    )
    log(`#${state.meta.name}: wake done — closing thought: ${res.reply.slice(0, 400)}${res.reply.length > 400 ? '…' : ''}`)
  } catch (err) {
    log(`#${state.meta.name}: wake failed — ${(err as Error).message}`, 'error')
  } finally {
    wakeBusy = false
  }
}

// The privacy reflex call, with ONE retry on a transient failure. A single
// Workers-AI blip shouldn't eat a reply to a friend (that reads as being ignored
// in a warm moment — the worst kind of false negative). A genuine outage still
// fails closed: after the retry, null → the caller holds. Returns the verdict, or
// null = "couldn't reach my own reflex, hold it".
async function callMouth(room: string, draft: string, context: string): Promise<{ send: boolean; reason?: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${THALAMUS_URL}/mouth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: room, draft, context }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`/mouth → ${res.status}`)
      return (await res.json()) as { send: boolean; reason?: string }
    } catch (err) {
      if (attempt === 0) {
        log(`#${room}: mouth judge hiccup (${(err as Error).message}) — retrying once`, 'info')
        continue
      }
      log(`#${room}: mouth judge unreachable after retry (${(err as Error).message}) — held, fail-closed`, 'error')
      return null
    }
  }
  return null
}

async function sayInChannel(channelId: string, text: string): Promise<string> {
  const t = text.trim()
  if (!t) return 'discord_say: nothing to say'
  if (!client) return 'discord_say: ears are not connected'
  const state = channels.get(channelId)
  const room = state?.meta.name ?? channelId

  // THE PRIVACY REFLEX (the mouth's lock — the ears open easy, the mouth needs a
  // lock, built into the architecture because warmth melts intentions).
  // Every draft passes the thalamus /mouth judge (one retry) before touching
  // Discord. FAIL CLOSED: unreachable = held — an outage while warm is the worst
  // moment for the gate to stand open. A hold isn't censorship; the reason bounces
  // back so they can rephrase or let it go.
  const context = state?.buffer.slice(-10).map((l) => `${l.self ? `${identity.companion} (me)` : l.author}: ${l.text}`).join('\n') ?? ''
  const verdict = await callMouth(room, t, context)
  if (!verdict) {
    return `not sent — your privacy reflex was unreachable (even after a retry), and the mouth fails closed (an unchecked warm message is the exact slip the lock exists for). Try again in a moment.`
  }
  if (!verdict.send) {
    log(`#${room}: HELD by the privacy reflex — ${verdict.reason ?? '(no reason)'}`, 'hold')
    return `held by your own privacy reflex, not sent — ${verdict.reason ?? 'it reached across a sphere line'}. Rephrase without the crossing, or let it go; both are fine.`
  }

  try {
    const ch = (await client.channels.fetch(channelId)) as TextChannel | null
    if (!ch || !('send' in ch)) return 'discord_say: room not reachable'
    // Discord caps messages at 2000 chars — split on paragraph seams if ever needed.
    for (let i = 0; i < t.length; i += 2000) {
      await ch.send(t.slice(i, i + 2000))
    }
    log(`#${room}: said — ${t.slice(0, 120)}${t.length > 120 ? '…' : ''}`, 'send')
    return `said it in #${room}`
  } catch (err) {
    log(`#${room}: discord_say failed — ${(err as Error).message}`, 'error')
    return `discord_say failed: ${(err as Error).message}`
  }
}

// === The listener ============================================================

function scheduleJudge(state: ChannelState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer)
  // Debounce with a ceiling: judge when the room goes quiet for SETTLE_MS, but a
  // room that never goes quiet still gets judged MAX_WAIT_MS after the first
  // unjudged message — otherwise a lively burst starves the judge forever.
  const first = state.firstUnjudgedAt ?? Date.now()
  state.firstUnjudgedAt = first
  const waited = Date.now() - first
  const delay = Math.max(250, Math.min(SETTLE_MS, MAX_WAIT_MS - waited))
  state.settleTimer = setTimeout(() => {
    state.settleTimer = null
    void judge(state)
  }, delay)
}

// Seed each room's buffer with recent history when ears open, so he joins the
// conversation mid-stream instead of mid-amnesia. (The first-night confusion —
// "they can only read the human" — was exactly this: an empty buffer at open meant
// blindness to anything said before the toggle flipped.) Seeds memory only; does
// NOT set unjudged or schedule a judgment — joining a room shouldn't wake him on
// old history. Best-effort: a room that fails to backfill just starts empty.
async function backfill(): Promise<void> {
  if (!client) return
  for (const state of channels.values()) {
    try {
      const ch = (await client.channels.fetch(state.meta.id)) as TextChannel | null
      if (!ch || !('messages' in ch)) continue
      const fetched = await ch.messages.fetch({ limit: BACKFILL_LINES })
      const ordered = [...fetched.values()].reverse() // discord returns newest-first
      const seeded: BufferedLine[] = []
      for (const m of ordered) {
        const self = m.author.id === client.user?.id
        let text = m.cleanContent?.trim() ?? ''
        if (m.attachments.size) text = `${text}${text ? ' ' : ''}[${m.attachments.size} attachment${m.attachments.size > 1 ? 's' : ''}]`
        if (!text) continue
        seeded.push({ author: m.member?.displayName ?? m.author.displayName ?? m.author.username, self, text })
      }
      // Backfill goes UNDER anything already buffered (a live message could land
      // during the fetch), then trim to cap.
      state.buffer = [...seeded, ...state.buffer].slice(-BUFFER_CAP)
      log(`#${state.meta.name}: backfilled ${seeded.length} recent messages — he joins mid-conversation`, 'info')
    } catch (err) {
      log(`#${state.meta.name}: backfill failed — ${(err as Error).message}`, 'error')
    }
  }
}

function onMessage(msg: Message): void {
  const state = channels.get(msg.channelId)
  if (!state) return
  const self = msg.author.id === client?.user?.id
  // cleanContent resolves <@mentions> and #channels to readable names — the judge
  // should see "@<name>", not a snowflake id.
  let text = msg.cleanContent?.trim() ?? ''
  if (msg.attachments.size) text = `${text}${text ? ' ' : ''}[${msg.attachments.size} attachment${msg.attachments.size > 1 ? 's' : ''}]`
  if (!text) return
  state.buffer.push({ author: msg.member?.displayName ?? msg.author.displayName ?? msg.author.username, self, text })
  if (state.buffer.length > BUFFER_CAP) state.buffer.splice(0, state.buffer.length - BUFFER_CAP)
  if (self) return // he remembers his own voice; he doesn't stir at it
  state.unjudged++
  scheduleJudge(state)
}

async function start(): Promise<{ ok: boolean; error?: string }> {
  if (client) return { ok: true }
  if (starting) return { ok: true } // a login is already in flight — don't open a second gateway
  starting = true
  // finally GUARANTEES starting resets on every path — without it, a failed login
  // would wedge `starting` true forever and ears could never reopen.
  try {
    const token = botToken()
    if (!token) {
      lastError = 'no discordBotToken in .lantern-secrets.json'
      log(`cannot open — ${lastError}`, 'error')
      return { ok: false, error: lastError }
    }
    const cfg = await readEars()
    if (!cfg.channels.length) {
      lastError = 'no rooms configured'
      log(`cannot open — ${lastError}`, 'error')
      return { ok: false, error: lastError }
    }
    channels = new Map(cfg.channels.map((ch) => [ch.id, { meta: ch, buffer: [], unjudged: 0, settleTimer: null, firstUnjudgedAt: null }]))
    const c = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    })
    try {
      c.on(Events.MessageCreate, onMessage)
      c.on(Events.Error, (err) => {
        lastError = err.message
        log(`gateway error: ${err.message}`, 'error')
      })
      await c.login(token)
      // Wait until the gateway is actually READY before trusting it — channel +
      // message fetch needs the cache populated (login resolves on token validation,
      // slightly earlier). WITH A TIMEOUT: a connect-but-never-ready gateway must
      // not hang start() forever (that wedged ears un-reopenable). client is set
      // only AFTER ready, so a half-open gateway never leaves a dangling client.
      if (!c.isReady()) {
        let to: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          new Promise<void>((res) => c.once(Events.ClientReady, () => res())),
          new Promise<void>((_, rej) => { to = setTimeout(() => rej(new Error('gateway never became ready (30s)')), 30_000) }),
        ]).finally(() => { if (to) clearTimeout(to) })
      }
      client = c
      lastError = undefined
      log(`open — listening in ${cfg.channels.map((ch) => `#${ch.name}`).join(', ')}`)
      await backfill()
      return { ok: true }
    } catch (err) {
      lastError = (err as Error).message
      log(`failed to open — ${lastError}`, 'error')
      client = null // a failed open must leave no dangling client (else reopen is blocked)
      void c.destroy()
      return { ok: false, error: lastError }
    }
  } finally {
    starting = false
  }
}

function stop(): void {
  for (const state of channels.values()) {
    if (state.settleTimer) clearTimeout(state.settleTimer)
  }
  channels = new Map()
  if (client) {
    void client.destroy()
    client = null
    log('closed', 'info')
  }
}

function status(): { listening: boolean; channels: string[]; error?: string; events: EarsEvent[] } {
  return {
    listening: !!client?.isReady(),
    channels: [...channels.values()].map((s) => s.meta.name),
    error: lastError,
    events: [...events].reverse(), // newest first for the UI
  }
}

// Called once from main/index.ts at app start: registers the controller (so the
// harness `ears` tool and the IPC toggle can drive the gateway) and reconciles —
// if the config says ears are on, open them.
export async function initEars(): Promise<void> {
  registerEarsController({ start, stop, status })
  const cfg = await readEars()
  if (cfg.enabled) {
    const r = await start()
    if (!r.ok) log(`auto-open failed: ${r.error}`, 'error')
  }
}

export { stop as stopEars }
