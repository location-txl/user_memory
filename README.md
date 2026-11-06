# 公共记忆

在单台机器上，让 Codex、ZCode、Claude Code、Pi、DeepSeek Harness 和 Hermes 使用同一份全局与项目记忆。

**Markdown 是记忆正文和元数据的事实源。** 一个本机 TypeScript 服务负责自动写入；SQLite 保存采集事件、提炼任务、召回回执和搜索索引。没有向量数据库，也不需要额外的模型 API Key：后台提炼使用已登录的 Codex CLI。

## 快速启动

需要 Node.js 24+、pnpm 10、可用的 Codex CLI 登录。当前版本优先面向 macOS。

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
node dist/cli.js serve
```

另开终端，在项目目录打开管理页：

```sh
node dist/cli.js web
```

服务默认监听 `127.0.0.1:43123`。`web` 用 URL fragment 传递本机访问密钥，页面读取后立即移除 fragment，密钥只留在当前标签页的 sessionStorage。直接打开裸 URL 不会自动获得访问权限。

自定义数据目录时，所有命令保持相同的 `--home`，或设置 `UMEM_HOME`：

```sh
node dist/cli.js --home /绝对路径/公共记忆 init
node dist/cli.js --home /绝对路径/公共记忆 serve
```

开发界面使用 `pnpm dev`；后台仍需启动。日常使用构建后的管理页即可。`serve --no-worker` 暂停自动提炼，仍接受采集、检索和显式写入；此参数只影响本次运行。

## 接入工具

先启动服务，再预览安装内容：

```sh
node dist/cli.js setup codex
node dist/cli.js setup codex --apply
node dist/cli.js doctor
```

`codex` 可替换为 `zcode`、`claude`、`pi`、`deepseek`、`hermes`。

| 工具             | 自动采集与召回                                                        | 主动记忆 | 安装结果                                                    |
| ---------------- | --------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| Codex            | SessionStart / UserPromptSubmit / Stop hooks，增量读取当前 transcript | MCP      | 合并 `.codex/hooks.json` 和 `config.toml` 的 MCP 条目       |
| ZCode            | hooks 的用户原话与最终回复；召回注入 additionalContext                | MCP      | 合并 `.zcode/cli/config.json`                               |
| Claude Code      | 提交 hook 与增量 transcript                                           | MCP      | 合并 `.claude/settings.json`、`.claude.json`                |
| Pi               | before_agent_start / message_end 扩展                                 | MCP      | 安装扩展入口，合并 `.pi/agent/mcp.json`                     |
| DeepSeek Harness | 原生 Cordis 插件；只采集已提交的真实用户消息                          | MCP      | 生成独立 overlay，按安装结果中的 `dsh web --patch …` 启动   |
| Hermes           | profile 独立的 memory provider，采集已完成轮次                        | MCP      | 准备 provider 与 MCP 片段；手工在目标 profile 选择 provider |

前三种工具需要宿主支持相应 hooks，并完成宿主自身的信任授权。**安装文件存在不等于接入成功。** 在管理页查看最近采集、召回时间，再用两个新会话验证模型真的使用了记忆。桌面应用以它内置的运行时为准，不以系统 CLI 版本代替验收。

所有安装都先备份，重复安装相同配置不增加条目。备份可能包含原配置中的敏感值，保存在权限受限的数据目录。安装期间若文件发生变化则拒绝覆盖。

```sh
node dist/cli.js uninstall codex          # 预览
node dist/cli.js uninstall codex --apply  # 恢复原配置，保留记忆库
```

如果安装后配置又被手动修改，卸载会停止，保留备份供人工合并，不会覆盖用户的新修改。

Hermes 多 profile 分别指定实际目录：

```sh
node dist/cli.js setup hermes --hermes-home /绝对路径/hermes-profile --apply
```

provider 按 `hermes_home` 区分会话来源，记忆仍写入指定的公共数据目录。没有宿主传入的 `cwd` 时只使用全局记忆；不会把 Gateway 的进程目录误当成项目。provider 切换会影响原生记忆，因此本安装器不自动修改 `memory.provider`，具体片段见命令输出。

## 日常操作

```sh
# 直接记住、查询、纠正和撤回
node dist/cli.js memory add '沟通语言' '默认使用中文沟通'
node dist/cli.js memory list --query 中文
node dist/cli.js memory get <id>
node dist/cli.js memory correct <id> '按用户新要求修正后的内容'
node dist/cli.js memory forget <id>

# 看当前项目实际会得到哪些记忆
node dist/cli.js recall '构建方式' --cwd /绝对路径/项目

# 将另一个目录绑定到相同项目
node dist/cli.js project list
node dist/cli.js project bind /另一个目录 --to <project-id>

# 失败任务不会无限重试，可检查后手动重试
node dist/cli.js jobs
node dist/cli.js jobs --retry <job-id>
```

网页支持相同的记忆编辑、候选批准、撤回、来源查看、修订历史、导入预览、任务重试和提炼配置。

MCP 提供 `memory_search`、`memory_get`、`memory_remember`、`memory_correct`、`memory_forget`。纠正和撤回必须带上最近读到的 revision 与 etag，避免旧会话覆盖新内容。检索返回摘录，完整内容用 `memory_get` 读取。

## 导入已有记忆

不会在安装时扫描所有历史会话。只读取你明确指定的 Markdown 文件或目录：

```sh
node dist/cli.js import /绝对路径/原生记忆目录
node dist/cli.js import /绝对路径/某条记忆.md --apply
node dist/cli.js import /项目记忆目录 --project <project-id> --apply
```

更推荐网页导入：先查看原文预览，再勾选文件。索引和汇总文件默认不选，避免重复；导入后统一进入待审核，批准后才参与召回。预览到确认期间源文件变动会拒绝导入。原文件不修改。

单次限制 200 个 Markdown 文件、4 层目录；每条记忆最多 16000 字符。较大的原生汇总请先拆分。本版按文件导入，不自动猜测其项目范围，也不自动分解长篇汇总。批量导入按文件保存；中途失败时已完成的记录保留，重复提交相同来源不会再建同一条记录。

## 最终存储文件

```text
~/.user-memory/
├── memories/
│   └── <id>.md             # 正文、范围、状态、来源、版本，事实源
├── history/<id>/
│   └── <revision>-<hash>.md # 修改前的完整文件
├── projects.json           # 项目 ID、目录别名、Git common dir
├── runtime.db              # 事件、任务、回执、搜索索引
├── runtime.db-wal          # SQLite 运行期间可能存在
├── spool/                  # 宿主写入的待接收事件；服务断线时保留
├── worker/                 # 提炼 schema 与临时结果
├── receipts/               # 增量 transcript 的读取位置
├── integrations/           # DeepSeek / Hermes 安装片段
├── backups/                # 宿主配置原文与安装回执
├── config.json             # 本机服务和提炼配置
└── token                   # 本机 HTTP 访问密钥
```

一个记忆文件的示例：

```md
---
id: example-memory
title: 默认用中文沟通
scope: global
kind: preference
status: active
revision: 1
createdAt: 2026-11-06T10:00:00.000Z
updatedAt: 2026-11-06T10:00:00.000Z
sources:
  - id: example-user-event
    agent: codex
    role: user
    excerpt: 以后默认用中文交流
    at: 2026-11-06T10:00:00.000Z
---

用户希望默认使用中文交流。
```

可以直接编辑 MD；下一次读取时扫描文件变化并更新索引。文件格式错误会保留原件并显示错误，恢复格式后重新进入索引。文件名必须与 frontmatter 的 id 一致。手工编辑不会自动生成修订历史；要保留历史，请通过网页、CLI 或 MCP 修改。不要在后台服务修改同一文件的同时手工保存：etag 能识别已经发生的外部修改，但普通编辑器不会参加服务的写入队列。

**runtime.db 不是纯缓存，不能随手删除。** 正文和元数据可从 MD 重建，采集证据、待处理任务、已注入版本回执不能全部重建。`memories`、`history`、`projects.json` 和 `spool` 同样需要保留。

导出可携带的记忆文件：

```sh
node dist/cli.js export /一个尚不存在的备份目录
```

导出包含 Markdown、历史与项目映射，不含运行队列或访问密钥。需要完整且一致的备份时，先停止服务，再复制整个数据目录，包括 SQLite 文件及可能存在的 WAL。

“撤回”指停止使用记忆，并阻止相同旧来源再次提炼成有效记忆。它保留审计历史，不等于物理擦除，也不能从已发送给模型的上下文中删除原文字节。对已注入的会话，下次召回会提供忽略旧版本的提示。

## 自动提炼如何工作

```text
宿主产生新消息 ──→ 本机 spool ──→ 事件去重、按会话合并任务
                                            │
                                    空闲 30 秒后串行提炼
                                            │
                           已登录 Codex CLI → 校验结构与来源
                                            │
                        明确证据：写 MD      不确定：待审核
                                            │
新会话 / 新一轮 ←── 全局 + 当前项目检索 ←── 更新本机索引
```

核心流程的伪代码：

```ts
onMessage(event):
  if event.isInjected || event.isWorker: return
  persistToSpool(event)

workerTick():
  ingestSpoolWithEventDeduplication()
  job = claimNextIdleSessionJob()
  proposals = codex.extract(job.events, relatedActiveMemories)
  for proposal in proposals:
    verifySourceIdsAndProjectScope(proposal)
    if sourceWasWithdrawn(proposal): continue
    if assistantOnly || uncertain || correctionVersionChanged:
      saveCandidateMarkdown(proposal)
    else:
      serializedWriteWithRevisionCheck(proposal)

recall(session, project, query):
  candidates = globalMemories + currentProjectMemories
  return versionChanges + boundedRelevantExcerpts(candidates, query)
```

同一个 Git 仓库的不同 worktree 使用 `git --git-common-dir` 归属同一项目；非 Git 项目按已登记目录匹配，也可以手动绑定别名。项目划分是相关性边界，不是不同本机用户之间的权限隔离。

提炼器使用 ephemeral、read-only、独立工作目录，关闭 Codex 原生记忆和 hooks，避免递归采集自己；不加载用户的 Codex config.toml，但继续使用原有登录凭据。可以在设置中指定 Codex 可执行路径和模型。

已识别的常见凭据格式会隐去；这不是通用秘密识别器。本机保存会话摘录，提炼会将待处理证据发送给 Codex 所用模型服务，并消耗该账户额度。

## 边界与验收

- 自动保存依赖模型判断，不承诺完美的语义去重或矛盾识别。失败任务保留，可重试；不确定内容进入候选。
- 搜索使用 SQLite FTS5 和中文分词，是关键词检索，不是向量语义搜索。每次注入正文预算约 6000 字符，长记录给出摘录和完整读取提示。
- DeepSeek 目前只自动采集真实用户消息，不解码 assistant 紧凑事件流。Hermes 不自动采集 subagent、cron 或 bot 发言。
- 暂不追溯宿主分支回退造成的历史证据变化。已经生效但后来不再适用的记忆，需要显式纠正或撤回。
- 本版提供六种适配器和安装配方；真实桌面 / CLI 宿主的加载、信任和模型使用情况，需要按各自版本验收。
- 不自动关闭现有原生记忆。先完成导入、审核、跨工具读写测试，再在宿主设置中切换，避免迁移中途失去记忆。

测试与实现记录见 [验收记录](docs/verification.md)。

```sh
pnpm typecheck
pnpm test
pnpm test:hermes
pnpm test:web
```

网页测试默认在 macOS 使用安装好的 Chrome。其他环境先执行 `pnpm exec playwright install chromium`，或通过 `UMEM_BROWSER_CHANNEL` 选择安装的浏览器。测试数据均在临时目录，截图放在 `.test-output/`。

macOS 登录启动项：

```sh
node dist/cli.js service          # 查看路径与启动方式
node dist/cli.js service --apply  # 先停止手动 serve，再执行
```

停用：`launchctl bootout gui/$(id -u)/local.user-memory`，再移除 `~/Library/LaunchAgents/local.user-memory.plist`。宿主接入配置和记忆数据保持原样。

## 项目文件

```text
src/
├── cli.ts / daemon.ts / server.ts / client.ts
├── contracts.ts / config.ts / mcp.ts
├── memory/         # Markdown、检索、事件队列、Codex 提炼
├── adapters/       # hooks、Pi、DeepSeek
├── integrations/   # 安装/撤销、原生记忆导入
└── web/            # React 管理页
adapters/hermes/    # Python stdlib provider，宿主要求 Python
tests/             # 核心、HTTP/MCP、安装和适配器契约测试
scripts/           # 浏览器与真实 stdio 验收
docs/              # 验收记录
```

依赖采用 Hono、MCP 官方 SDK、better-sqlite3、Zod、YAML、proper-lockfile 和 React；未实现自定义数据库、锁协议或 Agent 框架。
