# 发布 npm 包和 GitHub Release

## 首次配置

发布工作流合入后，打开 npm 上 `@location-txl/umem` 的包设置，在 Trusted Publisher 中选择 GitHub Actions。

| 设置                 | 值                     |
| -------------------- | ---------------------- |
| Organization or user | `location-txl`         |
| Repository           | `user_memory`          |
| Workflow filename    | `release.yml`          |
| Environment name     | 留空                   |
| Allowed actions      | 允许直接 `npm publish` |

新配置须在两天内完成首次成功发布。配置说明见 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。

## 发布版本

确认待发布的提交已通过回归，且 npm 上还没有这个版本，然后在该提交上创建并推送标签。

```sh
git tag 1.0.0
git push origin refs/tags/1.0.0
```

发布版本取自标签。即使仓库的 `package.json` 仍为 `0.1.1`，这个标签也会发布 `@location-txl/umem@1.0.0`。解开 npm 下载的 `.tgz` 或查看安装目录，包内的 `package.json` 都是 `1.0.0`，CLI、MCP 和 Hermes 也使用该版本。GitHub 上标签对应的源码仍来自原提交，里面的 `package.json` 是 `0.1.1`。

正式版发布到 npm 的 `latest`。例如，`1.1.0-beta.1` 会发布到 `next`，GitHub Release 也会标为预发布。标签可以带 `v` 前缀，每个版本只推送一种写法。标签支持 SemVer 预发布后缀，不能带 `+` 构建元数据。

## 失败恢复

在 GitHub Actions 中查看出错的任务。若 npm 发布成功而 GitHub Release 失败，选择 **Re-run failed jobs**，只补发 Release。若 npm 任务报版本已存在，先核对 npm 上的版本是否为预期产物，再决定为该标签手动补建 Release，或用新版本发布修正。
