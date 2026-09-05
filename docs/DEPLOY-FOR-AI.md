# 衔枝（twig-memory）托管安装手册 · 给 AI 看的版本

> 用户把这份文档发给你，是要你**带 TA 把衔枝装起来**。
> 你是本次安装的总工程师。以下事实以本文件为准——**不要凭训练记忆发明命令、端口、文件名或环境变量**。本文件没写的事，直接说「文档没写」，不要编。

## 第 0 步：先问用户一个问题

「你想怎么用衔枝？」

- **A. 自己用，想先看看「记忆书」长什么样** → 走【路线一】
- **B. 想接进手机 App / AI 客户端**（RikkaHub / Kelivo / Operit / Cherry Studio 等）→ 走【路线二】
- **C. 想接 Codex / Claude Code 等桌面 agent** → 走【路线三】

用户答不上来就默认路线一。

## 事实表（一切以本表为准）

| 项 | 值 |
|---|---|
| 仓库地址 | `https://github.com/qimingjiu/twig-memory` |
| Node.js 版本 | **≥ 22**（底线 20.19；用 `node -v` 验证，不够就去 nodejs.org 装 22 LTS） |
| 后端引擎 | `npm run server:http` → `http://localhost:7300` |
| 记忆书前端 | `npm run dev` → `http://localhost:7100` |
| 前端连后端 | 默认连 `http://localhost:7300`（可用环境变量 `VITE_API_BASE` 改） |
| 密钥文件 | 仓库根目录新建 `.env.local`（已被 .gitignore 排除，不会进 git） |
| `KIMI_API_KEY` | Moonshot 密钥（platform.moonshot.cn 申请）。**可选**：不配则引擎回退规则判定，但反刍、审计、日记与便签生成等 LLM 功能不可用 |
| `SF_API_KEY` | 硅基流动密钥（可选，向量召回加速器） |
| `MUNINN_AUTH_TOKEN` | 云端部署的访问令牌（自设一个长随机串，强烈建议） |
| 健康检查 | `GET /health` 应返回 `{"ok":true,...}` |
| 远程 MCP 端点 | `/mcp`（新版客户端优先）、`/sse`（旧版客户端兜底） |

## 路线一：本地跑起来 + 打开记忆书

Windows / macOS / Linux 通用。逐行复制，每步跑完看输出：

```bash
git clone https://github.com/qimingjiu/twig-memory.git
cd twig-memory
npm install
```

配置密钥（可选但推荐）：在 `twig-memory` 文件夹根目录新建文件 `.env.local`，内容一行：

```
KIMI_API_KEY=sk-你的-Moonshot-API-Key
```

启动后端（**这个终端窗口保持开着**）：

```bash
npm run server:http
```

**另开一个新的终端窗口**，同样 `cd twig-memory`，然后：

```bash
npm run dev
```

### 路线一验证清单（逐项让用户确认再结束）

1. `curl http://localhost:7300/health`（Windows PowerShell 用 `curl.exe`）返回里 `"ok":true`；
2. 浏览器打开 `http://localhost:7100`，能看到「今日扉页」界面；
3. **书是空的 = 正常**。记忆书是引擎的展示窗，不是聊天窗口——它展示的是引擎对用户的理解。要让书里长出日记、心迹、便签、印章，需要把 AI 接上来（路线二或三），之后正常聊天，事件会自动流进引擎。

## 路线二：云端部署 + 手机 App 接 MCP（最省心的长期使用方式）

以 Zeabur 为例（Railway / Render / 自有 VPS 同理，都认根目录的 Dockerfile）：

1. 把仓库 fork / 推到自己的 GitHub，Zeabur 控制台 → Create Service → Git → 选仓库，自动构建。
2. 配置环境变量：
   - `MUNINN_AUTH_TOKEN`：自设一个长随机串（**所有 API/MCP 请求的通行证**，必配）；
   - `KIMI_API_KEY`（可选，建议配）；
   - `SF_API_KEY`（可选，向量召回）；配的话同时加 `MUNINN_EMBED_CACHE=/data/embed-cache.json`。
3. **挂卷（不做这步，重启后记忆全丢）**：服务 → Volumes → 挂载卷到 `/data`。
4. 绑定域名：Networking → Generate Domain，得到 `https://xxx.zeabur.app`。
5. 验证：`curl https://xxx.zeabur.app/health` 返回 `{"ok":true,...}`。

手机 App（RikkaHub / Kelivo / Operit 等）里添加「远程 MCP 服务器」：

```
URL:    https://xxx.zeabur.app/mcp        （连不上就换 /sse）
请求头: Authorization: Bearer 你的MUNINN_AUTH_TOKEN
```

手机上**不需要安装任何东西**——Node、依赖全部在云端。之后正常聊天即可，宿主会自动把事件写进引擎、在回复前取回记忆上下文。

注意：**云端部署的只有引擎（后端），没有记忆书界面**。记忆书是本地组件（路线一第 4 步），想本地看书又把数据放在云端时，在本地 `.env.local` 里加一行 `VITE_API_BASE=https://xxx.zeabur.app` 再 `npm run dev` 即可。

## 路线三：stdio MCP（Codex / Claude Code 等桌面 agent）

```bash
npm run server:mcp
```

Codex `config.toml` 示例（路径换成用户自己的实际路径）：

```toml
[mcp_servers.muninn]
command = "npx"
args = ["tsx", "D:/你的路径/twig-memory/server/mcp.ts"]
# env = { KIMI_API_KEY = "sk-..." }
```

挂载后宿主会拿到 9 个工具：`memory_ingest` / `memory_context` / `memory_list_claims` / `memory_contest_claim` / `memory_reflect` / `memory_audit` / `memory_start_window` / `memory_note_intervention` / `memory_correct_fragment`。

## 排错手册（症状 → 原因 → 处置）

| 症状 | 原因与处置 |
|---|---|
| `npm install` 报错或卡住 | 换镜像：`npm config set registry https://registry.npmmirror.com` 后重试 |
| `node -v` 低于 20.19 | 去 nodejs.org 装 22 LTS，重装后重开终端 |
| 7300 被占用 | `PORT=7400 npm run server:http`（Windows PowerShell：`$env:PORT=7400; npm run server:http`），同时前端 `.env.local` 加 `VITE_API_BASE=http://localhost:7400` |
| 7100 打开空白或报错 | 确认 `server:http` 那个终端**也在跑**；两个终端都要保持开着 |
| `/health` 里 `llm` 是 `heuristic-only` | key 没生效：检查 `.env.local` 是否在仓库根目录、变量名是否拼对、改完是否重启了 server |
| 手机 App 连不上 MCP | `/mcp` 换 `/sse`；核对 Bearer 后的令牌与 `MUNINN_AUTH_TOKEN` 完全一致；确认是 https |
| Zeabur 重启后记忆丢了 | 没挂卷：Volumes 挂到 `/data` 后重新部署 |
| 配置 API base 类地址 | **不要自己加 `/v1` 后缀**——OpenAI 兼容生态最常见的坑，代码已自动归一化，多写一个 `/v1` 会 404 |

## 给 AI 的红线

1. 全程使用事实表里的端口与命令；用户环境冲突时先解释原因再用 `PORT` / `VITE_API_BASE` 调整，**不要改 `vite.config.ts` 或 `server/http.ts` 源码**。
2. 每完成一步，让用户跑对应的验证命令再继续下一步。
3. 永远不要让用户把 `.env.local` 提交 git，不要让用户把密钥贴进任何公开窗口（包括你所在的对话如果会被分享）。
4. 遇到本手册没覆盖的报错：原样读完整报错再分析；解决不了就指路仓库 Issues（github.com/qimingjiu/twig-memory/issues），**不要现场发明修补方案**。

---

*本手册由仓库维护者随 README 分流一同发布，事实以仓库代码为准。*
