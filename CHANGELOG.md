# Changelog

## [0.3.2] – 2026-10-23

### 修复运行时历史碎片不可达

- MCP 新增 `memory_list_fragments` / `memory_search_fragments`；HTTP 新增 `GET /v1/fragments` / `GET /v1/search`，两种接入共用只读服务。
- 从评测模块提取无副作用的 BM25 / 向量排序 / RRF 原语，保留评测原有英文分词、零分兜底与排序口径；运行时增加中文相邻双字分词，排除零分词法结果。
- 检索覆盖全部非影子碎片（包括近期窗口之外的历史），保留完整正文与本人修正；分页可显式查看影子碎片。显式查事实不会修改或唤醒 SILENT 线索。
- 有嵌入 key 时可用向量 RRF 与现有磁盘缓存；无 key 时纯 BM25；向量失败或超过 10 秒预算时降级并报告 `degradedReason`。可用 `MUNINN_SEARCH_EMBED=0` 强制词法查询。运行时不自动调用 HyDE/LLM。
- MCP 描述与上下文标明「最近 5 条」只是窗口。stdout 留给 MCP JSON-RPC，嵌入日志改发 stderr。
- 服务端类型检查发现并修正既有 `map(fragView)` 的数组索引误传（避免把索引当作来源标记）以及 `reflect` 返回类型的重复 Promise 声明。
- 增加离线回归：中文旧事、分页、修正、隔离、降级、缓存、HTTP 鉴权、远程 MCP / stdio 与持久化重启。

状态文件格式不变，无需迁移。更新代码并重启服务，再让 MCP 客户端重连以刷新工具列表；详见 `server/README.md`。

## [Unreleased]

### 临水轩 · 古风前端全线开馆（2026-09-10 ~ 09-11）

第二套前端「临水轩」：从「看画」到「入画」——一间临水的古风轩室，五扇折叠屏风即五大模块的入口。独立 Vite 应用（`xuan/`，端口 7101），与「记忆书」互不干扰；美术资产母版入 `art/`，经 `npm run art`（sharp）压 WebP 后由工程引用。

- **厅堂**：眺园图铺底、「衔枝榭」匾额悬顶、五扇画心（桃花/木铎/纸扇/琼瑶/窗棂古树，工笔绢本）+ 题签；屏风两段式交互——单击身侧**等高滑出简介卷轴**（典故 + 功能 + 入口，防误触），再点方入内；时辰光色（晨/昼/暮/夜）与全屋风值共享驱动（屏风摇、匾额摆、铎晃、丝绦飘）
- **春水**（桃花屏）：波场水引擎自研重写——CPU 粗网格波动方程 → WebGL 折射/焦散/天光带 → 2D 桃瓣与星芒叠加；划水起澜、投石问涟；花瓣为真透明 sprite（`art/petal-*.webp`）
- **采诗阁**（木铎屏）：振铎=点火 `POST /v1/reflect {async:1}`（同步语义实测 >5 分钟，async 点火 + 每 8s 轮询 `/v1/state` claims 指纹判「诗成」）；**诗笺墙**渲染未闭合线索（题/悬问/正采·暂歇·沉眠/悬置天数），**轩中之解**列认识层 claims + 泥金信值条 + 界线小字；已灌叙事测试数据并真实织出 6 笺 5 解
- **书阁**（纸扇屏）：书目（`journal/range`）+ 典籍空页上的日记排印（`journal/range`→`GET /v1/journal`）；「研墨成书」接 `journal/generate`（同步 LLM）
- **琼瑶**（玉璧屏）：玉佩 sprite 悬挂微摆；心迹（`soliloquy/recent`）；便签往来（`notes` 列表 + 「请轩中留一笺」`notes/generate` + 八章**盖印仪式** `notes/:id/stamp`）；**八章玉牒**（`art/seal-*.webp` 与 `shared/stamps.ts` 注册表 id 对齐，盖章得玻璃珠、玉牒点亮）
- **庭树**（窗棂屏）：状态四卡（碎片/线索/理解/占存）+ 仓廪存储条（`/v1/storage`）+ 盲推导审计（`/v1/audit` 点火、`audit/last` 展示分歧/基线/漂移信号）
- **竹简书案**：收起态为卷竹简实物图，展开为对话控制台（`POST /v1/chat`），墨迹逐字晕染、引擎未醒兜底；定位为宿主接入位（host-loop 参考实现），采诗素材来自宿主交流积累，开发期用 `scripts/seed-caishi.mjs` 灌数
- **可达性与性能**：`prefers-reduced-motion` 全屋退静画；资产 WebP 化 23MB→3MB（-88%）；DPR 封顶 2；离屏暂停

## [Unreleased-历史]

### v0.2.0 跑分收官（2026-09-09 ~ 09-10）：双基准零尸体入账（glm-5.3 口径）

**LongMemEval-S**

- 零失败卷入账：**Overall 0.892 / Task-averaged 0.9167 / Abstention 0.900**（27/30），500 题零批失败、零单题尸体，明细 `server/eval-data/longmemeval-s-result-1788993683045.json`
- 分科：single-session-user **1.000** / single-session-preference **0.933** / single-session-assistant **0.982** / temporal-reasoning **0.910** / knowledge-update **0.923** / multi-session **0.752**
- 作答/判分口径：glm-5-3-260801（火山方舟 Agent Plan `/api/plan/v3`）；传输层三补丁——plan 网关路径适配、空内容（思考耗尽）一律放大 max_tokens 至 16000、末次重试 `reasoning_effort=low` 刹车（根治 GLM 计数题思考链空转）
- 拒答条款收半格：扳机由「碎片没有现成答案」改为「碎片完全没有相关信息」+ 近似碎片护栏——销乱拒 9 道、该拒没拒 4 道；preference +7 经独立重判验真，非判分放水
- 测量硬化：answers/judge JSON 报废或条数不足抛错走批级重试（批 77 整批静默填尸事故根治），作答预算 1400→2000/题；eval-locomo 镜像同修（预算 700→1400）
- 前一卷 r6（0.876，含 5 尸）不作正式成绩，验尸报告见 `server/eval-data/longmemeval-s-result-1788967446368.NOTE.md`

**LoCoMo**

- 续跑卷入账：**总分 0.6695 / 及格线 0.6019 → PASS**，1986 题零单题尸体，明细 `server/eval-data/locomo-result-1789082385558.json`
- 分科：single-hop **0.838** / temporal **0.738** / multi-hop **0.539** / open-domain 0.563（仍未过单科线 0.656，立项靶子保留）；adversarial 0.740（单列不计入，较 M3 基线 0.843 回落，已注记待查）
- `eval-locomo` 抗断网三件套：逐会话增量快照（终盘前中断可捞回已完会话）、`--resume` 从快照续跑（断网/强重启最多损失当前会话）、answers/judge JSON 报废抛错走批级重试；作答预算 700→1400/题
- 两轮断网实战：r2 被 Windows 强制更新与断网咬死两次，conv-42 剔除后经 `--resume` 干净重跑，前 3 会话成绩整卷继承（明细含 `resumedFrom` 溯源）
- 查卷定责（抽样版）：adversarial 回落 0.843→0.740 为**答题侧贪答**（116/116 断言式作答、judge 无责——判据机械「拒答才给分」），疑 would/likely 条款对陷阱题误放行；open-domain 42 错中 20 拒答（「老实人税」叙事不变，CONSERVATIVE 口径照旧）；expand content_filter 批受影响 10 题全在分母、零尸体；LME 登记 preference 剩 2 错（1 检索未命中 / 1 证据在手仍拒）+ 条款回火 2 道（就寝时间 / 厨房小家电）
- 口径声明：两卷成绩跑于焊死前同一内容工作区（补丁内容与 `85cc113` / `6e7118f` 完全一致）；旧 M3 口径成绩（LME 0.856 / LoCoMo 0.640）降档为「历史锚点」，不可与新口径混引

## [0.1.0] – 2026-08-26

衔枝首个公开 Release：从「引擎 + 评测脚本」长成「可日常使用的记忆产品」。

### 新增 · 情感层与新前端「记忆书」（2026-08-23 ~ 08-26）

- 新前端「记忆书」页面群：今日扉页 / 记忆书（日历网格 + 日卡导出）/ 故事线 / 理解文档 / 自检日志 / 设置页（引擎状态灯 + 存储占用 + 最近审计）
- 情感层三件套：日记 / 心迹 / 便签——平行于编织层、只读于引擎；用户回应经影子碎片 + ContextAnchor 进入引擎视野
- 印章与玻璃珠：8 章 × 12 珠（`shared/stamps.ts` 前后端共用注册表），盖章仪式（StampRitual + WaxSeal 真火漆压痕），一签一章不可重复
- 便签 23:00–06:00 未读弹窗；便签生成基于当日碎片与活跃线索（剥离小模型偶发前缀）
- 服务端新接口：journal / soliloquy（含 range 与 export）/ notes（current、list、单条、read、respond、stamp、generate）/ stamps（含 recent）/ calendar / threads timeline / storage / audit/last
- 装饰组件：TwigWatermark（淡水印）/ InkEmpty（留白仪轨）/ PulseLine（心跳描记线）；记忆书中缝与丝带书签
- 移除旧观测面板页面与 demo 引擎（本地存档）；`src/` 更名 `visualizer/`
- 根 README 用户化重写；`server:http` 改 tsx watch；eslint 清零
- 新增环境变量：`MUNINN_TZ` / `MUNINN_CORS_ORIGIN` / `MUNINN_RATE_LIMIT` / `MUNINN_AUTO_REFLECT` / `MUNINN_REFLECT_INTERVAL_HOURS`

### 新增 · LongMemEval-S 评测（2026-08-22）

- LongMemEval-S 首考收官：全量 500 题 **Overall 0.856 / Task-averaged 0.844 / Abstention 0.867**，零批调用失败，检索召回 turn 0.962 / session 0.989
- `eval-longmemeval.ts`：分片嵌入缓存（每题嵌完即落盘，中断只损当前实例）、`--types` 类别过滤、`--answer-model` 独立答题模型
- 修复三处测量事故：`question_date` 从未传入答题 prompt（temporal 失去时间原点）、思考型模型预算未按「思考+产出」双份给、单题级失败被计数器瞒报
- 作答 prompt 强化：有证据必须计算/推断，不许拒答（preference 类 Likely 条款）

### 服务端 / 引擎层（2026-08-21 及以前）

- **P0 缺陷修复**
  - `ThreadEvent.day` 从 `Fragment.day` 派生，避免老化偏移
  - SILENT 唤醒后清空 `silentSignals`，支持再次沉默并入池
  - abandoned 线索在热路径扑空后被归档层扫描重激活
- **P1 稳定性**
  - 新增 per-user 异步锁 `withLock`（`server/manager.ts`）
  - 损坏文件自动备份 + 告警（`server/store.ts`）
  - body 大小限制、速率限制、空 token 告警
  - 全部写操作统一走 `withLock`
  - 时区、词表、riskLevel 失效等边界修复
- **P2 改进**
  - 反转 verdict 降低关联论断置信（与“推进”区分）
  - split 合成句重新生成、审计全配对
  - 邀请过期、反转标记、`claimsUnchecked`、`fragView` 时间戳
  - `extractJson` 增加平衡括号扫描器（`visualizer/engine/llm.ts`）
- **VAD 共享层**
  - 新建 `visualizer/engine/vad.ts`，`core.ts` 与 `engine.ts` 共用同一套 VAD 估计
- **评测与接入**
  - 冲突响应测试集 22 例（基线 100%）与 LoCoMo 事实底盘（全量 1986 题总分 0.640，双口径过线）
  - MiniMax M3 传输层、BGE-M3 混合检索（BM25 + 向量 RRF + HyDE）
  - `/v1/chat` 参考宿主闭环；债务⑪合规文本公开（COMPLIANCE / CRISIS-PROTOCOL）

### UI / shadcn 组件接入（2026-08-20）

- `Dialog`：`ImportOverlay` / `ClosureOverlay` 全屏叙事浮层，支持 ESC 关闭、焦点陷阱、ARIA
- `Accordion`：`ThreadBoard.ThreadSlip` 展开态替换手写 `open/close`，获得展开动画与无障碍
- `DropdownMenu`：`AppLayout` 引擎状态卡操作菜单
- `Progress`：`UnderstandingDoc.ConvictionGauge` 替换手写 `nv-meter`
- `Select`：`ThreadBoard` 线索池切换改为下拉选择，保留键盘导航
- `Badge`：`ThreadsPage` 池数量使用标准 badge 样式，与 `Seal` 并存
- `Separator`：替换 `OverviewPage` / `ThreadsPage` 多处 `border-t` 分隔线，语义化
- `Skeleton`：`OverviewPage` 引擎 `busy` 状态显示骨架占位
- `Popover`：`UnderstandingPage` 论断证据按钮悬停/点击显示碎片摘要详情
- `Sonner` / `Toast`：`App.tsx` 挂载全局 `<Toaster>`，`DemoPage` 关键节点发送通知

### 测试

- `server/dev-smoke.ts` 新增场景 11–14（+18 断言），覆盖 P0/P1/P2 关键修复路径

### 运维

- `Dockerfile` 增加 `USER node`，以非 root 运行容器
