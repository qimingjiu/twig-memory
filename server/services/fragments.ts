/** Read-only history access, shared by MCP and HTTP. No persisted schema changes. */
import { z } from 'zod'
import type { Fragment } from '../../visualizer/engine/types'
import { fragView } from '../core'
import { embedTexts, embeddingsAvailable, type EmbedOptions } from '../embed-node'
import { buildScoredRetriever, fuseRrfScored, tokenizeRuntime, topByVector, type Frag } from '../retrieval'

const userIdSchema = z.string().trim().min(1)
export const listFragmentsSchema = z.object({
  userId: userIdSchema,
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.number().int().min(1).max(500).default(50),
  includeShadow: z.boolean().default(false),
})
export const searchFragmentsSchema = z.object({
  userId: userIdSchema,
  query: z.string().trim().min(1).max(2000),
  k: z.number().int().min(1).max(20).default(8),
})

function record(fragment: Fragment) {
  return {
    id: fragment.id, date: fragment.dateLabel, title: fragment.title, body: fragment.body,
    threadIds: [...fragment.threadIds],
    ...(fragment.correction ? { correction: { ...fragment.correction } } : {}),
    ...(fragment.shadow ? { shadow: true } : {}),
  }
}

export function listFragments(fragments: Fragment[], options: Pick<z.infer<typeof listFragmentsSchema>, 'page' | 'limit' | 'includeShadow'>) {
  const { page, limit, includeShadow } = options
  const visible = includeShadow ? fragments : fragments.filter((f) => !f.shadow)
  return {
    fragments: visible.slice((page - 1) * limit, page * limit).map(record),
    totalFragments: visible.length, page, limit,
  }
}

export interface SearchDependencies {
  available: () => boolean
  embed: (texts: string[], shardId?: string, options?: EmbedOptions) => Promise<number[][]>
  timeoutMs?: number
}
const defaultDependencies: SearchDependencies = {
  available: () => {
    const available = embeddingsAvailable() // Loads .env.local before reading the runtime override.
    return process.env.MUNINN_SEARCH_EMBED !== '0' && available
  },
  embed: embedTexts,
}

export async function searchFragments(fragments: Fragment[], query: string, k: number, dependencies = defaultDependencies) {
  // Snapshot before any await: ingest/correction cannot mix old rankings with new bodies.
  // Explicit fact lookup does not wake or inject SILENT threads into daily context.
  const views = fragments.filter((f) => !f.shadow).map((f) => ({ ...record(f), body: fragView(f).body }))
  const byId = new Map(views.map((f) => [f.id, f]))
  const corpus: Frag[] = views.map((f) => {
    const text = `${f.id} ${f.title}\n${f.body}`
    const tokens = tokenizeRuntime(`${text} ${f.date}`)
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    return { id: f.id, date: f.date, text, tf, len: tokens.length }
  })
  const candidates = Math.max(k * 3, 20)
  const lexical = buildScoredRetriever(corpus, tokenizeRuntime, true)(query, candidates)
  let ranked = lexical.slice(0, k)
  let mode: 'bm25' | 'hybrid' = 'bm25'
  let degradedReason: 'embeddings_unavailable' | undefined
  if (corpus.length && tokenizeRuntime(query).length && dependencies.available()) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 10_000)
    try {
      // Use the existing disk cache for both history and repeated queries. No LLM/HyDE call.
      const vectors = await dependencies.embed(
        [...corpus.map((f) => `${f.text} ${f.date}`), query], undefined,
        { signal: controller.signal, maxRetries: 0 },
      )
      const queryVector = vectors[corpus.length]
      if (vectors.length !== corpus.length + 1 || !queryVector?.length || vectors.some((v) =>
        v.length !== queryVector.length || v.some((n) => !Number.isFinite(n)) || !v.some((n) => n !== 0))) {
        throw new Error('Invalid embedding vectors')
      }
      ranked = fuseRrfScored(lexical.map((hit) => hit.fragment), topByVector(corpus, vectors, queryVector, candidates), k)
      mode = 'hybrid'
    } catch {
      // Auth errors, outages, malformed vectors and timeout all retain usable lexical recall.
      degradedReason = 'embeddings_unavailable'
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    hits: ranked.map(({ fragment, score }) => ({ ...byId.get(fragment.id)!, score })),
    mode,
    ...(degradedReason ? { degradedReason } : {}),
  }
}
