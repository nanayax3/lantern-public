import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// OpenSubtitles client for Movie Night's second-screen lane (docs/movie-nook.md).
// The user never hunts subtitle files — Lantern searches and fetches them. The free
// API needs a consumer key (opensubtitles.com account → API consumer); it lives in
// the gitignored .lantern-secrets.json as `opensubtitlesApiKey`. No key → callers
// get { error } with instructions, never a throw. Download quota on the free tier
// is ~20/day — the renderer caches fetched subs in localStorage so a movie is one
// download, ever.

const API = 'https://api.opensubtitles.com/api/v1'
const UA = 'Lantern v0.0.1'
const PROJECT_ROOT = process.env.LANTERN_PROJECT_ROOT || resolve(process.cwd(), '..', '..')

let _key: string | null | undefined
async function apiKey(): Promise<string | null> {
  if (_key !== undefined) return _key
  try {
    const raw = await readFile(resolve(PROJECT_ROOT, '.lantern-secrets.json'), 'utf8')
    _key = (JSON.parse(raw) as { opensubtitlesApiKey?: string }).opensubtitlesApiKey ?? null
  } catch {
    _key = null
  }
  return _key
}

const NO_KEY =
  'no OpenSubtitles key — make a free account at opensubtitles.com, request an API consumer key, and add it to .lantern-secrets.json as "opensubtitlesApiKey"'

export interface SubResult {
  file_id: number
  title: string
  year: number | null
  language: string
  release: string
  season: number | null
  episode: number | null
  downloads: number
}

// Search subtitles by title (+ optional season/episode). English + German, most
// downloaded first — popularity is a decent proxy for "the subs that match the cut."
export async function searchSubs(
  query: string,
  season?: number,
  episode?: number,
): Promise<{ results?: SubResult[]; error?: string }> {
  const key = await apiKey()
  if (!key) return { error: NO_KEY }
  try {
    const p = new URLSearchParams({ query, languages: 'en,de', order_by: 'download_count', order_direction: 'desc' })
    if (season) p.set('season_number', String(season))
    if (episode) p.set('episode_number', String(episode))
    const res = await fetch(`${API}/subtitles?${p}`, {
      headers: { 'Api-Key': key, 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { error: `search failed: ${res.status}` }
    const json = (await res.json()) as {
      data?: Array<{
        attributes?: {
          language?: string
          download_count?: number
          release?: string
          files?: Array<{ file_id?: number; file_name?: string }>
          feature_details?: { title?: string; year?: number; season_number?: number; episode_number?: number }
        }
      }>
    }
    const results: SubResult[] = []
    for (const d of json.data ?? []) {
      const a = d.attributes
      const fileId = a?.files?.[0]?.file_id
      if (!a || !fileId) continue
      results.push({
        file_id: fileId,
        title: a.feature_details?.title ?? query,
        year: a.feature_details?.year ?? null,
        language: a.language ?? '?',
        release: a.release ?? a.files?.[0]?.file_name ?? '',
        season: a.feature_details?.season_number ?? null,
        episode: a.feature_details?.episode_number ?? null,
        downloads: a.download_count ?? 0,
      })
    }
    return { results: results.slice(0, 12) }
  } catch (err) {
    return { error: `search failed: ${(err as Error).message}` }
  }
}

// Download one subtitle file's text (the API hands back a temporary link; we fetch
// it and return the raw SRT). This is the call that spends daily quota.
export async function fetchSub(fileId: number): Promise<{ srt?: string; error?: string }> {
  const key = await apiKey()
  if (!key) return { error: NO_KEY }
  try {
    const res = await fetch(`${API}/download`, {
      method: 'POST',
      headers: { 'Api-Key': key, 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { error: `download failed: ${res.status}${res.status === 406 ? ' (daily quota reached?)' : ''}` }
    const json = (await res.json()) as { link?: string; remaining?: number }
    if (!json.link) return { error: 'download failed: no link returned' }
    const file = await fetch(json.link, { signal: AbortSignal.timeout(30000) })
    if (!file.ok) return { error: `file fetch failed: ${file.status}` }
    const srt = await file.text()
    if (!srt.trim()) return { error: 'empty subtitle file' }
    return { srt }
  } catch (err) {
    return { error: `download failed: ${(err as Error).message}` }
  }
}
