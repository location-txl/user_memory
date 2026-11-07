# 实现验收记录

2026-11-06。本记录区分代码测试、协议连通和真实宿主验收。

## 已执行

| 项目            | 证据                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| TypeScript 编译 | `pnpm typecheck`、`pnpm build`                                                                           |
| Markdown 主存储 | 手工修改后检索更新；删除测试数据库后从 MD 恢复；无效文件保留并报告                                       |
| 并发修改        | 两个请求携带同一版本，只有一个成功；外部修改未递增 revision 时 etag 仍拒绝旧覆盖                         |
| 范围与生命周期  | 全局/当前项目召回、排除其他项目与候选、纠正提示、撤回提示、同源导入不复活                                |
| 提炼任务        | 去重、失败保留及重试、中断恢复、来源伪造拒绝、助手独立推测进入候选、版本冲突转候选                       |
| HTTP            | 真实本机监听，访问密钥、跨站拒绝、CRUD、版本冲突、单服务锁                                               |
| MCP             | 官方 Client 的内存传输握手 + 编译后 CLI 独立 stdio 进程握手；检索、写入、撤回、项目范围检查              |
| Hooks           | ZCode JSON 输入采集与召回；Codex 增量 transcript 的旧历史跳过、UTF-8 跨块、半行保留；离线 spool 重启消费 |
| 六种安装配方    | 隔离目录内预览不写入、应用、幂等、保留已有配置、卸载恢复、拒绝覆盖用户后续修改                           |
| Pi / DeepSeek   | 宿主接口契约 fixture：当前会话绑定、注入去重、保留既有 decision、用户来源识别、子会话排除                |
| Hermes          | Python 标准库测试：profile 实例隔离、无 cwd 仅全局、session 切换、bot/subagent 排除、凭据格式隐去        |
| 管理页          | 真实浏览器中的新增、编辑、撤回、导入预览、批准、设置持久化、无结果搜索、窄屏无横向溢出                   |

真实 Codex CLI `0.162.0` 已执行一次隔离提炼：输入为人工构造的“所有项目默认使用中文沟通”，输出为合法 JSON proposal，包含正确的 global 范围、preference 类型与 `synthetic-acceptance` 来源 ID。该验证没有读取用户历史会话，也未安装宿主 hooks 或改变其原生记忆设置。

网页测试图片：运行后位于 `.test-output/memory-desktop.png`、`.test-output/connections-desktop.png`、`.test-output/memory-mobile.png`。这些图片使用测试记录，不是用户真实记忆。

## GitHub Actions

`后端回归` 在 Ubuntu 24.04 上执行类型检查、全部 Vitest 测试和 Hermes 测试。它使用镜像自带的 Corepack 和 Python 3.12，按 `pnpm-lock.yaml` 缓存 pnpm store。

只改 `README.md` 或 `docs/` 的 PR 和 `main` 推送会跳过该工作流。PR 使用相对于目标分支的变更范围，同一个 PR 的新运行会取消旧运行。

`main` 的代码推送会并行检查这次推送包含的每个提交。各次推送独立运行，同一批中某个提交失败也不会取消其他提交。GitHub Actions 每次运行最多生成 256 个矩阵任务，超过这个数量的提交需分批推送。

如果以后启用必需检查，先把路径判断移到始终触发的工作流内，并提供一个对纯文档变更也会回报成功的合并检查。直接把当前按路径过滤的 `后端检查` 设为必需，会让纯文档 PR 一直等待。

## 尚未据此宣称通过的内容

六种真实宿主中的加载、信任、首次授权、新会话召回，以及模型最终使用记忆的行为，不能由 fixture 或 MCP 连通测试替代。当前没有自动改写用户的宿主配置、导入真实历史数据、关闭原生记忆，或安装登录启动项。

Hermes provider 的测试替换了宿主 ABC，不等同于实际 Gateway 加载测试。DeepSeek 插件接口依据官方源码，尚未在真实 DSH Host 中运行。Pi 扩展与各桌面版本同样需要实际加载验收。

可按下列顺序完成真实接入：

1. 启动服务，预览并应用一个宿主的配置，按宿主要求完成信任或重载。
2. 发送一条带唯一标记的长期偏好，例如“验收用的偏好标记是 memory-1106”。
3. 核对事件已采集、任务已完成、MD 中来源正确。
4. 在另一个已接入宿主中新建会话，要求检索该标记，核对模型回答。
5. 纠正或撤回，再确认下一轮召回的版本变化。
6. 完成原生记忆导入和审核后，再决定是否关闭宿主自带自动记忆。

## 接口依据

- [Codex 源码](https://github.com/openai/codex)，研究快照 `2c502d8`：hooks 的 JSON 输入/输出和 hooks.json 加载；记忆流水线的 workspace lock 与任务状态。
- 本地 ZCode 研究快照 `a9fe401e`：`apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts`、`packages/shared/src/workspace-hook-config.ts`，以及 desktop MCP 配置解析。
- 已安装 Pi `1.4.0` 的 `docs/extensions.md` 与 `docs/mcp.md`。
- [DeepSeek 扩展模式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)及 [MCP 接入规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md)：`agent/pre-step`、`session/event`、Cordis insert patch、stdio MCP。
- 本机 Hermes 源码的 `agent/memory_provider.py`、`agent/agent_init.py`、`hermes_cli/plugins.py`：provider 生命周期、profile 实例边界与 `cwd` 的真实传入路径。

这些实现细节会随宿主版本变化。安装器不会绕过宿主自己的 hook 信任，也不会把“服务收到了请求”标成“模型已正确使用记忆”。
