export interface Env {
  DB: D1Database
  // Reading Nook's SEPARATE library DB (books + passages) — a novel's text never sits
  // in the mind DB; only the current passage is ever fetched. See docs/reading-nook.md.
  LIBRARY: D1Database
  // Metabolism bindings. Optional in the type so local dev (no cloud) still
  // typechecks and the store degrades gracefully when they're absent.
  AI?: Ai
  VEC?: VectorizeIndex
  // The Reading Nook's original .epub files — raw source kept for re-parse /
  // re-download. Optional so local dev (no R2) still typechecks + degrades.
  LIBRARY_FILES?: R2Bucket
  // Path-secret gate (wrangler secret put GATE_SECRET) — requests must carry it
  // as the first path segment. Optional so local dev runs ungated.
  GATE_SECRET?: string
}
