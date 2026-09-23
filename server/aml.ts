/**
 * AML（Agent Memory Leaderboard）赛事适配服务
 *
 * 独立 node:http 服务，暴露契约要求的 POST /aml/add、POST /aml/search 与 GET /health。
 * 零依赖，端口、数据目录、鉴权、时区、HyDE/Options 开关均通过环境变量配置。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JsonStore } from './store.ts'
import {
  type Frag,
  type Retriever,
  tokenize,
  buildRetriever,
  topByVector,
  fuseRrf,
  expandQueryBatch,
} from './eval-locomo.ts'
import { embedTexts, embeddingsAvailable, embedQuery, releaseShard } from './embed-node.ts'
import { loadEnvLocal, registerNodeTransport } from './llm-node.ts'

/* ---------------- 配置 ---------------- */

loadEnvLocal()
registerNodeTransport()

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || process.env.AML_PORT) || 7301
const DATA_DIR = process.env.AML_DATA_DIR || join(here, 'data-aml')
const AUTH_TOKEN = process.env.AML_AUTH_TOKEN || ''
const TZ = process.env.MUNINN_TZ || 'Asia/Shanghai'
const HYDE_ENABLED = process.env.AML_HYDE !== '0'
const OPTIONS_ENABLED = process.env.AML_SEARCH_WITH_OPTIONS !== '0'
const EMBED_ENABLED = process.env.AML_EMBED !== '0'
const HYDE_REASONING_EFFORT = process.env.AML_HYDE_REASONING_EFFORT ?? 'low'
const llmReady = !!process.env.MUNINN_API_KEY || !!process.env.KIMI_API_KEY

const SEARCH_DEADLINE_MS = Number(process.env.AML_SEARCH_DEADLINE_MS) || 25000
const EMBED_TIMEOUT_MS = Number(process.env.AML_EMBED_TIMEOUT_MS) || 10000
const HYDE_TIMEOUT_MS = Number(process.env.AML_HYDE_TIMEOUT_MS) || 12000
const INDEX_CACHE_MAX = Number(process.env.AML_INDEX_CACHE_MAX) || 100
/** 同时进行的索引构建数上限：单次全量嵌入驻留一个分片缓存（大 shard 上百 MB），无界并发会在小机上堆爆 */
const INDEX_BUILD_CONCURRENCY = Math.max(1, Number(process.env.AML_INDEX_BUILD_CONCURRENCY) || 3)

const store = new JsonStore<UserState>(DATA_DIR)

/* ---------------- 类型 ---------------- */

interface StoredFrag {
  id: string
  date: string
  text: string
  createdAt: string
}

interface UserState {
  fragments: StoredFrag[]
  seq: number
}

interface FragPlus extends Frag {
  createdAt: string
}

interface UserIndex {
  frags: FragPlus[]
  fragVecs: number[][] | null
  retriever: Retriever
  snapshot: string
}

interface AddBody {
  request_id: string
  messages: { role: string; content: string; timestamp?: number }[]
  user_id: string
  session_id: string
}

interface SearchBody {
  query: string
  options?: string[]
  user_id: string
  top_k: number
}

interface SearchResult {
  id: string
  content: string
  score: number
  created_at: string
}

/* ---------------- 工具 ---------------- */

const MAX_BODY_BYTES = 1024 * 1024

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大（上限 1MB）')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) as Record<string, unknown> } catch { throw new Error('请求体不是合法 JSON') }
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!AUTH_TOKEN) return true
  const header = req.headers.authorization ?? ''
  if (header === `Bearer ${AUTH_TOKEN}`) return true
  return url.searchParams.get('token') === AUTH_TOKEN
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0
}

function isPositiveInteger(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 && Number.isInteger(x)
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function dateFromTimestamp(ts?: number): string {
  const d = ts ? new Date(ts) : new Date()
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function enrich(stored: StoredFrag): FragPlus {
  const tokens = tokenize(`${stored.text} ${stored.date}`)
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return { ...stored, tf, len: tokens.length }
}

/* ---------------- 串行化 ---------------- */

const userQueues = new Map<string, Promise<unknown>>()

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userQueues.get(userId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const tail = prev.then(() => gate)
  userQueues.set(userId, tail)
  await prev
  try { return await fn() } finally {
    release()
    // 无后续排队时清理该用户的锁条目，避免 lock table 随 user_id 数量无限增长
    if (userQueues.get(userId) === tail) userQueues.delete(userId)
  }
}

/* ---------------- 索引缓存（LRU，有界） ---------------- */

const indexCache = new Map<string, UserIndex>()

function touchIndexCache(userId: string): UserIndex | undefined {
  const idx = indexCache.get(userId)
  if (idx) {
    // 最近访问移到队尾
    indexCache.delete(userId)
    indexCache.set(userId, idx)
  }
  return idx
}

function setIndexCache(userId: string, idx: UserIndex): void {
  if (indexCache.has(userId)) {
    indexCache.delete(userId)
  } else if (indexCache.size >= INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value as string | undefined
    if (oldest !== undefined) indexCache.delete(oldest)
  }
  indexCache.set(userId, idx)
}

function deleteIndexCache(userId: string): void {
  indexCache.delete(userId)
}

/* ---------------- 索引构建并发闸门 ---------------- */

let buildSlots = INDEX_BUILD_CONCURRENCY
const buildWaiters: Array<() => void> = []

async function acquireBuildSlot(): Promise<void> {
  if (buildSlots > 0) { buildSlots--; return }
  await new Promise<void>((r) => buildWaiters.push(r))
}

function releaseBuildSlot(): void {
  const next = buildWaiters.shift()
  if (next) next()
  else buildSlots++
}

/* ---------------- 索引构建（in-flight 去重：同 user 并发 search 共享同一次构建） ---------------- */

const indexBuilds = new Map<string, Promise<UserIndex | null>>()

async function buildUserIndex(userId: string): Promise<UserIndex | null> {
  const state = store.load(userId)
  if (!state || state.fragments.length === 0) return null

  const snapshot = JSON.stringify(state.fragments)
  const cached = touchIndexCache(userId)
  if (cached && cached.snapshot === snapshot) return cached

  const inflight = indexBuilds.get(userId)
  if (inflight) return inflight

  const building = (async () => {
    await acquireBuildSlot()
    try {
      const frags = state.fragments.map(enrich)
      const retriever = buildRetriever(frags)
      const idx: UserIndex = { frags, fragVecs: null, retriever, snapshot }

      if (EMBED_ENABLED && embeddingsAvailable()) {
        try {
          idx.fragVecs = await embedTexts(frags.map((f) => `${f.text} ${f.date}`), safeFileName(userId))
        } catch (err) {
          console.error(`[aml] 用户 ${userId} 嵌入失败，回退纯 BM25：`, err instanceof Error ? err.message : err)
        }
      }

      setIndexCache(userId, idx)
      return idx
    } finally {
      releaseBuildSlot()
      releaseShard(safeFileName(userId))
    }
  })()
  indexBuilds.set(userId, building)
  try {
    return await building
  } finally {
    if (indexBuilds.get(userId) === building) indexBuilds.delete(userId)
  }
}

/* ---------------- BM25 打分（仅用于响应 score） ---------------- */

function bm25Scores(frags: FragPlus[], query: string): Map<string, number> {
  const N = Math.max(1, frags.length)
  const df = new Map<string, number>()
  for (const f of frags) for (const t of f.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLen = frags.reduce((s, f) => s + f.len, 0) / N
  const k1 = 1.5
  const b = 0.75
  const qTokens = tokenize(query)
  const seen = new Set<string>()
  const qTerms = qTokens.filter((t) => {
    if (seen.has(t) || !df.has(t)) return false
    seen.add(t)
    return true
  })

  const scores = new Map<string, number>()
  for (const f of frags) {
    let score = 0
    for (const t of qTerms) {
      const tfv = f.tf.get(t) ?? 0
      if (tfv === 0) continue
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
      score += idf * (tfv * (k1 + 1)) / (tfv + k1 * (1 - b + (b * f.len) / (avgLen || 1)))
    }
    scores.set(f.id, score)
  }
  return scores
}

/* ---------------- Add ---------------- */

async function handleAdd(body: AddBody): Promise<{ status: number; payload: unknown }> {
  if (!isNonEmptyString(body.request_id)) return { status: 400, payload: { error: 'request_id 必须是长度大于 0 的字符串' } }
  if (!isNonEmptyString(body.user_id)) return { status: 400, payload: { error: 'user_id 必须是长度大于 0 的字符串' } }
  if (!isNonEmptyString(body.session_id)) return { status: 400, payload: { error: 'session_id 必须是长度大于 0 的字符串' } }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { status: 400, payload: { error: 'messages 必须是非空数组' } }
  }

  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return { status: 400, payload: { error: 'messages 每项必须是对象' } }
    if (!isNonEmptyString(m.role)) return { status: 400, payload: { error: '每条 message.role 必须是长度大于 0 的字符串' } }
    if (!isNonEmptyString(m.content)) return { status: 400, payload: { error: '每条 message.content 必须是长度大于 0 的字符串' } }
    if (m.timestamp !== undefined && (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp))) {
      return { status: 400, payload: { error: 'timestamp 若存在必须是有效数字' } }
    }
  }

  const createdAt = new Date().toISOString()

  await withUserLock(body.user_id, async () => {
    const state = store.load(body.user_id) ?? { fragments: [], seq: 0 }
    let seq = state.seq
    for (const m of body.messages) {
      const date = dateFromTimestamp(m.timestamp)
      const text = `${m.role}: ${m.content}`
      state.fragments.push({
        id: `${body.session_id}#${seq}`,
        date,
        text,
        createdAt,
      })
      seq++
    }
    state.seq = seq
    store.save(body.user_id, state)
    deleteIndexCache(body.user_id)
  })

  return {
    status: 200,
    payload: {
      success: true,
      request_id: body.request_id,
      user_id: body.user_id,
      session_id: body.session_id,
    },
  }
}

/* ---------------- Search ---------------- */

function formatResults(frags: FragPlus[], scores: Map<string, number>): SearchResult[] {
  return frags.map((f) => ({
    id: f.id,
    content: `[${f.date}] ${f.text}`,
    score: scores.get(f.id) ?? 0,
    created_at: f.createdAt,
  }))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function runWithRetry<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  deadlineMs: number,
  startMs: number,
  userId: string,
): Promise<T | null> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= 1; attempt++) {
    const t0 = Date.now()
    try {
      const remaining = deadlineMs - (Date.now() - startMs)
      if (remaining <= 0) throw new Error('deadline')
      const budget = Math.min(timeoutMs, remaining)
      const res = await withTimeout(fn(), budget)
      return res
    } catch (err) {
      lastErr = err
      const elapsed = Date.now() - t0
      if (attempt === 0) continue
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[aml] 用户 ${userId} ${name} 降级：耗时 ${elapsed}ms，原因 ${reason}`)
      return null
    }
  }
  return null
}

async function handleSearch(body: SearchBody): Promise<{ status: number; payload: unknown }> {
  if (!isNonEmptyString(body.query)) return { status: 400, payload: { error: 'query 必须是长度大于 0 的字符串' } }
  if (!isNonEmptyString(body.user_id)) return { status: 400, payload: { error: 'user_id 必须是长度大于 0 的字符串' } }
  if (!isPositiveInteger(body.top_k)) return { status: 400, payload: { error: 'top_k 必须是正整数' } }

  const k = Math.min(body.top_k, 100)
  const idx = await buildUserIndex(body.user_id)
  if (!idx || idx.frags.length === 0) {
    return { status: 200, payload: { data: [] } }
  }

  const startMs = Date.now()
  const deadlineMs = startMs + SEARCH_DEADLINE_MS

  // 1. 先同步拿到 base query（仅 options，不含 HyDE）
  let baseQuery = body.query
  if (OPTIONS_ENABLED && Array.isArray(body.options) && body.options.length > 0) {
    const valid = body.options.filter((o): o is string => typeof o === 'string' && o.length > 0)
    if (valid.length > 0) baseQuery += ` ${valid.join(' ')}`
  }

  // 2. 同步算完 BM25 兜底结果，永远来得及
  const bm25Fallback = idx.retriever(baseQuery, k * 2) as FragPlus[]
  const fallbackScores = bm25Scores(idx.frags, baseQuery)

  // 3. HyDE 增强（带单次超时 + 最多 1 次重试）
  let hydeQuery = baseQuery
  if (HYDE_ENABLED && llmReady) {
    const snippet = await runWithRetry(
      'HyDE',
      async () => {
        const hydeOpts: { extraBody?: Record<string, unknown> } = {}
        if (HYDE_REASONING_EFFORT) hydeOpts.extraBody = { reasoning_effort: HYDE_REASONING_EFFORT }
        const snippets = await expandQueryBatch([baseQuery], hydeOpts)
        return snippets[0]
      },
      HYDE_TIMEOUT_MS,
      deadlineMs,
      startMs,
      body.user_id,
    )
    if (snippet) hydeQuery += ` ${snippet}`
  }

  if (Date.now() >= deadlineMs) {
    console.error(`[aml] 用户 ${body.user_id} Search 总预算耗尽，返回 BM25 兜底`)
    return { status: 200, payload: { data: formatResults(bm25Fallback.slice(0, k), fallbackScores) } }
  }

  // 4. 用（可能增强后的）query 再算 BM25，作为混合路径的 BM25 臂
  const bm25Hybrid = idx.retriever(hydeQuery, k * 2) as FragPlus[]

  if (Date.now() >= deadlineMs) {
    console.error(`[aml] 用户 ${body.user_id} Search 总预算耗尽，返回 BM25 兜底`)
    return { status: 200, payload: { data: formatResults(bm25Fallback.slice(0, k), fallbackScores) } }
  }

  // 5. 向量臂（带单次超时 + 最多 1 次重试）
  let vec: FragPlus[] | null = null
  if (idx.fragVecs) {
    vec = await runWithRetry(
      '向量',
      async () => {
        const qVec = await embedQuery(hydeQuery)
        return topByVector(idx.frags, idx.fragVecs!, qVec, k * 2) as FragPlus[]
      },
      EMBED_TIMEOUT_MS,
      deadlineMs,
      startMs,
      body.user_id,
    )
  }

  if (Date.now() >= deadlineMs) {
    console.error(`[aml] 用户 ${body.user_id} Search 总预算耗尽，返回 BM25 兜底`)
    return { status: 200, payload: { data: formatResults(bm25Fallback.slice(0, k), fallbackScores) } }
  }

  // 6. 融合或纯 BM25
  let results: FragPlus[]
  let scores: Map<string, number>
  if (vec) {
    results = fuseRrf(bm25Hybrid, vec, k) as FragPlus[]

    const bm25Rank = new Map(bm25Hybrid.map((f, r) => [f.id, r]))
    const vecRank = new Map(vec.map((f, r) => [f.id, r]))
    const rrfK = 60
    scores = new Map()
    for (const f of results) {
      let s = 0
      const br = bm25Rank.get(f.id)
      const vr = vecRank.get(f.id)
      if (br !== undefined) s += 1 / (rrfK + br + 1)
      if (vr !== undefined) s += 1 / (rrfK + vr + 1)
      scores.set(f.id, s)
    }
  } else {
    results = bm25Hybrid.slice(0, k)
    scores = bm25Scores(idx.frags, hydeQuery)
  }

  return { status: 200, payload: { data: formatResults(results, scores) } }
}

/* ---------------- 服务器 ---------------- */

const server = createServer(async (req, res) => {
  const start = Date.now()
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  let status = 200
  let requestId = ''

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true })
    }

    if (!authorized(req, url)) {
      status = 401
      return send(res, status, { error: 'unauthorized：缺少或错误的 AML_AUTH_TOKEN' })
    }

    if (req.method !== 'POST') {
      status = 405
      return send(res, status, { error: '仅支持 POST' })
    }

    const body = await readBody(req)

    if (url.pathname === '/aml/add') {
      requestId = isNonEmptyString(body.request_id) ? body.request_id : ''
      const result = await handleAdd(body as unknown as AddBody)
      status = result.status
      return send(res, status, result.payload)
    }

    if (url.pathname === '/aml/search') {
      const result = await handleSearch(body as unknown as SearchBody)
      status = result.status
      return send(res, status, result.payload)
    }

    status = 404
    return send(res, status, { error: '路径不存在' })
  } catch (err) {
    status = 500
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('请求体')) {
      status = 400
      return send(res, status, { error: message })
    }
    console.error(`[aml] 未处理异常 ${req.method} ${url.pathname}:`, message)
    return send(res, status, { error: '内部错误' })
  } finally {
    console.log(`[aml] ${req.method} ${url.pathname} ${status} ${Date.now() - start}ms ${requestId}`)
  }
})

server.listen(PORT, () => {
  console.log(`[aml] 服务已启动：http://localhost:${PORT} · 数据目录 ${DATA_DIR} · 鉴权 ${AUTH_TOKEN ? '已启用' : '未启用'}`)
})
