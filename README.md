# 公共记忆

在单台机器上，让 Codex、ZCode、Claude Code、Pi、DeepSeek Harness 和 Hermes 使用同一份全局与项目记忆。

**Markdown 是记忆正文和元数据的事实源。** 一个本机 TypeScript 服务负责自动写入；SQLite 保存采集事件、提炼任务、召回回执和搜索索引。没有向量数据库，也不需要额外的模型 API Key：后台提炼使用已登录的 Codex CLI。

## 编译并安装全局命令

需要 Node.js 24+、pnpm 10、npm，以及可用的 Codex CLI 登录。当前版本优先面向 macOS。源码用 pnpm 安装依赖和编译，编译产物用 npm 安装成全局命令 `umem`。

### 1. 编译与打包

在本项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
npm pack
```

`pnpm build` 生成 `dist/`，包含 CLI、服务端和网页。`npm pack` 将它们和适配器打成安装包；当前版本的文件名为 `local-user-memory-0.1.0.tgz`。以后版本号变化时，以下命令使用 `npm pack` 实际输出的文件名。

### 2. 使用 npm 安装到全局

```sh
npm install --global ./local-user-memory-0.1.0.tgz
umem --version
umem --help
```

这会安装本地编译的包，无需发布到 npm registry。全局安装后，可以在任意目录运行 `umem`。

如果提示 `umem: command not found`，先查看 `npm prefix --global`，确认该目录下的 `bin` 已在 `PATH` 中。使用 nvm 等 Node 版本管理器时，全局安装通常属于当前 Node 版本；切换 Node 版本后可能需要重新安装。

## 初始化并启动公共记忆

首次使用执行：

```sh
umem init
umem serve
```

`umem init` 创建默认数据目录 `~/.user-memory`、配置和访问密钥，重复执行会保留已有记忆。`umem serve` 也会自动初始化数据目录，可以直接运行。服务在当前终端前台运行，按 `Ctrl+C` 停止。

另开一个终端打开管理页、检查状态：

```sh
umem web
umem doctor
```

服务默认监听 `127.0.0.1:43123`。`web` 用 URL fragment 传递本机访问密钥，页面读取后立即移除 fragment，密钥只留在当前标签页的 sessionStorage。直接打开裸 URL 不会自动获得访问权限。

CLI 按 `--home`、`UMEM_HOME`、`~/.user-memory` 的顺序选择数据目录。使用默认目录时直接运行 `umem` 命令即可。自定义目录时，在执行命令的终端设置 `UMEM_HOME`，或在命令中显式指定目录：

```sh
umem --home /绝对路径/公共记忆 init
umem --home /绝对路径/公共记忆 serve
umem --home /绝对路径/公共记忆 web
```

开发界面使用 `pnpm dev`；后台仍需启动。日常使用构建后的管理页即可。`umem serve --no-worker` 暂停自动提炼，仍接受采集、检索和显式写入；此参数只影响本次运行。

## Codex 如何初始化接入

这里有两项独立的初始化：**Codex CLI 登录**供后台提炼使用，**`umem setup codex`** 将公共记忆接入 Codex 的 hooks 和 MCP。仅执行 `umem init` 不会修改 Codex 配置。

### 1. 确认 Codex CLI 已安装和登录

如果还没有安装 Codex CLI：

```sh
npm install --global @openai/codex
```

检查版本与登录状态：

```sh
codex --version
codex login status
```

如果尚未登录，再执行 `codex login`，按提示完成登录。已有可用登录时可以跳过。安装了 Codex 桌面应用不代表终端中的 `codex` 命令一定可用；后台提炼需要能启动该 CLI。

### 2. 给 Codex 安装公共记忆配置

保持 `umem serve` 运行，在另一个终端执行：

```sh
umem setup codex --dry-run  # 可选，预览将修改哪些文件
umem setup codex            # 备份并写入 hooks 和 MCP 配置
```

默认修改：

- `~/.codex/hooks.json`：添加 SessionStart、UserPromptSubmit 和 Stop hooks。
- `~/.codex/config.toml`：添加 `mcp_servers.user-memory`。

配置中使用当前 Node 和已安装 CLI 的绝对路径，不依赖 Codex 启动时能否从 PATH 找到 `umem`。这一步不导入旧会话，也不关闭 Codex 自带的记忆。

使用自定义公共记忆目录时，接入命令也需要指向同一目录。可以沿用 `UMEM_HOME`，或显式指定目录：

```sh
umem --home /绝对路径/公共记忆 setup codex
```

安装器默认按 `~/.codex` 写入。若 Codex 使用自定义 `CODEX_HOME`，当前安装器不会自动跟随该变量；需要将生成的 hooks 和 MCP 条目合并到实际配置目录，不能仅在默认目录运行完就视为接入成功。

### 3. 重启 Codex 并完成验证

重新启动 Codex CLI，或完全退出并重新打开 Codex 桌面应用，再新建会话。按宿主提示完成 hooks 信任；若相应版本关闭了 `codex_hooks` 功能，需要在宿主中启用。系统 CLI 与桌面应用内置运行时可能不同，分别验证。

```sh
codex mcp list
umem doctor
```

`codex mcp list` 应出现 `user-memory`；这表示已登记配置，实际工具调用还需验证。可以在新 Codex 会话中发送：

> 请调用公共记忆的 memory_remember 工具，记住一条全局偏好：我的验收标记是 umem-codex-1106。

然后再新建一个会话询问：

> 请从公共记忆中查找我的验收标记。

核对模型是否调用了公共记忆工具，并在 `umem web` 中检查正文和来源。自动采集另行验证：提交一条明确的长期偏好，等待默认 30 秒空闲期和提炼完成，再通过 `umem jobs`、`umem doctor` 查看任务和采集/召回时间。

只接入一次即可覆盖使用同一套 Codex 用户配置的新会话，无需在每个项目重复安装。项目范围会根据会话目录识别；目录别名可以用 `umem project bind` 登记。

## 更新或卸载全局命令

更新时，在源码目录重新执行 `pnpm install --frozen-lockfile`、`pnpm build`、`npm pack`，再用 `npm install --global ./新安装包.tgz` 覆盖安装。更新前先停止正在运行的服务，更新后重新启动。`~/.user-memory` 独立于 npm 安装目录，更新不会清空已有数据。

卸载时，先撤销已接入工具的配置，再卸载命令：

```sh
umem uninstall codex
# 其他已接入工具也分别执行 umem uninstall <agent>
# 随后停止 umem serve；若装过登录启动项，也先停用并移除它
npm uninstall --global @local/user-memory
```

卸载全局包不会删除记忆数据。macOS 登录启动项的停用方式见文末。

## 接入工具

先启动服务，再安装接入配置：

```sh
umem setup codex --dry-run  # 可选，预览配置变更
umem setup codex
umem doctor
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
umem uninstall codex --dry-run  # 可选，预览将恢复或移除的文件
umem uninstall codex            # 恢复原配置，保留记忆库
```

如果安装后配置又被手动修改，卸载会停止，保留备份供人工合并，不会覆盖用户的新修改。

Hermes 多 profile 分别指定实际目录：

```sh
umem setup hermes --hermes-home /绝对路径/hermes-profile
```

provider 按 `hermes_home` 区分会话来源，记忆仍写入指定的公共数据目录。没有宿主传入的 `cwd` 时只使用全局记忆；不会把 Gateway 的进程目录误当成项目。provider 切换会影响原生记忆，因此本安装器不自动修改 `memory.provider`，具体片段见命令输出。

## 日常操作

```sh
# 直接记住、查询、纠正和撤回
umem memory add '沟通语言' '默认使用中文沟通'
umem memory list --query 中文
umem memory get <id>
umem memory correct <id> '按用户新要求修正后的内容'
umem memory forget <id>

# 看当前项目实际会得到哪些记忆
umem recall '构建方式' --cwd /绝对路径/项目

# 将另一个目录绑定到相同项目
umem project list
umem project bind /另一个目录 --to <project-id>

# 失败任务不会无限重试，可检查后手动重试
umem jobs
umem jobs --retry <job-id>
```

网页支持相同的记忆编辑、候选批准、撤回、来源查看、修订历史、导入预览、任务重试和提炼配置。

「设置与任务」显示按请求模型汇总的提炼次数、输入、缓存输入、输出和总 token。界面用 K、M、B 简写较大的 token 数，悬停可查看原值。缓存输入已包含在输入 token 中，总量按输入加输出计算。`umem jobs` 可查看近期任务的分模型明细。分批和重试会累加，失败也会保留 Codex 已上报的用量。模型留空的调用归入「Codex 默认（模型未上报）」，未上报用量会单独标记。统计从升级后开始记录，使用支持 `codex exec --json` 的 Codex CLI。

MCP 提供 `memory_search`、`memory_get`、`memory_remember`、`memory_correct`、`memory_forget`。纠正和撤回必须带上最近读到的 revision 与 etag，避免旧会话覆盖新内容。检索返回摘录，完整内容用 `memory_get` 读取。

## 导入已有记忆

不会在安装时扫描所有历史会话。只读取你明确指定的 Markdown 文件或目录：

```sh
umem import /绝对路径/原生记忆目录 --dry-run  # 可选，仅预览
umem import /绝对路径/某条记忆.md
umem import /项目记忆目录 --project <project-id>
```

更推荐网页导入：先查看原文预览，再勾选文件。索引和汇总文件默认不选，避免重复；导入后统一进入待审核，批准后才参与召回。预览到确认期间源文件变动会拒绝导入。原文件不修改。

单次限制 200 个 Markdown 文件、4 层目录；每条记忆最多 16000 字符。较大的原生汇总请先拆分。本版按文件导入，不自动猜测其项目范围，也不自动分解长篇汇总。批量导入按文件保存；中途失败时已完成的记录保留，重复提交相同来源不会再建同一条记录。

## 最终存储文件

项目目录使用创建时的项目名称与本工具的完整项目 ID，固定保存在 `projects.json` 的 `memoryDirectory` 字段中；修改显示名称或绑定目录别名不搬动文件。同一 Git 仓库的多个 worktree 共用项目记忆，不按 Agent 分目录。

只读取全局及已登记项目目录直属的 Markdown 文件。文件名、范围和项目必须与所在目录一致，错放文件会报告错误且不加载。旧版平铺目录不再读取，不提供迁移或兼容。

```text
~/.user-memory/
├── memories/
│   ├── global/
│   │   └── <id>.md         # 全局记忆，Markdown 事实源
│   └── projects/
│       └── <name>-<projectId>/
│           └── <id>.md     # 项目记忆，Markdown 事实源
├── history/<id>/
│   └── <revision>-<hash>.md # 修改前的完整文件
├── projects.json           # 项目 ID、固定记忆目录、目录别名、Git common dir
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
umem export /一个尚不存在的备份目录
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
  proposals = codex.extract(job.events, relatedActiveMemoriesWithSourceExcerpts)
  for proposal in proposals:
    verifySourceIdsAndProjectScope(proposal)
    if sourceWasWithdrawn(proposal): continue
    if assistantOnly || uncertain || correctionVersionChanged:
      saveCandidateMarkdown(proposal)
    else:
      serializedWriteWithRevisionCheck(proposal)

recall(session, project, query):
  candidates = globalMemories + currentProjectMemories
  entries = versionChanges + relevantMemories(candidates, query) + stablePreferences
  reserveIndexesWithinContextBudget(entries)
  fillCompleteShortBodiesWithRemainingBudget(entries)
  acknowledgeOnlyDeliveredVersions(entries)
  return contextWithin6000Characters(entries)
```

参考 Anthropic 的 [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)，这里将注入上下文作为小型入口，完整 Markdown 与采集证据继续承担详细信息的保存：

- 召回先为版本通知和记忆索引预留空间，再按优先顺序填入完整短正文。正文超过 1600 字符或剩余预算不足时，仅注入标题、ID 和 `memory_get` 读取提示，避免截断后遗漏限定条件。返回的 `memories[].delivery` 区分 `full` 与 `index`；没有列出的内容仍可用 `memory_search` 搜索。
- 完整注入文本（包括说明、分隔符和版本通知）限制为 6000 个 JavaScript 字符单位，不是模型 token 数。超预算的版本变更保留旧回执，在后续召回继续通知；仅收到新版索引时，旧正文也已失效，使用前须读取新版。
- 后台提炼同时比较新事件与旧记忆的来源、时间和适用条件。旧来源最多携带最近三条、每条 1000 字符，并标记是否截断；这只是核对线索，不代表已经回查完整会话。新提案仍必须引用本批真实事件。
- 保存指引强调可复用的方法、验证过程和适用条件，兼顾成功经验与失败教训，避免保存可直接查询的实时状态。是否值得保存仍由模型判断，不新增自动过期或定时重写全部记忆的任务。

同一个 Git 仓库的不同 worktree 使用 `git --git-common-dir` 归属同一项目；非 Git 项目按已登记目录匹配，也可以手动绑定别名。项目划分是相关性边界，不是不同本机用户之间的权限隔离。

提炼器使用 ephemeral、read-only、独立工作目录，关闭 Codex 原生记忆和 hooks，避免递归采集自己；不加载用户的 Codex config.toml，但继续使用原有登录凭据。可以在设置中指定 Codex 可执行路径和模型。

已识别的常见凭据格式会隐去；这不是通用秘密识别器。本机保存会话摘录，提炼会将待处理证据发送给 Codex 所用模型服务，并消耗该账户额度。

## 边界与验收

- 自动保存依赖模型判断，不承诺完美的语义去重或矛盾识别。失败任务保留，可重试；不确定内容进入候选。
- 搜索使用 SQLite FTS5 和中文分词，是关键词检索，不是向量语义搜索。每次完整注入预算为 6000 个 JavaScript 字符单位，长记录给出索引和完整读取提示。
- DeepSeek 目前只自动采集真实用户消息，不解码 assistant 紧凑事件流。Hermes 不自动采集 subagent、cron 或 bot 发言。
- 暂不追溯宿主分支回退造成的历史证据变化。已经生效但后来不再适用的记忆，需要显式纠正或撤回。
- 本版提供六种适配器和安装配方；真实桌面 / CLI 宿主的加载、信任和模型使用情况，需要按各自版本验收。
- 不自动关闭现有原生记忆。先完成导入、审核、跨工具读写测试，再在宿主设置中切换，避免迁移中途失去记忆。

测试与实现记录见 [验收记录](docs/verification.md)。

```sh
pnpm typecheck
pnpm test:backend
pnpm test:integration
pnpm test
pnpm test:hermes
pnpm test:web
```

`pnpm test:backend` 在临时目录测试 Markdown、SQLite 和后端接口，包括 Hermes 的 Python 用例，无需启动服务。只改记忆模块时可运行 `pnpm exec vitest run tests/backend/memory/`。`pnpm test:integration` 验证本机 HTTP、真实 MCP stdio 和 CLI 子进程。`pnpm test` 运行全部 TypeScript 用例。PR 会自动执行类型检查、完整 TypeScript 测试和 Hermes 测试，纯文档变更跳过。触发范围见[验收记录](docs/verification.md#github-actions)。

网页测试默认在 macOS 使用安装好的 Chrome。其他环境先执行 `pnpm exec playwright install chromium`，或通过 `UMEM_BROWSER_CHANNEL` 选择安装的浏览器。测试数据均在临时目录，截图放在 `.test-output/`。

macOS 登录启动项：

```sh
umem service install --dry-run  # 查看启动项路径
umem service install            # 先停止手动运行的 umem serve
umem service install --force    # 替换启动项配置并重新加载
umem service uninstall          # 停止服务并移除启动项
```

普通安装会保留已有启动项配置，若已加载则直接返回。要更新启动项使用的 Node 路径或 `--home`，请使用 `install --force`，服务会短暂重启。卸载保留宿主接入配置和记忆数据。

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
tests/             # backend 快测、integration 集成测试及 Hermes/网页单元测试
scripts/           # 浏览器与真实 stdio 验收
docs/              # 验收记录
```

依赖采用 Hono、MCP 官方 SDK、better-sqlite3、Zod、YAML、proper-lockfile 和 React；未实现自定义数据库、锁协议或 Agent 框架。
