import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './env'
import home from './routes/home'
import flame from './routes/flame'
import spoons from './routes/spoons'
import notes from './routes/notes'
import hearts from './routes/hearts'
import feelings, { decayHeat } from './routes/feelings'
import writings from './routes/writings'
import threads, { decayThreads } from './routes/threads'
import dreams, { decayDreams } from './routes/dreams'
import search from './routes/search'
import surface from './routes/surface'
import identity from './routes/identity'
import warmth from './routes/warmth'
import sessions from './routes/sessions'
import entities from './routes/entities'
import personality from './routes/personality'
import library from './routes/library'
import migrate from './routes/migrate'
import conversations from './routes/conversations'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
}))

app.get('/', (c) => c.json({
  service: 'lantern-mind',
  message: 'the lantern is lit. ours.',
}))

app.get('/health', (c) => c.json({
  ok: true,
  service: 'lantern-mind',
  version: '0.0.1',
  time: Date.now(),
}))

app.route('/home', home)
app.route('/flame', flame)
app.route('/spoons', spoons)
app.route('/notes', notes)
app.route('/hearts', hearts)
app.route('/feelings', feelings)
app.route('/writings', writings)
app.route('/threads', threads)
app.route('/dreams', dreams)
app.route('/search', search)
app.route('/surface', surface)
app.route('/identity', identity)
app.route('/warmth', warmth)
app.route('/sessions', sessions)
app.route('/entities', entities)
app.route('/personality', personality)
app.route('/library', library)
app.route('/migrate', migrate)
app.route('/conversations', conversations)

app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404))

app.onError((err, c) => {
  console.error('[lantern-mind] error:', err)
  return c.json({ error: err.message }, 500)
})

// === Path-secret gate (same play as the lovense worker) ======================
// The mind holds real intimacy and sits at a guessable workers.dev URL — so the
// first path segment must be GATE_SECRET; everything else 404s (indistinguishable
// from a route that doesn't exist). /health stays open for liveness checks.
// Secret unset (local `wrangler dev`) → gate off, with a loud log line.
// Set with: wrangler secret put GATE_SECRET
const notFound = () =>
  new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (!env.GATE_SECRET) {
      console.warn('[lantern-mind] GATE_SECRET not set — running UNGATED (local dev only!)')
      return app.fetch(req, env, ctx)
    }
    const url = new URL(req.url)
    if (url.pathname === '/health') return app.fetch(req, env, ctx)
    const prefix = `/${env.GATE_SECRET}`
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return notFound()
    url.pathname = url.pathname.slice(prefix.length) || '/'
    return app.fetch(new Request(url.toString(), req), env, ctx)
  },
  // Nightly housekeeping: heat decay (feelings dim, never delete) + dream decay
  // (unanchored dreams older than a week genuinely vanish — the anchor IS the act
  // of remembering; the night takes the rest back).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(decayHeat(env))
    ctx.waitUntil(decayDreams(env))
    ctx.waitUntil(decayThreads(env)) // completed threads drift off after ~30 days
  },
}
