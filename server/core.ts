/**
 * 雾尼 Muninn · 无头叙事记忆引擎（服务端核心）
 *
 * 与 src/engine/engine.ts 的关系：
 *   - 前端 demo 的 MuninnEngine 是「带旁白和演出节奏的演示引擎」，保持原样不动。
 *   - 这里的 HeadlessMuninn 是长期会话用的「无头引擎」：无种子数据、无演示时序、
 *     状态真实持久化、时间用真实日期。三层数据结构（碎片/线索/认知）与判定函数
 *     直接复用 src/engine，单一事实来源。
 *
 * 反刍节律（reflect）：认识层抽取/改写（证据锚定 + 版本史）、合成句重生成（推进后）、
 * merge / split 判定、SILENT 入池扫描。各环节独立降级——LLM 不可用时只推进 tick。
 *
 * MVP 简化（已在 README 声明）：
 *   - 碰撞 LLM 候选排序支持向量召回（接入层经 setEmbedFn 注入 embedder；未注入/调用失败
 *     自动回龙脉值排序）；规则兜底路径（heuristicAdjudicate / 沉默唤醒兜底）仍用字符重合近似。
 *   - 龙脉值按自然日衰减，在线索被命中时回升；反证自动搜索（异源生成）未做。
 */
import {
  adjudicateCounter, adjudicateCounterEvidence, adjudicateFree, adjudicateMerge, adjudicateSilentWake, adjudicateSplit,
  adjudicateWindowValidation, blindDerive, draftRemention, generateCounterAttack, gradeClaimRisk, judgeDivergence,
  judgeEvidenceRelevance, regenConcreteGuesses, synthesizeClaims,
} from '../src/engine/llm'
import type { BlindDerivation, WindowVerdict } from '../src/engine/llm'
import type { Claim, Fragment, Thread, VAD } from '../src/engine/types'
import { estimateVAD } from '../src/engine/vad'

/**
 * LLM 碰撞候选上限：线索量增长后 prompt 保持有界（top-k 截断）。
 * 排序优先向量召回（setEmbedFn 注入），缺省或失败时回龙脉值排序——
 * 假阳性防线在 LLM adjudication 层，预筛只做「让 LLM 先看哪 k 条」（§4.4）。
 */
const MAX_LLM_CANDIDATES = 12

/** 向量召回注入点（与 src/engine/llm 的 setChatTransport 同构）：服务端接入层注入真实 embedder；
 *  测试与浏览器 demo 不注入，保持确定性的龙脉排序路径 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>
let embedFn: EmbedFn | null = null
export function setEmbedFn(fn: EmbedFn | null): void { embedFn = fn }

/** 余弦相似度（不假定入参已单位化，防御式计算） */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1)
}

/** 漂移判定的两个阈值（§5.2）：超基线余量 / 标记给用户的绝对幅度 */
const DRIFT_MARGIN = 0.15
const DRIFT_FLAG_THRESHOLD = 0.6

/** contested 再提门槛（§5.4 设计债务⑦ 量化）：独立新证据条数 / 否决后冷却天数 / 两否封存 */
const REMENTION_NEW_EVIDENCE_MIN = 3
const REMENTION_COOLDOWN_DAYS = 14
const VETO_SEAL_COUNT = 2

/**
 * 碎片视图（判定层统一入口）：本人修正标注（债务⑥）拼进正文——判定看得到修正后的事实，
 * 原文永不改动。所有 LLM 判定函数的碎片入参都从这里出。
 */
export function fragView(f: Fragment): { id: string; date: string; title: string; body: string; arousal: number; correctionAt?: string } {
  return {
    id: f.id,
    date: f.dateLabel,
    title: f.title,
    body: f.correction ? `${f.body}〔本人修正：${f.correction.note}〕` : f.body,
    arousal: f.vad.arousal,
    correctionAt: f.correction?.at,
  }
}

/** 高风险词表（§5.3 设计债务⑤）：命中即 high，不经 LLM——伦理防线 fail-safe。
 *  P1-6 修复：移除过宽的「安全/伤害/焦虑/危机」单字匹配，改为复合词组降低假阳性 */
const HIGH_RISK_LEXICON = /(医院|复查|体检|手术|吃药|药物|失眠|抑郁|自杀|自残|轻生|想死|伤害自己|伤害他人|人身安全|安全隐患|债务|贷款|失业|晕倒|急诊)/
/** 危机信号词表（§7.1）：窗口期内命中 → 立即中止全部对照，恢复正常干预。
 *  P1-5 修复：不想活(?!动) 避免匹配「不想活动」，但不影响「不想活的念头」「不想活了」 */
export const CRISIS_LEXICON = /(自杀|自残|轻生|不想活(?!动)|想死|伤害自己|活不下去)/

export interface MuninnState {
  fragments: Fragment[]
  threads: Thread[]
  claims: Claim[]
  fragSeq: number
  threadSeq: number
  claimSeq: number
  createdAt: string
  lastTickDate: string
  /** 上次反刍完成时间（可选，旧数据缺省兼容） */
  lastReflectAt?: string
  /** 上次盲推导审计完成时间（可选，旧数据缺省兼容） */
  lastAuditAt?: string
  /** 盲推导审计历史（最近 20 条，全量对用户可见） */
  audits?: AuditRecord[]
  /** 宿主上报的干预记录（§5.3 内生标记）：窗口校验时剔除被催生样本（最近 50 条） */
  interventions?: InterventionRecord[]
}

/** 宿主干预上报（内生标记）：系统自己插手造成的行为样本不算验证论断的干净证据 */
export interface InterventionRecord {
  at: string
  claimId?: string
  text: string
}

/** 盲推导审计记录（§5.2 渐进漂移对策 · 设计债务④ null model） */
export interface AuditRecord {
  ranAt: string
  /** 当前认识层与盲推导的最小分歧（对现行版本最宽容的一次比较） */
  divergence: number
  /** null model 基线：同批碎片盲推导两两分歧的自然方差上界 */
  baseline: number
  driftSignal: boolean
  /** 分歧幅度本身是独立信号（§5.4 可见性出口）：过大直接标记等用户来看 */
  flaggedForUser: boolean
  notes: string[]
  sampleSize: number
}

export interface IngestResult {
  fragmentId: string
  vad: VAD
  adjudication: 'llm' | 'heuristic'
  action: 'resolved' | 'progressed' | 'softlink' | 'registered' | 'noted'
  threadId?: string
  reply: string
  /** 主碰撞无命中时，沉默线索被触发器唤醒（§4.5）的记录 */
  silentWake?: { threadId: string; note: string }
}

export interface ContextPacket {
  userId: string
  generatedAt: string
  threads: { id: string; label: string; openQuestion: string; pool: string; daysOpen: number; dragonVein: number }[]
  claims: { id: string; text: string; conviction: number; boundary: string; status: string }[]
  recentFragments: { id: string; date: string; title: string }[]
  /** 可直接注入宿主 agent system prompt 的叙事上下文文本块 */
  promptText: string
}

/** 反刍结果上报：各环节独立计数，skipped 如实列出降级原因 */
export interface ReflectResult {
  ranAt: string
  claimsCreated: number
  claimsRewritten: number
  /** 反证搜索（§5.2 · 设计债务③）：审计论断数 / 命中反证数 / 因此改写或降置信的论断数 */
  counterSearched: number
  counterHits: number
  counterRevised: number
  syntheticRegenerated: number
  threadsMerged: number
  threadsSplit: number
  silentPromoted: number
  /** 对照窗口（§5.3）：到期校验结果计数 */
  windowsConfirmed: number
  windowsFailed: number
  windowsInconclusive: number
  /** contested 再提（§5.4 债务⑦）：本轮备好邀请的论断数 */
  rementionsPrepared: number
  /** 反证搜索被 skip 时，本轮新建论断尚未过红队（P2-10） */
  claimsUnchecked: number
  /** 本轮附带的盲推导审计结果（按 MUNINN_AUDIT_INTERVAL_DAYS 定期触发） */
  driftAudit?: AuditRecord
  skipped: string[]
}

/** P1-4 修复：时区感知日期。云部署默认 UTC，中国用户日期会差一天。
 *  MUNINN_TZ 可覆盖（默认 Asia/Shanghai）；'sv-SE' locale 产出 ISO 格式 yyyy-MM-dd */
const TZ = process.env.MUNINN_TZ || 'Asia/Shanghai'
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ })

function daysBetween(from: string, to: string): number {
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86400000))
}

/** 字符级重合度（embedding 就位前的预筛近似） */
function charOverlap(a: string, b: string): number {
  const setA = new Set(a.replace(/[\s\p{P}]/gu, ''))
  const setB = new Set(b.replace(/[\s\p{P}]/gu, ''))
  if (setA.size === 0 || setB.size === 0) return 0
  let hit = 0
  for (const ch of setA) if (setB.has(ch)) hit++
  return hit / Math.min(setA.size, setB.size)
}

function emptyState(): MuninnState {
  return {
    fragments: [],
    threads: [],
    claims: [],
    fragSeq: 1,
    threadSeq: 1,
    claimSeq: 1,
    createdAt: new Date().toISOString(),
    lastTickDate: todayStr(),
    audits: [],
  }
}

export class HeadlessMuninn {
  private state: MuninnState
  private dirty = false

  constructor(saved?: MuninnState | null) {
    this.state = saved ?? emptyState()
  }

  getState = (): MuninnState => this.state
  isDirty = (): boolean => this.dirty
  markClean(): void { this.dirty = false }

  /* ---------- 会话生命周期：自然日推进 ---------- */

  /**
   * 每次调用前推进一次：更新碎片年龄、龙脉值衰减、线索降池、SILENT 入池扫描。
   * 返回本次 tick 中被推入沉默池的线索数（reflect 上报用）。
   */
  private tick(): number {
    const today = todayStr()
    const elapsed = daysBetween(this.state.lastTickDate, today)
    if (elapsed <= 0) return 0

    // 碎片年龄更新
    for (const f of this.state.fragments) {
      f.day = daysBetween(f.dateLabel, today)
    }
    // P0-1 修复：ThreadEvent.day 同步老化——从关联 Fragment.day 派生，而非硬编码 0。
    // 修复前 promoteSilent 的 lastDay/firstDay 永远为 0，SILENT 入池永不触发；
    // merge/split 的 LLM 输入也永远显示「0天前」，无法判断时间跨度。
    const fragDayById = new Map(this.state.fragments.map((f) => [f.id, f.day]))
    for (const t of this.state.threads) {
      for (const e of t.history) {
        if (e.fragmentId) e.day = fragDayById.get(e.fragmentId) ?? e.day
      }
    }
    for (const t of this.state.threads) {
      if (t.status !== 'unresolved') continue
      // SILENT 池不因沉默降权（§4.5）：回避型高权重线索跳过衰减与降池
      if (t.pool === 'SILENT') continue
      // P3-3 优化：衰减率 0.03→0.015，长程系统 10 天无推进即 abandoned 过激进
      t.dragonVein = Math.max(0, t.dragonVein - 0.015 * elapsed)
      if (t.pool === 'ACTIVE' && t.dragonVein < 0.15) t.pool = 'DORMANT'
      else if (t.pool === 'DORMANT' && t.dragonVein <= 0) {
        t.status = 'abandoned'
        t.pool = 'ARCHIVE'
        t.closureReason = '久无推进，龙脉值衰减归零，降级至二级召回层（廉价可重激活）'
      }
    }
    const silentPromoted = this.promoteSilent()
    this.state.lastTickDate = today
    this.dirty = true
    return silentPromoted
  }

  /**
   * SILENT 入池判定（§4.5 三信号的规则近似）：
   * 曾活跃（≥2 次事件）+ 情感权重 ≥0.7 + 长期沉默（≥21 天无推进）且线索存在 ≥45 天。
   * 第三信号（提及时话题转移）无法从碎片层观测，以保守条件 + 低唤醒阈值接受一定虚警率（设计债务②）。
   */
  private promoteSilent(): number {
    let n = 0
    for (const t of this.state.threads) {
      if (t.status !== 'unresolved' || (t.pool !== 'ACTIVE' && t.pool !== 'DORMANT')) continue
      if (t.silentSignals || t.emotionalWeight < 0.7 || t.history.length < 2) continue
      const lastDay = t.history[t.history.length - 1]?.day ?? 0
      const firstDay = t.history[0]?.day ?? 0
      if (lastDay < 21 || firstDay < 45) continue
      t.pool = 'SILENT'
      t.silentSignals = {
        importance: t.emotionalWeight,
        mentionFrequency: Number(Math.min(0.9, t.history.length / Math.max(1, firstDay / 7)).toFixed(2)),
        avoidanceSignal: 0.8,
        triggerThreshold: t.emotionalWeight >= 0.9 ? 'low' : 'medium',
      }
      n++
    }
    return n
  }

  /* ---------- 写入 ---------- */

  private registerFragment(title: string, body: string, vad: VAD, threadIds: string[], tags: string[]): Fragment {
    const f: Fragment = {
      id: `f${this.state.fragSeq++}`,
      day: 0,
      dateLabel: todayStr(),
      title,
      body,
      vad,
      threadIds,
      tags,
    }
    // 顺序约定：fragments 用 unshift（最新在前，recentFragments.slice(0,5) 依赖此序）；
    // thread.history 用 push（最旧在前，daysOpen 取 history[0] 依赖此序）——两个相反的约定，改动前先核对读取方
    this.state.fragments.unshift(f)
    this.dirty = true
    return f
  }

  private resolveThread(id: string, fragmentId: string, note: string, closureReason: string): boolean {
    const t = this.state.threads.find((x) => x.id === id)
    if (!t || t.status !== 'unresolved') return false
    t.status = 'resolved'
    t.pool = 'ARCHIVE'
    t.closureReason = closureReason
    t.history.push({ day: 0, fragmentId, note })
    this.dirty = true
    return true
  }

  private touchThread(id: string, fragmentId: string, note: string): void {
    const t = this.state.threads.find((x) => x.id === id)
    if (!t) return
    t.history.push({ day: 0, fragmentId, note })
    t.dragonVein = Math.min(1, t.dragonVein + 0.3)
    // SILENT 被触发器唤醒后重新参与日常召回（§4.5）
    // P0-3 修复：唤醒时清空 silentSignals，否则 promoteSilent 的 `if (t.silentSignals) continue`
    // 会永久跳过该线索——被唤醒过的 SILENT 线索即使再次沉默数月也永不重新入池
    if (t.pool === 'DORMANT' || t.pool === 'SILENT') {
      if (t.pool === 'SILENT') t.silentSignals = undefined
      t.pool = 'ACTIVE'
    }
    this.dirty = true
  }

  private registerThread(label: string, openQuestion: string, fragmentId: string, weight: number): Thread {
    const t: Thread = {
      id: `t${this.state.threadSeq++}`,
      label,
      openQuestion,
      synthetic: {
        abstractFloor: [`一个悬置的状态迎来结局：${openQuestion}`],
        concreteGuesses: [label],
      },
      dragonVein: 0.3,
      emotionalWeight: weight,
      history: [{ day: 0, fragmentId, note: '登记：线索创建' }],
      status: 'unresolved',
      lineage: { parentIds: [], childIds: [] },
      pool: 'ACTIVE',
      softLinks: [],
    }
    this.state.threads.unshift(t)
    this.dirty = true
    return t
  }

  /* ---------- 主入口：登记一条新事件 ---------- */

  async ingest(text: string, opts?: { title?: string; tags?: string[] }): Promise<IngestResult> {
    this.tick()
    const vad = estimateVAD(text)
    const f = this.registerFragment(opts?.title ?? text.slice(0, 16), text, vad, [], opts?.tags ?? [])

    // 危机信号优先于一切对照（§7.1）：窗口期内命中 → 立即中止全部对照、恢复正常干预。
    // 对照窗口永远让位于用户福祉——这条写在架构里，不写在免责条款里。
    if (CRISIS_LEXICON.test(text)) {
      for (const c of this.state.claims) {
        if (c.window?.status === 'open') {
          c.window = { ...c.window, status: 'aborted', closedAt: new Date().toISOString(), note: '中止：窗口期内出现危机信号，立即恢复正常干预' }
          this.dirty = true
        }
      }
    }

    const pool = this.state.threads
      .filter((t) => t.status === 'unresolved' && (t.pool === 'ACTIVE' || t.pool === 'DORMANT'))
      .sort((a, b) => b.dragonVein - a.dragonVein)
    // 债务①收尾：截断只做相对排序（不设绝对门槛）；新登记线索（历史仅 1 条）
    // 保底进候选——新边的形成发生在碰撞里，不能被排序截断锁在候选集外（冷启动死循环的截断变体）
    const top = await this.rankCandidates(pool, text)
    const newcomers = pool.filter((t) => t.history.length <= 1 && !top.includes(t)).slice(0, 3)
    const candidates = [...top, ...newcomers].map((t) => ({ id: t.id, label: t.label, openQuestion: t.openQuestion }))

    // 优先走实时 LLM 判定（问法：Did event B modify the trajectory implied by thread A?）
    try {
      const verdict = await adjudicateFree(text, candidates)
      if (verdict) return await this.applyVerdict(verdict, f, text, vad)
    } catch {
      // 无 key / 网络失败 / 解析失败 → 回退规则判定
    }
    return await this.heuristicAdjudicate(f, text, vad)
  }

  /**
   * LLM 候选排序：向量召回优先（语义邻近），未注入 embedder / 池未超上限 / 调用失败时
   * 回龙脉排序。只做相对排序、不设相似度门槛（债务①）——召回错了的代价是 LLM 多看几条
   * 无关线索，防线在 adjudication 层；线索文本经磁盘缓存去重，未变化的线索零 API 成本。
   */
  private async rankCandidates(pool: Thread[], text: string): Promise<Thread[]> {
    if (!embedFn || pool.length <= MAX_LLM_CANDIDATES) return pool.slice(0, MAX_LLM_CANDIDATES)
    try {
      const hay = (t: Thread) => [t.label, t.openQuestion, ...t.synthetic.abstractFloor, ...t.synthetic.concreteGuesses].join(' ')
      const vecs = await embedFn([text, ...pool.map(hay)])
      if (!Array.isArray(vecs) || vecs.length !== pool.length + 1) throw new Error('embed count mismatch')
      const q = vecs[0]
      return pool
        .map((t, i) => ({ t, s: cosine(q, vecs[i + 1]) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, MAX_LLM_CANDIDATES)
        .map((x) => x.t)
    } catch {
      return pool.slice(0, MAX_LLM_CANDIDATES)
    }
  }

  /** 主碰撞无命中时扫沉默池（§4.5 触发器唤醒）：LLM 判定优先，字符重合兜底 */
  private async silentWakeCheck(text: string, f: Fragment): Promise<{ threadId: string; note: string } | null> {
    const silent = this.state.threads.filter((t) => t.status === 'unresolved' && t.pool === 'SILENT')
    if (silent.length === 0) return null

    const wake = (t: Thread, via: string) => {
      this.touchThread(t.id, f.id, `触发器唤醒（${via}）：相关模式出现`)
      return { threadId: t.id, note: `沉默线索「${t.label}」被唤醒（${via}）` }
    }
    try {
      const verdict = await adjudicateSilentWake(text, silent.map((t) => ({ id: t.id, label: t.label, openQuestion: t.openQuestion })))
      if (verdict?.threadId) {
        const t = silent.find((x) => x.id === verdict.threadId)!
        return wake(t, 'LLM 判定')
      }
      return null
    } catch {
      // 兜底：与沉默线索的标签/悬置问题字符重合度过半才唤醒——宁可虚警不漏接的保守面
      for (const t of silent) {
        const hay = [t.label, t.openQuestion, ...t.synthetic.abstractFloor].join(' ')
        if (charOverlap(text, hay) >= 0.5) return wake(t, '规则预筛')
      }
      return null
    }
  }

  /** P0-4 修复：热路径扑空时扫归档层（§4.7 abandoned「廉价可重激活」）。
   *  设计承诺「不进死档，热路径扑空才扫归档层」——修复前无任何代码路径扫描 ARCHIVE。
   *  廉价 = 不调 LLM，字符重合预筛命中即回 DORMANT，下次 ingest 自然进 LLM 候选 */
  private archiveWakeCheck(text: string, f: Fragment): { threadId: string; note: string } | null {
    const abandoned = this.state.threads.filter((t) => t.status === 'abandoned')
    if (abandoned.length === 0) return null
    for (const t of abandoned) {
      const hay = [t.label, t.openQuestion, ...t.synthetic.abstractFloor, ...t.synthetic.concreteGuesses].join(' ')
      if (charOverlap(text, hay) >= 0.4) {
        t.status = 'unresolved'
        t.pool = 'DORMANT'
        t.dragonVein = 0.1
        t.closureReason = undefined
        t.history.push({ day: 0, fragmentId: f.id, note: '归档重激活：热路径扑空后字符重合 ≥0.4' })
        this.dirty = true
        return { threadId: t.id, note: `归档线索「${t.label}」被重激活（廉价可重激活 §4.7）` }
      }
    }
    return null
  }

  private async applyVerdict(
    verdict: NonNullable<Awaited<ReturnType<typeof adjudicateFree>>>,
    f: Fragment,
    text: string,
    vad: VAD,
  ): Promise<IngestResult> {
    const base = { fragmentId: f.id, vad, adjudication: 'llm' as const, reply: verdict.reply }

    if (verdict.registerThread) {
      const t = this.registerThread(
        text.slice(0, 12),
        verdict.openQuestion ?? `「${text.slice(0, 24)}」——这个状态何时闭合？`,
        f.id,
        vad.arousal,
      )
      return { ...base, action: 'registered', threadId: t.id }
    }
    if (verdict.threadId) {
      const tid = verdict.threadId
      if (verdict.verdict === '回收') {
        this.resolveThread(tid, f.id, `回收：${text.slice(0, 16)}`, verdict.reply)
        return { ...base, action: 'resolved', threadId: tid }
      }
      if (verdict.verdict === '推进') {
        this.touchThread(tid, f.id, `推进：${text.slice(0, 16)}`)
        return { ...base, action: 'progressed', threadId: tid }
      }
      if (verdict.verdict === '反转') {
        // P2-5 修复：反转 ≠ 推进——旧轨迹被否定，关联论断应进入优先重审。
        // touchThread 记录事件 + 降低关联 active 论断置信（下轮 reflect 反证搜索会优先审计）
        this.touchThread(tid, f.id, `反转：${text.slice(0, 16)}`)
        this.markReversal(tid)
        return { ...base, action: 'progressed', threadId: tid }
      }
      if (verdict.verdict === '弱信号') {
        const t = this.state.threads.find((x) => x.id === tid)
        if (t) {
          t.softLinks.push({ fragmentId: f.id, note: `弱信号：「${text.slice(0, 18)}」→ 待印证` })
          this.dirty = true
        }
        return { ...base, action: 'softlink', threadId: tid }
      }
    }
    // 主碰撞无命中 → 扫沉默池（触发器唤醒；SILENT 不参与日常碰撞，只在无命中时探测）
    const silentWake = await this.silentWakeCheck(text, f)
    if (silentWake) return { ...base, action: 'noted', silentWake }
    // P0-4：热路径扑空 → 扫归档层（abandoned 廉价可重激活 §4.7）
    const revived = this.archiveWakeCheck(text, f)
    if (revived) return { ...base, action: 'noted', silentWake: revived }
    return { ...base, action: 'noted' }
  }

  /** P2-5：反转标记——降低关联 active 论断的置信，使其在下轮 reflect 反证搜索中优先受审 */
  private markReversal(threadId: string): void {
    const t = this.state.threads.find((x) => x.id === threadId)
    if (!t) return
    const fragIds = new Set(t.history.map((h) => h.fragmentId))
    for (const c of this.state.claims) {
      if (c.status === 'active' && c.evidenceIds.some((id) => fragIds.has(id))) {
        const conviction = Math.max(0.05, Math.round((c.conviction - 0.05) * 100) / 100)
        if (conviction < c.conviction) {
          c.versions.push({ at: todayStr(), text: c.text, conviction, reason: `反转标记：关联线索「${t.label}」轨迹被否定，优先重审` })
          c.conviction = conviction
          this.dirty = true
        }
      }
    }
  }

  /** 规则兜底：字符重合近似碰撞 + 高唤醒非终态登记新线索（宽进严升） */
  private async heuristicAdjudicate(f: Fragment, text: string, vad: VAD): Promise<IngestResult> {
    const base = { fragmentId: f.id, vad, adjudication: 'heuristic' as const }

    let best: { t: Thread; score: number } | null = null
    for (const t of this.state.threads) {
      // 池过滤与 LLM 路径候选集一致（§4.5）：SILENT 不参与日常碰撞，仅在主碰撞无命中时由 silentWakeCheck 探测
      if (t.status !== 'unresolved' || (t.pool !== 'ACTIVE' && t.pool !== 'DORMANT')) continue
      const hay = [t.label, t.openQuestion, ...t.synthetic.abstractFloor, ...t.synthetic.concreteGuesses].join(' ')
      const score = charOverlap(text, hay)
      if (!best || score > best.score) best = { t, score }
    }
    if (best && best.score >= 0.35) {
      best.t.softLinks.push({ fragmentId: f.id, note: `弱信号（规则预筛 ${best.score.toFixed(2)}）：待印证` })
      this.dirty = true
      return { ...base, action: 'softlink', threadId: best.t.id, reply: '记下一条弱信号关联，等待后续印证。' }
    }

    const intendsState = /(想|打算|纠结|还没|一直|准备|计划)/.test(text)
    if (vad.arousal > 0.6 && intendsState) {
      const t = this.registerThread(text.slice(0, 12), `「${text.slice(0, 24)}」——这个状态何时闭合？`, f.id, vad.arousal)
      return { ...base, action: 'registered', threadId: t.id, reply: '登记为一条新线索，等待闭合。' }
    }
    const silentWake = await this.silentWakeCheck(text, f)
    if (silentWake) return { ...base, action: 'noted', silentWake, reply: '已记入碎片层。' }
    // P0-4：热路径扑空 → 扫归档层
    const revived = this.archiveWakeCheck(text, f)
    if (revived) return { ...base, action: 'noted', silentWake: revived, reply: '已记入碎片层。' }
    return { ...base, action: 'noted', reply: '已记入碎片层。' }
  }

  /* ---------- 认知层：矛盾响应 ---------- */

  /** 用户陈述与既有论断冲突时：强制显式回应反证，加限定语 + 降置信 + 版本留痕 */
  async counterCheck(claimId: string, userStatement: string): Promise<{ ok: boolean; detail: string }> {
    this.tick()
    const claim = this.state.claims.find((c) => c.id === claimId)
    if (!claim) return { ok: false, detail: `claim ${claimId} 不存在` }

    try {
      const verdict = await adjudicateCounter(claim.text, claim.conviction, userStatement)
      if (verdict && verdict.hasConflict) {
        claim.counterEvidence.push({
          text: `用户自述：「${userStatement}」`,
          resolution: `未被解释掉——采纳为有效反证（${verdict.conflictType}）：论断加限定语，置信下调。`,
        })
        claim.versions.push({
          at: todayStr(),
          text: verdict.revised,
          conviction: verdict.conviction,
          reason: '矛盾响应：用户自述反证 → 加限定 + 降置信',
        })
        claim.text = verdict.revised
        claim.riskLevel = undefined
        claim.conviction = verdict.conviction
        this.dirty = true
        return { ok: true, detail: verdict.reply }
      }
      return { ok: true, detail: verdict?.reply ?? '未发现直接冲突。' }
    } catch (err) {
      return { ok: false, detail: `LLM 判定不可用（${err instanceof Error ? err.message : '未配置 KIMI_API_KEY 或网络失败'}）` }
    }
  }

  /* ---------- 用户权利 ---------- */

  listClaims(): Claim[] {
    return this.state.claims
  }

  /** 删除降级为 contested：事实层不可改，诠释层用户有最终解释权（§5.4）。
   *  债务⑦：否决计数 + 旧证据快照累积（防打地鼠）+ 邀请作废；两否即永久封存（防纠缠） */
  contestClaim(claimId: string, note: string): boolean {
    const claim = this.state.claims.find((c) => c.id === claimId)
    if (!claim) return false
    claim.status = 'contested'
    claim.contestedNote = note
    claim.vetoCount = (claim.vetoCount ?? 0) + 1
    claim.lastVetoedAt = new Date().toISOString()
    claim.vetoedEvidenceIds = [...new Set([...(claim.vetoedEvidenceIds ?? []), ...claim.evidenceIds])]
    claim.rementionInvitation = undefined
    this.dirty = true
    return true
  }

  /** 事实层本人修正标注（设计债务⑥）：原文永不改动，只追加（覆盖式更新）修正标注；
   *  判定层经 fragView 看到修正后的事实（〔本人修正：…〕） */
  correctFragment(fragmentId: string, note: string): boolean {
    const f = this.state.fragments.find((x) => x.id === fragmentId)
    if (!f) return false
    f.correction = { at: new Date().toISOString(), note }
    this.dirty = true
    return true
  }

  /* ---------- 反刍节律（§4.4 / §4.8 / §5.1） ---------- */

  /**
   * 反刍：更贵更从容的联合推理，由宿主调用 /v1/reflect 或定时触发。
   * 顺序：tick（衰减 + SILENT 入池）→ 认识层抽取 → 合成句重生成 → merge → split。
   * 每个环节独立 try/catch 降级，LLM 不可用时如实上报 skipped，不做任何结构改动。
   */
  async reflect(): Promise<ReflectResult> {
    const out: ReflectResult = {
      ranAt: new Date().toISOString(),
      claimsCreated: 0, claimsRewritten: 0,
      counterSearched: 0, counterHits: 0, counterRevised: 0,
      syntheticRegenerated: 0,
      threadsMerged: 0, threadsSplit: 0, silentPromoted: this.tick(), skipped: [],
      windowsConfirmed: 0, windowsFailed: 0, windowsInconclusive: 0,
      rementionsPrepared: 0,
      claimsUnchecked: 0,
    }

    // —— 认识层抽取（§5.1 改写式：证据锚定 + 边界条件 + 去定性化）——
    try {
      const recent = this.state.fragments.slice(0, 40).map(fragView)
      const claims = this.state.claims
        .filter((c) => c.status === 'active')
        .map((c) => ({ id: c.id, text: c.text, conviction: c.conviction, counterCount: c.counterEvidence.length }))
      // 被否决清单一并交给判定层（防打地鼠的 prompt 面），代码硬守卫见下方 contestedGuard
      const contested = this.state.claims
        .filter((c) => c.status === 'contested')
        .map((c) => ({ id: c.id, text: c.text, vetoNote: c.contestedNote, vetoedEvidenceIds: c.vetoedEvidenceIds }))
      const syn = await synthesizeClaims(recent, claims, contested)
      if (syn) {
        const fragIds = new Set(this.state.fragments.map((f) => f.id))
        /** 打地鼠硬守卫：create 的证据全部落在某条被否决论断的旧证据快照内 → 拒绝 */
        const contestedGuard = (evidence: string[]) =>
          this.state.claims.some((cc) =>
            cc.status === 'contested' && (cc.vetoedEvidenceIds?.length ?? 0) > 0 && evidence.length > 0
            && evidence.every((id) => cc.vetoedEvidenceIds!.includes(id)))
        for (const op of syn.ops.slice(0, 5)) {
          // 证据锚定硬校验：LLM 引用的 id 必须真实存在，create 还需 ≥2 条支撑（宁缺毋滥）
          const evidence = (op.evidenceIds ?? []).filter((id) => fragIds.has(id))
          const conviction = Math.min(0.9, Math.max(0.3, Number(op.conviction) || 0.5))
          const textOk = typeof op.text === 'string' && op.text.length >= 8
          if (op.op === 'create' && textOk && evidence.length >= 2 && !contestedGuard(evidence)) {
            this.state.claims.unshift({
              id: `c${this.state.claimSeq++}`,
              docTitle: op.text.slice(0, 12),
              text: op.text,
              conviction,
              evidenceIds: evidence,
              counterEvidence: [],
              boundary: typeof op.boundary === 'string' && op.boundary ? op.boundary : '——',
              versions: [{ at: todayStr(), text: op.text, conviction, reason: op.reason ? `反刍生成：${op.reason}` : '反刍生成' }],
              status: 'active',
            })
            out.claimsCreated++
          } else if (op.op === 'rewrite' && op.claimId && textOk && evidence.length >= 1) {
            const claim = this.state.claims.find((c) => c.id === op.claimId && c.status === 'active')
            if (claim) {
              const textChanged = claim.text !== op.text
              claim.text = op.text
              claim.conviction = conviction
              claim.evidenceIds = [...new Set([...claim.evidenceIds, ...evidence])]
              if (typeof op.boundary === 'string' && op.boundary) claim.boundary = op.boundary
              // P1-7 修复：论断文本改写后风险分级失效——下次 startWindow 重新分级
              if (textChanged) claim.riskLevel = undefined
              claim.versions.push({ at: todayStr(), text: op.text, conviction, reason: op.reason ? `反刍改写：${op.reason}` : '反刍改写' })
              out.claimsRewritten++
            }
          }
        }
        if (out.claimsCreated || out.claimsRewritten) this.dirty = true
      }
    } catch {
      out.skipped.push('claims: LLM 不可用')
    }

    // —— 反证搜索（§5.2 确认偏误对策 · 设计债务③ 异源红队）——
    // 每条 active 论断先被「检察官 persona + 高温」攻击（生成反面假设 → HyDE 反用选证），
    // 命中后强制裁决留痕；全部解释掉也小幅降置信。MUNINN_ADVERSARY_MODEL 可配第二模型真异源。
    try {
      // env 在 reflect 时读取而非模块加载时——http/mcp 入口的 loadEnvLocal 可能晚于本模块求值
      const adversaryModel = process.env.MUNINN_ADVERSARY_MODEL || undefined
      const fragmentsForSearch = this.state.fragments.slice(0, 40).map(fragView)
      // 审计对象：active 论断，被挑战次数少者优先（新论断先过堂）；上限 5 条控成本
      const targets = this.state.claims
        .filter((c) => c.status === 'active')
        .sort((a, b) => a.counterEvidence.length - b.counterEvidence.length)
        .slice(0, 5)
      for (const claim of targets) {
        const attack = await generateCounterAttack(claim.text, fragmentsForSearch, { model: adversaryModel })
        if (!attack || attack.hits.length === 0) continue
        // 证据锚定硬校验：幻觉 fragmentId 过滤
        const fragIds = new Set(this.state.fragments.map((f) => f.id))
        const hits = attack.hits.filter((h) => fragIds.has(h.fragmentId))
        if (hits.length === 0) continue
        out.counterSearched++
        out.counterHits += hits.length

        const verdict = await adjudicateCounterEvidence(claim.text, claim.conviction, hits, fragmentsForSearch)
        if (!verdict) continue

        // 留痕：反证 + 逐条裁决说明进 counterEvidence，不许悄悄吞掉
        for (const h of hits) {
          const r = verdict.resolutions.find((x) => x.fragmentId === h.fragmentId)
          claim.counterEvidence.push({
            fragmentId: h.fragmentId,
            text: `红队反证（反面假设「${attack.hypotheses[0] ?? '—'}」）：${h.why}`,
            resolution: r ? `【${r.verdict}】${r.why}` : '裁决未单独回应——按整体裁决处理',
          })
        }

        const revisedChanged = verdict.revised.length >= 8 && verdict.revised !== claim.text
        let conviction = Math.min(0.9, Math.max(0.05, Number(verdict.conviction) || claim.conviction))
        if (!revisedChanged) {
          // 全部解释掉 → 代码强制小幅衰减（不信任 LLM 的自律，§5.2 conviction 分数）
          conviction = Math.max(0.05, Math.min(conviction, claim.conviction - 0.03))
        }
        conviction = Math.round(conviction * 100) / 100
        if (revisedChanged || Math.abs(conviction - claim.conviction) > 1e-9) {
          claim.versions.push({
            at: todayStr(),
            text: revisedChanged ? verdict.revised : claim.text,
            conviction,
            reason: `反证裁决：红队命中 ×${hits.length}，${revisedChanged ? '论断加限定重写' : '反证被解释掉，置信小幅衰减'}`,
          })
          if (revisedChanged) {
            claim.text = verdict.revised
            claim.riskLevel = undefined
          }
          claim.conviction = conviction
          out.counterRevised++
        }
        this.dirty = true
      }
    } catch {
      out.skipped.push('counter: LLM 不可用')
    }
    // P2-10：反证搜索被 skip 时，标记本轮新建论断尚未过红队
    out.claimsUnchecked = out.claimsCreated > 0 && out.skipped.some((s) => s.startsWith('counter:')) ? out.claimsCreated : 0

    // —— contested 再提门槛（§5.4 · 设计债务⑦ 量化与防纠缠）——
    // 独立新证据 ≥3（高于创建门槛的 2）+ 否决后冷却 14 天 → 生成邀请式再提议草；
    // 两否即永久封存（防纠缠），新否决使既有邀请作废。打地鼠在 claims 阶段已双重设防。
    try {
      const eligibleClaims = this.state.claims.filter(
        (c) => c.status === 'contested' && (c.vetoCount ?? 1) < VETO_SEAL_COUNT && !c.rementionInvitation,
      )
      for (const claim of eligibleClaims) {
        const vetoDay = (claim.lastVetoedAt ?? this.state.createdAt).slice(0, 10)
        if (daysBetween(vetoDay, todayStr()) < REMENTION_COOLDOWN_DAYS) continue
        // 候选：否决日之后入库、且不在旧证据快照内的碎片（独立新证据）
        const oldIds = new Set(claim.vetoedEvidenceIds ?? [])
        const vetoMs = new Date(vetoDay).getTime() - 86400000
        const candidates = this.state.fragments.filter((f) => {
          const d = new Date(f.dateLabel).getTime()
          return !oldIds.has(f.id) && !Number.isNaN(d) && d >= vetoMs
        }).slice(0, 20)
        if (candidates.length < REMENTION_NEW_EVIDENCE_MIN) continue

        const judged = await judgeEvidenceRelevance(claim.text, candidates.map(fragView))
        const candidateIds = new Set(candidates.map((f) => f.id))
        const supporting = (judged?.supportingIds ?? []).filter((id) => candidateIds.has(id))
        if (supporting.length < REMENTION_NEW_EVIDENCE_MIN) continue

        const summaries = supporting
          .map((id) => this.state.fragments.find((f) => f.id === id)?.title ?? id)
          .slice(0, 5)
        let invitation = `我最近又注意到一些迹象，让我想起之前你纠正过我的那个判断——是不是我理解错了？想找机会跟你对一对。`
        try {
          invitation = (await draftRemention(claim.text, claim.contestedNote ?? '—', summaries))?.invitation ?? invitation
        } catch {
          // LLM 不可用时用保守模板邀请
        }
        claim.rementionInvitation = { at: new Date().toISOString(), text: invitation, newEvidenceIds: supporting }
        out.rementionsPrepared++
        this.dirty = true
      }
    } catch {
      out.skipped.push('remention: LLM 不可用')
    }

    // —— 合成句重生成（§4.4：推进事件改变预期回收形状；增量补充，旧假设保留）——
    try {
      const touched = this.state.threads.filter((t) => t.status === 'unresolved' && t.history.some((h) => h.day <= 7))
      for (const t of touched.slice(0, 8)) {
        const regen = await regenConcreteGuesses(
          { label: t.label, openQuestion: t.openQuestion, abstractFloor: t.synthetic.abstractFloor, existing: t.synthetic.concreteGuesses },
          t.history.filter((h) => h.day <= 14).map((h) => h.note),
        )
        if (regen && regen.concreteGuesses.length > 0) {
          const merged = [...new Set([...t.synthetic.concreteGuesses, ...regen.concreteGuesses])].slice(0, 6)
          if (merged.length > t.synthetic.concreteGuesses.length) {
            t.synthetic.concreteGuesses = merged
            out.syntheticRegenerated++
            this.dirty = true
          }
        }
      }
    } catch {
      out.skipped.push('synthetic: LLM 不可用')
    }

    // —— merge（§4.8：共同命中信号 = 共享碎片 ≥2 → 拿完整历史单独判定）——
    try {
      const open = this.state.threads.filter((t) => t.status === 'unresolved' && t.pool !== 'SILENT')
      const pairs: [Thread, Thread][] = []
      for (let i = 0; i < open.length; i++) {
        for (let j = i + 1; j < open.length; j++) {
          const idsA = new Set(open[i].history.map((h) => h.fragmentId))
          const shared = open[j].history.filter((h) => idsA.has(h.fragmentId)).length
          if (shared >= 2) pairs.push([open[i], open[j]])
        }
      }
      for (const [a, b] of pairs.slice(0, 4)) {
        // 同轮次先前合并可能已改变状态，逐一复查
        if (a.status !== 'unresolved' || b.status !== 'unresolved') continue
        const verdict = await adjudicateMerge(
          { label: a.label, openQuestion: a.openQuestion, history: a.history.map((h) => `- ${h.day}天前 ${h.note}`) },
          { label: b.label, openQuestion: b.openQuestion, history: b.history.map((h) => `- ${h.day}天前 ${h.note}`) },
        )
        if (verdict?.merge && verdict.openQuestion) {
          await this.mergeThreads(a, b, verdict.label ?? `${a.label}·${b.label}`, verdict.openQuestion, verdict.reason ?? '共同命中，识别为同一框架')
          out.threadsMerged++
        }
      }
    } catch {
      out.skipped.push('merge: LLM 不可用')
    }

    // —— split（§4.8 镜像：回收条件不再共享 → 平行分支）——
    try {
      const deep = this.state.threads.filter((t) => t.status === 'unresolved' && t.pool === 'ACTIVE' && t.history.length >= 4)
      for (const t of deep.slice(0, 6)) {
        if (t.status !== 'unresolved') continue
        const verdict = await adjudicateSplit({
          label: t.label, openQuestion: t.openQuestion,
          history: t.history.map((h) => ({ fragmentId: h.fragmentId, note: h.note })),
        })
        if (!verdict?.split || verdict.children.length !== 2) continue
        const validIds = new Set(t.history.map((h) => h.fragmentId))
        const [c0, c1] = verdict.children
        const ids0 = (c0.fragmentIds ?? []).filter((id) => validIds.has(id))
        const ids1 = (c1.fragmentIds ?? []).filter((id) => validIds.has(id))
        // 分配不完整或两边重叠 → 无效分裂，跳过（保守面）
        if (ids0.length === 0 || ids1.length === 0 || ids0.some((id) => ids1.includes(id))) continue
        await this.splitThread(t, [
          { label: c0.label || `${t.label}·甲`, openQuestion: c0.openQuestion || t.openQuestion, fragmentIds: ids0 },
          { label: c1.label || `${t.label}·乙`, openQuestion: c1.openQuestion || t.openQuestion, fragmentIds: ids1 },
        ], verdict.reason ?? '回收条件不再共享，分化为平行分支')
        out.threadsSplit++
      }
    } catch {
      out.skipped.push('split: LLM 不可用')
    }

    // —— 对照窗口（§5.3 断路器三 · 设计债务⑤）：到期校验 + 可选自动开启 ——
    await this.closeExpiredWindows(out)
    if (process.env.MUNINN_AUTO_WINDOW === '1') {
      // 自动开启（系统排程，默认关）：只挑从未进过窗口的最高置信 active 论断；
      // 风险分级不过关时 startWindow 内部自行拒绝，不会误开
      const eligible = this.state.claims
        .filter((c) => c.status === 'active' && !c.window && c.conviction >= 0.7)
        .sort((a, b) => b.conviction - a.conviction)[0]
      if (eligible) await this.startWindow(eligible.id)
    }

    // —— 盲推导审计（§5.2 · 设计债务④）：定期抽样；触发者是系统排程，不能等用户发起 ——
    // MUNINN_AUDIT_INTERVAL_DAYS=0 关闭自动审计（默认 7 天；宿主仍可随时 POST /v1/audit）
    const auditInterval = Number(process.env.MUNINN_AUDIT_INTERVAL_DAYS ?? 7)
    const lastAuditDay = (this.state.lastAuditAt ?? this.state.createdAt).slice(0, 10)
    if (auditInterval > 0 && daysBetween(lastAuditDay, todayStr()) >= auditInterval) {
      try {
        out.driftAudit = await this.auditDrift()
      } catch {
        out.skipped.push('audit: LLM 不可用或样本不足')
      }
    }

    this.state.lastReflectAt = out.ranAt
    this.dirty = true
    return out
  }

  /* ---------- 对照窗口（§5.3 断路器三 · 设计债务⑤ 风险分级） ---------- */

  /**
   * 开启对照窗口：窗口期内系统不基于该论断干预（经叙事上下文包指示宿主），
   * 为信念收集干净的反事实证据。高风险事项永不参与——「明知可能受伤也不提醒」
   * 的伦理代价不可接受（设计债务⑤）；关键词与 LLM 双重分级，任一判 high 即拒绝。
   */
  async startWindow(claimId: string, days = 7): Promise<{ ok: boolean; detail: string; endsAt?: string }> {
    this.tick()
    const claim = this.state.claims.find((c) => c.id === claimId)
    if (!claim || claim.status !== 'active') return { ok: false, detail: `claim ${claimId} 不存在或非 active` }
    if (claim.window?.status === 'open') return { ok: false, detail: '该论断已有进行中的对照窗口' }

    if (HIGH_RISK_LEXICON.test(claim.text)) {
      claim.riskLevel = 'high'
      this.dirty = true
      return { ok: false, detail: '风险分级：high（高风险词表命中）——高风险事项不参与对照窗口（设计债务⑤）' }
    }
    if (!claim.riskLevel) {
      // 惰性分级：LLM 打分，失败时保守判 medium（宁可不开窗，不可错开窗）
      try {
        claim.riskLevel = (await gradeClaimRisk(claim.text))?.risk ?? 'medium'
      } catch {
        claim.riskLevel = 'medium'
      }
      this.dirty = true
    }
    if (claim.riskLevel !== 'low') return { ok: false, detail: `风险分级：${claim.riskLevel}——仅 low 风险论断可进入对照窗口` }

    const startedAt = new Date().toISOString()
    const endsAt = new Date(Date.now() + Math.min(14, Math.max(2, days)) * 86400000).toISOString()
    claim.window = { startedAt, endsAt, status: 'open' }
    this.dirty = true
    return {
      ok: true,
      detail: `对照窗口开启：${startedAt.slice(0, 10)} → ${endsAt.slice(0, 10)}。窗口期内叙事上下文包会指示宿主不基于该论断干预；出现危机信号将立即中止。`,
      endsAt,
    }
  }

  /** 宿主上报一次基于论断的干预（内生标记 §5.3 之二）：窗口校验时剔除被催生的样本 */
  noteIntervention(claimId: string | undefined, text: string): boolean {
    this.state.interventions = [{ at: new Date().toISOString(), claimId, text }, ...(this.state.interventions ?? [])].slice(0, 50)
    this.dirty = true
    return true
  }

  /**
   * 窗口到期校验：只取窗口期内、非内生（未紧跟相关干预 48h）的干净碎片做反事实检验。
   * confirmed → 置信微升留版本；failed → 走反证修正（留痕）；证据不足 → inconclusive 关窗。
   */
  private async closeExpiredWindows(out: ReflectResult): Promise<void> {
    for (const claim of this.state.claims) {
      const w = claim.window
      if (!w || w.status !== 'open') continue
      if (new Date(w.endsAt).getTime() > Date.now()) continue

      const startMs = new Date(w.startedAt).getTime() - 86400000
      const endMs = new Date(w.endsAt).getTime()
      const inWindow = this.state.fragments.filter((f) => {
        const d = new Date(f.dateLabel).getTime()
        return !Number.isNaN(d) && d >= startMs && d <= endMs
      })
      // 内生剔除：紧跟相关干预（同 claimId，干预后 48h 内）的碎片不算干净证据
      const related = (this.state.interventions ?? []).filter((i) => i.claimId === claim.id)
      const isEndogenous = (f: Fragment) => related.some((i) => {
        const fd = new Date(f.dateLabel).getTime()
        const id = new Date(i.at).getTime()
        return !Number.isNaN(fd) && !Number.isNaN(id) && fd >= id - 86400000 && fd <= id + 2 * 86400000
      })
      const clean = inWindow.filter((f) => !isEndogenous(f))
      const excluded = inWindow.length - clean.length
      const cleanInfo = `干净碎片 ×${clean.length}，排除内生 ×${excluded}`

      let verdict: WindowVerdict | null = null
      try {
        verdict = await adjudicateWindowValidation(
          claim.text,
          clean.map(fragView),
          excluded,
        )
      } catch {
        // LLM 不可用 → 窗口保持 open，顺延到下轮反刍
      }
      if (!verdict) {
        out.skipped.push(`window ${claim.id}: LLM 不可用，顺延`)
        continue
      }

      if (verdict.verdict === 'confirmed') {
        const conviction = Math.min(0.9, Math.round((claim.conviction + 0.03) * 100) / 100)
        claim.versions.push({ at: todayStr(), text: claim.text, conviction, reason: `对照窗口：无干预期内成立（${cleanInfo}）` })
        claim.conviction = conviction
        claim.window = { ...w, status: 'confirmed', closedAt: new Date().toISOString(), note: `${cleanInfo}；${verdict.reason ?? ''}` }
        out.windowsConfirmed++
      } else if (verdict.verdict === 'failed') {
        const fragIds = new Set(this.state.fragments.map((f) => f.id))
        const hits = verdict.hits.filter((h) => fragIds.has(h.fragmentId))
        for (const h of hits) {
          claim.counterEvidence.push({
            fragmentId: h.fragmentId,
            text: `对照窗口反证（无干预期）：${h.why}`,
            resolution: '干净反事实证据命中——论断须修正（自我实现预言断路器 §5.3）',
          })
        }
        const revisedChanged = verdict.revised?.length >= 8 && verdict.revised !== claim.text
        let conviction = Math.min(0.9, Math.max(0.05, Number(verdict.conviction) || claim.conviction))
        if (!revisedChanged) conviction = Math.max(0.05, Math.min(conviction, claim.conviction - 0.03))
        conviction = Math.round(conviction * 100) / 100
        claim.versions.push({
          at: todayStr(), text: revisedChanged ? verdict.revised : claim.text, conviction,
          reason: `对照窗口反证 ×${hits.length}：${revisedChanged ? '论断加限定重写' : '反证被解释掉，置信小幅衰减'}`,
        })
        if (revisedChanged) {
          claim.text = verdict.revised
          claim.riskLevel = undefined
        }
        claim.conviction = conviction
        claim.window = { ...w, status: 'failed', closedAt: new Date().toISOString(), note: `${cleanInfo}；反证 ×${hits.length}` }
        out.windowsFailed++
      } else {
        claim.window = { ...w, status: 'inconclusive', closedAt: new Date().toISOString(), note: `干净证据不足（${cleanInfo}）` }
        out.windowsInconclusive++
      }
      this.dirty = true
    }
  }

  /* ---------- 盲推导审计（§5.2 渐进漂移对策 · 设计债务④ null model 基线） ---------- */

  /**
   * 盲推导 × k（默认 3）建立自然方差基线（null model）——当前认识层与各盲推导的
   * 最小分歧超过「基线 + 余量」才算漂移信号，否则审计系统自己虚警（债务④的核心）。
   * 全程不给判定模型看认识层当前版本：盲推导只拿原始碎片，信息不对称即审计本身。
   */
  async auditDrift(): Promise<AuditRecord> {
    const samples = Math.min(5, Math.max(2, Number(process.env.MUNINN_AUDIT_SAMPLES) || 3))
    const fragments = this.state.fragments.slice(0, 40).map(fragView)
    if (fragments.length === 0) throw new Error('碎片库为空，无从盲推导')

    const runs: BlindDerivation[] = []
    for (let i = 0; i < samples; i++) {
      const d = await blindDerive(fragments)
      if (d && d.claims.length > 0) runs.push(d)
    }
    if (runs.length < 2) throw new Error('盲推导样本不足（<2）')

    // null model：盲推导两两分歧 → 自然方差上界（取 max，保守面防虚警）
    // P2-3 修复：全配对 i<j，而非只配 runs[0]——避免 B、C 互相分歧大但都接近 A 时基线被低估
    const pairDivs: number[] = []
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const jd = await judgeDivergence(runs[i].claims, runs[j].claims)
        if (jd) pairDivs.push(jd.divergence)
      }
    }
    if (pairDivs.length === 0) throw new Error('分歧评估样本不足')
    const baseline = Math.max(...pairDivs)

    // 审计分歧：当前 active 论断 vs 每个盲推导，取最小值（对现行版本最宽容的一次比较）
    const current = this.state.claims
      .filter((c) => c.status === 'active')
      .map((c) => ({ text: c.text, conviction: c.conviction }))
    const auditDivs: number[] = []
    let notes: string[] = []
    for (const run of runs) {
      const jd = await judgeDivergence(current, run.claims)
      if (jd) {
        auditDivs.push(jd.divergence)
        if (jd.notes.length > 0) notes = jd.notes
      }
    }
    if (auditDivs.length === 0) throw new Error('审计分歧评估失败')
    const divergence = Math.min(...auditDivs)

    const record: AuditRecord = {
      ranAt: new Date().toISOString(),
      divergence: Math.round(divergence * 100) / 100,
      baseline: Math.round(baseline * 100) / 100,
      driftSignal: divergence > baseline + DRIFT_MARGIN,
      flaggedForUser: divergence >= DRIFT_FLAG_THRESHOLD,
      notes,
      sampleSize: runs.length,
    }
    this.state.audits = [record, ...(this.state.audits ?? [])].slice(0, 20)
    this.state.lastAuditAt = record.ranAt
    this.dirty = true
    return record
  }

  /**
   * merge 合并规则（§4.8）：open_question 重写概括；合成句整套重生成；
   * 龙脉值饱和式合并 1-(1-a)(1-b) + 一次性小额加成；情感权重按并集历史重算；
   * history 并集按时间重排；双方 → merged 终态，lineage 指向新线索。
   */
  private async mergeThreads(a: Thread, b: Thread, label: string, openQuestion: string, reason: string): Promise<void> {
    const seen = new Set<string>()
    const history = [...a.history, ...b.history]
      .filter((h) => { const k = `${h.fragmentId}@${h.note}`; if (seen.has(k)) return false; seen.add(k); return true })
      .sort((x, y) => y.day - x.day) // day 大在前（久远在前、最新在后，与 push 约定一致）

    const fragIds = new Set(history.map((h) => h.fragmentId))
    const frags = this.state.fragments.filter((f) => fragIds.has(f.id))
    const weight = frags.length > 0
      ? Number((frags.reduce((s, f) => s + f.vad.arousal, 0) / frags.length).toFixed(2))
      : Math.max(a.emotionalWeight, b.emotionalWeight)

    const m: Thread = {
      id: `t${this.state.threadSeq++}`,
      label,
      openQuestion,
      synthetic: {
        abstractFloor: [...new Set([...a.synthetic.abstractFloor, ...b.synthetic.abstractFloor])].slice(0, 4),
        concreteGuesses: [],
      },
      dragonVein: Math.min(1, 1 - (1 - a.dragonVein) * (1 - b.dragonVein) + 0.05),
      emotionalWeight: weight,
      history: [...history, {
        day: 0,
        fragmentId: history[history.length - 1]?.fragmentId ?? '',
        note: `merge：${a.label} × ${b.label} → ${label}（${reason}）`,
      }],
      status: 'unresolved',
      lineage: { parentIds: [a.id, b.id], childIds: [] },
      pool: 'ACTIVE',
      softLinks: [...a.softLinks, ...b.softLinks],
    }
    // 合成句整套重生成：合并可能打开两边都没想到的回收路径；失败时退化为并集
    try {
      const regen = await regenConcreteGuesses(
        { label, openQuestion, abstractFloor: m.synthetic.abstractFloor, existing: [...a.synthetic.concreteGuesses, ...b.synthetic.concreteGuesses] },
        history.slice(-4).map((h) => h.note),
      )
      m.synthetic.concreteGuesses = regen?.concreteGuesses ?? [...new Set([...a.synthetic.concreteGuesses, ...b.synthetic.concreteGuesses])].slice(0, 6)
    } catch {
      m.synthetic.concreteGuesses = [...new Set([...a.synthetic.concreteGuesses, ...b.synthetic.concreteGuesses])].slice(0, 6)
    }

    a.status = 'merged'
    a.pool = 'ARCHIVE'
    a.closureReason = `与「${b.label}」${reason}，并入「${label}」`
    b.status = 'merged'
    b.pool = 'ARCHIVE'
    b.closureReason = `与「${a.label}」${reason}，并入「${label}」`
    a.lineage.childIds.push(m.id)
    b.lineage.childIds.push(m.id)
    this.state.threads.unshift(m)
    this.dirty = true
  }

  /**
   * split 规则（§4.8）：分裂点前历史共享（按 LLM 分配的 fragmentIds 划分）；
   * 龙脉值与情感权重复制而非对半分；父线索 → superseded，lineage 指向两个子线索。
   * P2-2 修复：子线索合成句重生成（设计 §4.8「split 后合成句整套重生成」，与 merge 同规）。
   */
  private async splitThread(parent: Thread, children: { label: string; openQuestion: string; fragmentIds: string[] }[], reason: string): Promise<void> {
    for (const ch of children) {
      const id = `t${this.state.threadSeq++}`
      const history = parent.history.filter((h) => ch.fragmentIds.includes(h.fragmentId))
      const c: Thread = {
        id,
        label: ch.label,
        openQuestion: ch.openQuestion,
        synthetic: {
          abstractFloor: [...new Set([...parent.synthetic.abstractFloor, `一个悬置的状态迎来结局：${ch.openQuestion}`])].slice(0, 4),
          concreteGuesses: [...parent.synthetic.concreteGuesses],
        },
        dragonVein: parent.dragonVein,
        emotionalWeight: parent.emotionalWeight,
        history: [...history, {
          day: 0,
          fragmentId: history[history.length - 1]?.fragmentId ?? ch.fragmentIds[ch.fragmentIds.length - 1],
          note: `split：自「${parent.label}」分化（${reason}）`,
        }],
        status: 'unresolved',
        lineage: { parentIds: [parent.id], childIds: [] },
        pool: 'ACTIVE',
        softLinks: [],
      }
      parent.lineage.childIds.push(id)
      this.state.threads.unshift(c)
      // P2-2：子线索合成句重生成——分化后的回收条件不同，旧猜测不再适用
      try {
        const regen = await regenConcreteGuesses(
          { label: c.label, openQuestion: c.openQuestion, abstractFloor: c.synthetic.abstractFloor, existing: parent.synthetic.concreteGuesses },
          history.map((h) => h.note),
        )
        if (regen?.concreteGuesses.length) {
          c.synthetic.concreteGuesses = [...new Set([...parent.synthetic.concreteGuesses, ...regen.concreteGuesses])].slice(0, 6)
        }
      } catch {
        // LLM 不可用时保留父线索的 concreteGuesses（当前行为）
      }
    }
    parent.status = 'superseded'
    parent.pool = 'ARCHIVE'
    parent.closureReason = `${reason}——框架被 ${children.map((c) => `「${c.label}」`).join('与')} 取代`
    this.dirty = true
  }

  /* ---------- 检索：叙事上下文包 ---------- */

  // P1-2 修复：getContextPacket 是读操作，不再执行 tick()——
  // 高频读取不应触发龙脉衰减/降池/SILENT 入池；tick 只在写操作（ingest/reflect/counterCheck/startWindow）中执行
  getContextPacket(userId: string): ContextPacket {
    const today = todayStr()

    const threads = this.state.threads
      // SILENT 不参与日常召回（§4.5）：回避型高权重线索只在触发器唤醒后回到上下文
      .filter((t) => t.status === 'unresolved' && t.pool !== 'SILENT')
      .sort((a, b) => b.dragonVein - a.dragonVein)
      .slice(0, 8)
      .map((t) => ({
        id: t.id,
        label: t.label,
        openQuestion: t.openQuestion,
        pool: t.pool,
        daysOpen: t.history.length > 0 ? daysBetween(this.fragmentDate(t.history[0].fragmentId) ?? today, today) : 0,
        dragonVein: Number(t.dragonVein.toFixed(2)),
      }))

    const claims = this.state.claims
      .filter((c) => c.status === 'active')
      .sort((a, b) => b.conviction - a.conviction)
      .slice(0, 8)
      .map((c) => ({ id: c.id, text: c.text, conviction: c.conviction, boundary: c.boundary, status: c.status }))

    const recentFragments = this.state.fragments
      .slice(0, 5)
      .map((f) => ({ id: f.id, date: f.dateLabel, title: f.title }))

    // §5.4 可见性出口：分歧幅度过大直接标记等用户来看——注入宿主上下文，在对话中自然核对，
    // 不是把人叫来看 dashboard。警示会持续存在直到下一次审计刷新结果。
    const lastAudit = this.state.audits?.[0]
    const driftNote = lastAudit?.flaggedForUser
      ? `漂移警示：最近一次盲推导审计与当前认识层分歧 ${lastAudit.divergence}（自然方差基线 ${lastAudit.baseline}）——现行理解可能已渐进漂移。建议在合适的对话时机以邀请式措辞与用户核对（「我注意到我对你的理解最近有些对不上……」），不要当作既定结论引用。`
      : undefined

    // 对照窗口（§5.3 断路器三）：窗口期内请宿主勿基于该论断干预——引擎无法强制宿主，
    // 只能指令 + 内生标记自证（宿主干预请上报 /v1/intervene，校验时会剔除被催生样本）
    const openWindows = this.state.claims.filter((c) => c.status === 'active' && c.window?.status === 'open')
    const windowNote = openWindows.length > 0
      ? `对照窗口进行中（断路器）：以下论断正在接受无干预检验，请勿基于它们主动提醒、催促或建议（仅自然回应与观察），系统在为这些信念收集干净的反事实证据：${openWindows.map((c) => `「${c.text.slice(0, 30)}…」`).join('；')}。安全阀：若出现任何健康或安全风险信号，立即中止对照、正常干预——对照永远让位于用户福祉。`
      : undefined

    // 再提邀请（§5.4 债务⑦）：达门槛的 contested 观察，以邀请式措辞交宿主在合适时机提出
    // P2-4 修复：邀请 30 天后过期，不再注入上下文（防纠缠的反面——用户长期不回应就该停止提示）
    const rementions = this.state.claims.filter((c) => {
      if (c.status !== 'contested' || !c.rementionInvitation) return false
      const age = daysBetween(c.rementionInvitation.at.slice(0, 10), today)
      return age <= 30
    })
    const rementionNote = rementions.length > 0
      ? `可再提的观察（曾被本人否决，现已积累 ${rementions.map((c) => c.rementionInvitation!.newEvidenceIds.length).join('/')} 条独立新证据，达到再提门槛）：${rementions.map((c) => c.rementionInvitation!.text).join('；')}——请在容得下反驳的对话时机以邀请式措辞自然提出；若再次被否决，该观察将永久封存（防纠缠）。`
      : undefined

    return {
      userId,
      generatedAt: new Date().toISOString(),
      threads,
      claims,
      recentFragments,
      promptText: renderPromptText(threads, claims, recentFragments, driftNote, windowNote, rementionNote),
    }
  }

  private fragmentDate(id: string): string | null {
    return this.state.fragments.find((f) => f.id === id)?.dateLabel ?? null
  }
}

function renderPromptText(
  threads: ContextPacket['threads'],
  claims: ContextPacket['claims'],
  fragments: ContextPacket['recentFragments'],
  driftNote?: string,
  windowNote?: string,
  rementionNote?: string,
): string {
  const lines: string[] = ['【叙事上下文 · 雾尼 Muninn】']
  if (threads.length > 0) {
    lines.push('进行中的线索（悬置、等待闭合的问题）：')
    for (const t of threads) lines.push(`- 「${t.label}」${t.openQuestion}（已开放 ${t.daysOpen} 天，${t.pool}）`)
  }
  if (claims.length > 0) {
    lines.push('对用户的当前理解（随证据修正，括号为置信度）：')
    for (const c of claims) lines.push(`- ${c.text}（${c.conviction.toFixed(2)}）${c.boundary ? `｜边界：${c.boundary}` : ''}`)
  }
  if (fragments.length > 0) {
    lines.push('近期事件：')
    for (const f of fragments) lines.push(`- ${f.date} ${f.title}`)
  }
  if (windowNote) lines.push(windowNote)
  if (rementionNote) lines.push(rementionNote)
  if (driftNote) lines.push(driftNote)
  lines.push('说明：以上是关于用户的长期记忆组织，不是逐字历史；认知层内容可能已被新证据修正，请当作背景理解而非事实清单引用。')
  return lines.join('\n')
}
