/**
 * Node 端向量嵌入传输层：直连硅基流动（SiliconFlow）embeddings API，OpenAI 兼容。
 * 密钥从环境变量读取（SF_API_KEY / SILICONFLOW_API_KEY）。
 *
 * 分片缓存（eval 用）：每个实例一个 JSON 文件（embed-cache/{shardId}.json），
 * 嵌完一批立刻落盘——跑到一半断电只损失当前实例，不连坐。
 * shardId = question_id（LongMemEval）/ sample_id（LoCoMo）；不传时走遗留单文件缓存（core.ts 引擎路径）。
 *
 * 迁移：分片查不到时回查遗留 embed-cache.json，命中则懒拷贝到分片——老数据不浪费。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvLocal } from './llm-node'
import { setEmbedFn } from './core'

const TIMEOUT_MS = 60000
const RETRY_BASE_MS = 5000
const MAX_RETRIES = 4
const BATCH_SIZE = 64

const here = dirname(fileURLToPath(import.meta.url))
/** 遗留单文件缓存路径（core.ts 引擎路径用；须在 loadEnvLocal 之后读取，故不作为模块级常量） */
const cacheFile = (): string => process.env.MUNINN_EMBED_CACHE || join(here, 'eval-data', 'embed-cache.json')
/** 分片缓存目录（eval 用；每实例一个文件） */
const shardDir = (): string => process.env.MUNINN_EMBED_CACHE_DIR || join(here, 'eval-data', 'embed-cache')

/* ---------------- 分片缓存（每实例一文件，中断只损当前实例） ---------------- */

interface ShardStore { data: Record<string, number[]>; dirty: boolean; savedAt: number }
const shardStores = new Map<string, ShardStore>()

function getShardStore(shardId: string): ShardStore {
  let s = shardStores.get(shardId)
  if (!s) {
    const file = join(shardDir(), `${shardId}.json`)
    try {
      const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, number[]> : {}
      s = { data, dirty: false, savedAt: 0 }
    } catch {
      s = { data: {}, dirty: false, savedAt: 0 }
    }
    shardStores.set(shardId, s)
  }
  return s
}

function saveShard(shardId: string): void {
  const s = shardStores.get(shardId)
  if (!s || !s.dirty) return
  mkdirSync(shardDir(), { recursive: true })
  writeFileSync(join(shardDir(), `${shardId}.json`), JSON.stringify(s.data), 'utf8')
  s.dirty = false
  s.savedAt = Date.now()
}

/** AML 的 shard 可达上万条（JSON 上百 MB），每批全量同步重写会把事件循环饿死。
 *  构建期间最多每 SAVE_INTERVAL_MS 落一次盘，崩溃最多损失一个间隔的嵌入进度。 */
const SAVE_INTERVAL_MS = 10000

function saveShardThrottled(shardId: string): void {
  const s = shardStores.get(shardId)
  if (!s || !s.dirty || Date.now() - s.savedAt < SAVE_INTERVAL_MS) return
  saveShard(shardId)
}

/** 构建完成后调用：强制落盘并释放内存副本（向量与 UserIndex.fragVecs 共享引用，不丢数据），
 *  下次用到时从磁盘重读。防止 shardStores 无界驻留把 2C4GB 堆爆。 */
export function releaseShard(shardId: string): void {
  try { saveShard(shardId) } catch (err) {
    console.warn(`[embed] 分片落盘失败（shard=${shardId}）：${err instanceof Error ? err.message : err}`)
  }
  shardStores.delete(shardId)
}

/* ---------------- 查询向量缓存（纯内存、有界 LRU；查询向量一次性语义，不落盘、不进分片缓存） ---------------- */

const QUERY_CACHE_MAX = 512
const queryCache = new Map<string, number[]>()

/** 单条查询嵌入：结果与 embedTexts 完全一致（同 API 同模型同单位化），但避开分片缓存的整文件重写 */
export async function embedQuery(text: string): Promise<number[]> {
  loadEnvLocal()
  const apiKey = process.env.SF_API_KEY || process.env.SILICONFLOW_API_KEY
  if (!apiKey) throw new Error('缺 SF_API_KEY / SILICONFLOW_API_KEY')
  const model = process.env.MUNINN_EMBED_MODEL || 'BAAI/bge-m3'
  const baseUrl = (process.env.SF_BASE_URL || 'https://api.siliconflow.cn').replace(/\/+$/, '').replace(/\/v1$/, '')
  const key = cacheKey(model, text)
  const hit = queryCache.get(key)
  if (hit) {
    queryCache.delete(key)
    queryCache.set(key, hit)
    return hit
  }
  const [vec] = await embedBatch([text], model, baseUrl, apiKey)
  if (queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value
    if (oldest !== undefined) queryCache.delete(oldest)
  }
  queryCache.set(key, vec)
  return vec
}

/* ---------------- 遗留单文件缓存（core.ts 引擎路径用；eval 已迁移到分片） ---------------- */

let legacyCache: Record<string, number[]> | null = null
let legacyCacheDirty = false

function legacyCacheLoad(): Record<string, number[]> {
  if (legacyCache) return legacyCache
  try {
    legacyCache = existsSync(cacheFile()) ? JSON.parse(readFileSync(cacheFile(), 'utf8')) as Record<string, number[]> : {}
  } catch {
    legacyCache = {}
  }
  return legacyCache
}

function legacyCacheSave(): void {
  if (!legacyCacheDirty || !legacyCache) return
  mkdirSync(dirname(cacheFile()), { recursive: true })
  try {
    writeFileSync(cacheFile(), JSON.stringify(legacyCache), 'utf8')
    legacyCacheDirty = false
  } catch (err) {
    console.warn(`[embed] 遗留缓存写入跳过（${Object.keys(legacyCache).length} 条）：${err instanceof Error ? err.message : err}`)
  }
}

const cacheKey = (model: string, text: string): string =>
  `${model}:${createHash('sha1').update(text).digest('hex')}`

/** 配置就绪（有 key）才算可用；调用方无 key 时应回退到纯 BM25 */
export function embeddingsAvailable(): boolean {
  loadEnvLocal()
  return !!(process.env.SF_API_KEY || process.env.SILICONFLOW_API_KEY)
}

/** 把向量召回注入引擎核心（core.ts 的碰撞候选排序）。无 SF key 返回 false，引擎保持龙脉排序 */
export function registerEmbedProvider(): boolean {
  if (!embeddingsAvailable()) return false
  setEmbedFn(embedTexts)
  return true
}

/** BGE-M3 最大 8192 tokens；按字符截断到 512（英文 ~128 tokens），超长碎片只取前缀做语义签名——
 *  嵌入只做召回预筛（碰撞候选排序），精确匹配靠 BM25 词法路，向量路只需语义指纹即可 */
const MAX_EMBED_CHARS = 512

const normalize = (v: number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / n)
}

async function embedBatch(texts: string[], model: string, baseUrl: string, apiKey: string): Promise<number[][]> {
  const payload = texts.map((t) => t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t)
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: payload }),
        signal: ctrl.signal,
      })
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
        lastErr = new Error(`HTTP ${resp.status}（嵌入限流/服务端错误，退避重试）`)
        continue
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`)
      }
      const data: any = await resp.json()
      const rows = data?.data
      if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error('嵌入响应条数不符')
      // OpenAI 兼容返回按 index 排序对齐输入
      const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      return sorted.map((r) => {
        if (!Array.isArray(r?.embedding)) throw new Error('嵌入响应缺 embedding 字段')
        return normalize(r.embedding as number[])
      })
    } catch (err) {
      lastErr = err
      if (attempt >= MAX_RETRIES) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('嵌入调用失败')
}

/**
 * 批量嵌入（自动分块 + 磁盘缓存 + 单位化，cosine 直接点积）。无 key 时抛错，调用方先 embeddingsAvailable() 探活。
 *
 * shardId：评测传实例 ID（question_id / sample_id），缓存分片到 embed-cache/{shardId}.json，
 *          每批落盘，中断只损失当前实例。不传走遗留单文件缓存（core.ts 引擎路径）。
 * 迁移：分片查不到时回查遗留 embed-cache.json，命中则懒拷贝到分片——老数据不浪费。
 */
export async function embedTexts(texts: string[], shardId?: string): Promise<number[][]> {
  loadEnvLocal()
  const apiKey = process.env.SF_API_KEY || process.env.SILICONFLOW_API_KEY
  if (!apiKey) throw new Error('缺 SF_API_KEY / SILICONFLOW_API_KEY')
  const model = process.env.MUNINN_EMBED_MODEL || 'BAAI/bge-m3'
  const baseUrl = (process.env.SF_BASE_URL || 'https://api.siliconflow.cn').replace(/\/+$/, '').replace(/\/v1$/, '')

  const shardStore = shardId ? getShardStore(shardId) : null
  const store: Record<string, number[]> = shardStore ? shardStore.data : legacyCacheLoad()

  const out: (number[] | null)[] = texts.map((t) => {
    const key = cacheKey(model, t)
    if (store[key]) return store[key]
    // 迁移：分片查不到时回查遗留缓存，命中则懒拷贝
    if (shardStore) {
      const lv = legacyCacheLoad()[key]
      if (lv) { store[key] = lv; shardStore.dirty = true; return lv }
    }
    return null
  })
  const pending: { i: number; text: string }[] = []
  out.forEach((v, i) => { if (!v) pending.push({ i, text: texts[i] }) })
  if (pending.length > 0) {
    console.log(`[embed] ${texts.length} 条文本，缓存命中 ${texts.length - pending.length}，待嵌入 ${pending.length}（model=${model}${shardId ? `, shard=${shardId}` : ''}）`)
    for (let b = 0; b < pending.length; b += BATCH_SIZE) {
      const chunk = pending.slice(b, b + BATCH_SIZE)
      const vecs = await embedBatch(chunk.map((c) => c.text), model, baseUrl, apiKey)
      chunk.forEach((c, j) => {
        store[cacheKey(model, c.text)] = vecs[j]
        out[c.i] = vecs[j]
      })
      if (shardStore) { shardStore.dirty = true; saveShardThrottled(shardId!) }
      else { legacyCacheDirty = true; legacyCacheSave() }
    }
    if (shardStore) saveShard(shardId!)
  }
  return out as number[][]
}
