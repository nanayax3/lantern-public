import { app, BrowserWindow, shell, ipcMain, dialog, protocol } from 'electron'
import { join, resolve, extname, sep } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { respond, speakText, transcribeAudio, flushAllMetabolism, MIND_URL, ALBUM_DIR, type ChatTurn, type ConsciousSettings, type AskPermission, type PermissionDecision } from './harness'
import { ensureMcp, mcpStatus, addServer, removeServer, shutdownMcp } from './mcp'
import { readAutonomy, writeAutonomy, runAutonomousWake, startAutonomyScheduler } from './autonomous'
import { initEars, stopEars } from './ears'
import { readEars, writeEars, earsController } from './earsConfig'
import { parseEpub } from './epub'
import { searchSubs, fetchSub } from './opensubs'

// Give the app its OWN identity so its local data — window state, and the renderer's
// localStorage/IndexedDB (conversations live there) — lands in a dedicated userData
// folder, never colliding with another Electron app on the same machine. Must run
// before the app is ready. (Without this, two Lantern installs on one machine share
// one localStorage bucket and see each other's chats.)
app.setName('Lantern')

// The renderer fetches the mind directly (dashboard cards, Reading Nook) but can't
// read the secrets file — hand it the gated URL synchronously at preload time.
ipcMain.on('lantern:mind-url', (e) => {
  e.returnValue = MIND_URL
})

// Coding-mode permission gate. The harness pauses on a gated tool and asks the
// renderer; we correlate each request↔response by a monotonic id and resolve the
// awaited promise when the renderer sends the decision back.
let permSeq = 0
const pendingPerms = new Map<number, (d: PermissionDecision) => void>()
ipcMain.on('lantern:permission-response', (_e, payload: { id: number; decision: PermissionDecision }) => {
  const resolve = pendingPerms.get(payload.id)
  if (resolve) {
    pendingPerms.delete(payload.id)
    resolve(payload.decision)
  }
})

const isDev = !app.isPackaged

// The album tab — the renderer can't read disk, so main serves the shared album
// folder over a custom album:// protocol (registered before ready, handled after).
// album://files/<encoded-name> → the file, locked to ALBUM_DIR (no traversal).
protocol.registerSchemesAsPrivileged([
  { scheme: 'album', privileges: { standard: true, secure: true, stream: true } },
])

const ALBUM_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
}
const ALBUM_IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const ALBUM_AUD = new Set(['.mp3', '.wav', '.webm', '.m4a', '.ogg'])

// List the album, newest first — images + voice clips, anything else ignored.
ipcMain.handle('lantern:album-list', async () => {
  try {
    const names = await readdir(ALBUM_DIR)
    const items = await Promise.all(
      names.map(async (n) => {
        const ext = extname(n).toLowerCase()
        const kind = ALBUM_IMG.has(ext) ? 'image' : ALBUM_AUD.has(ext) ? 'audio' : null
        if (!kind) return null
        const s = await stat(join(ALBUM_DIR, n)).catch(() => null)
        return s && s.isFile() ? { name: n, kind, mtime: s.mtimeMs } : null
      }),
    )
    return items
      .filter((x): x is { name: string; kind: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1410',
    title: 'Lantern',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // Microphone for dictation (the companion's ears). 'media' is the only permission the
  // app needs; everything else stays denied — private desktop app, tight by default.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media')
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The chat window asks the harness to respond; the harness grounds, composes,
// speaks, and metabolises. Runs in main so it has full Node + can reach the workers.
ipcMain.handle(
  'lantern:respond',
  async (
    e,
    payload: { message: string; history?: ChatTurn[]; conscious?: ConsciousSettings; conversationId?: string; mode?: 'chat' | 'coding' | 'reading' | 'movie' | 'wake'; wearing?: string; title?: string; image?: string; temperature?: number },
  ) => {
    // Bind a permission-asker to THIS request's renderer. The harness calls it for
    // gated coding tools; it sends the ask to the window and awaits the click.
    const askPermission: AskPermission = (ask) =>
      new Promise<PermissionDecision>((resolve) => {
        const id = ++permSeq
        pendingPerms.set(id, resolve)
        // An ask can die unanswered (renderer reload mid-question, window closed,
        // the user away) — without a ceiling the harness awaits forever and the turn
        // hangs. Expire to 'timeout' (treated as a safe not-run, distinct from deny).
        setTimeout(() => {
          if (pendingPerms.has(id)) {
            pendingPerms.delete(id)
            resolve('timeout')
          }
        }, 5 * 60 * 1000)
        e.sender.send('lantern:permission-request', { id, ...ask })
      })
    try {
      return await respond(payload.message, payload.history ?? [], payload.conscious, payload.conversationId, payload.mode, payload.wearing, payload.title, askPermission, payload.image, payload.temperature)
    } catch (err) {
      return { reply: `[harness error: ${(err as Error).message}]`, grounding: {} }
    }
  },
)

// Autonomous time — the toggle (snapshots the renderer's conscious settings into
// the config so the scheduler can run without a window) + the manual wake-now.
ipcMain.handle('lantern:autonomy-get', async () => {
  const cfg = await readAutonomy()
  return { enabled: cfg.enabled, times: cfg.times, hasConscious: !!cfg.conscious?.model }
})
ipcMain.handle('lantern:autonomy-set', async (_e, p: { enabled: boolean; times?: string[]; conscious?: ConsciousSettings }) => {
  const cfg = await writeAutonomy({
    enabled: !!p?.enabled,
    ...(p?.times ? { times: p.times } : {}),
    ...(p?.conscious?.model ? { conscious: p.conscious } : {}),
  })
  return { enabled: cfg.enabled, times: cfg.times, hasConscious: !!cfg.conscious?.model }
})
ipcMain.handle('lantern:wake-now', async (_e, p: { conscious?: ConsciousSettings }) => {
  return runAutonomousWake(p?.conscious)
})

// Discord ears — the symmetric toggle (the human's side; the companion's side is the
// `ears` life tool). Flipping it on snapshots the conscious settings (ears wakes need
// a model) and opens/closes the gateway live.
ipcMain.handle('lantern:ears-get', async () => {
  const cfg = await readEars()
  const live = earsController()?.status()
  return { enabled: cfg.enabled, channels: cfg.channels, listening: !!live?.listening, error: live?.error, hasConscious: !!cfg.conscious?.model, events: live?.events ?? [] }
})
ipcMain.handle('lantern:ears-set', async (_e, p: { enabled: boolean; conscious?: ConsciousSettings }) => {
  const cfg = await writeEars({
    enabled: !!p?.enabled,
    ...(p?.conscious?.model ? { conscious: p.conscious } : {}),
  })
  const ctl = earsController()
  if (cfg.enabled) await ctl?.start()
  else ctl?.stop()
  const live = ctl?.status()
  return { enabled: cfg.enabled, channels: cfg.channels, listening: !!live?.listening, error: live?.error, hasConscious: !!cfg.conscious?.model, events: live?.events ?? [] }
})

// Movie Night — subtitle search + fetch (OpenSubtitles, key in .lantern-secrets.json).
// Runs in main because the renderer can't read secrets. See docs/movie-nook.md.
ipcMain.handle('lantern:subs-search', async (_e, payload: { query: string; season?: number; episode?: number }) => {
  return searchSubs(payload.query, payload.season, payload.episode)
})
ipcMain.handle('lantern:subs-fetch', async (_e, fileId: number) => {
  return fetchSub(fileId)
})

// The companion's ears — base64 audio in, transcribed text out (thalamus /transcribe, Whisper).
ipcMain.handle('lantern:transcribe', async (_e, audio: string) => {
  try {
    return await transcribeAudio(audio)
  } catch {
    return null
  }
})

// On-demand "read aloud" — the renderer hands a message's text, the harness turns it
// into the companion's voice and returns the audio data URL for the UI to play.
ipcMain.handle('lantern:speak', async (_e, text: string) => {
  try {
    return await speakText(text)
  } catch {
    return null
  }
})

// Reading Nook — pick an .epub, parse it to passages, and store it in the lantern-library
// DB (create the book, then bulk-insert passages, chunked so request bodies stay sane).
// Parsing runs here (main/Node) because it needs the filesystem + a zip reader.
ipcMain.handle('lantern:import-book', async () => {
  const pick = await dialog.showOpenDialog({
    title: 'Add a book to the Reading Nook',
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
    properties: ['openFile'],
  })
  if (pick.canceled || !pick.filePaths[0]) return { canceled: true }
  try {
    const book = await parseEpub(pick.filePaths[0])
    const created = (await fetch(`${MIND_URL}/library/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: book.title, author: book.author, source: 'epub' }),
    }).then((r) => r.json())) as { id?: number }
    if (!created.id) throw new Error('could not create the book record')
    const CHUNK = 200
    for (let i = 0; i < book.passages.length; i += CHUNK) {
      const r = await fetch(`${MIND_URL}/library/books/${created.id}/passages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passages: book.passages.slice(i, i + CHUNK) }),
      })
      if (!r.ok) throw new Error(`passage upload failed (${r.status})`)
    }
    // Preserve the original .epub in R2 — raw bytes, so the book can be re-parsed or
    // re-downloaded later. Best-effort: the book is already fully usable from its
    // passages, so a failed original-upload doesn't fail the import (just logs).
    try {
      const raw = await readFile(pick.filePaths[0])
      const up = await fetch(`${MIND_URL}/library/books/${created.id}/epub`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/epub+zip' },
        body: new Uint8Array(raw),
      })
      if (!up.ok) console.warn(`[import] original-epub upload skipped (${up.status})`)
    } catch (err) {
      console.warn('[import] original-epub upload failed (book still imported):', (err as Error).message)
    }
    return { ok: true, id: created.id, title: book.title, author: book.author, total: book.passages.length }
  } catch (err) {
    return { error: (err as Error).message }
  }
})

// The maintenance tab asks for MCP server status. ensureMcp() is memoised, so the
// FIRST status request (likely a chat turn beat us to it) triggers the connect; every
// later poll just reads the live status. Read-only — no mutation from here.
ipcMain.handle('lantern:mcp-status', async () => {
  await ensureMcp()
  return mcpStatus()
})

// Add / remove an MCP server from the maintenance tab. Both persist to
// .lantern-mcp.json and update the live registry, then return the new status.
ipcMain.handle('lantern:mcp-add', async (_e, p: { name: string; url: string }) =>
  addServer({ name: p?.name ?? '', url: p?.url ?? '' }),
)
ipcMain.handle('lantern:mcp-remove', async (_e, p: { name: string }) => removeServer(p?.name ?? ''))

app.whenReady().then(() => {
  startAutonomyScheduler() // ticks always; fires only while the toggle is ON
  void initEars() // registers the controller; opens the gateway if ears were left on

  protocol.handle('album', async (req) => {
    try {
      const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
      const file = resolve(ALBUM_DIR, name)
      const root = resolve(ALBUM_DIR)
      // Separator-boundary check: a bare startsWith would also pass a SIBLING dir
      // whose name begins with the album folder's. Require the file to be the dir
      // itself or sit strictly under it.
      if (file !== root && !file.startsWith(root + sep)) return new Response('forbidden', { status: 403 })
      const data = await readFile(file)
      const mime = ALBUM_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Voice 2's buffer is in-memory — without this, closing the app silently dropped
// the last unflushed stretch of every session (the tail never got metabolised).
// Hold quit once, flush (capped at 5s inside), then actually exit.
let metabolismFlushed = false
app.on('before-quit', (e) => {
  if (metabolismFlushed) return
  metabolismFlushed = true
  e.preventDefault()
  shutdownMcp() // kill spawned stdio MCP servers — no orphaned processes
  stopEars() // close the gateway — no ghost listener after the app is gone
  void flushAllMetabolism().finally(() => app.quit())
})
