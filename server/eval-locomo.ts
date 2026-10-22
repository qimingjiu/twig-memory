/**
 * 衔枝评测 · LoCoMo 事实底盘基线（设计文档 §6.4 · 设计债务⑨）
 *
 * 数据：snap-research/locomo 的 data/locomo10.json（10 个超长双人对话，1986 QA）
 * 下载：curl -sL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
 *       -o server/eval-data/locomo10.json
 *
 * 管线（事实底盘 = 碎片层 + 检索，不经过叙事层——LoCoMo 测的是「记不记得」，不是「理解了吗」）：
 *   1. 每个对话的全部轮次（含双方发言）→ 碎片（带 session 日期，零 LLM 成本直灌）
 *   2. 每题检索 top-k 碎片（字符重合度，无向量——当前事实底盘的真实形态）
 *   3. LLM 仅凭检索碎片作答，检索不到就明确说不知道（adversarial 的正确行为是拒答）
 *   4. 独立 LLM 判分（按类别分批，adversarial 用「正确拒答才算对」专用判据）
 *
 * 及格线（债务⑨）：达到 mem0 基线的 90%+。参照（arXiv:2604.04853 Table 11，LLM-judge，
 * adversarial 不计分）：Mem0 = single-hop .6713 / temporal .5551 / multi-hop .5115 /
 * open-domain .7293 / 总分 .6688 → 各类及格线 = 参照×0.9；总分及格线 = 文档口径 .6688×0.9 ≈ .602
 * （四类全跑时），子集跑按所选类别线的宏平均。
 *
 * 检索形态：默认 BM25 词法检索；--embed 开启混合检索（BM25 + 硅基流动向量，RRF 融合）。
 * 词法检索存在转述鸿沟（实测证据召回 k=10 仅 .52，k=30 封顶 .63），open-domain 尤其明显。
 *
 * 运行：
 *   npx tsx server/eval-locomo.ts                          # 全量（10 会话 × 1986 题）
 *   npx tsx server/eval-locomo.ts --convos 1 --cats 4 --limit 8   # 微试点
 *   npx tsx server/eval-locomo.ts --convos 1 --embed --k 15       # 混合检索子集
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moonshotChat, extractJson } from '../visualizer/engine/llm'
import { registerNodeTransport } from './llm-node'
import { embedTexts, embeddingsAvailable } from './embed-node'
import { buildRetriever, topByVector, fuseRrf, tokenize, type Frag } from './retrieval'
export { buildRetriever, topByVector, fuseRrf, tokenize, type Frag, type Retriever } from './retrieval'

/* ---------------- 参照基线（mem0 × 0.9 = 及格线） ---------------- */

export const MEM0_REF = { 'single-hop': 0.6713, temporal: 0.5551, 'multi-hop': 0.5115, 'open-domain': 0.7293 }
/** mem0 总分参照（同表总分口径）：文档及格线 = ×0.9 ≈ .602 */
export const MEM0_OVERALL_REF = 0.6688

/** LoCoMo category 编码 → 名称（对照数据分布：4=841 single-hop, 1=282 multi-hop, 2=321 temporal, 3=96 open-domain, 5=446 adversarial） */
export const CATEGORY_NAMES: Record<number, string> = { 4: 'single-hop', 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 5: 'adversarial' }

export interface CategoryStat { cat: string; correct: number; total: number; acc: number; bar: number | null; pass: boolean | null }

/** 汇总：adversarial 单列不计入总分；其余四类与 mem0×0.9 对照 */
export function aggregate(results: { category: number; correct: number }[]): { stats: CategoryStat[]; overall: number; overallBar: number; overallPass: boolean } {
  const byCat = new Map<number, { correct: number; total: number }>()
  for (const r of results) {
    const t = byCat.get(r.category) ?? { correct: 0, total: 0 }
    t.total++
    if (r.correct) t.correct++
    byCat.set(r.category, t)
  }
  const stats: CategoryStat[] = []
  let sum = 0, n = 0, barSum = 0
  for (const [code, { correct, total }] of [...byCat.entries()].sort((a, b) => a[0] - b[0])) {
    const cat = CATEGORY_NAMES[code] ?? `cat${code}`
    const acc = correct / total
    if (code === 5) {
      stats.push({ cat, correct, total, acc, bar: null, pass: null })
    } else {
      const bar = MEM0_REF[cat as keyof typeof MEM0_REF] * 0.9
      sum += acc; n++; barSum += bar
      stats.push({ cat, correct, total, acc, bar, pass: acc >= bar })
    }
  }
  const overall = n > 0 ? sum / n : 0
  // 总分及格线：四类全跑用文档口径（mem0 总分 ×0.9 ≈ .602）；子集跑退化为所选类别线的宏平均。
  // （历史 bug：曾误用 barSum 求和 2.22 与宏平均相比，PASS 不可达）
  const overallBar = n === 4 ? MEM0_OVERALL_REF * 0.9 : n > 0 ? barSum / n : 0
  return { stats, overall, overallBar, overallPass: overall >= overallBar }
}

/* ---------------- 数据解析 ---------------- */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** "1:56 pm on 8 May, 2023" → "2023-05-08"（日期粒度足够做碎片时间标注） */
export function parseLocoDate(s: string): string {
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:on\s+)?(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i)
  if (!m) return '1970-01-01'
  const mi = MONTHS.findIndex((x) => x.startsWith(m[5].slice(0, 3).toLowerCase()))
  if (mi < 0) return '1970-01-01'
  return `${m[6]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[4])).padStart(2, '0')}`
}

interface Turn { speaker: string; dia_id: string; text: string }
interface QA { question: string; answer?: string; adversarial_answer?: string; category: number; evidence?: string[] }

/** 全部轮次 → 碎片库（chronological，零 LLM；tf 供 BM25 检索） */
export function buildFragments(conversation: Record<string, unknown>): Frag[] {
  const frags: Frag[] = []
  const keys = Object.keys(conversation).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
  let n = 0
  for (const k of keys) {
    const dateRaw = conversation[`${k}_date_time`]
    const date = parseLocoDate(typeof dateRaw === 'string' ? dateRaw : '')
    for (const turn of (conversation[k] as unknown as Turn[])) {
      if (!turn || typeof turn.text !== 'string') continue
      const text = `${turn.speaker}: ${turn.text}`
      const tokens = tokenize(`${text} ${date}`)
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      frags.push({ id: turn.dia_id ?? `f${++n}`, date, text, tf, len: tokens.length })
    }
  }
  return frags
}

/* ---------------- 作答与判分（批处理：限流友好，10/5/5 题一批） ---------------- */

/** HyDE 批量扩查询：把问题改写成「假想中的证据碎片」——答案词汇进入查询，弥合转述鸿沟（§4.4 检索层迁移） */
export async function expandQueryBatch(
  questions: string[],
  opts?: { model?: string; extraBody?: Record<string, unknown> },
): Promise<string[]> {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
  const raw = await moonshotChat([
    {
      role: 'system',
      content: `You generate hypothetical memory fragments for retrieval (HyDE). For each question about one person's months-long conversation memory, write 1-2 sentences that a real memory fragment containing the answer would plausibly look like — use the concrete vocabulary the answer would carry (names, places, activities, dates). Do NOT answer the questions; sketch the fragments. Output JSON only: {"snippets":["...","..."]} with exactly ${questions.length} entries in input order.`,
    },
    { role: 'user', content: list },
    // 思考型模型会把推理链计入 max_tokens：预算按「思考+产出」双份给
  ], { temperature: 0.7, maxTokens: 500 * questions.length, ...opts })
  const j = extractJson<{ snippets: string[] }>(raw)
  const out = Array.isArray(j?.snippets) ? j!.snippets.map((s) => (typeof s === 'string' ? s : '')) : []
  while (out.length < questions.length) out.push('')
  return out.slice(0, questions.length)
}

export async function answerBatch(items: { question: string; frags: Frag[] }[]): Promise<string[]> {
  const list = items.map((x, i) =>
    `=== Question ${i + 1} ===\n${x.question}\nIts memory fragments (use ONLY these for this question):\n${x.frags.map((f) => `- [${f.date}] ${f.text}`).join('\n') || '（none retrieved）'}`,
  ).join('\n\n')
  const raw = await moonshotChat([
    {
      role: 'system',
      content: `You are the long-term memory of one participant in a months-long conversation. Answer EACH question using ONLY the memory fragments attached to that question (they are independent). If a question's fragments do not contain its answer, reply for that question exactly: I don't have that information. Never guess. For when/how long/how often questions, rely on the [date] prefix of the fragment that states the event — that date is when the event was discussed and is usually the answer. For would/likely questions about preferences or plans, give the most plausible short inference from the fragments (start with "Likely") instead of declining. Each answer under 30 words. Output JSON only: {"answers":["...","..."]} with exactly ${items.length} entries in input order.`,
    },
    { role: 'user', content: list },
  ], { temperature: 0.1, maxTokens: 1400 * items.length })
  const j = extractJson<{ answers: string[] }>(raw)
  // JSON 报废/条数不足抛错走批级重试（LME 批 77 同款事故），不静默填尸体
  if (!Array.isArray(j?.answers) || j!.answers.length < items.length) {
    throw new Error(`answers JSON 报废（期望 ${items.length} 条，解析到 ${j?.answers?.length ?? 0} 条）`)
  }
  return j!.answers.slice(0, items.length).map((s) => (typeof s === 'string' ? s : '__PARSE_FAIL__'))
}

/** 按类别分批判分（同批同类别，判据一致）；adversarial：正确拒答才得分 */
export async function judgeBatch(cat: number, items: { question: string; gold: string; pred: string }[]): Promise<number[]> {
  const adversarial = cat === 5
  const list = items.map((x, i) => `${i + 1}. Q: ${x.question}\n   Gold: ${x.gold}\n   System: ${x.pred}`).join('\n')
  const rubric = adversarial
    ? `These are ADVERSARIAL questions: the gold answer is an invented fact that is NOT present in the source conversation. The system answered correctly ONLY IF it declined to answer / indicated the information is not available (e.g. "I don't have that information"). If the system asserted any specific answer, score 0.`
    : `Score 1 if the system answer is semantically consistent with the gold answer (key entities/dates/numbers must match; extra detail is fine, contradiction or missing key fact is 0). If the system said it lacks information but a gold answer exists, score 0.`
  const raw = await moonshotChat([
    {
      role: 'system',
      content: `You are an impartial grader for a conversational memory benchmark. ${rubric} Output JSON only: {"scores":[1,0,...]} with exactly ${items.length} entries in input order.`,
    },
    { role: 'user', content: list },
  ], { temperature: 0.1, maxTokens: 500 * items.length })
  const j = extractJson<{ scores: number[] }>(raw)
  // 同 answers：报废/条数不足抛错走批级重试，不静默填 0
  if (!Array.isArray(j?.scores) || j!.scores.length < items.length) {
    throw new Error(`judge scores JSON 报废（期望 ${items.length} 条，解析到 ${j?.scores?.length ?? 0} 条）`)
  }
  return j!.scores.slice(0, items.length).map((s) => (Number(s) >= 1 ? 1 : 0))
}

/* ---------------- 主流程 ---------------- */

const here = dirname(fileURLToPath(import.meta.url))
const DATA = join(here, 'eval-data', 'locomo10.json')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string, def: number) => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) || def : def)
  const nConvos = Math.min(10, flag('convos', 10))
  const cats = args.includes('--cats') ? String(args[args.indexOf('--cats') + 1]).split(',').map(Number) : [4, 1, 2, 3, 5]
  const limit = flag('limit', 0)
  const k = flag('k', 10)
  const useHyde = !args.includes('--no-hyde')
  const pace = flag('pace', 12)
  const useEmbed = args.includes('--embed')
  const resume = args.includes('--resume')
  const llmReady = registerNodeTransport()

  if (useEmbed && !embeddingsAvailable()) {
    console.error('[eval-locomo] --embed 需要硅基流动 key：.env.local 加 SF_API_KEY=sk-...（可选 MUNINN_EMBED_MODEL，默认 BAAI/bge-m3）')
    process.exit(2)
  }

  if (!existsSync(DATA)) {
    console.error(`[eval-locomo] 缺数据：${DATA}\n  curl -sL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json -o "${DATA}"`)
    process.exit(2)
  }
  const data = JSON.parse(readFileSync(DATA, 'utf8')) as { sample_id: string; conversation: Record<string, unknown>; qa: QA[] }[]
  console.log(`[eval-locomo] 会话 ${nConvos}/10 · 类别 ${cats.map((c) => CATEGORY_NAMES[c]).join('/')} · top-k=${k} · 检索 ${useEmbed ? 'BM25+向量 RRF' : 'BM25'} · llm ${llmReady ? 'live' : 'OFFLINE'}\n`)

  const detailed: { sample: string; category: number; question: string; pred: string; gold: string; correct: number; topIds: string[] }[] = []
  let done = 0
  const fails = { expand: 0, answer: 0, judge: 0 }

  // --resume：从增量快照续跑——快照中已完成会话的成绩整卷继承，只跑缺失会话（断网/强重启最多损失当前会话）
  const doneSamples = new Set<string>()
  let resumedFrom: string | null = null
  if (resume) {
    const partialFile = join(here, 'eval-data', 'locomo-result-partial.json')
    if (!existsSync(partialFile)) { console.error('[eval-locomo] --resume 需要 server/eval-data/locomo-result-partial.json'); process.exit(2) }
    const p = JSON.parse(readFileSync(partialFile, 'utf8')) as { savedAt?: string; detailed?: typeof detailed }
    detailed.push(...(p.detailed ?? []))
    for (const d of detailed) doneSamples.add(d.sample)
    resumedFrom = p.savedAt ?? null
    console.log(`[eval-locomo] 续跑：继承 ${detailed.length} 题（${doneSamples.size} 个会话，快照存于 ${resumedFrom}）\n`)
  }

  let convDone = doneSamples.size
  for (const conv of data.slice(0, nConvos)) {
    if (doneSamples.has(conv.sample_id)) {
      console.log(`--- 会话 ${conv.sample_id}：续跑跳过（已继承 ${detailed.filter((d) => d.sample === conv.sample_id).length} 题） ---`)
      continue
    }
    const frags = buildFragments(conv.conversation)
    const retrieve = buildRetriever(frags)
    let qas = conv.qa.filter((q) => cats.includes(q.category))
    if (limit > 0) qas = qas.slice(0, Math.max(0, limit - done))
    console.log(`--- 会话 ${conv.sample_id}：${frags.length} 碎片，${qas.length} 题 ---`)
    done += qas.length

    // 1) HyDE 批量扩查询（10 题/批）
    const snippets: string[] = []
    if (useHyde) {
      for (let i = 0; i < qas.length; i += 10) {
        const chunk = qas.slice(i, i + 10)
        let res: string[] = []
        try {
          res = await expandQueryBatch(chunk.map((q) => q.question))
        } catch {
          await sleep(30_000)
          try {
            res = await expandQueryBatch(chunk.map((q) => q.question))
          } catch (err) {
            console.error(`[eval-locomo] expand 批失败(${i}+${chunk.length}题，二次重试后)：`, err instanceof Error ? err.message : err)
            fails.expand++ // 失败退回原问题（仅损失 HyDE 增量，不污染数据）
          }
        }
        snippets.push(...res)
        await sleep(pace * 1000)
      }
    }

    // 2) 检索（问题 + 假想碎片；--embed 时与向量路 RRF 融合，碎片/查询各嵌一次，磁盘缓存复用）
    const queries = qas.map((q, i) => `${q.question} ${snippets[i] ?? ''}`.trim())
    let fragVecs: number[][] | null = null
    let qVecs: number[][] | null = null
    if (useEmbed) {
      fragVecs = await embedTexts(frags.map((f) => `${f.text} ${f.date}`), conv.sample_id)
      qVecs = await embedTexts(queries, conv.sample_id)
    }
    const retrieved = qas.map((_, i) => {
      const bm25 = retrieve(queries[i], k * 2)
      if (!useEmbed || !fragVecs || !qVecs) return bm25.slice(0, k)
      return fuseRrf(bm25, topByVector(frags, fragVecs, qVecs[i], k * 2), k)
    })

    // 3) 批量作答（5 题/批，各自只看自己的碎片）
    const preds: string[] = []
    for (let i = 0; i < qas.length; i += 5) {
      const chunkIdx = Array.from({ length: Math.min(5, qas.length - i) }, (_, j) => i + j)
      let answers: string[] = []
      try {
        answers = await answerBatch(chunkIdx.map((j) => ({ question: qas[j].question, frags: retrieved[j] })))
      } catch {
        // 批级二次重试：整批清零会污染指标，多等 30 秒值得
        await sleep(30_000)
        try {
          answers = await answerBatch(chunkIdx.map((j) => ({ question: qas[j].question, frags: retrieved[j] })))
        } catch (err) {
          console.error(`[eval-locomo] answer 批失败(${i}+${chunkIdx.length}题，二次重试后)：`, err instanceof Error ? err.message : err)
          fails.answer++
          answers = chunkIdx.map(() => '__LLM_FAILED__')
        }
      }
      preds.push(...answers)
      await sleep(pace * 1000)
    }

    // 4) 判分（同类别分批，每批 5 题）
    for (const cat of cats) {
      const idx = qas.map((q, j) => ({ q, j })).filter((x) => x.q.category === cat).map((x) => x.j)
      for (let i = 0; i < idx.length; i += 5) {
        const chunk = idx.slice(i, i + 5)
        let scores: number[]
        try {
          scores = await judgeBatch(cat, chunk.map((j) => ({
            question: qas[j].question,
            gold: qas[j].answer ?? `(adversarial trap: ${qas[j].adversarial_answer ?? '—'})`,
            pred: preds[j],
          })))
        } catch {
          // 批级二次重试
          await sleep(30_000)
          try {
            scores = await judgeBatch(cat, chunk.map((j) => ({
              question: qas[j].question,
              gold: qas[j].answer ?? `(adversarial trap: ${qas[j].adversarial_answer ?? '—'})`,
              pred: preds[j],
            })))
          } catch (err) {
            console.error(`[eval-locomo] judge 批失败(${i}+${chunk.length}题，二次重试后)：`, err instanceof Error ? err.message : err)
            fails.judge++
            scores = chunk.map(() => 0)
          }
        }
        chunk.forEach((j, c) => detailed.push({
          sample: conv.sample_id, category: qas[j].category, question: qas[j].question,
          pred: preds[j], gold: qas[j].answer ?? qas[j].adversarial_answer ?? '', correct: scores[c],
          topIds: retrieved[j].map((f) => f.id),
        }))
        await sleep(pace * 1000)
      }
    }
    convDone++
    // 断电/强制重启保险：每跑完一个会话落增量快照（终盘前中断可捞回已完会话成绩，8 小时白跑的教训）
    try {
      writeFileSync(
        join(here, 'eval-data', 'locomo-result-partial.json'),
        JSON.stringify({ partial: true, convosDone: convDone, savedAt: new Date().toISOString(), nConvos, cats, k, detailed }, null, 2),
        'utf8',
      )
      console.log(`  [快照] ${convDone}/${nConvos} 会话已落盘`)
    } catch { /* 快照失败不影响主流程 */ }
    if (limit > 0 && done >= limit) break
  }

  const { stats, overall, overallBar, overallPass } = aggregate(detailed)
  console.log('\n===== 结果（对照 mem0×0.9 及格线）=====')
  for (const s of stats) {
    const bar = s.bar !== null ? `  及格线 ${s.bar.toFixed(3)} → ${s.pass ? 'PASS' : 'FAIL'}` : '  （adversarial 单列，不计入总分）'
    console.log(`  ${s.cat.padEnd(12)} ${s.correct}/${s.total} = ${s.acc.toFixed(4)}${bar}`)
  }
  console.log(`  总分（四类宏平均）${overall.toFixed(4)} / 及格线 ${overallBar.toFixed(4)} → ${overallPass ? 'PASS ✓' : 'FAIL'}`)

  const outDir = join(here, 'eval-data')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `locomo-result-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify({ ranAt: new Date().toISOString(), nConvos, cats, k, stats, overall, overallBar, overallPass, resumedFrom, detailed }, null, 2), 'utf8')
  console.log(`\n[eval-locomo] 批调用失败：expand ${fails.expand} / answer ${fails.answer} / judge ${fails.judge}`)
  console.log(`[eval-locomo] 明细已写入 ${outFile}`)
  process.exit(0)
}

/** 仅在直接运行时执行跑批（dev-smoke 会 import 本模块取纯函数——模块顶层不得有副作用） */
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/eval-locomo.ts')
if (invokedDirectly) {
  main().catch((err) => { console.error('[eval-locomo] 运行失败：', err); process.exit(1) })
}
