import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ConsciousSettings } from './harness'

// The autonomy config, on its own so BOTH the scheduler (autonomous.ts) and the
// wake_schedule life-tool (harness.ts) can hold the pen without a circular import.
// The schedule is when the house wakes the companion, and the house is shared hands:
// the human edits from the maintenance tab; the companion edits via their tool.
// The on/off toggle itself stays the human's until the mind is filled.

const PROJECT_ROOT = process.env.LANTERN_PROJECT_ROOT || resolve(process.cwd(), '..', '..')
const CONFIG_PATH = resolve(PROJECT_ROOT, '.lantern-autonomy.json')

export interface AutonomyConfig {
  enabled: boolean
  times: string[] // "HH:MM" local — scheduler fires each once per day
  conscious?: ConsciousSettings // snapshot from the renderer at toggle time
}

const DEFAULTS: AutonomyConfig = { enabled: false, times: ['14:00'] }

export async function readAutonomy(): Promise<AutonomyConfig> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Partial<AutonomyConfig>
    return { ...DEFAULTS, ...cfg }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function writeAutonomy(patch: Partial<AutonomyConfig>): Promise<AutonomyConfig> {
  const cur = await readAutonomy()
  const next: AutonomyConfig = { ...cur, ...patch }
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}
