# 雾尼 Muninn · 服务端接入层

把叙事记忆引擎从浏览器 demo 变成可长期运行的服务。旧 demo 页面已从仓库移除，
存档于 `D:/kimi/workspace/muninn-old-demo`。这里复用 `server/core.ts` 中的无头引擎与 LLM 判定函数（单一事实来源），
外加真实持久化的 HTTP/MCP 服务。

```
server/
  core.ts       HeadlessMuninn：碎片/线索/认知三层状态机 + 碰撞判定 + SILENT 池 + 反刍节律（reflect）+ 叙事上下文包
  store.ts      JSON 文件持久化（每用户一文件，tmp+rename 原子写；可换 SQLite/Postgres）
  manager.ts    多用户引擎管理：按需加载、变更落盘
  llm-node.ts   Node 端直连 Moonshot（注入到 visualizer/engine/llm 的传输层）
  embed-node.ts 硅基流动嵌入 + 磁盘缓存（碰撞候选向量召回、评测混合检索）
  retrieval.ts  评测/运行时共享的纯检索原语（BM25 / 向量排序 / RRF）
  services/fragments.ts 历史碎片分页与查询（MCP / HTTP 共用）
  http.ts       HTTP API（零依赖 node:http）+ 远程 MCP 端点
  mcp.ts        MCP server（stdio，Codex / Claude Code 等可直接挂载）
  host-loop.ts  参考宿主闭环（/v1/chat）：注入上下文包 → 作答 → 自动 ingest
  services/     情感层服务：journal / soliloquy / notes / stamps（只读于引擎；
                用户回应经影子碎片 + ContextAnchor 进入引擎视野）
```

## 快速开始

```bash
npm install
npm run server:http          # http://localhost:7300
```

可选：启用实时 LLM 判定（无 key 时自动回退规则判定，全部功能仍可用）：

```bash
# .env.local 或环境变量
KIMI_API_KEY=sk-你的-Moonshot-API-Key
# 主模型缺省 kimi-k2.6（现役）；换供应商须三件套同改：MUNINN_BASE_URL + MUNINN_API_KEY + MUNINN_MODEL
# MUNINN_MODEL=deepseek-v4-flash   # 例：DeepSeek 官方（MUNINN_BASE_URL=https://api.deepseek.com）
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/ingest` | `{ userId, text, title?, tags?[] }` 登记事件并做碰撞判定 |
| GET | `/v1/context?userId=` | 叙事上下文包；`promptText` 注入位置按接入形态选（两法等价），见下文「宿主 agent 的典型接法」 |
| GET | `/v1/fragments?userId=&page=1&limit=50&includeShadow=false` | 历史碎片分页，最新在前；limit 上限 500，默认排除影子碎片 |
| GET | `/v1/search?userId=&q=&k=8` | 全部非影子碎片检索，k 上限 20；BM25 / 向量 RRF，返回完整正文与修正 |
| GET | `/v1/state?userId=` | 完整三层状态（调试/可视化用；支持 `page`/`limit` 对碎片分页） |
| GET | `/v1/claims?userId=` | 认知层论断列表（用户默认全透明可见） |
| POST | `/v1/contest` | `{ userId, claimId, note }` 用户否决 → contested（不删除、不假改） |
| POST | `/v1/counter` | `{ userId, claimId, text }` 矛盾响应判定（LLM，需 key） |
| POST | `/v1/reflect` | `{ userId }` 反刍：认识层抽取/改写 + 反证搜索（异源红队）+ 合成句重生成 + merge/split（LLM，需 key） |
| POST | `/v1/audit` | `{ userId }` 盲推导审计：null model 基线 + 漂移信号 + 用户可见标记（LLM，需 key；结果落盘保留最近 20 条） |
| GET | `/v1/audit/last?userId=` | 最近一次审计记录（无则 `null`；仪表盘/设置页用） |
| GET | `/v1/storage` | 数据目录存储占用，按顶层条目聚合（设置页状态仪表用） |
| POST | `/v1/window` | `{ userId, claimId, days? }` 开启对照窗口（仅 low 风险论断；设计债务⑤） |
| POST | `/v1/intervene` | `{ userId, claimId?, text, outcome?, evidenceLevel? }` 宿主上报干预（内生标记，窗口校验时剔除被催生样本；v0.3.1：`outcome=user_engaged` + `claimId` 消费对应 remention 邀请，`evidenceLevel=post_intervention` 触发 reflect 中的碎片权重降级） |
| POST | `/v1/correct` | `{ userId, fragmentId, note }` 事实层本人修正标注：原文不动，追加标注（债务⑥） |
| POST | `/v1/chat` | `{ userId, text }` 参考宿主闭环：注入叙事上下文包 → 作答 → 代码自动 ingest（`server/host-loop.ts`；会话历史进程内缓冲，不落盘） |
| GET | `/health` | 服务与判定模式（`llm`: live / heuristic-only；`embed`: vector-recall / dragonvein-only；`auth`: 是否启用令牌） |

### 情感层与新前端 API（日记 / 心迹 / 便签 / 印章）

**情感层只读于引擎**：引擎的 `ingest` / `reflect` 不直接读写 journal/soliloquy/notes/stamps
目录；用户对便签的回应与盖印经**影子碎片 + ContextAnchor** 进入引擎视野（影子碎片不参与
碰撞/线索登记/认识抽取/向量召回），设计与数据模型见
[docs/新前端技术设计文档-v1.0.md](../docs/新前端技术设计文档-v1.0.md)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/journal?userId=&date=` | 某日日记（缺省今日） |
| GET | `/v1/journal/range?userId=&from=&to=` | 日期范围内有日记的日子列表（日历用） |
| POST | `/v1/journal/generate` | `{ userId, date? }` 基于当日碎片与活跃线索生成日记（LLM，需 key；失败不覆盖已有日记） |
| GET | `/v1/journal/export?userId=&format=` | 导出全部日记，`format=md`（默认，text/markdown）或 `json` |
| GET | `/v1/soliloquy?userId=&date=` | 某日心迹 |
| GET | `/v1/soliloquy/recent?userId=&limit=` | 最近心迹（默认 7 条） |
| GET | `/v1/soliloquy/export?userId=&format=` | 导出全部心迹，格式同上 |
| GET | `/v1/notes/current?userId=` | 当前应展示便签 + `shouldPopup`（23:00–06:00 未读弹窗信号） |
| GET | `/v1/notes?userId=&page=&limit=` | 便签历史列表（默认每页 20） |
| GET | `/v1/notes/:id?userId=` | 单条便签 |
| POST | `/v1/notes` | `{ userId, content }` 宿主写入便签 |
| POST | `/v1/notes/generate` | `{ userId, date? }` 基于当日碎片与活跃线索生成便签（LLM，需 key） |
| POST | `/v1/notes/:id/read` | 标记已读（也接受 PATCH） |
| POST | `/v1/notes/:id/respond` | `{ userId, text, mood? }` 用户回应：自动建影子碎片（便签原文）+ 回应带 contextAnchor 入引擎 |
| POST | `/v1/notes/:id/stamp` | `{ userId, type, userNote? }` 盖印：印章候选池选珠 + 影子碎片；一签一章，重复返回 409 |
| GET | `/v1/stamps?userId=` | 全部盖印记录 + 玻璃珠罐 |
| GET | `/v1/stamps/recent?userId=&limit=` | 最近 N 条盖印（默认 7，注入上下文用） |
| GET | `/v1/calendar?userId=&month=YYYY-MM` | 月历标记：哪些日子有日记/心迹/便签/印章 |
| GET | `/v1/threads/:id/timeline?userId=` | 单条线索生命周期时间线（事件 + 对应碎片） |

印章类型（8 章）与玻璃珠（12 珠）注册表见 `shared/stamps.ts`，前后端共用。

新增可选环境变量（2026-08-23~26）：`MUNINN_TZ`（时区，默认 `Asia/Shanghai`，影响碎片日期
标签与天数计算）、`MUNINN_CORS_ORIGIN`（CORS 允许源，默认 `*`，生产建议设为具体域名）、
`MUNINN_RATE_LIMIT`（每用户每分钟请求上限，默认 0 = 不限）、`MUNINN_AUTO_REFLECT=1`
（进程内定时反刍，仅覆盖已加载用户）+ `MUNINN_REFLECT_INTERVAL_HOURS`（间隔，默认 24）。

## 远程 MCP（手机 App / 任意 MCP 客户端，无需装依赖）

`server:http` 启动后同时暴露两个远程 MCP 端点：

| 端点 | 传输 | 适用 |
|---|---|---|
| `/mcp` | Streamable HTTP | 新客户端优先（RikkaHub / Kelivo 新版等） |
| `/sse` | 旧版 SSE | 只支持 SSE 的客户端兜底 |

手机 App（RikkaHub、Kelivo、Operit 等）里添加「远程 MCP 服务器」，填：

```
URL:  https://你的域名/mcp        # 连不上就换 https://你的域名/sse
请求头: Authorization: Bearer 你的MUNINN_AUTH_TOKEN
```

手机上不需要安装任何东西——Node、tsx、依赖全部在服务器上。

## MCP 接入（本机桌面 agent，stdio）

```bash
npm run server:mcp
```

Codex `config.toml` 示例：

```toml
[mcp_servers.muninn]
command = "npx"
args = ["tsx", "D:/kimi/workspace/muninn/server/mcp.ts"]
# env = { KIMI_API_KEY = "sk-..." }
```

工具：`memory_ingest` / `memory_context` / `memory_list_fragments` / `memory_search_fragments` / `memory_list_claims` / `memory_contest_claim` / `memory_reflect` / `memory_audit` / `memory_start_window` / `memory_note_intervention` / `memory_correct_fragment`。

## 历史碎片查询（v0.3.2）

`memory_context.recentFragments` 只展示最近 5 条非影子事件，线索/论断也只是有界摘要，不能据此判断旧事丢失。用户问起过去的事实时，宿主应先查询历史；若未命中，换关键词或逐页查账，不要把一次未命中当作遗忘。

```json
{"name":"memory_search_fragments","arguments":{"userId":"你的用户ID","query":"换电脑","k":8}}
{"name":"memory_list_fragments","arguments":{"userId":"你的用户ID","page":1,"limit":50}}
```

- 分页返回 `{ fragments, totalFragments, page, limit }`，顺序为存储序（最新在前）；总数与 `includeShadow` 过滤一致。每条含 `id/date/title/body/threadIds/correction?`，正文保留原文，修正单独附带。
- 检索返回 `{ hits, mode, degradedReason? }`；每条含 `id/date/title/body/threadIds/correction?/score`。检索与返回的完整正文包含 `〔本人修正：…〕`，避免只召回已被本人更正的旧说法。`score` 是排序分数，不是事实置信度；BM25 与 RRF 分数不跨模式比较。
- 中文使用相邻双字分词，英文、日期和碎片 ID 可直接查询。无嵌入 key 时零外部 API 调用；词法零命中返回空数组。检索不改写、衰减、删除或唤醒任何记忆/线索。
- 已配置 `SF_API_KEY` / `SILICONFLOW_API_KEY` 时默认启用向量 RRF，沿用 `MUNINN_EMBED_MODEL` 与 `MUNINN_EMBED_CACHE`。重复的同模型文本/查询命中磁盘缓存；新增文本、修正或换模型会产生新的嵌入。首次大库构建可能超时，已完成的批次会保留缓存，下次查询继续补齐。向量路总预算 10 秒、无重试；失败返回 BM25 并带 `degradedReason=embeddings_unavailable`。
- `MUNINN_SEARCH_EMBED=0` 可强制词法查询，不影响引擎原有碰撞候选向量召回。运行时不自动调用 HyDE/LLM；评测的查询扩写管线保持原样，不能把评测分数直接当作运行时召回率。
- 查询参数校验两端一致：`userId/query` 不得为空，query 最长 2000 字符，page/limit/k 为范围内正整数。HTTP 的 `includeShadow` 只接受 `true` / `false`。

升级：在既有服务代码目录执行 `git pull --ff-only`，按原部署方式重启（容器部署需重新构建镜像），然后在手机 MCP 客户端断开并重连，确认工具列表出现上述两个工具。状态 JSON **格式不变、无需迁移**。挂载卷保持原路径。

本修复提供历史访问入口；仅注入 `/v1/context` 的自定义宿主仍需接入 `/v1/search` 或新 MCP 工具，`/v1/chat` 参考闭环不会自动扩展为完整历史检索。

离线验收：

```bash
npm run test:recall
npm run typecheck:server
MUNINN_TZ=UTC npx tsx server/dev-smoke.ts  # 旧 smoke fixture 使用 UTC 日期
```

## 部署到 Zeabur（作为记忆后端）

仓库根目录已带 `Dockerfile`，Zeabur 会自动识别：

1. 把仓库推到 GitHub，Zeabur 控制台 → Create Service → Git → 选仓库，自动构建。
2. 配置环境变量：
   - `MUNINN_AUTH_TOKEN`（强烈建议）：所有 API / MCP 请求的 Bearer 令牌
   - `KIMI_API_KEY`（可选）：启用实时 LLM 判定，不配则规则判定兜底
   - `MUNINN_DATA_DIR`：默认镜像内已设为 `/data`
   - `SF_API_KEY`（可选）：碰撞候选向量召回（硅基流动嵌入）；建议同时设 `MUNINN_EMBED_CACHE=/data/embed-cache.json` 让缓存随卷持久
3. **挂卷**：Zeabur 服务 → Volumes → 挂载一个卷到 `/data`，
   否则容器重启后记忆数据会丢（当前持久化是 JSON 文件）。
4. 绑定域名（Networking → Generate Domain），得到 `https://xxx.zeabur.app`。
5. 验证：`GET https://xxx.zeabur.app/health` 应返回 `{"ok":true,...}`。

其他平台（Railway / Render / 自有 VPS）同样适用：只要支持 Dockerfile + 注入 `PORT` 即可。

> **承重安全组件**：危机协议（危机词表命中 → 立即中止全部对照窗口 + 窗口安全阀指令）是无开关的无条件代码路径，全文见 [docs/CRISIS-PROTOCOL.md](../docs/CRISIS-PROTOCOL.md)。**裁剪它等于拆除承重安全组件**；按命名惯例（[docs/COMPLIANCE.md](../docs/COMPLIANCE.md) 附则），移除了危机协议的部署不得自称基于雾尼 / 衔枝。

## 宿主 agent 的典型接法

1. 每轮对话结束后，把用户新表达的事实/状态变化 `memory_ingest` 给引擎。
2. 每轮对话开始前（或定期）取 `memory_context`，把 `promptText` 按接入形态注入（两法等价，按有没有跨轮历史要保护选）：
   - **多轮常驻宿主**（host-loop / 长期接入）：拼进**本轮 user 消息头部**——system 只留稳定
     人设、会话历史 append-only 且只存原文，变动块固定在末尾，前缀缓存跨轮命中
     （参考实现 `server/host-loop.ts`）；
   - **单轮无状态**（cron+curl、每次全新会话）：没有历史可保护，注入 system prompt 末尾即可。
   拿到的是「叙事上下文包」：进行中的线索 + 当前理解（带置信度）+ 近期事件，不是 top-k 卡片。
3. 用户要求查看/更正记忆时，用 `memory_list_claims` / `memory_contest_claim`。
4. 每天一次（或批量事件后）调用 `memory_reflect` / `POST /v1/reflect` 反刍：
   认知层自动抽取/改写（带证据锚定与版本史）、异源红队反证搜索、被推进线索的合成句重生成、merge/split 判定。
   SILENT 池无需反刍——入池在 tick 内自动判定，唤醒由 ingest 时的触发器检测完成。
5. 低频调用 `memory_audit` / `POST /v1/audit` 做盲推导审计（reflect 也会按
   `MUNINN_AUDIT_INTERVAL_DAYS`，默认 7 天，自动附带一次）。
6. 自我实现预言防护：你基于某条论断对用户采取了干预（提醒/催促/建议）后，
   `memory_note_intervention` 上报一次（内生标记）；可为 low 风险论断开
   `memory_start_window` 对照窗口——窗口期内 `promptText` 会指示你**不要**基于
   该论断干预，窗口到期由 reflect 自动校验（详见下节）。
   v0.3.1：触达引擎产生的干预请带 `evidenceLevel=post_intervention`（其前后
   窗口内的碎片会在 reflect 中权重降级，防自强化回路）；用户回应了再提邀请后
   补报 `outcome=user_engaged`（带 claimId），对应邀请即被消费、不再重复注入
   上下文（`outcome` 还支持 `user_ignored` / `user_resolved` / `user_contested`）。

## 行为要点（SILENT 池，§4.5）

- **入池**（自动）：线索曾活跃（≥2 次事件）、情感权重 ≥0.7、≥21 天无推进且存在 ≥45 天 → 推入 SILENT，跳过龙脉衰减（不因沉默降权）。
- **隔离**：SILENT 线索不参与碰撞候选（LLM 与规则路径一致）、不出现在叙事上下文包中。
- **唤醒**：主碰撞无命中时做一次唤醒判定（LLM 优先，字符重合 ≥0.5 兜底），命中即回 ACTIVE 并记入事件历史。
- 已知近似：设计文档的三信号（骤停 + 高情感 + 话题转移）中，话题转移无法从碎片层观测，
  以保守条件接受虚警率（设计债务②）。

## 反证搜索（§5.2 确认偏误对策 · 设计债务③）

`/v1/reflect` 内置异源反证搜索，对每条 active 论断（被挑战次数少者优先，上限 5 条/轮）：

1. **红队攻击**：以「检察官」persona + 温度 0.8 生成反面假设（论断在什么情形下会是错的），并按 HyDE 反用从近 40 条碎片中选出支持反面假设或直接反驳论断的证据——与论断作者（认识层 persona、温度 0.3）刻意异源。找不到反证就诚实空手而归，不许硬凑。
2. **强制裁决留痕**：每条命中反证必须被显式回应——推翻 / 加限定 / 写明为什么不足以推翻，说明写入 `counterEvidence`，不许悄悄吞掉。
3. **防教条化**：反证全部被「解释掉」时，代码强制置信度小幅衰减（-0.03，不信任 LLM 自律）；论断未改动也留版本记录，衰减可审计。

异源配置：默认同模型 persona+温度异源；设置 `MUNINN_ADVERSARY_MODEL`（如 `deepseek-v4-flash`，跨供应商真异源）
可让红队用第二模型，实现真正的模型异源。这是设计债务③的**缓解而非根治**——同源数据下
的自我对抗天花板依然存在，已写进局限性。

## 盲推导审计（§5.2 渐进漂移对策 · 设计债务④ null model）

`POST /v1/audit` / MCP `memory_audit` / reflect 内定期自动触发（默认 7 天一次，系统排程，
不等用户发起——人和系统活在同一套缓慢扭曲的叙事里时，双方都不会觉得有必要审计）：

1. **盲推导**：不给模型看认识层当前版本，只给原始碎片（近 40 条），从零重新生成理解。
   盲推导不继承现行理解里的渐进漂移——信息不对称即审计本身。
2. **null model 基线（债务④的核心）**：盲推导抽样 k 次（`MUNINN_AUDIT_SAMPLES`，默认 3），
   两两分歧取最大值作为自然方差上界。**当前认识层与各盲推导的最小分歧（对现行版本最
   宽容的一次比较）超过「基线 + 0.15」才算漂移信号**——否则审计系统自己虚警。
3. **用户可见标记（§5.4 可见性出口）**：分歧幅度本身是独立信号——绝对分歧 ≥0.6 时
   `flaggedForUser` 置位，并在叙事上下文包（`promptText`）注入邀请式核对提示
   （「我注意到我对你的理解最近有些对不上……」），让宿主在对话中自然浮出，直到下一次
   审计刷新。审计历史（最近 20 条）存于 state，全量对用户透明。

已知边界：分歧评估与盲推导同用 Moonshot 模型，judge 噪声由「取最小分歧 + max 基线 + 0.15
余量」三重保守面吸收；漂移定位（按历史版本时间戳二分重建碎片子集比对）未实现，当前只有
检测与标记，不定位漂移发生点。

## 对照窗口（§5.3 自我实现预言断路器 · 设计债务⑤ 风险分级）

打破「认识影响回复、回复影响行为、行为反过来『验证』认识」的闭环——给系统自己的信念
留一次干净的反事实检验：

1. **开窗**（`POST /v1/window` / MCP `memory_start_window`）：选定一条论断，窗口期内
   （2-14 天，默认 7）系统不基于它干预。**叙事上下文包会注入「请勿基于该论断主动提醒/
   催促/建议」的指令**——引擎无法强制宿主，只能指令 + 内生标记自证（宿主干预请上报
   `/v1/intervene`）。
2. **风险分级（债务⑤的核心）**：高风险事项永不参与对照——「明知可能受伤也不提醒」
   的伦理代价不可接受。双重分级：高风险词表（医院/失眠/自杀/债务等，命中即拒，不经
   LLM，fail-safe）+ LLM 分级兜底（LLM 不可用时保守判 medium 拒绝）。仅 `low` 可开窗。
3. **内生标记**：宿主每上报一次干预，窗口校验时剔除干预后 48h 内被催生的碎片样本
   （被催三次才交，证明的是催促起了作用，不是论断本身）。
4. **危机中止阀**：窗口期内 ingest 命中危机信号词（自杀/自残/不想活等）→ 立即中止
   全部对照窗口、恢复正常干预——对照永远让位于用户福祉，写在架构里。
5. **到期校验**（reflect 自动）：只用窗口期内干净碎片判定——confirmed → 置信微升
   （+0.03）留版本；failed → 反证留痕（「对照窗口反证」）+ 加限定重写或强制降置信；
   证据不足 → inconclusive 关窗不改动。LLM 不可用时窗口顺延，不误判。
6. **自动开窗**：默认关闭；`MUNINN_AUTO_WINDOW=1` 时 reflect 自动为从未进过窗口的
   最高置信 low 风险论断开窗（最 load-bearing 的信念优先过堂）。

已知边界：窗口指令依赖宿主自觉遵守 + 干预上报的诚实性（架构边界，引擎在宿主外部）；
风险词表是保守近似，宁拒开窗不冒险。

## 修正标注与再提门槛（§5.4 · 设计债务⑥⑦）

**事实层本人修正（债务⑥）**：`POST /v1/correct` / MCP `memory_correct_fragment`。
碎片原文永不改动（改了就是改写历史），只追加 `correction` 标注；所有 LLM 判定
（认识层抽取、红队反证、盲推导、窗口校验、再提判定）经统一的碎片视图看到
`〔本人修正：…〕`——判定基于修正后的事实，历史保留原始记录。

**contested 再提（债务⑦，量化）**：`contestClaim` 每次否决累积计数 + 旧证据快照；
再提必须同时满足三个条件，缺一不可：

1. **独立新证据 ≥3 条**（高于创建门槛的 2）：否决日之后入库、不在旧证据快照内、
   且经独立证据判定确认能单独支撑该论断的碎片；
2. **冷却 14 天**：否决后至少两周内绝不再提；
3. **邀请式措辞**：达门槛后由再提议草模块生成邀请文本（「我最近又注意到……是我理
   解错了吗？」），注入叙事上下文包，由宿主在容得下反驳的对话时机提出——不是
   重申式断言。

**防打地鼠（双重设防）**：认识层抽取的输入包含被否决清单（prompt 约束不得基于原
证据重新生成相近观察）+ 代码硬守卫（create 操作的证据全部落在某条被否决论断的旧
证据快照内 → 直接拒绝）。

**防纠缠（两否封存）**：同一条论断被否决 2 次即永久退出再提通道，无论后续证据多
少；每次新否决都会使既有邀请作废、冷却期重置。

## 评测：冲突响应测试集（§6.2 · 设计债务⑧）

```bash
npx tsx server/eval-counter.ts             # 22 例全量（真实 LLM，读 .env.local）
npx tsx server/eval-counter.ts --limit 4   # 调试子集
npx tsx server/eval-counter.ts --judge     # 追加独立 LLM 盲评
```

构造规范（`server/eval-counter.ts` 即规范的可执行形式）：场景类型学 4 类
（事实冲突/偏好反转/能力变化/关系变化）× 5 例 + 无冲突负例 × 2，共 22 例。
盲评流程：评分只看**结构化状态迁移**（发现冲突 / 降低置信 / 修改认识或留痕），
由代码机械判定，期望值不出现在任何被测模型可见的上下文——杜绝「你出题你答题」；
过程评测不判「改得对不对」。传输层带 429 指数退避，跑批不会被限流打断。

基线（moonshot-v1-8k，2026-08）：**22/22（100%）**，冲突场景平均置信下调 0.11-0.25。
第一轮曾发现负例误报（日常琐事被过度解读为冲突），已在判定 prompt 中加防过度解读
约束后修复——评测集的第一笔真实产出。

## 评测：LoCoMo 事实底盘基线（§6.4 · 设计债务⑨）

```bash
# 数据（2.8MB，一次性）
curl -sL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json \
  -o server/eval-data/locomo10.json

npx tsx server/eval-locomo.ts --convos 10          # 全量 1986 题
npx tsx server/eval-locomo.ts --convos 1           # 单会话子集（~200 题）
npx tsx server/eval-locomo.ts --convos 1 --cats 4 --limit 10   # 微试点
npx tsx server/eval-locomo.ts --no-hyde            # 关闭 HyDE 扩查询（消融对照）
npx tsx server/eval-locomo.ts --embed --k 15       # 混合检索：BM25 + 硅基流动向量 RRF 融合
```

`--embed` 需要在 `.env.local` 加 `SF_API_KEY=sk-...`（可选 `MUNINN_EMBED_MODEL`，默认 `BAAI/bge-m3`）；
嵌入按 `model:sha1(text)` 磁盘缓存（`eval-data/embed-cache.json`），重跑只付一次钱。
作答/判分模型经 `MUNINN_API_KEY` / `MUNINN_BASE_URL` / `MUNINN_MODEL` 切换（任意 OpenAI 兼容方）。

管线定位：**事实底盘 = 碎片层 + 检索**（LoCoMo 测「记不记得」，不测「理解了吗」，
与叙事层评测分工）。全部轮次直灌碎片库（零 LLM）→ 每题检索 top-k → LLM 仅凭检索
碎片作答（检索不到就拒答）→ 独立 LLM 判分（adversarial 用「正确拒答才算对」判据）。

检索 = **BM25 词元 + BGE-M3 向量 RRF 混合 + HyDE 批量扩查询**（问题先改写成假想证据碎片再检索，弥合转述鸿沟；`--embed` 开关向量路，默认纯 BM25；向量经 `embed-node.ts` 走硅基流动 embeddings API）。
及格线 = mem0 基线 × 90%（参照 arXiv:2604.04853 Table 11，LLM-judge，adversarial 单列）：
single-hop ≥.604 / temporal ≥.500 / multi-hop ≥.460 / open-domain ≥.656 / 总分 ≥.602。

**历史锚点 · M3 时代口径（2026-08-17，k=15，BM25+向量 RRF + HyDE，嵌入 BGE-M3 经硅基流动，作答/判分 MiniMax M3 官方 API 直连；不可与 v0.2.0 口径混引）**：
1986 题零批调用失败——single-hop **0.800** / temporal **0.726** / multi-hop **0.504** / open-domain 0.531 / adversarial 0.843（单列不计入）；
**总分 0.640**，双口径过线（四类及格线宏平均 0.5551、文档总分口径 0.602），高于 mem0 参照宏平均 0.617。
open-domain（0.531 vs 0.729）为已知短板，差在跨碎片推断，已立项为下一靶子。
mem0 数值为论文参照值、非同场裁判；对照结论以「参照口径」表述。

**全量基线 v0.2.0（2026-09-10，r3 续跑卷，k=15，BM25+向量 RRF + HyDE，嵌入 BGE-M3 经硅基流动，作答/判分 glm-5-3-260801 火山方舟 Agent Plan `/api/plan/v3`）**：
1986 题零单题尸体（前 3 会话经 `--resume` 从增量快照继承，conv-42 断网咬伤后剔除重跑，明细含 `resumedFrom` 溯源）——
single-hop **0.838** / temporal **0.738** / multi-hop **0.539** / open-domain 0.563（仍未过线 0.656）/ adversarial 0.740（单列不计入；较 M3 基线 0.843 回落，疑与模型拒陷阱风格差异及末次低推理刹车偏好作答有关，待立项复查）；
**总分 0.6695**，及格线 0.6019（文档总分口径）→ **PASS**，高于 mem0 参照宏平均 0.617。
明细：`server/eval-data/locomo-result-1789082385558.json`（force-added，gitignored 目录破例入库）。
查卷附注：adversarial 回落逐题定责为答题侧贪答（116/116 断言式作答、拒答判 0 为 0 道，judge 判据机械无口味问题），疑「would/likely 优先推断」条款对陷阱题误放行，待立项；open-domain 42 错中 20 拒答（「老实人税」叙事不变）；expand 唯一批失败（content_filter，conv-42 #230–239）受影响 10 题全在分母、零尸体。前 3 会话经 `--resume` 继承、conv-42 剔除断网咬伤后重跑，成绩跑于焊死前同一内容工作区，补丁内容与 commit `6e7118f` 一致。

限流注意：LoCoMo 的 prompt 远大于冲突评测，免费档 TPM 很容易撞墙。管线已做三重防护
（传输层 429 指数退避、批处理 10/5/5、批级二次重试），`--pace`（默认 12 秒）可再调慢；
批调用失败数会在结果尾部如实上报（expand 失败只损失 HyDE 增量，answer/judge 失败
计 0 分并在明细中留 `__LLM_FAILED__`）。

检索诊断（零 LLM，金标证据命中率）：`buildRetriever` 为纯函数，可直接对
`qa.evidence` 做命中率分析——BM25 top-8 证据命中 single-hop 约 54-60%，
是当前事实底盘的主要瓶颈（转述鸿沟），HyDE 即为此而设。

## 评测：LongMemEval 长程记忆基线（ICLR 2025）

```bash
# 数据（oracle ~15MB / s ~265MB，一次性；HuggingFace 连不上用 hf-mirror.com）
curl.exe -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json \
  -o server/eval-data/longmemeval_oracle.json
curl.exe -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json \
  -o server/eval-data/longmemeval_s_cleaned.json

npx tsx server/eval-longmemeval.ts --data oracle --limit 10                              # 微试点
npx tsx server/eval-longmemeval.ts --data s --embed --k 15                               # 标准 500 题 + 混合检索
npx tsx server/eval-longmemeval.ts --data s --limit 50 --types single-session-user       # 按题型子集
npx tsx server/eval-longmemeval.ts --data oracle --offset 54 --limit 6                  # 跳到 abstention 题
npx tsx server/eval-longmemeval.ts --data s --no-hyde                                    # 消融：关闭 HyDE
```

数据（xiaowu0162/longmemeval-cleaned，ICLR 2025）三个文件：
- `oracle` — 仅证据会话（检索零难度，测作答质量与 abstention 判定）
- `s` — 标准 ~40 会话 / ~115k tokens（主基准，同 LoCoMo 定位：碎片层 + 检索）
- `m` — ~500 会话（超长，需更强检索）

管线与 LoCoMo 一致：每个实例的全部会话轮次 → 碎片（零 LLM 直灌）→ 每题检索 top-k
（BM25 + 向量 RRF + HyDE）→ LLM 仅凭检索碎片作答 → 独立 LLM 判分。判分 rubric 逐字来自
官方 `evaluate_qa.py`，按题型分派（temporal-reasoning 容忍 off-by-one、knowledge-update
只看更新后答案、single-session-preference 按 rubric 判、abstention 正确拒答才得分）。

500 题 6 题型 + 30 abstention：single-session-user(70) / single-session-assistant(56) /
single-session-preference(30) / multi-session(133) / temporal-reasoning(133) /
knowledge-update(78) / abstention(30，question_id 以 `_abs` 结尾)。

指标（对照官方 `print_qa_metrics.py`）：各题型准确率 / Task-averaged（6 类宏平均）/
Overall（全部微平均）/ Abstention（单独）/ 检索召回（turn-level `has_answer` 命中率 +
session-level `answer_session_ids` 命中率，诊断用，abstention 题不计）。

`--embed` / `--no-hyde` / `--pace` / 作答判分模型切换与 LoCoMo 完全相同（共用 `.env.local`）。
判分模型与官方不同（官方用 GPT-4o，本管线用 `MUNINN_MODEL`），对照结论以「参照口径」表述。

**历史锚点 · M3 时代口径（2026-08-22，LongMemEval_S，commit `59352ea`；不可与 v0.2.0 口径混引）**：
k=15，BM25 + BGE-M3 向量 RRF + HyDE（嵌入经硅基流动），作答/判分 MiniMax M3（官方 API 直连）。
500 题零批调用失败——
single-session-user **1.000** / single-session-assistant **0.982** / knowledge-update **0.885** /
temporal-reasoning **0.820** / multi-session **0.812** / single-session-preference **0.567** /
**Task-averaged 0.844 / Overall 0.856 / Abstention 0.867**（26/30）。
检索召回 turn-level **0.962** / session-level **0.989**。
明细：`server/eval-data/longmemeval-s-result-1787405412219.json`（force-added，gitignored 目录破例入库）。

**全量基线 v0.2.0（2026-09-10，LongMemEval_S，r7 零失败卷）**：
k=15，BM25 + BGE-M3 向量 RRF + HyDE（嵌入经硅基流动），作答/判分 glm-5-3-260801（火山方舟 Agent Plan `/api/plan/v3`）。
500 题零批失败、零单题尸体——
single-session-user **1.000** / single-session-preference **0.933** / single-session-assistant **0.982** /
temporal-reasoning **0.910** / knowledge-update **0.923** / multi-session **0.752** /
**Task-averaged 0.9167 / Overall 0.892 / Abstention 0.900**（27/30）。
检索召回 turn-level **0.972** / session-level **0.996**。
口径变更（对照 M3 基线必读）：拒答条款收半格（相关性扳机 + 近似碎片护栏）、作答预算 2000/题、传输层空内容放大至 16000 + 末次低推理刹车；multi-session 0.752 处历史波动带（0.74~0.81）内，计数欠数随 HyDE 抽样摆动。
明细：`server/eval-data/longmemeval-s-result-1788993683045.json`（force-added，gitignored 目录破例入库）；前一卷 r6（0.876，含 5 尸）不作正式成绩，验尸见同目录 NOTE.md。
登记项：preference 剩 2 错（0edc2aef 检索未命中后拒答，属检索账；09d032c9 证据在手仍拒，属条款残余）；条款回火 2 道（dd2973ad 就寝时间 / 0977f2af 厨房小家电，均证据在手新增拒答）——净收益仍为 +12/-2。成绩跑于焊死前同一内容工作区，补丁内容与 commit `85cc113` 一致。

## 设计债务清偿对照表（对照设计文档 §9，更新于本仓库服务端）

| # | 债务 | 状态 |
|---|---|---|
| ① | 龙脉值冷启动死循环 | **已清**：龙脉只做相对排序，登记准入从不看龙脉；top-12 候选截断对新登记线索（历史=1）保底放行 |
| ② | avoidance 三信号门槛 | **部分缓解**：服务端按「曾活跃+高情感+久沉默」规则入池；话题转移信号无法从碎片层观测（已声明） |
| ③ | 异源反证生成 | **已清**（缓解级）：红队 persona+高温异源，`MUNINN_ADVERSARY_MODEL` 可配第二模型 |
| ④ | 盲推导 null model | **已清**：k 次抽样自然方差基线 + 三重保守面；漂移定位（二分重建）未做 |
| ⑤ | 对照窗口风险分级 | **已清**：词表+LLM 双重分级、内生标记、危机中止阀、到期校验 |
| ⑥ | 事实层修正标注 | **已清**：`/v1/correct`，原文不动，判定层经 fragView 见修正后事实 |
| ⑦ | contested 再提门槛 | **已清**：≥3 独立新证据 + 14 天冷却 + 邀请式措辞 + 两否封存 + 打地鼠双守卫 |
| ⑧ | 冲突测试集规范 | **已清**：22 例类型学数据集 + 机械盲评 + `eval-counter.ts` 跑批（基线 100%） |
| ⑨ | LoCoMo 及格线量化 | **已清**：全量 10 会话 1986 题总分 0.6695（v0.2.0 口径），及格线 0.6019 过线，超 mem0 参照宏平均 0.617；open-domain 未过单科线，已立项 |
| ⑪ | 合规声明文本 | **已清**：not-a-medical-device / 情感数据最小化 / 命名惯例附则，见 [docs/COMPLIANCE.md](../docs/COMPLIANCE.md) |

## MVP 简化声明（后续迭代方向）

- 碰撞 LLM 候选排序：向量召回（配 `SF_API_KEY` 即启用；嵌入经 `embed-node.ts` 磁盘缓存去重，未变化线索零 API 成本；缺 key 或调用失败自动回龙脉值排序）。top-12 截断与新线索保底放行不变（债务①）；无 LLM 时的规则兜底路径仍用字符重合度近似（`charOverlap`）——防线在 adjudication 层，预筛只是加速器。
- 认知层反刍抽取与反证搜索（异源红队 + 强制裁决留痕 + 防教条化衰减）已实现（`/v1/reflect`）；用户自述反证走 `/v1/counter`。
- 盲推导审计已实现（null model 基线 + 漂移信号 + 用户可见标记，`/v1/audit`）；漂移定位（历史版本二分重建）未实现。
- 对照窗口已实现（风险分级 + 内生标记 + 危机中止阀 + 到期校验，`/v1/window`）；窗口指令依赖宿主遵守（架构边界）。
- 事实层修正标注（债务⑥）与 contested 再提门槛/防纠缠（债务⑦）已实现；再提门槛的「独立新证据」判定与邀请措辞为 LLM 判断，幻觉 id 均经代码过滤。
- merge/split 已实现（共享碎片 ≥2 触发 merge 判定、回收条件分化触发 split），但反刍无自动排程——`MUNINN_AUTO_REFLECT=1` 开启进程内定时（仅覆盖已加载用户），否则宿主手动调用。
- 存储为单文件 JSON，多实例部署需换共享存储。
