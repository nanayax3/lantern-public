// Per-install deployment config — the infra knobs that differ per user: the URLs of
// their OWN deployed workers, where the album saves to disk, optional Cloudflare
// account id (for deploy scripts) and Discord wiring (for Ears). Lives in
// lantern.config.json at the repo root (gitignored — copy it from
// lantern.config.example.json). Read SYNC at module load, same pattern as the gate
// secret. A missing file just yields empty defaults: the app still boots; calls to the
// workers simply fail until the user deploys them and fills the URLs in (see README).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = process.env.LANTERN_PROJECT_ROOT || resolve(process.cwd(), '..', '..')

export interface LanternConfig {
  workers: { mindUrl: string; thalamusUrl: string }
  cloudflare: { accountId: string }
  paths: { albumDir: string }
  discord: { botToken: string; channels: string[] }
}

const DEFAULTS: LanternConfig = {
  workers: { mindUrl: '', thalamusUrl: '' },
  cloudflare: { accountId: '' },
  paths: { albumDir: resolve(PROJECT_ROOT, 'album') },
  discord: { botToken: '', channels: [] },
}

function read(): LanternConfig {
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, 'lantern.config.json'), 'utf8')
    const j = JSON.parse(raw) as Partial<LanternConfig>
    return {
      workers: {
        mindUrl: j.workers?.mindUrl ?? DEFAULTS.workers.mindUrl,
        thalamusUrl: j.workers?.thalamusUrl ?? DEFAULTS.workers.thalamusUrl,
      },
      cloudflare: { accountId: j.cloudflare?.accountId ?? DEFAULTS.cloudflare.accountId },
      paths: { albumDir: j.paths?.albumDir || DEFAULTS.paths.albumDir },
      discord: {
        botToken: j.discord?.botToken ?? DEFAULTS.discord.botToken,
        channels: j.discord?.channels ?? DEFAULTS.discord.channels,
      },
    }
  } catch {
    return DEFAULTS
  }
}

export const config: LanternConfig = read()
