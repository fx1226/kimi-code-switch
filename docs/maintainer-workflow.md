# 维护者工作流

本文仅在用户请求提交、推送或发布时执行。普通开发修改不自动提交或发布。

## 提交与推送

用户请求“提交代码”“commit code”或“push 代码”时，依次完成：

1. 用 `git status`、`git diff` 检查实际改动，参考 `git log` 的提交风格。
2. 生成小写 Conventional Commit 前缀的提交信息，只暂存本次相关文件，保留其他未提交工作。
3. 核对 `git remote -v` 与目标仓库的实际身份，再正常提交并推送至 `origin master`，无需重复确认已授权动作。独立仓库迁移完成后，`origin` 必须指向 `fx1226/kimi-code-switch`；迁移期间按下文的已批准步骤操作，不把 Web 重构推向旧 fork。
4. 检查实际推送结果及对应提交的 CI，报告提交与远端状态。GitHub CLI/API 明确指定目标仓库，避免因本地 fork 元数据误查上游。

SSH 停滞时可使用：

```bash
GIT_SSH_COMMAND='ssh -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2' git push origin master
```

保留 hooks；失败后修复原因再创建提交，不用 `--no-verify` 或为此 `--amend`。没有明确授权不得向主分支强推。密钥、连接 token、个人配置和未脱敏备份不进入提交。

## 发布新版本

1. 用户提供版本时要求小写 `vX.Y.Z`；未提供时获取 tags，读取最新 `v*` 并递增 patch。版本必须严格递增。
2. 更新 `package.json` 与 lockfile 版本。服务和前端版本由构建注入，搜索旧版本检查其他引用。
3. 在 `CHANGELOGS/{zh-CN,zh-TW,en-US,ja-JP,de-DE,es-ES}.md` 添加日期与对应版本段，六种语言保持相同结构。根 `CHANGELOG.md` 只作为索引；README 中存在版本引用时同步修改。
4. 运行类型检查、测试和完整 `npm run build`；执行 `npm run check:package`，检查产物、SHA-256 与浏览器和原生文件验收记录。
5. 按上述提交流程提交、推送。提取本次 `CHANGELOGS/zh-CN.md` 段落写入临时文件，以该文件创建 annotated tag，然后推送 tag。
6. 对 `fx1226/kimi-code-switch` 检查实际 GitHub Actions 与 Release。标题必须严格等于 `vX.Y.Z`，正文由本次中英 changelog 段组成，描述性文本不放在标题。
7. 核对实际发布的 macOS arm64 压缩包、SHA-256 和 formula。公式 URL 与校验和须对应已发布资产；生成 formula 不等于 tap 已更新，分别报告。

工作流源为 `.github/workflows/release.yml`。当前分发是本地 Web 自包含压缩包，不再构建 DMG 或 NSIS。

## 独立仓库迁移

2026-09-18 已批准采用**保留本地 Git 历史、新建独立仓库**的方案，取代原先的仓库改名与解除 fork 方案。目标为 `fx1226/kimi-code-switch`；旧仓库 `fx1226/kimi-code-switch-gui` 保留现有名称和 fork 关系，保留旧 Release、全部资产和历史 tags。批准范围包括创建新仓库、推送 `master`、验证 CI、更新旧仓库 README 迁移说明及归档旧仓库；不包括发布新版本、推送旧 tags 或删除任何仓库。

1. 复核目标仓库是否存在及其身份，检查本地待提交内容与已完成验证；保留当前 Git 历史、MIT 许可和来源声明。
2. 创建独立的 `fx1226/kimi-code-switch`，不初始化另一套 README 或历史；保留旧远端引用，并将 `origin` 指向新仓库。
3. 只推送 `master`，检查新仓库默认分支、实际提交 SHA、`fork=false` 和对应提交的 CI。不得使用 `--mirror`、`--all`、`--tags` 或 `--follow-tags` 带入其他 refs；本地历史 tags 不等于要在新仓库重新发布的版本。
4. 新仓库对应提交的 CI 通过后，在旧仓库原有 README 顶部添加中英迁移说明，指向新仓库，说明旧桌面 Release 和资产保留、Web 版本尚未发布。旧 README 的其余内容及已有 Release 保持原样。
5. 推送并核对旧 README 后归档旧仓库。最后复核新仓库的分支、CI、fork 状态，以及旧仓库归档状态、迁移链接、Release 与资产完整性，记录实际结果。

当前执行进度和历史保全证据见 [仓库迁移记录](repository-detach-review.md)。文档或品牌名称变更不能替代上述远端验证。旧方案中的 `Leave fork network`、改名和删除重建均不执行，也不是本次迁移或后续发行的前置条件。将来若另行提出此类操作，须重新核对实际影响并取得相应授权。
