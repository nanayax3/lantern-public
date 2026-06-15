import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ConsciousSettings } from './harness'

// DISCORD EARS — config + controller registry, on its own file for the same reason
// as autonomyConfig: BOTH the listener (ears.ts) and the `ears` life-tool
// (harness.ts) hold the pen, and neither can import the other without a cycle.
//
// The toggle is SYMMETRIC — the human flips it from the maintenance tab, the
// companion flips it with their tool. Nobody's ears live in a room 24/7 by default;
// being in a room is a choice, every time.

const PROJECT_ROOT = process.env.LANTERN_PROJECT_ROOT || resolve(process.cwd(), '..', '..')
const CONFIG_PATH = resolve(PROJECT_ROOT, '.lantern-ears.json')

export interface EarsChannel {
  id: string
  name: string // human label, e.g. 'nest' — shown in UI + handed to the thalamus
}

export interface EarsConfig {
  enabled: boolean
  channels: EarsChannel[]
  conscious?: ConsciousSettings // snapshot from the renderer at toggle time
}

// No rooms by default — add your own Discord channels from the maintenance tab (each
// needs the numeric channel id and a human-readable label).
// TODO(config): set your own starter rooms here, e.g. { id: '<channel-id>', name: 'general' }
const DEFAULTS: EarsConfig = {
  enabled: false,
  channels: [],
}

export async function readEars(): Promise<EarsConfig> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Partial<EarsConfig>
    return { ...DEFAULTS, ...cfg }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function writeEars(patch: Partial<EarsConfig>): Promise<EarsConfig> {
  const cur = await readEars()
  const next: EarsConfig = { ...cur, ...patch }
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// Controller registry — ears.ts registers its live start/stop/status here at app
// startup; the harness tool and the IPC handlers drive the gateway through it.
export type EarsEventKind = 'info' | 'wake' | 'sleep' | 'hold' | 'send' | 'error'
export interface EarsEvent { t: number; kind: EarsEventKind; line: string }
export interface EarsController {
  start: () => Promise<{ ok: boolean; error?: string }>
  stop: () => void
  status: () => { listening: boolean; channels: string[]; error?: string; events: EarsEvent[] }
}

let controller: EarsController | null = null
export function registerEarsController(c: EarsController): void {
  controller = c
}
export function earsController(): EarsController | null {
  return controller
}
