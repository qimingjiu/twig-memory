# AML 参赛工作日志（交接版）

> 写于 2026-09-23 上午，供新窗口/新会话秒恢复上下文。实时进度以 [Evaluation 页](https://agentmemoryleaderboard.ai/evaluation)为准。

## 一、当前状态（最重要，先看这个）

- **正式 full 评测进行中**：任务 `teval_711d4cfc78692fc4`，文本赛道 · **工业榜**，full 模式，版本 `v1.0-aml (commit 2c6763e)`，2026-09-22 12:23:42 首次提交
- 已两次断点续跑（服务器两次宕机，详见第四节），**最新状态：检索阶段 38.4%，运行中**
- 关键日期：**第二次 full 2026-10-22 12:23 解锁**（30 天冷却）；评测截止 10-31；接口需保活到 11-04；本号 Agent Plan **10-08 到期**（待办见第六节）
- 公榜规则：full 成功后需管理员复核才发布；smoke 成绩不公榜

## 二、资产清单

| 资产 | 位置 |
|---|---|
| 参赛系统 | 衔枝 Twig · 雾尼 Muninn，仓库 github.com/qimingjiu/twig-memory（公开，MIT） |
| 部署 | Zeabur 项目 `muninn-aml`（阿里云香港 2C4GB 独服，K3s），域名 `https://muninn-aml.zeabur.app` |
| 接口 | Add `/aml/add`、Search `/aml/search`、Health `/health`（免鉴权） |
| 参赛配置 | BM25 + BGE-M3 向量 RRF + HyDE（glm-5-3-260801，reasoning_effort=low）+ 25s 保险丝（超时自动降级 BM25）+ **LRU 有界索引缓存（94d20ad 热修复）** |
| 密钥 | AML_AUTH_TOKEN（a5dd 开头）= 报给平台的 Memory System Key；ldbd_key 在 QQ 邮箱审核通过邮件里；Agent Plan key（5e0a3 结尾）、SF_API_KEY 在 `.env.local`；Zeabur token（zat_ 开头）在 `~/.kimi-code/mcp.json` |
| 评测档案 | `docs/aml/00~03`（官方协议存档）、`docs/aml/04-ab-replay-results.md` + `aml-ab-results-20260916.json`（彩排成绩与四雷排查报告） |

## 三、彩排成绩（本地口径，LoCoMo 1986 题，证据命中率）

| 配置 | hit@10 | hit@20 | hit@50 | hit@100 |
|---|---|---|---|---|
| B（BM25+向量） | 0.5247 | 0.6425 | 0.7664 | 0.8479 |
| **E（全量，参赛配置）** | **0.7115** | **0.7845** | **0.8781** | **0.8781** |

- E 每个 k 档都是冠军；延迟 p50 4.2s / p95 9.6s / max 50s（保险丝把 87s 尾掐掉了）
- 平台 smoke（46 题小样本）：**52.27**（对照首期榜首 MemoraX 全量 58.02）
- 参赛配置 E 的命中区间 88%~93%（HyDE 有方差，temperature 0.7）

## 四、时间线大事记

- 09-11：收到 AML 私信邀请 → 核实赛事真实（CSIG 主办，官网/公告/GitHub 三方交叉验证）
- 09-11~16：协议文档存档 → 建 Add/Search 适配层（`server/aml.ts`）→ 契约自检 7/7 → A/B 彩排战役（4 配置 × 10 会话）→ E 配置夺冠（0.9265）
- 09-16：排「赛前四雷」：尾延迟（p99 9.7s 但 3 次 87s 卡顿）→ 根因=embed/HyDE 无硬超时 → **25s 保险丝**；hit@k 对齐（E 全档冠军）；平台公开 pipeline 确认返回格式兼容
- 09-16：部署 Zeabur（ZCode 执行），公网自检全绿；选榜时发现**学术榜要求 Add/Search 模型必须 gpt-4o-mini** → 改选**工业榜**（不限模型，无奖金但正好证明实力——她说「只想证明衔枝」）
- 09-20：报名审核通过（工业榜，长期有效 ldbd_key）；09-21 smoke **52.27 通过**
- 09-22 12:23：首次 full 提交 → 19:53 失败（**K3s 宕机**，2C4GB 扛不住 16 并发 + 内存驻留索引）→ 整机重启（取消勾选服务）→ 项目页 Restart → 断点续跑（检索 27.5%）
- 09-23 01:15：再次失败（`SEARCH_SERVICE_UNAVAILABLE · 502`，同一根因：每用户索引缓存无界 → Node 堆 OOM）→ **热修复 `94d20ad`：LRU 有界缓存（100 用户，行为零变化，压测驱逐前后结果一致、RSS 有界 97MB）** → 重启 → **Redeploy（用新 commit 重建）** → 04:20 续跑成功
- 09-23 上午：检索 38.4%，运行中
- 09-23 04:28：新窗口接手监护。检索 39.5%（观测期间 39.0→39.5 持续推进），运行中。每 3 小时检查 cron 已设（19 */3 * * *，仅本会话有效，新窗口需重设）。注意：主会话直调 kimi-cu `get_app_state` 反复触发 oneOf 参数绑定报错（参数被吞），派 coder 子代理执行 kimi-cu 则一切正常——后续窗口如遇同款 bug 直接走子代理
- 09-23 06:31：定时检查。检索 49.2%（105 秒内 49.1→49.2 推进中）。注意页面读数滞后，F5 刷新后才见真实进度（39.9→49.1 跳变）
- 09-23 08:21：第三次失败（`PARTICIPANT_ENDPOINT_UNAVAILABLE`，19h58m）。08:44 抢修：服务器 VM RUNNING 但 isOnline=false、SSH 不通（整机断气，同前两次根因）。**新坑**：04:24 一个 `docs(aml)` 提交自动触发的构建 FAILED，服务 deployment 指针落在坏镜像上，Reboot+Restart 后新 Pod 拉不到镜像卡 STARTING（老 Pod 才是扛评测的那个）。抢修全程走 Zeabur GraphQL API（见第五节新增）：rebootServer(force, []) → restartService 无效（坏指针）→ rollbackDeployment 需付费 → **redeployService 重建**（commit 1cb340f7 = 94d20ad + docs，行为不变）。注意：阿里云→Zeabur registry 拉镜像极慢（约 19 分钟/186MB），此期间 502 属正常
- 09-23 09:37：**第三次宕机抢修完成，全程 76 分钟**。/health 09:33 回 200 → 自检 **7/7 PASS**（首跑 6/7 系索引预热抖动，20 秒后重跑全绿；token 取自 service variables API——教训：Python `open('/tmp/...')` 在 Windows 会落到盘符根目录的 \tmp，自检要用 bash 写入的 /tmp 文件）→ 评测页「**一键续跑最近中断任务**」→ 确定（保持原 dispatch ID）→ 运行中，检索 **52.3%**，断点进度全保住
- 09-23 12:33：定时检查。运行中，检索 55.9%（速度较昨夜放缓：重启后缓存全冷 + 断点重放 add）。日志旁证服务在真实工作（12:34 仍在出 `/aml/search` 200），但抓到一条 **25 分钟级 search 尾延迟**（1510129ms）+ zeaburlet 监控代理再次失联（isOnline=false，App 本身正常）——列入观察项，加设 14:03 一次性复查
- 09-23 13:34：第四次失败（**`ADD_RUNTIME_ERROR`**，25h10m）。14:03 复查抓到。**根因链（代码级实锤）**：① `buildUserIndex` 无 in-flight 去重——同 shard 并发 search 各自全量重嵌（日志 4 条同秒重复 embed 即此）；② 查询向量臂 `embedTexts([query], shardId)` 每搜一次就把整个 shard 缓存（万条级 ≈ 200MB JSON）同步 stringify+重写——25/40 分钟 search 尾延迟与事件循环饿死的直接元凶；③ shardStores 无界驻留 + indexCache 上限 100（万条 shard 单个 ~100MB）→ 慢速 OOM。平台视角：add 请求排不上事件循环 → 超时报 ADD_RUNTIME_ERROR。**热修复（行为零变化，本地实测）**：`buildUserIndex` 加 per-user in-flight 共享 + 构建并发闸门 3（`AML_INDEX_BUILD_CONCURRENCY`）；`saveShard` 节流到 10s + 构建结束强制落盘 + `releaseShard` 释放内存驻留；查询向量改走 `embedQuery`（纯内存 LRU 512，同 API 同模型结果一致，不进分片缓存）；Zeabur 加配 `AML_INDEX_CACHE_MAX=12`（原默认 100 对万条 shard 太肥）。本地验证：6 并发同 user 只嵌 1 次、结果一致；增量 add 10 条只嵌 10 条；重复查询 16ms
- 09-23 12:31：定时检查。/health 直连 200（1.0s）。检索 55.9%（续跑后 +3.5pt/2.9h，节奏放慢但持续推进），无异常

## 五、运维手册（下次出事照着做）

**服务宕机恢复（已验证两次）**：
1. Zeabur → Servers → 点服务器 → Settings → 按 End 到底部 Danger Zone → **Reboot Server** → 弹窗里 **Deselect All**（让服务器干净恢复）→ Reboot
2. 等 VM 回 RUNNING、K3s 绿灯（约 3~5 分钟）
3. Projects → muninn-aml → **Restart**（不改代码）或 **Redeploy**（要上新 commit 时）→ curl `/health` 200
4. 自检：`cd /d/kimi/workspace/muninn && AML_BASE_URL=https://muninn-aml.zeabur.app AML_AUTH_TOKEN=<a5dd...> npx tsx server/aml-selfcheck.ts` 应 7/7 PASS
5. 评测页 → **从断点续跑** → 确定（保持原 dispatch ID，不消耗新 full 次数）

**注意**：本机 curl 服务器可能超时（她本机→阿里云香港的路由时好时坏），**以评测页进度为准**，别被本地探测骗了。GitHub/npm 直连不通时用代理 `http://127.0.0.1:7890`。

**API 抢修通道（09-23 验证，免开 dashboard）**：Zeabur GraphQL `https://api.zeabur.com/graphql`，`Authorization: Bearer <zat token>`（在 `~/.kimi-code/mcp.json`）。ID 固定：server `6a91ecacaf37eeef8fb27aa9` / project `6aaa9c9a905b4aaea95db29a` / env `6aaa9c9a1d7bf7f6aa4aac3e` / service `6aaa9ca4905b4aaea95db29d`。对应手册步骤：`rebootServer(_id, force:true, deploymentsToSuspend:[])`＝第 1 步（空数组＝Deselect All）；`restartService(serviceID, environmentID)`＝第 3 步 Restart；`redeployService`＝Redeploy；`rollbackDeployment` 要付费套餐，别试。状态查询：`server(_id){status{isOnline vmStatus}}`、`service(_id){status podStatuses{name status}}`、`runtimeLogs(projectID,serviceID,environmentID)`。**陷阱：任何一次构建 FAILED 后 deployment 指针会落在坏镜像上，此时 Restart 会让 Pod 卡死拉镜像——必须 redeployService 重建。**

**未做的加固**：Zeabur Settings → Advanced → **Resource Reservation**（给 K3s 预留 CPU/内存防挤死）——评测期间不敢动，赛后配上。

## 六、待办清单

- [ ] **监控**：cron 每 3 小时查一次评测页（新窗口需重设，见第七节）
- [ ] **10-06**：激活第二个火山号的 Agent Plan，把新 plan key 给 ZCode 换 Zeabur 的 `MUNINN_API_KEY`（本号 10-08 到期；模型 ID、接口、鉴权都不变，只换付费账号）
- [ ] **评测成功后**：记录 AVERAGE 与各能力分项 vs MemoraX 58.02；等管理员复核上公榜
- [ ] **赛后 30 天内**：删除 Zeabur `/data` 卷里的评测数据（合规要求）
- [ ] **赛后**：`.env.local` 里的 MUNINN_* 三件套可删（plan key 若续用则留）；`glm-5-3-flash` 测试模型可在火山控制台关闭；Resource Reservation 配上
- [ ] 可选项：官方问询邮件（Search 超时上限、作答实际用多少条记忆）→ contactus@agentmemoryleaderboard.ai 或直接回审核邮件

## 七、新窗口开场词（贴给新会话）

```
看 D:/kimi/workspace/muninn/docs/aml/05-worklog.md 接手 AML 赛事监护。当前正式 full 评测 teval_711d4cfc78692fc4 在跑（工业榜，断点续跑过两次，热修复 94d20ad 已上线）。帮我：1) 用 kimi-cu 看 Edge 浏览器 agentmemoryleaderboard.ai/evaluation 的任务进度并每 3 小时设一次检查 cron；2) 服务若再宕机按 worklog 第五节流程恢复；3) 待办清单在第六节，10-06 的订阅接力别漏。
```
