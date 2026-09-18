# 仓库迁移与历史保全记录

检查日期：2026-09-18。本文件保存原 fork 转换方案的只读核查与本地保全证据，并记录同日批准的新迁移方案。本文件可入库；本地二进制与平台记录归档不能随代码发布。

## 当前采用的方案

用户已批准保留当前本地 Git 历史，新建独立远端 `fx1226/kimi-code-switch`，先推送 `master` 并验证对应提交的 CI。CI 通过后，在旧仓库 `fx1226/kimi-code-switch-gui` 的 README 顶部添加中英迁移说明，再归档旧仓库。旧仓库的 fork 关系、名称、Release、全部资产及历史 tags 均保留；不执行 detach、改名或删除重建，不向新仓库推送旧 tags，不发布新版本。

**原先的改名与解除 fork 方案已被取代。** 下文关于 detach 的影响与出口条件仅为历史记录，不是当前待办。Wiki/Projects 的原核查缺口仍如实保留；本方案不删除旧仓库或迁移这些平台对象，因此不以补齐 detach 损失清单作为当前迁移的前置条件。

迁移已完成。API 确认新仓库 `full_name=fx1226/kimi-code-switch`、public、`fork=false`、默认分支 `master`。本地 `origin` 指向新仓库，`legacy` 保留旧仓库，`upstream` 保留来源引用。重构提交 `81571f336721ca7b89dca13fa39de495e4b8550f` 已推送，远端 SHA 与本地一致；GitHub compare 确认原 HEAD `f98fd7f958773af5f2456c795819a8f16b77cb5b` 为其祖先。具体流程见 [维护者工作流](maintainer-workflow.md)。

- [x] 新建 `fx1226/kimi-code-switch`，核实为 public 独立仓库，`fork=false`。
- [x] 更新本地远端：`origin` 指向新仓库、`legacy` 保留旧仓库、`upstream` 保留来源引用。
- [x] 保留本地历史，只推送 `master`，核对远端提交 SHA，并设置默认分支为 `master`。
- [x] 对实际推送提交的 CI 验证通过；未创建新 Release、未推送历史 tags。
- [x] 在旧仓库原 README 顶部添加中英迁移说明，确认链接指向新仓库且说明 Web 尚未正式发布。
- [x] 归档旧仓库，复核旧 Release、全部 6 个资产及 28 个历史 tag 保留。

[首次 CI 35318635825](https://github.com/fx1226/kimi-code-switch/actions/runs/35318635825) 对应上述重构提交：Ubuntu / Node 22 上类型检查、58 个文件共 925 项测试、Web 与服务端构建通过。package、release 两个 job 按分支推送规则跳过；此次未执行远端发版。

旧仓库 README 更新提交为 [`97f38ed7ab143efc0d9feba527de00200e03c1ee`](https://github.com/fx1226/kimi-code-switch-gui/commit/97f38ed7ab143efc0d9feba527de00200e03c1ee)，已读回确认只在原文前增加迁移说明。随后 API 确认 `archived=true`、`fork=true`。归档前后对比确认：原 `v2.2.7` Release 的 ID、正文和发布时间未变，6 个资产的 ID、名称、大小、digest 和下载 URL 未变，28 个 tag 的 SHA 未变。旧 `master` 仅前进到 README 提交。公开核查摘要见 [repository-transition.json](../output/refactor-qa/repository-transition.json)；完整平台响应保留于本机未入库归档。

## 迁移前的仓库与平台快照

以下是原方案审查时的快照，不表示迁移后的状态。来源为当时认证的 GitHub REST/GraphQL API、`git ls-remote` 和本地 refs。首次部分请求遇到代理 EOF，重试结果与首次错误均已保留。

| 项目 | 已核实结果 | 归档内证据 |
|---|---|---|
| 当前仓库 | `fx1226/kimi-code-switch-gui`，public fork，当前账号有 admin 权限 | `metadata/repository.json` |
| 上游 | `sunhao-java/kimi-code-switch-gui` | `metadata/repository.json` |
| 默认分支 | `master`，HEAD `f98fd7f958773af5f2456c795819a8f16b77cb5b` | `metadata/branches.json` |
| GitHub refs | 1 个分支、28 个 tag，合计 29 个 branch/tag refs | `metadata/git-refs.json`、`metadata/remote-refs.txt` |
| 大小 | GitHub 报告 `37041` KiB | `metadata/repository.json` |
| stars / watchers / child forks | 均为 0 | `metadata/stargazers.json`、`metadata/subscribers.json`、`metadata/forks.json` |
| issues / PRs / comments | all-state issues、PRs、issue comments、commit comments 均为 0；Issues 当前未开启 | 对应 `metadata/*.json` |
| Discussions | 功能未开启；GraphQL 总数 0 | `metadata/discussions.json` |
| Wiki | 功能开关开启；wiki Git endpoint 返回 `Repository not found`，未获取到内容，不能据此保证不存在平台残留 | `metadata/wiki-refs.txt` |
| Projects | 功能开关开启；Projects v2 缺少 `read:project` scope；classic endpoint 返回 HTTP 404，实际状态未验证 | `metadata/discussions-projects.error.txt`、`metadata/projects-classic.retry-1.error.txt` |
| Webhooks / deploy keys / environments | 可见列表均为 0 | 对应 `metadata/*.json` |
| Secrets / variables | Actions、Dependabot、Codespaces 的 secret 名称列表及 Actions variable 名称列表均为 0；未请求任何 secret 值 | 对应 `metadata/*.json` |
| 分支保护 / rulesets | `master` 未保护；rulesets 为空 | `metadata/branches.json`、`metadata/master-protection.retry-1.error.txt`、`metadata/rulesets.json` |
| Actions | 开启、允许所有 actions、未要求 SHA pinning；默认 workflow 权限 read，不允许批准 PR review | `metadata/action-permissions.json`、`metadata/workflow-permissions.json` |
| 工作流及历史 | 1 个 active workflow `Release Installers`；6 个运行记录，已保存元数据，未归档运行日志及 artifact 内容 | `metadata/action-workflows.json`、`metadata/action-runs.json` |
| 协作者 | 只有 `fx1226`，角色 admin | `metadata/collaborators.json` |
| Pages | 仓库开关关闭，API 返回 HTTP 404 | `metadata/repository.json`、`metadata/pages.retry-1.error.txt` |

`FINAL-MANIFEST.json` 是最终结果，`manifest.json` 只记录首次查询，可能包含已在重试中解决的网络错误。

## 保全材料与实际验证

归档位于维护者私有本机工作区的 `output/repository-preservation-20260918/`，不提交或公开其中的快照、平台元数据及二进制资产。目录权限 `0700`、文件权限 `0600`，约 108 MiB。`.gitignore` 仅新增 `/output/repository-preservation-*/`，不影响其他用户素材及验收截图。

- `repository-all-refs.bundle` 包含 38 个本地 refs，覆盖全部 29 个远端 branch/tag refs，以及本地 remote/checkpoint refs。逐项 SHA 匹配通过；`git bundle verify` 通过；从 bundle 创建临时镜像克隆并执行 `git fsck --full` 通过，临时克隆已删除。
- `metadata/release-v2.2.7.json` 保存 Release 标题、正文、时间和资产元数据；`metadata/releases.json` 确认当前仅此一个 Release。
- `release-v2.2.7-assets/` 保存全部 6 个资产，每个文件的大小及 SHA-256 均与 GitHub digest 一致；发布的三个 checksum 文件也与对应安装程序一致。
- `SHA256SUMS` 覆盖归档内文件，实际执行 `shasum -a 256 -c SHA256SUMS` 全部通过。`README.md` 说明恢复检查方式及边界。

现有 Release 为 [`v2.2.7`](https://github.com/fx1226/kimi-code-switch-gui/releases/tag/v2.2.7)，发布时间 `2026-09-15T09:24:59Z`：

| 资产 | 字节数 | SHA-256 |
|---|---:|---|
| `kimi-code-switch-gui-2.2.7-mac-arm64.dmg` | 27,741,406 | `ba4018c284daacdb620c8be48950ce9732d373f47cd8b572143862a94d8361e5` |
| `kimi-code-switch-gui-2.2.7-mac-x64.dmg` | 29,447,033 | `07e9e335d91fe9e9369f68281aec9d1b23f2e31919af0e76181a85eac0c95f48` |
| `kimi-code-switch-gui-2.2.7-win-x64-setup.exe` | 19,011,749 | `8da9a25fcb860beda337efc3133c42bdb931dcc5a985c7abddc5cc19cbe75b02` |
| `SHA256SUMS-macos-arm64.txt` | 107 | `3ec421da748a16dcee42c76048bb56355be52c4fbb7587960e4265b9375b2808` |
| `SHA256SUMS-macos-x64.txt` | 105 | `419a5b618932390300e0a68b38e4994ee9897133690dd6e6e19ad8d2a34e041e` |
| `SHA256SUMS-windows-x64.txt` | 111 | `24f8d90f3af74c496d4abbfc9d33287d84f0445cee144deecb8ce33bec0d1fa8` |

Git bundle 不包含未提交工作。重构前工作区另保存在 `/tmp/kimi-code-switch-refactor-baseline-20260918/`；此临时目录不应替代待交付改动的正常 Git 提交及独立备份。

## 已取代方案的恢复能力与不可逆影响（历史记录）

以下评估针对原先的 detach 方案。当前方案保留旧仓库，不执行这些操作，也不需要重建其 Release 或资产。

GitHub 官方说明：离开 fork network 是永久操作，之后不能重新接回；Git commit 元数据会保留，但现有 issues、PRs、wiki、stars、watchers、comments、child forks 及其他平台元数据不会保留。官方 UI 入口只适用于 public、大小小于 1 GB、没有 child forks 的 fork。当前 API 数据满足这三项条件，尚未验证操作时 UI 的实时资格。[GitHub：Detaching a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork)（2026-09-18 核实）

| 内容 | 本次保全能力与剩余风险 |
|---|---|
| Git commits、branches、tags | bundle 已实际恢复验证，可在独立目录恢复对象与 refs，无需删除当前仓库 |
| Release 正文与资产 | 可作为人工重建依据；不能保证原 Release/asset ID、URL、下载计数及时间戳保留 |
| stars、watchers、child forks、issues、PRs、comments | 当前数量为 0；后续新增内容不在此次快照中，操作前应复核 |
| Wiki / Projects | 未完整核实，不能按“没有内容”处理；需通过管理界面核对，或取得适当只读权限后补查 |
| Actions 及平台设置 | 已保留安全可见设置与运行元数据；日志、artifact 内容、平台内部 ID/关系不在恢复保证内，转换后需逐项核对 |
| Credentials | 未导出 secret 值；当前可见名称为空。今后如有新增，应从维护者原密钥来源重新配置 |
| fork 关系 | 本地备份不能恢复；离开后的上游 network 关系不可逆 |

## 已取代方案的单独确认条件（历史记录，不执行）

原方案拟定的出口条件如下，已随方案变更退出当前待办：

- [ ] 重构代码、真实浏览器流程及自包含产物达到对应验收条件。
- [ ] 操作前刷新 GitHub refs、Release、平台计数；新增内容补充归档并校验。
- [ ] 补查 Wiki、Projects 的未验证项，明确 Actions 日志/artifact 是否需另行保留。
- [ ] 将归档复制到维护者选择的可靠保存位置，复核 `SHA256SUMS`；本轮未上传保全材料。
- [ ] 展示最终实际损失清单，对正确仓库的不可逆 “Leave fork network” 操作取得一次单独确认。
- [ ] 确认后才实施仓库名称及 fork 关系转换，核对 Release、workflow、权限和链接，更新本地 remote；不自动采用删除仓库再创建的兜底方式。

原只读核查与保全完成时，远端仓库保持不变。这一历史记录不表示需要继续请求 detach 确认；当前迁移以本文顶部的新方案和验收项为准。
