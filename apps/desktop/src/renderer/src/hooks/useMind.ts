import { useEffect, useState } from 'react'
import { MIND_URL } from '../lib/mind'

// One place every dashboard card reads the live mind from. Replaces the `mock`
// imports — fetch a route once on mount, get {data, loading, error}. Cards handle
// their own empty/null state (the mind is often sparse, and that's honest).

export function useMind<T>(path: string): { data: T | null; loading: boolean; error: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`${MIND_URL}${path}`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d: T) => { if (alive) { setData(d); setLoading(false) } })
      .catch(() => { if (alive) { setError(true); setLoading(false) } })
    return () => { alive = false }
  }, [path])

  return { data, loading, error }
}

// Write to the mind (push a heart, leave a note). Cards update optimistically
// and fire this; the next mount re-reads the truth.
export async function mindPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(`${MIND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

// Re-render the caller on an interval so relative-time labels (`ago`) tick live
// instead of freezing until the next remount. Default: every 30s.
export function useNowTick(intervalMs = 30_000): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}

// Unix-seconds → friendly relative time, for the "updated X ago" feet.
export function ago(unixSeconds?: number | null): string {
  if (!unixSeconds) return ''
  const s = Math.floor(Date.now() / 1000) - unixSeconds
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  // Older than a week → an actual date, not an absurd "94d ago". Year only if not this year.
  const d = new Date(unixSeconds * 1000)
  const now = new Date()
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${d.getDate()} ${months[d.getMonth()]}${year}`
}
