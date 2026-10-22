/**
 * MCP server 工厂：工具注册的唯一事实来源。
 * stdio 入口（mcp.ts）与 HTTP 远程端点（http.ts 的 /mcp、/sse）共用。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { EngineManager } from './manager'
import * as Note from './services/notes'
import * as Stamp from './services/stamps'
import * as Journal from './services/journal'
import * as Soliloquy from './services/soliloquy'
import { isValidStampType } from '../shared/stamps'
import { generateJournalDraft } from '../visualizer/engine/llm'
import { listFragments, listFragmentsSchema, searchFragments, searchFragmentsSchema } from './services/fragments'

const TZ = process.env.MUNINN_TZ || 'Asia/Shanghai'
function todayStr(): string { return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }) }

export function createMcpServer(manager: EngineManager): McpServer {
  const server = new McpServer({ name: 'muninn-memory', version: '0.3.2' })

  server.registerTool(
    'memory_ingest',
    {
      description: '登记一条用户事件到叙事记忆引擎：建立碎片、与既有线索做碰撞判定（回收/推进/弱信号/新线索），状态持久化。',
      inputSchema: {
        userId: z.string().describe('用户标识，按用户隔离记忆'),
        text: z.string().describe('事件内容（用户原话或摘要）'),
        title: z.string().optional().describe('短标题，缺省取正文前 16 字'),
        tags: z.array(z.string()).optional().describe('情境标签'),
      },
    },
    async ({ userId, text, title, tags }) => {
      const result = await manager.get(userId).ingest(text, { title, tags })
      manager.persist(userId)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'memory_context',
    {
      description: '取该用户的叙事上下文包：进行中的线索、对用户的当前理解（带置信度）、近期事件。recentFragments 仅为最近 5 条事件窗口，不代表全部记忆；查询旧事先用 memory_search_fragments，逐页查账用 memory_list_fragments，不能因本窗口没有就断言遗忘。promptText 注入位置按接入形态选（两法等价）：多轮常驻宿主拼进本轮 user 消息头部（护住前缀缓存，参考 host-loop）；单轮无状态注入 system prompt 末尾即可。',
      inputSchema: { userId: z.string().describe('用户标识') },
    },
    async ({ userId }) => {
      const packet = manager.get(userId).getContextPacket(userId)
      manager.persist(userId)
      return { content: [{ type: 'text', text: JSON.stringify(packet, null, 2) }] }
    },
  )

  server.registerTool(
    'memory_list_fragments',
    {
      description: '按最新在前的存储顺序分页查看完整历史碎片，核实旧记忆是否仍在；返回原文与本人修正标注。默认排除影子碎片，includeShadow=true 可查情感层来源。',
      inputSchema: listFragmentsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const options = listFragmentsSchema.parse(input)
      const result = listFragments(manager.get(options.userId).getState().fragments, options)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'memory_search_fragments',
    {
      description: '查询该用户全部历史事实碎片（不限近期窗口）。支持中文、英文、日期与碎片 ID；无嵌入 key 时用 BM25，有 key 时加向量 RRF，失败降级。返回完整正文与本人修正；score 是排序分数而非事实置信度。未命中不代表记忆已删除，可改关键词或分页查账。',
      inputSchema: searchFragmentsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const { userId, query, k } = searchFragmentsSchema.parse(input)
      const result = await searchFragments(manager.get(userId).getState().fragments, query, k)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'memory_list_claims',
    {
      description: '列出认知层全部论断（含版本史与反证），记忆对用户默认全透明可见。',
      inputSchema: { userId: z.string().describe('用户标识') },
    },
    async ({ userId }) => {
      return { content: [{ type: 'text', text: JSON.stringify(manager.get(userId).listClaims(), null, 2) }] }
    },
  )

  server.registerTool(
    'memory_contest_claim',
    {
      description: '用户否决某条论断：不删除、不假改，降级为 contested 并记录用户的注记。诠释层用户有最终解释权。',
      inputSchema: {
        userId: z.string().describe('用户标识'),
        claimId: z.string().describe('论断 ID'),
        note: z.string().describe('用户的否决理由'),
      },
    },
    async ({ userId, claimId, note }) => {
      const ok = manager.get(userId).contestClaim(claimId, note)
      manager.persist(userId)
      return { content: [{ type: 'text', text: ok ? `claim ${claimId} 已标记为 contested` : `claim ${claimId} 不存在` }] }
    },
  )

  server.registerTool(
    'memory_reflect',
    {
      description: '触发反刍节律：从近期碎片抽取/改写认知层论断（证据锚定 + 版本史）、异源红队反证搜索、重生成被推进线索的合成句、执行 merge/split 判定，并自动生成当日日记与心迹。建议每天一次或在批量事件后调用。',
      inputSchema: { userId: z.string().describe('用户标识') },
    },
    async ({ userId }) => {
      const result = await manager.reflect(userId)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'memory_audit',
    {
      description: '盲推导审计：不给模型看当前认识层，只从原始碎片从零重推理解，与现行版本对照。多次盲推导建立自然方差基线（null model），超基线的分歧才算漂移信号；分歧过大时结果会标记 flaggedForUser 并出现在 memory_context 的警示里。建议低频调用（如每周一次）。',
      inputSchema: { userId: z.string().describe('用户标识') },
    },
    async ({ userId }) => {
      try {
        const result = await manager.get(userId).auditDrift()
        manager.persist(userId)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `审计失败：${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'memory_start_window',
    {
      description: '为一low风险论断开启对照窗口（自我实现预言断路器）：窗口期内请勿基于该论断对用户做任何提醒/催促/建议，系统将用无干预期的干净证据重新校验它。高风险论断（健康/安全相关）会被拒绝。窗口到期在 reflect 时自动校验。',
      inputSchema: {
        userId: z.string().describe('用户标识'),
        claimId: z.string().describe('论断 ID（memory_list_claims 可查）'),
        days: z.number().optional().describe('窗口天数（2-14，默认 7）'),
      },
    },
    async ({ userId, claimId, days }) => {
      const result = await manager.get(userId).startWindow(claimId, days ?? 7)
      manager.persist(userId)
      return { content: [{ type: 'text', text: result.detail }], isError: !result.ok }
    },
  )

  server.registerTool(
    'memory_note_intervention',
    {
      description: '上报一次你基于某论断对用户采取的干预（内生标记）：如基于「她拖延」提醒了 deadline。被干预催生的行为不算验证该论断的干净证据，对照窗口校验时会剔除干预后 48h 内的样本。v0.3.1：evidenceLevel=post_intervention 标记触达引擎产生的干预（reflect 会对干预前后窗口内的碎片做权重降级，防自强化回路）；outcome=user_engaged 且带 claimId 时消费对应 remention 邀请（不再重复注入上下文）。',
      inputSchema: {
        userId: z.string().describe('用户标识'),
        claimId: z.string().optional().describe('相关论断 ID（如有）'),
        text: z.string().describe('干预内容描述（做了什么）'),
        outcome: z.enum(['user_ignored', 'user_engaged', 'user_resolved', 'user_contested']).optional()
          .describe('用户对该干预的回应：user_ignored=未回应 / user_engaged=回应了内容（消费再提邀请）/ user_resolved=表示问题已解决 / user_contested=提出异议'),
        evidenceLevel: z.enum(['pre_intervention', 'post_intervention']).optional()
          .describe('证据层级：post_intervention = 触达引擎产生的干预（其前后窗口内碎片在 reflect 中权重降级）；缺省视为宿主基于认识层的主动干预（pre_intervention）'),
      },
    },
    async ({ userId, claimId, text, outcome, evidenceLevel }) => {
      const engine = manager.get(userId)
      const ok = engine.noteIntervention(claimId, text, outcome, evidenceLevel)
      manager.persist(userId)
      if (!ok) return { content: [{ type: 'text', text: '记录失败' }] }
      // v0.3.1 消费反馈：user_engaged + claimId 命中邀请时告知调用方，便于宿主闭环确认
      let redeemed = ''
      if (outcome === 'user_engaged' && claimId) {
        const inv = engine.getState().claims.find((c) => c.id === claimId)?.rementionInvitation
        if (inv?.status === 'redeemed') redeemed = '；对应 remention 邀请已兑现（redeemed），后续上下文不再注入'
      }
      const meta = [outcome && `outcome=${outcome}`, evidenceLevel && `evidenceLevel=${evidenceLevel}`].filter(Boolean).join('，')
      return { content: [{ type: 'text', text: `干预已记录（内生标记${meta ? `：${meta}` : ''}）${redeemed}` }] }
    },
  )

  server.registerTool(
    'memory_correct_fragment',
    {
      description: '事实层本人修正标注：用户指出某条事件记录有误时使用。原文永不改动（改了就是改写历史），只追加修正标注；此后所有判定都会看到修正后的事实（〔本人修正：…〕）。',
      inputSchema: {
        userId: z.string().describe('用户标识'),
        fragmentId: z.string().describe('碎片 ID'),
        note: z.string().describe('本人的修正说明（以用户口吻）'),
      },
    },
    async ({ userId, fragmentId, note }) => {
      const ok = manager.get(userId).correctFragment(fragmentId, note)
      manager.persist(userId)
      return { content: [{ type: 'text', text: ok ? '修正标注已追加，原文未改动' : `fragment ${fragmentId} 不存在` }], isError: !ok }
    },
  )

  server.registerTool(
    'memory_note_create',
    {
      description: '宿主为用户写入一条新便签（短消息/提醒/问候），旧便签自动归档。',
      inputSchema: { userId: z.string(), content: z.string() },
    },
    async ({ userId, content }) => {
      return { content: [{ type: 'text', text: JSON.stringify(Note.createNote(userId, content), null, 2) }] }
    },
  )

  server.registerTool(
    'memory_note_respond',
    {
      description: '用户对某条便签做出回应，回应内容作为影子碎片进入引擎视野。',
      inputSchema: { userId: z.string(), noteId: z.string(), text: z.string(), mood: z.string().optional() },
    },
    async ({ userId, noteId, text, mood }) => {
      const note = Note.respondNote(userId, noteId, text, mood, manager.get(userId))
      manager.persist(userId)
      return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }], isError: !note }
    },
  )

  server.registerTool(
    'memory_note_stamp',
    {
      description: '用户对某条便签盖印章，AI 回赠一颗玻璃珠并创建影子碎片。',
      inputSchema: { userId: z.string(), noteId: z.string(), type: z.string() },
    },
    async ({ userId, noteId, type }) => {
      if (!isValidStampType(type)) return { content: [{ type: 'text', text: '无效印章类型' }], isError: true }
      const n = Note.readNote(userId, noteId)
      if (!n) return { content: [{ type: 'text', text: '便签不存在' }], isError: true }
      const result = Stamp.stampNote(userId, noteId, n.content, type, manager.get(userId))
      if (!result) return { content: [{ type: 'text', text: '该便签已盖印，不可重复' }], isError: true }
      n.stamp = { type: result.record.type, beadType: result.record.beadType, beadName: result.jar.beadName, stampedAt: result.record.stampedAt }
      Note.saveNoteByPath(userId, n)
      manager.get(userId).setStamps(Stamp.loadStamps(userId))
      manager.persist(userId)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'memory_stamps',
    {
      description: '取用户印章记录与玻璃珠罐。',
      inputSchema: { userId: z.string() },
    },
    async ({ userId }) => {
      return { content: [{ type: 'text', text: JSON.stringify(Stamp.listStamps(userId), null, 2) }] }
    },
  )

  server.registerTool(
    'memory_journal_generate',
    {
      description: '触发生成今日日记（由 reflect 调用或手动触发）。',
      inputSchema: { userId: z.string() },
    },
    async ({ userId }) => {
      const date = todayStr()
      const state = manager.get(userId).getState()
      const fragmentsArg = state.fragments.filter((f) => f.dateLabel === date).map((f) => ({ title: f.title, body: f.body }))
      const threadsArg = state.threads.filter((t) => t.status === 'unresolved' && t.pool !== 'SILENT').map((t) => ({ label: t.label, openQuestion: t.openQuestion }))
      try {
        const journal = await generateJournalDraft(fragmentsArg, threadsArg)
        if (!journal?.content) return { content: [{ type: 'text', text: 'LLM 不可用，日记未生成（已有日记未被改动）' }], isError: true }
        const content = `# 日记 · ${date}\n\n${journal.content}`
        Journal.saveJournal(userId, date, content)
        return { content: [{ type: 'text', text: JSON.stringify({ date, content }, null, 2) }] }
      } catch {
        return { content: [{ type: 'text', text: 'LLM 不可用，日记未生成（已有日记未被改动）' }], isError: true }
      }
    },
  )

  return server
}
