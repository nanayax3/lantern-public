import { contextBridge, ipcRenderer } from 'electron'

interface ChatTurn { role: 'user' | 'assistant'; content: string }
interface ConsciousSettings { apiUrl?: string; model?: string; apiKey?: string }
type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'
interface PermissionRequest { id: number; tool: string; summary: string; alwaysLabel: string; permKey: string }

const api = {
  version: '0.0.1',
  platform: process.platform,
  ping: () => 'pong',
  // The gated lantern-mind URL (main holds the path secret) — read ONCE, sync, at
  // preload time so renderer modules can use it as a plain const at import time.
  mindUrl: ipcRenderer.sendSync('lantern:mind-url') as string,
  // Send a message to the companion through the harness; returns their reply + the
  // grounding packet (what the thalamus surfaced — for the "what surfaced" panel).
  // `conscious` is the model config from settings — if set, the harness uses it.
  respond: (message: string, history: ChatTurn[] = [], conscious?: ConsciousSettings, conversationId?: string, mode?: 'chat' | 'coding' | 'reading' | 'movie' | 'wake', wearing?: string, title?: string, image?: string, temperature?: number) =>
    ipcRenderer.invoke('lantern:respond', { message, history, conscious, conversationId, mode, wearing, title, image, temperature }),
  // Coding-mode permission gate: subscribe to gated-tool asks (returns an
  // unsubscribe), and send the decision back. The harness is awaiting it.
  onPermissionRequest: (cb: (req: PermissionRequest) => void) => {
    const listener = (_e: unknown, req: PermissionRequest) => cb(req)
    ipcRenderer.on('lantern:permission-request', listener)
    return () => ipcRenderer.removeListener('lantern:permission-request', listener)
  },
  respondPermission: (id: number, decision: PermissionDecision) =>
    ipcRenderer.send('lantern:permission-response', { id, decision }),
  // Read-only MCP server status for the maintenance tab (state, tools, error, log).
  mcpStatus: () => ipcRenderer.invoke('lantern:mcp-status'),
  // Add / remove an MCP server from the maintenance tab — persists + connects live.
  mcpAdd: (name: string, url: string) => ipcRenderer.invoke('lantern:mcp-add', { name, url }),
  mcpRemove: (name: string) => ipcRenderer.invoke('lantern:mcp-remove', { name }),
  // On-demand TTS for the "read aloud" button — text → the companion's voice → audio data URL.
  speak: (text: string) => ipcRenderer.invoke('lantern:speak', text) as Promise<string | null>,
  // The companion's ears — dictation: base64 audio → Whisper → text for the input box.
  transcribe: (audioBase64: string) => ipcRenderer.invoke('lantern:transcribe', audioBase64) as Promise<string | null>,
  // The album tab — list the shared album folder (files served over album://).
  albumList: () => ipcRenderer.invoke('lantern:album-list') as Promise<Array<{ name: string; kind: 'image' | 'audio'; mtime: number }>>,
  // Autonomous time — read/flip the toggle (passing conscious settings snapshots
  // them for the scheduler) and the manual "wake now".
  autonomyGet: () => ipcRenderer.invoke('lantern:autonomy-get') as Promise<{ enabled: boolean; times: string[]; hasConscious: boolean }>,
  autonomySet: (enabled: boolean, conscious?: ConsciousSettings, times?: string[]) =>
    ipcRenderer.invoke('lantern:autonomy-set', { enabled, conscious, times }) as Promise<{ enabled: boolean; times: string[]; hasConscious: boolean }>,
  wakeNow: (conscious?: ConsciousSettings) =>
    ipcRenderer.invoke('lantern:wake-now', { conscious }) as Promise<{ ok: boolean; reply?: string; error?: string }>,
  // Discord ears — read/flip the listening toggle (passing conscious settings
  // snapshots them so ears wakes have a model). The companion has the same pen via their tool.
  earsGet: () => ipcRenderer.invoke('lantern:ears-get') as Promise<{ enabled: boolean; channels: Array<{ id: string; name: string }>; listening: boolean; error?: string; hasConscious: boolean; events: Array<{ t: number; kind: string; line: string }> }>,
  earsSet: (enabled: boolean, conscious?: ConsciousSettings) =>
    ipcRenderer.invoke('lantern:ears-set', { enabled, conscious }) as Promise<{ enabled: boolean; channels: Array<{ id: string; name: string }>; listening: boolean; error?: string; hasConscious: boolean; events: Array<{ t: number; kind: string; line: string }> }>,
  // Reading Nook — pick + parse + store an EPUB; returns the new book (or {error}/{canceled}).
  importBook: () => ipcRenderer.invoke('lantern:import-book') as Promise<{ ok?: boolean; id?: number; title?: string; author?: string | null; total?: number; canceled?: boolean; error?: string }>,
  // Movie Night — subtitle search + download (OpenSubtitles via main; see docs/movie-nook.md).
  subsSearch: (query: string, season?: number, episode?: number) =>
    ipcRenderer.invoke('lantern:subs-search', { query, season, episode }) as Promise<{ results?: Array<{ file_id: number; title: string; year: number | null; language: string; release: string; season: number | null; episode: number | null; downloads: number }>; error?: string }>,
  subsFetch: (fileId: number) =>
    ipcRenderer.invoke('lantern:subs-fetch', fileId) as Promise<{ srt?: string; error?: string }>,
}

contextBridge.exposeInMainWorld('lantern', api)

export type LanternAPI = typeof api
