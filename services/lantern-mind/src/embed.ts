import type { Env } from './env'

// The metabolism's enzymes: turn text into a vector, store it, surface by meaning.
//
// Kind-aware on purpose. A mind surfaces relevant memory regardless of whether it
// was a feeling, a journal entry, or a dream — so all memory kinds share ONE
// Vectorize index, namespaced by an id prefix (`feeling-12`) + a `kind` in
// metadata. The conscious `/surface` tool and the thalamus's Voice 1 ambient
// paint both reuse `querySimilar` — same primitive, two callers.
//
// Model: bge-base-en-v1.5 → 768-dim. The index must match: dim 768, cosine.
// (Index is named `lantern-feelings` for legacy reasons; it holds all kinds.)
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'

export type MemoryKind = 'feeling' | 'writing' | 'dream' | 'entity_fact' | 'identity'

// Returns the embedding vector, or null if the AI binding isn't available
// (e.g. local dev). Null is a soft failure: the row still stored, `embedded`
// stays 0, and Voice 3 can backfill later.
export async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null
  try {
    // bge output is a union (sync vs queued); the sync shape carries `data`.
    const res = (await env.AI.run(EMBED_MODEL, { text: [text] })) as { data?: number[][] }
    return res?.data?.[0] ?? null
  } catch (err) {
    console.error('[embed] failed:', err)
    return null
  }
}

// Upsert a memory's vector. Vectorize id = `${kind}-${id}`; metadata carries the
// kind + ref back to the row, plus light summary fields for cheap rendering.
export async function upsertMemory(
  env: Env,
  kind: MemoryKind,
  id: number,
  vector: number[],
  meta: Record<string, string | number>,
): Promise<void> {
  if (!env.VEC) return
  await env.VEC.upsert([
    {
      id: `${kind}-${id}`,
      values: vector,
      metadata: { kind, ref_id: id, ...meta },
    },
  ])
}

// Query the most semantically-similar memories to a piece of text, optionally
// filtered to certain kinds. The "surface itself back" half of the heartbeat.
export async function querySimilar(
  env: Env,
  text: string,
  topK = 5,
  kinds?: MemoryKind[],
): Promise<Array<{ kind: MemoryKind; ref_id: number; score: number }>> {
  if (!env.VEC) return []
  const vector = await embedText(env, text)
  if (!vector) return []

  const res = await env.VEC.query(vector, { topK, returnMetadata: true })
  let matches = (res.matches ?? []).map((m) => {
    const md = m.metadata as { kind?: string; ref_id?: number }
    return {
      kind: (md?.kind ?? 'feeling') as MemoryKind,
      ref_id: Number(md?.ref_id ?? -1),
      score: m.score,
    }
  })
  if (kinds?.length) matches = matches.filter((x) => kinds.includes(x.kind))
  return matches
}
