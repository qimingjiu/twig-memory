/** Shared, side-effect-free retrieval primitives. Evaluation defaults stay unchanged. */
export interface Frag { id: string; date: string; text: string; tf: Map<string, number>; len: number }

export interface Retriever { (question: string, k: number): Frag[] }

export interface ScoredFrag { fragment: Frag; score: number }
export type Tokenizer = (text: string) => string[]

/** Runtime Chinese uses overlapping bigrams; retain the evaluation's English tokenizer. */
export function tokenizeRuntime(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens = tokenize(normalized)
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run]
    if (chars.length === 1) tokens.push(chars[0])
    else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

/** 分词（小写、去标点；BM25 的 IDF 会自然压低常用词权重，无需停用词表） */
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9']+/g)?.filter((t) => t.length > 1) ?? []
}

/**
 * 碎片库 → BM25 检索器（词法检索，无向量——embedding 到位后替换此函数即可，作答/判分管线不变）。
 * 微试点教训：字符重合度对英文长句无区分度（常见字母淹没关键词），5/8 失败全是检索未命中。
 */
export function buildRetriever(frags: Frag[]): Retriever {
  const retrieve = buildScoredRetriever(frags)
  return (question, k) => retrieve(question, k).map((hit) => hit.fragment)
}

/** Positive-score-only mode avoids presenting unrelated recent fragments as search hits. */
export function buildScoredRetriever(frags: Frag[], tokenizer: Tokenizer = tokenize, positiveOnly = false) {
  const N = Math.max(1, frags.length)
  const df = new Map<string, number>()
  for (const f of frags) for (const t of f.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLen = frags.reduce((s, f) => s + f.len, 0) / N
  const k1 = 1.5, b = 0.75

  return (question: string, k: number): ScoredFrag[] => {
    const qTokens = tokenizer(question)
    if (qTokens.length === 0) return positiveOnly ? [] : frags.slice(0, k).map((fragment) => ({ fragment, score: 0 }))
    const seen = new Set<string>()
    const qTerms = qTokens.filter((t) => { if (seen.has(t) || !df.has(t)) return false; seen.add(t); return true })
    return frags
      .map((f) => {
        let score = 0
        for (const t of qTerms) {
          const tf = f.tf.get(t) ?? 0
          if (tf === 0) continue
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
          score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * f.len) / (avgLen || 1)))
        }
        return { fragment: f, score }
      })
      .filter((hit) => !positiveOnly || hit.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, k)
  }
}

/* ---------------- 向量检索与融合（--embed · 设计文档 §4.4 检索层迁移） ---------------- */

/** 向量 top-k：embedTexts 已单位化，点积即 cosine */
export function topByVector(frags: Frag[], fragVecs: number[][], qVec: number[], k: number): Frag[] {
  return frags
    .map((f, i) => {
      const v = fragVecs[i]
      let s = 0
      for (let d = 0; d < qVec.length; d++) s += v[d] * qVec[d]
      return { f, s }
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.f)
}

/** RRF 融合：词法管精确词（人名/日期），向量管转述（语义鸿沟），两路互补 */
export function fuseRrf(bm25: Frag[], vec: Frag[], k: number, rrfK = 60): Frag[] {
  return fuseRrfScored(bm25, vec, k, rrfK).map((hit) => hit.fragment)
}

export function fuseRrfScored(bm25: Frag[], vec: Frag[], k: number, rrfK = 60): ScoredFrag[] {
  const acc = new Map<string, { f: Frag; s: number }>()
  const add = (list: Frag[]) => list.forEach((f, r) => {
    const e = acc.get(f.id) ?? { f, s: 0 }
    e.s += 1 / (rrfK + r + 1)
    acc.set(f.id, e)
  })
  add(bm25); add(vec)
  return [...acc.values()].sort((a, b) => b.s - a.s).slice(0, k).map((e) => ({ fragment: e.f, score: e.s }))
}
