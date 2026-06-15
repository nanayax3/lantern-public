// Lantern MCP client — runs in the Electron MAIN process (full Node, global fetch).
//
// Lets the Lantern companion use external MCP servers as if their tools were their
// own. First slice is CLOUD-ONLY: streamable-HTTP servers at workers.dev URLs
// (sketchpass, archive search). No process spawning, no stdio — that comes later.
//
// Deliberately hand-rolled JSON-RPC rather than @modelcontextprotocol/sdk: for
// request/response over HTTP it's ~a screenful, zero new dependency, no Electron
// ESM/CJS friction — same call we made reimplementing Glob/Grep instead of shelling
// to rg. The SDK earns its keep once we add local stdio servers; not before.
//
// Shape mirrors the WEB_TOOLS pattern in harness.ts: a list of tool defs handed to
// the conscious model + an executor that routes a call back to the right place. The
// conscious model just sees more tools (namespaced mcp__<server>__<tool>); the
// tool-call loop is unchanged.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

// Same repo-root logic as the harness (apps/desktop → ../.. = lantern root); the
// config lives there next to .lantern-secrets.json. Overridable for odd layouts.
const PROJECT_ROOT = process.env.LANTERN_PROJECT_ROOT || resolve(process.cwd(), '..', '..')
const CONFIG_PATH = process.env.LANTERN_MCP_CONFIG || resolve(PROJECT_ROOT, '.lantern-mcp.json')

// The protocol version we ASK for on initialize; the server answers with the one it
// will actually speak, and we adopt that for the MCP-Protocol-Version header after.
const PREFERRED_PROTOCOL = '2025-06-18'
const CONNECT_TIMEOUT_MS = 20000
const CALL_TIMEOUT_MS = 30000
const RESULT_CLAMP = 16000

interface ServerCfg {
  name: string
  url?: string // streamable-HTTP transport (cloud servers)
  headers?: Record<string, string> // optional extra headers (e.g. an Authorization)
  // LOCAL STDIO transport (the second slice, 12 June — built for Krita): when
  // `command` is set, Lantern SPAWNS the server and speaks newline-delimited
  // JSON-RPC over stdin/stdout. Lantern owns the process lifecycle — spawned on
  // connect, killed on quit, exit recorded into the status log.
  command?: string
  args?: string[]
  env?: Record<string, string>
}

// One tool as the conscious model sees it (OpenAI function shape — same as TOOLS/WEB_TOOLS).
interface McpToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

// Live connection state for one server. sessionId/protocolVersion are filled in by
// the initialize handshake and echoed on every later request. A stdio server
// additionally carries its child process + the pending-request map the stdout
// reader resolves into.
interface ServerConn {
  name: string
  url: string
  headers: Record<string, string>
  sessionId?: string
  protocolVersion: string
  child?: ChildProcess
  pending?: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
}

// Every spawned stdio child, so quit can sweep them — no orphaned servers.
const children = new Set<ChildProcess>()
const conns = new Map<string, ServerConn>()

export function shutdownMcp(): void {
  for (const c of children) {
    try { c.kill() } catch { /* already gone */ }
  }
  children.clear()
}

// Raw MCP tool descriptor from tools/list.
interface RawMcpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

let _id = 0
const nextId = (): number => ++_id

function clampResult(s: string): string {
  return s.length > RESULT_CLAMP ? s.slice(0, RESULT_CLAMP) + '\n…(truncated)' : s
}

// Function names the API accepts: ^[a-zA-Z0-9_-]{1,64}$. Namespace as mcp__server__tool,
// sanitise anything illegal to _, and keep it under 64 chars (truncate the tail if a
// server hands us a very long tool name — the routing map keys on this sanitised form).
function namespaced(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  return raw.length <= 64 ? raw : raw.slice(0, 64)
}

// === JSON-RPC over stdio =====================================================
// Newline-delimited JSON over the child's stdin/stdout (the MCP stdio framing).
// Requests park in conn.pending; the stdout line-reader resolves them by id.
function stdioRpc(
  conn: ServerConn,
  method: string,
  params?: unknown,
  opts: { notification?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  const child = conn.child
  if (!child?.stdin?.writable) return Promise.reject(new Error('server process not running'))
  const body: Record<string, unknown> = { jsonrpc: '2.0', method }
  const id = opts.notification ? undefined : nextId()
  if (id !== undefined) body.id = id
  if (params !== undefined) body.params = params
  child.stdin.write(JSON.stringify(body) + '\n')
  if (id === undefined) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending?.delete(id)
      reject(new Error(`${method}: timed out`))
    }, opts.timeoutMs ?? CALL_TIMEOUT_MS)
    conn.pending!.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
  })
}

// Wire a freshly-spawned stdio child to its conn: line-buffer stdout into JSON-RPC
// responses, log stderr into the status (servers chat there), and on exit fail the
// status + flush every pending request so nothing hangs forever.
function attachStdio(conn: ServerConn, st: McpServerStatus): void {
  const child = conn.child!
  let buf = ''
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = safeJson(line)
      if (!msg || msg.id === undefined) continue // server-initiated notifications: ignored (v1)
      const p = conn.pending?.get(msg.id)
      if (!p) continue
      conn.pending!.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
  })
  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString('utf8').trim()
    if (line) logLine(st, `stderr: ${line.slice(0, 200)}`)
  })
  const fail = (why: string): void => {
    logLine(st, why)
    if (st.state !== 'failed') { st.state = 'failed'; st.error = why }
    for (const [, p] of conn.pending ?? new Map()) p.reject(new Error(why))
    conn.pending?.clear()
    children.delete(child)
  }
  child.on('error', (e) => fail(`spawn error: ${e.message}`))
  child.on('exit', (code) => fail(`process exited (code ${code ?? '?'})`))
}

// === JSON-RPC over streamable-HTTP ==========================================
// One POST per message. The server may answer with application/json (a single
// response object) OR text/event-stream (SSE) — we handle both. Notifications carry
// no id and expect no response body. A conn with a child process routes to the
// stdio transport instead — same callers, two wires.
async function rpc(
  conn: ServerConn,
  method: string,
  params?: unknown,
  opts: { notification?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  if (conn.child) return stdioRpc(conn, method, params, opts)
  const body: Record<string, unknown> = { jsonrpc: '2.0', method }
  const id = opts.notification ? undefined : nextId()
  if (id !== undefined) body.id = id
  if (params !== undefined) body.params = params

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...conn.headers,
  }
  // Don't send the protocol-version header until the handshake has set it (the
  // initialize request itself negotiates the version).
  if (conn.protocolVersion) headers['MCP-Protocol-Version'] = conn.protocolVersion
  if (conn.sessionId) headers['Mcp-Session-Id'] = conn.sessionId

  const res = await fetch(conn.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
  })

  // The server hands back a session id on initialize; carry it on every later call.
  const sid = res.headers.get('mcp-session-id')
  if (sid) conn.sessionId = sid

  if (opts.notification) {
    await res.text().catch(() => undefined) // drain + ignore (often 202, empty)
    return undefined
  }

  if (!res.ok) throw new Error(`${method} → ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  const msg = ct.includes('text/event-stream') ? parseSse(text, id) : safeJson(text)
  if (!msg) throw new Error(`${method}: empty/unparseable response`)
  if (msg.error) throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`)
  return msg.result
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Parse an SSE body into the one JSON-RPC message we're waiting for. Events are
// separated by a blank line; within an event, data: lines join with a newline.
function parseSse(text: string, id: number | undefined): any {
  const candidates: any[] = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
    if (!dataLines.length) continue
    const obj = safeJson(dataLines.join('\n'))
    if (obj) candidates.push(obj)
  }
  return (
    (id !== undefined && candidates.find((o) => o.id === id)) ||
    candidates.find((o) => o.result !== undefined || o.error !== undefined) ||
    candidates[0]
  )
}

// === Status (for the maintenance tab) =======================================
// We KEEP per-server status + a small connection log so the UI can show what's
// connected, what broke, and WHY — instead of swallowing the error into the console.
export type McpState = 'connecting' | 'connected' | 'failed'
export interface McpLogEntry {
  t: number // epoch ms
  line: string
}
export interface McpServerStatus {
  name: string
  url: string
  state: McpState
  toolCount: number
  tools: string[] // original (un-namespaced) tool names, for a readable list
  error?: string // the failure reason, when state === 'failed'
  log: McpLogEntry[] // timestamped handshake steps / errors
}

const statuses = new Map<string, McpServerStatus>()
function logLine(st: McpServerStatus, line: string): void {
  st.log.push({ t: Date.now(), line })
}

// === Connect + register =====================================================
const toolDefs: McpToolDef[] = []
const routes = new Map<string, { conn: ServerConn; original: string }>()

async function connectOne(cfg: ServerCfg, st: McpServerStatus): Promise<void> {
  const conn: ServerConn = { name: cfg.name, url: cfg.url ?? '', headers: cfg.headers ?? {}, protocolVersion: '' }
  if (cfg.command) {
    logLine(st, `spawning: ${cfg.command} ${(cfg.args ?? []).join(' ')}`)
    conn.child = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}) },
      windowsHide: true,
    })
    conn.pending = new Map()
    children.add(conn.child)
    attachStdio(conn, st)
  } else if (!cfg.url) {
    throw new Error('server config needs a url (cloud) or a command (local stdio)')
  }
  conns.set(cfg.name, conn)
  logLine(st, 'initialize…')
  // A stdio server's first start may resolve deps (uv etc.) before it can answer —
  // give the spawn path a longer leash than a cloud URL.
  const init = await rpc(
    conn,
    'initialize',
    { protocolVersion: PREFERRED_PROTOCOL, capabilities: {}, clientInfo: { name: 'Lantern', version: '0.1.0' } },
    { timeoutMs: cfg.command ? 60000 : CONNECT_TIMEOUT_MS },
  )
  conn.protocolVersion = init?.protocolVersion || PREFERRED_PROTOCOL
  logLine(st, `initialize ok — protocol ${conn.protocolVersion}${conn.sessionId ? ', session established' : ''}`)
  // Per spec: tell the server we're ready before issuing real requests.
  await rpc(conn, 'notifications/initialized', undefined, { notification: true }).catch(() => undefined)

  const list = await rpc(conn, 'tools/list', {}, { timeoutMs: CONNECT_TIMEOUT_MS })
  const tools: RawMcpTool[] = list?.tools ?? []
  for (const t of tools) {
    if (!t?.name) continue
    const name = namespaced(cfg.name, t.name)
    if (routes.has(name)) continue // first one wins on a collision
    routes.set(name, { conn, original: t.name })
    st.tools.push(t.name)
    toolDefs.push({
      type: 'function',
      function: {
        name,
        description: t.description ?? `${t.name} (via the ${cfg.name} MCP server)`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
    })
  }
  st.state = 'connected'
  st.toolCount = st.tools.length
  logLine(st, `tools/list ok — ${st.toolCount} tool(s)`)
  console.log(`[mcp] connected ${cfg.name}: ${st.toolCount} tool(s)`)
}

async function connectAll(): Promise<void> {
  let cfg: { servers?: ServerCfg[] }
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    console.log('[mcp] no .lantern-mcp.json — MCP disabled')
    return
  }
  const servers = cfg.servers ?? []
  // Connect concurrently; a server that fails to handshake is logged + recorded into
  // its status (state 'failed' + the reason) and SKIPPED — a dead MCP endpoint must
  // never take the app down with it, and the maintenance tab gets to show WHY.
  await Promise.all(
    servers.map((s) => {
      const display = s.command ? `stdio: ${s.command} ${(s.args ?? []).join(' ')}`.trim() : (s.url ?? '')
      const st: McpServerStatus = { name: s.name, url: display, state: 'connecting', toolCount: 0, tools: [], log: [] }
      statuses.set(s.name, st)
      return connectOne(s, st).catch((err) => {
        st.state = 'failed'
        st.error = (err as Error).message
        logLine(st, `FAILED: ${st.error}`)
        console.warn(`[mcp] ${s.name} failed: ${st.error}`)
      })
    }),
  )
}

let readyPromise: Promise<void> | null = null
// Memoised: the handshakes run ONCE per process, on the first turn that needs tools.
// Every later call is a no-op await on the resolved promise.
export function ensureMcp(): Promise<void> {
  if (!readyPromise) readyPromise = connectAll()
  return readyPromise
}

// The tool defs to UNION into the conscious model's toolbox (empty until connected).
export function mcpTools(): McpToolDef[] {
  return toolDefs
}

// Names of the servers that actually connected — for the model-facing note.
export function mcpServerNames(): string[] {
  return [...statuses.values()].filter((s) => s.state === 'connected').map((s) => s.name)
}

// Full per-server status for the maintenance tab (connection state, tools, error, log).
export function mcpStatus(): McpServerStatus[] {
  return [...statuses.values()]
}

// === Add / remove servers at runtime (the maintenance-tab form) =============
// Persist to .lantern-mcp.json AND mutate the live registry, so a server added
// from the UI connects immediately — its tools are usable on the next turn, no
// restart. respond() reads mcpTools() fresh each turn, so new tools just appear.

async function readConfig(): Promise<{ servers: ServerCfg[] }> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as { servers?: ServerCfg[] }
    return { servers: cfg.servers ?? [] }
  } catch {
    return { servers: [] }
  }
}

async function writeConfig(servers: ServerCfg[]): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify({ servers }, null, 2) + '\n', 'utf8')
}

// Drop a server's tools, routes, and status from the live registry. toolDefs is
// mutated IN PLACE so the reference mcpTools() hands out stays valid.
function unregister(name: string): void {
  const drop = new Set<string>()
  for (const [nsName, route] of routes) {
    if (route.conn.name === name) {
      drop.add(nsName)
      routes.delete(nsName)
    }
  }
  const kept = toolDefs.filter((d) => !drop.has(d.function.name))
  toolDefs.length = 0
  toolDefs.push(...kept)
  statuses.delete(name)
  // A stdio server's process goes down with its registration.
  const conn = conns.get(name)
  if (conn?.child) {
    try { conn.child.kill() } catch { /* already gone */ }
    children.delete(conn.child)
  }
  conns.delete(name)
}

// Add (or re-add) a server: persist it, then connect it LIVE. A bad URL is
// recorded as a failed status (red on the tab) rather than thrown — the same
// graceful path as startup. Returns the updated status list for the UI.
export async function addServer(cfg: ServerCfg): Promise<McpServerStatus[]> {
  await ensureMcp()
  const name = cfg.name.trim()
  const url = (cfg.url ?? '').trim()
  if (!name || !url) return mcpStatus()
  const { servers } = await readConfig()
  await writeConfig([...servers.filter((s) => s.name !== name), { name, url }])
  unregister(name) // clean re-connect if it already existed
  const st: McpServerStatus = { name, url, state: 'connecting', toolCount: 0, tools: [], log: [] }
  statuses.set(name, st)
  await connectOne({ name, url }, st).catch((err) => {
    st.state = 'failed'
    st.error = (err as Error).message
    logLine(st, `FAILED: ${st.error}`)
    console.warn(`[mcp] ${name} failed: ${st.error}`)
  })
  return mcpStatus()
}

// Remove a server: drop it from the config file AND the live registry.
export async function removeServer(name: string): Promise<McpServerStatus[]> {
  await ensureMcp()
  const { servers } = await readConfig()
  await writeConfig(servers.filter((s) => s.name !== name))
  unregister(name)
  return mcpStatus()
}

// Cheap routing check for the harness dispatcher.
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__')
}

// Run an MCP tool call. Always returns a string (even on error) so the assistant
// tool_calls and tool results stay in lockstep in the loop. If `images` is passed,
// image content parts are collected into it as data URLs (the harness feeds them
// to the conscious model as a vision block AND surfaces them in the UI) — this is
// what lets the companion actually SEE a get_canvas result instead of drawing blind.
export async function executeMcpTool(name: string, args: Record<string, unknown>, images?: string[]): Promise<string> {
  const route = routes.get(name)
  if (!route) return `unknown MCP tool: ${name} (server not connected?)`
  try {
    const result = await rpc(route.conn, 'tools/call', { name: route.original, arguments: args })
    return formatToolResult(result, images)
  } catch (err) {
    return `${name} failed: ${(err as Error).message}`
  }
}

// tools/call returns { content: [...], isError?, structuredContent? }. Pull the text
// parts out for the model; image parts are collected as data URLs when a collector
// is given (and noted in the text either way — base64 never rides the TEXT result).
function formatToolResult(result: any, images?: string[]): string {
  if (!result) return '(no result)'
  const content = result.content
  if (Array.isArray(content)) {
    const parts = content.map((c: any) => {
      if (c?.type === 'text') return String(c.text ?? '')
      if (c?.type === 'image') {
        if (images && c.data) {
          images.push(`data:${c.mimeType ?? 'image/png'};base64,${c.data}`)
          return '[image returned — attached right after this result so you can see it]'
        }
        return '[image returned by the tool]'
      }
      if (c?.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`
      return JSON.stringify(c)
    })
    const text = parts.filter(Boolean).join('\n').trim()
    return clampResult((result.isError ? `[tool error] ${text}` : text) || '(empty result)')
  }
  if (result.structuredContent !== undefined) return clampResult(JSON.stringify(result.structuredContent))
  return clampResult(JSON.stringify(result))
}
