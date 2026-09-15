# Kimi Code 0.38 剩余对齐实施计划

> 文件定位：本文件只描述当前工作树中**尚未完成**或**尚未被充分证明完成**的内容。
> 历史调研和已完成改动可参考 `docs/kimi-code-0.38-alignment-plan.md`，但后续实施、验收和完成判断以本文件为准。

## 1. 基线、范围和当前证据

### 1.1 固定官方基线

- 官方版本：`@moonshot-ai/kimi-code@0.38.0`
- 官方提交：`0999454bdcb5ddd98f39bffee434dcf0a810f394`
- 发布日期：2026-08-20
- 本地只读源码副本：`/private/tmp/kimi-code-upstream-038-audit`
- 核心官方契约：
  - `config.toml` / `tui.toml` / `.kimi-code/local.toml`
  - user、Git-root、cwd-local 三层 MCP 与 workspace trust
  - Skills roots、frontmatter、递归、优先级和 Built-in Skills
  - Plugin `installed.json`、manifest、marketplace 与生命周期
  - Provider catalog/custom registry
  - Node SDK MCP OAuth RPC

后续不得直接以官方 `main` 作为测试基线。升级基线必须先固定新 tag/commit，再独立更新 fixtures 和本文件。

### 1.2 目标边界

本项目应成为官方 Kimi Code 的桌面控制面，而不是第二套 Agent runtime：

1. 官方文件和官方 SDK/API 是运行时真相源。
2. GUI 专属 SQLite 只保存面板元数据、历史、用量和兼容缓存。
3. 可稳定调用官方 service/RPC 时，不自行重写 installer、OAuth store 或 runtime。
4. 无稳定结构化入口时，允许明确降级到官方交互式 TUI，但 UI 必须说明能力边界，不能伪装成自动完成。
5. 多环境、备份和历史属于 GUI 扩展能力，但不得破坏 `KIMI_CODE_HOME` 隔离、workspace trust、凭据权限或外部修改保护。

### 1.3 已有验证证据及其限制

最近一次完整门禁曾通过：

- 前端/共享：50 个测试文件、744 项测试。
- Rust：97 项通过、1 项依赖外部网络包的测试 ignored。
- 语句/行覆盖率：80.57%。
- `npm run build:web`、`npx tsc --noEmit`、`cargo test` 通过。
- 更晚新增的危险备份确认与 Plugin 风险清单已有 150 项聚焦测试通过。

限制：危险备份确认等最新改动之后尚需再次执行完整门禁。因此上述结果是阶段性证据，不是最终发布证据。

## 2. 剩余工作总览

状态列说明：下表反映「2026-08-26 实施轮」+「2026-09-15 推进轮」后的真实状态；标注完成依据见第 11/12 章。2026-09-15 轮重新修复 B1 授权来源、补全 B4 完整清单与 C2 人工恢复 UI、并修复恢复 apply 竞态；F3 重开，需在收口与 D 系列推进后重跑完整门禁。

| ID | 优先级 | 领域 | 状态 | 发布影响 |
| --- | --- | --- | --- | --- |
| B1 | P0 | Rust 文件系统授权与最终 symlink 边界 | 已完成（2026-09-15 重新修复：durable grant 改由 Rust 原生 dialog 生成并以 Rust 侧 store 持久化；backup_local_path 不再作为授权来源；含 pick_backup_directory） | 阻断发布 |
| B2 | P0 | portable directory 最终 revision 复核 | 已完成 | 阻断发布 |
| B3 | P1 | Provider 自定义 URL 的真实请求边界 | 已完成（2026-09-15 用户决策：接受已文档化的残余 DNS-rebinding/redirect 边界，保留 GUI 自动导入并保持 trust 确认文案；真实请求层约束需官方 SDK transport 后再收口） | 阻断安全验收 |
| B4 | P1 | 备份危险内容审查覆盖所有恢复入口 | 已完成（2026-09-15 补齐：风险清单不再截断，UI 完整可滚动/复制；local/WebDAV 统一门禁） | 阻断安全验收 |
| C1 | P0 | 保存请求串行化/latest-wins | 已完成 | 阻断发布 |
| C2 | P0 | 损坏/未知 journal quarantine 与恢复 UI | 已完成（2026-09-15 补全人工恢复：查看脱敏摘要/导出 journal/放弃/选择 original|desired + 写前 revision 复核 + 审计结果；quarantine+只读恢复保留） | 阻断发布 |
| C3 | P0 | regular/full/history restore crash journal | 已完成（full/regular 统一 journal；history 目录由 B2 复核+回滚点） | 阻断发布 |
| C4 | P1 | 历史文件权限、schema transaction、目标重绑定 | 已完成（本实施轮补齐 schema migration savepoint + rollback 测试） | 阻断迁移可靠性 |
| C5 | P2 | optimistic revision guard 的竞态模型 | 已完成（命名/文档统一为 optimistic revision guard；竞态+恢复路径已在 fileSnapshots/fs_access 注释） | 需文档化或改善 |
| D1 | P1 | Plugin marketplace 与完整生命周期 | 未开始（需官方 service/KAP/Node SDK） | 功能未拉齐 |
| D2 | P1 | Built-in Skills 实际 catalog | 未开始（需版本匹配的官方 package 枚举） | 内容视图未拉齐 |
| D3 | P1 | Custom Agents / `extra_agent_dirs` catalog | 未开始（需 Agents 目录契约实现） | 内容视图未拉齐 |
| D4 | P1 | MCP 定向结构化 OAuth begin/complete/reset | 未开始（上游 node-sdk 有 RPC 表面，需 harness 集成） | 功能未拉齐 |
| D5 | P2 | SSE/OAuth MCP GUI workbench | 部分完成（stdio+Streamable HTTP） | GUI 测试能力未拉齐 |
| D6 | P2 | 非默认环境 OAuth/账号管理 | 仅安全禁用（符合计划允许降级） | 多环境能力不完整 |
| E1 | P1 | 高级 `config.toml` 结构化管理 | 部分完成（secondary_model 结构化+alias 校验；builtin_product_skills 显式值跟踪；[thinking]/[mcp] 等项目由契约 fixture 保证往返透传） | 配置管理基本拉齐 |
| E2 | P2 | TUI explicit/effective 单一 schema | 已完成（ExplicitTuiConfig=EffectiveTuiConfig 分离、单一 normalizeTuiConfig schema、官方 fixture 差分） | 长期易漂移 |
| E3 | P2 | project-local config 的备份策略 | 已完成（方案 1：可移植备份排除 + backup.ts 注释说明；如需项目映射恢复需单独授权） | 灾难恢复边界清晰 |
| F1 | P1 | 官方契约 fixtures 与差异 CI | 已完成（新增 plugin/provider-registry fixtures+断言） | 防漂移已就位 |
| F2 | P2 | 兼容性状态页和升级 SOP | 已完成（about 页五档分类+基线+风险提示；SOP 文档落地） | 维护能力已就位 |
| F3 | P0 | 最终完成审计、全量构建与安全复核 | 重开：本轮已验证 tsc/build:web/cargo test 与 867 项 vitest，但需在收口提交与剩余功能主线后重跑计划 7 章完整门禁（Tauri 全量 build、npm audit、secrets scan、安全与官方交叉验证） | 阻断完成声明 |

## 11. 本轮完成证据（2026-08-26 实施轮）

- B1：`fs_access.rs` 新增 `PathGrantState`（受管根 + Rust dialog durable grant + 项目根组合写），移除「任意绝对路径默认允许」分支；symlink 解析后复核最终目标；新增 `/etc/../../`、symlink 逃逸、grant 类型/sibling、吊销测试。renderer 侧 `saveFile`/导出密钥改走 `save_file_with_dialog`，`saveProjectAdditionalDirs` 改走 `write_project_local_config`，启动 `reconcile_durable_grants` 重建备份/环境目录授权。
- B2：`replace_portable_directory` 在 staging 完成后、首次 rename 前重算目标 revision，不符则清理 staging 返回 external-change conflict（不触碰目标）+ 专用测试。
- C1：`saveCoordinator.ts` 单队列 latest-wins：immediate 高频合并只落最终值、显式保存保留 Promise 结果、first-a-failure-second-not-dropped、关闭前 `waitForExplicitFlush`。100 次爆发合并用例通过。
- C2：损坏/未知版 journal 原子移入 `quarantine`（0700/0600，Rust 命令），unknown 进入只读恢复模式不阻塞启动；App 顶部恢复横幅（放弃/关闭）+ 6 语言文案；`pending-restore-transaction.json` 也纳入。
- C3：统一 `RestoreTransactionRecord`（kind=restore-app-state，textFiles+panel），`beginRestoreTransaction`(prepare)→apply→`completeRestoreTransaction`(commit)；启动 `recoverPendingRestoreTransaction` 逐资源分类 original/desired/unknown，mixed 补全 desired，unknown 交人工恢复。
- B3：确认 HTTPS+DNS 预检已在 Rust；把「可能重定向到其他主机」写入 trust 确认文案，并加边界注释（不伪装为完整 SSRF）。
- B4：新增 `assessRestoreDocumentsRisk` 文档级审查（hooks/stdio MCP/remote endpoint/AGENTS，URL 脱敏），`restoreBackupSafe` 默认拒绝 `dangerous-content`，UI `allowRisk` 确认后重试；测试覆盖 local/WebDAV 恢复的危险门禁。
- F1：新增 `plugins/installed.json`、`plugins/managed/kimi-datasource/kimi.plugin.json`、`provider-registry/catalog.json` fixture + manifest 不可变 URL + contract 断言（3 项）。
- F2：about 页新增「官方兼容性状态」区块（基线 version/commit/date + 本机 CLI 版本 + 五档能力表 + 高于基线风险提示），6 语言文案；`docs/kimi-code-upgrade-sop.md` 落地升级 SOP。
- F3：`npx tsc --noEmit` 0 错；`npm test` 52 文件 759 项通过；`npm run build:web` 成功；`cargo fmt --check` + `cargo test` 101 passed / 1 ignored；`npm audit` 0 漏洞；`git diff --check` 干净；secrets scan 无真实凭据；完整 `npm run build`（Tauri release）产出 .app + .dmg。
- C4（补）：`ensure_config_history_environment_column` 多步 schema 迁移统一纳入 SAVEPOINT（`cfg_history_migration`），失败回滚到旧 schema；`migrate_config_history_unique_constraint` 内部改 SAVEPOINT 支持嵌套；新增 `migration_failure_rolls_back_environment_column_to_legacy_schema` 测试（注入 RENAME 冲突 → 列/索引/数据完整回滚 → 排除冲突后可重试成功）。
- C5（补）：CAS 语义统一命名/文档为 optimistic revision guard：`fileSnapshots.ts` 顶部新增竞态模型 + 用户恢复路径注释；`fs_access.rs::write_text_cas` 加 optimistic-guard 说明；`types.ts::tuiConfigSha256` 注释对齐。
- E3（补）：确认 local.toml 在可移植备份中被有意排除（`buildBackupFiles` 只收集 `$KIMI_CODE_HOME` 下文件），并在 `backup.ts` 添加方案一决策注释（含排除理由与未来「项目映射恢复」需单独授权）。
- E2（本轮）：完成 TUI Explicit/Effective 单一 schema。`types.ts` 新增 `ExplicitTuiConfig`（= 现有 `TuiConfig`，文件显式值）与 `EffectiveTuiConfig`（官方默认后不可空）；`tuiStore.ts` 新增 `EFFECTIVE_TUI_DEFAULTS`（对齐上游 `apps/kimi-code/src/tui/config.ts`：theme auto / renderLatex true / disablePasteBurst false / cacheExpiryHint true / editorCommand null / notifications{enabled:true,condition:unfocused} / upgrade.autoInstall true / statusLine 默认空）+ `normalizeTuiConfig(explicit)` 单一 schema；`parseTuiConfigDocumentWithDiagnostics` 返回值新增 `effective`。测试：显式/默认分离、空 command→null、未知 status_line 过滤；`kimiCodeContract.test.ts` 用官方 `tui.toml` fixture 做 effective 差分。
- E1（本轮）：高级 `config.toml` 结构化管理落地两级——(1) `secondary_model`：`configStore.ts` 新增 `extractSecondaryModel`（从 `extra.secondary_model` 解析显式值）与 `setSecondaryModel`（结构化 serializer，空则删除表回官方默认）；`configSafety.ts::validateModelReferences` 增加 `config.secondary-model.missing` error（与 default_model 同规则校验 alias 存在性）。(2) `builtin_product_skills`：parse 时纳入 `explicit_fields` 区分「文件显式出现」与「缺省 true」，且不物化默认；doctor 对显式 `false` 输出 `config.builtin-product-skills.disabled` info。测试 7 项。其余字段（thinking.keep / token_counting / subagent / [mcp] timeout / permission / tools / image / identity）维持契约 fixture 保证的 unknown-passthrough 往返（数据不丢），UI 如实展示能力边界。

### 未列入本轮、需单独授权或官方 SDK 集成的项

以下项在本轮「代码改动」范围内未实施，理由为计划第 9 章明确「不复制官方 runtime / 不自行实现第二套 installer / OAuth store」，且需要官方 service、KAP API、Node SDK harness 或 marketplace 的稳定入口：

- D1 Plugin 生命周期（install/update/remove/enable/marketplace）
- D2 Built-in Skills 实际 catalog（需版本匹配官方 package 枚举）
- D3 Custom Agents / `extra_agent_dirs` catalog
- D4 MCP 结构化 OAuth RPC（上游 `node-sdk` 存在 `beginGlobalMcpServerAuth` 等 RPC 表面，集成进 GUI 需要独立架构决策）

这些项在兼容性状态页（F2）中以「委托 TUI / 只透传 / 只读」如实标注，不在 UI 伪装为已自动完成，符合计划第 1.2 节边界要求。E1/E2 已在后续轮次落地（见第 11 章证据），不再列入此处。

## 3. Batch B：安全边界和目录写入

### B1. Rust 文件系统授权与最终 symlink 边界

#### 当前问题

`src-tauri/src/fs_access.rs::validate_path_scope()` 仍把任意绝对路径视为“用户经对话框授权”。renderer 实际可以直接调用 write/remove/move/copy 等命令，并不需要证明路径来自用户选择。单文件 symlink 虽然会解析到最终目标，但解析后没有重新执行严格授权判断。

受影响命令至少包括：

- `write_text`
- `write_text_cas`
- `remove_file`
- `remove_file_cas`
- `remove_dir`
- `ensure_dir`
- `ensure_private_dir`
- `move_file`
- `copy_dir`
- `replace_portable_directory`
- `write_executable`

#### 设计要求

1. 新增 Rust 管理的 `PathGrantState`，不得由 renderer 仅凭字符串自行声明授权。
2. 路径分为：
   - 固定受管根：`~/.kimi-code`、`~/.kimi-code-switch-gui`、legacy 迁移只读来源。
   - 当前注册环境根：每个受信的 `KIMI_CODE_HOME`。
   - 当前项目本地配置目标：仅 `<project-root>/.kimi-code/local.toml`。
   - 用户通过 Rust 原生 file/folder dialog 获得的临时 grant。
3. grant 至少绑定：规范绝对路径、操作类型、文件/目录类型、是否允许创建子项、应用会话。
4. 导出文件采用“Rust 打开 save dialog 并在同一命令写入”的组合操作，避免 renderer 伪造路径。
5. 备份目录采用 Rust 原生 folder picker 产生目录 grant；后续只能在该目录内部创建备份结构。
6. 所有写/删/移动操作在解析 symlink/父目录之后，必须再次验证最终目标。
7. 禁止受管目录内部 symlink 把 write/remove/copy 逃逸到授权根之外。
8. read-only 命令可保持较宽范围，但 credentials、日志和预览仍要服从脱敏规则。

#### 主要文件

- `src-tauri/src/fs_access.rs`
- `src-tauri/src/lib.rs`
- `src/renderer/src/tauri/fileAccess.ts`
- `src/renderer/src/tauri/kimiSwitch.ts`
- 所有调用 file dialog 后再写盘的 UI/action 文件

#### 测试要求

- 普通绝对路径 `/etc/...`、`~/.ssh/...` 写/删拒绝。
- 文件 symlink、目录 symlink、symlink 链和 dangling symlink。
- 受管根内路径与受管根外最终目标组合。
- grant 操作类型不匹配、grant 过期、路径 sibling/prefix 欺骗。
- Windows drive、UNC、大小写路径；macOS `/var` 与 `/private/var` identity。
- Rust dialog grant 的合法导入、导出和备份流程。

#### 完成证据

- 不再存在“任意绝对路径默认允许”的分支。
- 安全审查对 renderer 文件写入能力无 P0/P1。
- 上述攻击测试全部通过。

### B2. portable directory 最终 revision 复核

#### 当前问题

`replace_portable_directory` 在创建 staging 前检查目录 revision，但构建 staging 到最终 swap 之间可能经过较长时间。期间由 Kimi、编辑器或 Plugin installer 写入的变化可能被移动、覆盖或删除。

#### 实施内容

1. staging 完成后、第一次 rename/swap 前重新计算目标目录 revision。
2. 最终 revision 与 expected 不符时：
   - 不触碰目标目录。
   - 保留或安全清理 staging。
   - 返回明确 external-change conflict。
3. swap 各阶段写入 restore journal，记录 target、staging、original backup、expected/current hash。
4. 启动恢复必须识别：尚未 swap、已移走 original、已安装 desired、rollback 中断。
5. Skills history restore、Plugins restore 和 full backup restore 复用同一目录事务原语。

#### 测试要求

- staging 期间新增、修改、删除文件。
- 4,000 文件/64 MB 边界下并发修改。
- swap 每一步注入崩溃。
- rollback 本身失败后再次启动恢复。

### B3. Provider 自定义 URL 的真实请求边界

#### 已完成部分

- option-like Provider ID 已拒绝。
- registry 带凭据时强制 HTTPS。
- literal loopback/private/link-local 已拒绝。
- DNS 预解析会拒绝解析到私网的地址。
- UI 已增加“信任此 Registry、会发送 API key”的明确确认。

#### 尚未完成

实际 fetch 由独立 `kimi` 子进程重新解析 DNS并处理 redirect。预检查与真实请求之间仍存在 DNS rebinding 和 redirect 到私网的间隙；GUI 无法证明 API key 最终发往预检查的目标。

#### 可选方案评估

优先顺序：

1. 使用官方 SDK/service 的可注入 transport，并在真实请求层执行 DNS/IP/redirect policy。
2. 上游若提供安全 fetch hook，则直接接入，不在 GUI 复制 registry schema。
3. 无法约束真实请求时，取消 GUI 自动代理 custom registry import，只打开官方交互式 `/provider`，并把边界写清楚。

不得采用：仅增加第二次 DNS lookup、只检查初始 URL、或静默直接写 `config.toml` 复制官方 importer。

#### 验收

- HTTP、localhost、RFC1918、link-local、IPv4-mapped IPv6。
- DNS public→private rebinding。
- HTTPS→HTTP、public→private redirect。
- Authorization header 不跨 origin/降级转发。
- 无法证明上述边界时，GUI 不再自动代理 custom registry fetch。

### B4. 危险备份内容覆盖所有恢复入口

#### 已完成部分

- full backup 风险清单覆盖 stdio MCP、remote MCP、Provider endpoint、hooks、AGENTS、Skills 文档/脚本、Plugin source/manifest/MCP/hooks 和 executable files。
- full backup 对存在风险的内容默认禁用 Import，必须额外勾选信任确认。
- portable directory 已有文件数量、字节数、深度和路径穿越限制。

#### 尚未完成

1. 确认 WebDAV full restore、local restore、history restore 是否全部经过同一危险内容审查。
2. 风险清单需区分：
   - 配置型联网 endpoint。
   - 自动执行 hook/command。
   - executable 文件。
   - Plugin trust tier：official / curated / third-party / unknown。
3. 第三方 Plugin 不得因备份来自本机或已加密而自动视为可信。
4. 非交互自动恢复不得恢复 executable Plugin/Skill/hook。
5. 对超出 UI 前 20 项的风险必须支持展开或导出完整清单，不能只截断后要求确认。

#### 验收

- 构造包含恶意 hook、sessionStart、systemPrompt、stdio command、二进制和路径逃逸的备份。
- 所有入口均默认拒绝或要求独立明确确认。
- 用户能看到完整而非截断的危险内容集合。

## 4. Batch C：保存、恢复和历史事务

### C1. 保存请求串行化与 latest-wins

#### 当前问题

多个即时设置仍可能 fire-and-forget 调用 `persistState()`。全局 save journal 同时只允许一笔事务；并发请求可能争用 journal，后发的最新状态未必落盘。

#### 实施内容

1. 新建 renderer persistence coordinator，所有状态保存进入单一队列。
2. 保存请求分类：
   - 显式 Save：不可丢弃，调用方获得成功/失败结果。
   - 即时偏好：队列中可合并为 latest-wins。
   - 导入/切换环境前保存：必须等待成功，否则后续操作取消。
3. 队列只允许一笔 active save journal。
4. 保存完成后若队列已有更新状态，立即保存最新状态，不重复保存中间版本。
5. 应用关闭时等待已确认的显式保存，或向用户显示未完成提示。

#### 主要文件

- `src/renderer/src/useAppPersistence.ts`
- `src/renderer/src/useStateMutations.ts`
- `src/renderer/src/useUnsavedChangesGuard.ts`
- `src/renderer/src/tauri/fileAccess.ts`

#### 验收

- 高频输入 100 次只落盘最终值。
- 第一笔保存冲突、第二笔更新到来时不丢第二笔。
- Provider/MCP 导入、环境切换、关闭窗口均尊重 boolean 保存结果。

### C2. journal quarantine 和人工恢复

#### 当前问题

损坏、未知版本或遇到 CLI 合法外部修改的 `pending-save-transaction.json` 会在正常状态加载前抛错并保留，可能让应用每次启动都失败。

#### 实施内容

1. journal 分为：valid recoverable、valid unknown-state、malformed、unsupported-version。
2. malformed/unsupported 不再阻止应用启动：原文件原子移动到 private quarantine。
3. unknown-state 进入只读恢复模式，不自动覆盖任何文件。
4. UI 提供：查看脱敏摘要、导出 journal、放弃、选择 original、选择 desired。
5. 人工操作再次检查当前 revisions，并记录审计结果。
6. quarantine 和 journal 文件目录 `0700`、文件 `0600`。

#### 验收

- 截断 JSON、未知 version、外部修改、多次启动。
- 恢复 UI 不展示 API keys/token/Authorization 明文。
- 放弃 journal 后可以正常加载状态。

### C3. 统一 restore crash journal

#### 当前问题

full backup、regular restore 和 history restore 仍依赖多个 CAS、目录 swap 和 SQLite 更新加补偿回滚。进程崩溃或 rollback 自身失败可能留下跨文件混合版本。

#### 实施内容

1. 定义统一 `RestoreTransactionRecord`：
   - transaction id、kind、createdAt。
   - text resources、directory resources、SQLite logical resources。
   - original/desired revision。
   - staged/applied/rolledBack 状态。
2. 两阶段流程：prepare 全部资源 → apply → commit journal。
3. 启动时逐资源分类：original、desired、unknown、missing。
4. mixed 且无 unknown 时按 journal 规则完成或 rollback。
5. 任一 unknown 时停止自动写，进入 C2 恢复 UI。
6. SQLite 不宣称与文件系统真正原子；使用可重放状态和幂等写实现一致结果。

#### 验收

- 在每个 text、directory、SQLite 步骤注入崩溃。
- 重启后只能得到完整 original 或完整 desired；unknown 必须人工处理。

### C4. 历史存储安全和目标重绑定

#### 剩余问题

1. 历史 gzip 只压缩不加密；必须确保目录/文件权限不会被其他本机用户读取。
2. schema rebuild/migration 缺少显式 SQLite transaction。
3. environment home 变化后，旧 `target_path` 可能仍指向旧目录。
4. legacy-unassigned 虽已有分配 API/UI，需要验证所有 file id 和目录历史都能安全恢复。
5. 普通保存每次同步导出完整 Skills 树，接近上限时影响即时保存延迟。

#### 实施内容

- 历史 private directory/file permissions。
- schema migration transaction + rollback 测试。
- 恢复时通过 environment id 重新解析当前目标，禁止盲信旧路径。
- Skills/Plugins history 使用异步去重、mtime/revision 快速路径，失败必须告知而非静默无历史。

### C5. revision guard 的准确命名和竞态模型

当前 text revision check 仍可能在最终检查与 rename 的极小窗口内被不合作的外部进程写入。后续需要：

1. API、文档和 UI 使用 `optimistic revision guard`，不宣称 OS 级 compare-and-swap。
2. 评估 per-path advisory lock；官方 CLI 不遵循时不能把锁当成完整解决方案。
3. 写后复核与 journal 恢复应覆盖不可消除的竞态。
4. 对外部并发行为写清楚错误模型和用户恢复路径。

## 5. Batch D：官方运行时管理能力

### D1. Plugin 完整生命周期

#### 当前能力

GUI 已能读取 inventory、manifest、Skills、MCP、hooks、capability overrides；已修复 managed root 跨环境重映射、错误 Plugin 排除和 realpath containment。

#### 尚缺能力

- Official / Third-party / Custom marketplace。
- install / update / remove。
- enable / disable / reload。
- Plugin MCP enable / disable。
- trust tier、版本更新 badge、details/diagnostics。

#### 实施原则

1. 不直接手写 `installed.json` 实现第二套 installer。
2. 首选官方 Plugin service、KAP API 或 Node SDK。
3. mutation 必须针对活动 `KIMI_CODE_HOME`。
4. 官方结构化入口不可用时，只提供明确的 `/plugins` TUI 跳转，不声称 GUI 已完成操作。
5. 第三方安装必须默认取消并要求 trust 确认。

#### 验收

GUI 与官方 `/plugins` 交叉执行同一操作后，`installed.json`、managed root 和 effective MCP/Skills 完全一致。

### D2. Built-in Skills 实际 catalog

#### 当前问题

Built-in Skills 只有说明项，不参与实际 catalog、`builtin_product_skills` 过滤或 override 关系。

#### 实施内容

1. 从已安装、版本匹配的官方 Kimi package/SDK 获取 Built-in Skills summaries。
2. 至少覆盖 0.38 的 product skills 和 sub-skills。
3. 应用 `builtin_product_skills` 开关。
4. 合并顺序维持：project > user > extra > plugin > builtin。
5. 无法确认本机 Kimi 版本或 package path 时显示“不可验证”，不得伪造列表。

### D3. Custom Agents / `extra_agent_dirs`

需要新增 Agents catalog，覆盖：

- `$KIMI_CODE_HOME/AGENTS.md` 与通用 instructions 的边界。
- project/user/plugin/extra agent profile roots。
- `extra_agent_dirs` 路径解析、realpath、优先级和 diagnostics。
- `SYSTEM.md`、agent metadata、显式 runtime 文件。
- 备份、预览、历史和危险内容审查。

不得把“AGENTS.md 已备份”等同为 Agents 功能已拉齐。

### D4. MCP 定向结构化 OAuth

#### 当前状态

危险的 `kimi -p "/mcp-config login ..."` 已移除。当前按钮只打开活动环境中的普通交互式 Kimi，并提示用户手动运行 `/mcp-config`；它不是针对选中 server 的自动授权。

#### 目标实现

接入官方 SDK RPC：

- `listGlobalMcpServerAuthStatuses`
- `beginGlobalMcpServerAuth(name)` / `beginMcpServerAuth(locator)`
- `completeGlobalMcpServerAuth` / `completeMcpServerAuth`
- `cancel...`
- `resetGlobalMcpServerAuth` / `resetMcpServerAuth`

要求：

1. flow id 保留在 Rust/SDK service，不写入普通配置。
2. authorization URL 只允许 HTTPS，并由系统 opener 打开。
3. 支持取消、超时、窗口关闭和重复点击。
4. user/global MCP 先完成；Plugin locator 若官方 0.38 bridge 不支持，应明确降级。
5. 不自行读取、复制或解释官方 OAuth token store。

### D5. MCP GUI workbench

当前 GUI workbench 不能等价处理 legacy SSE 和官方 OAuth runtime。后续应复用官方 MCP client/service，统一：

- stdio local/kaos runtime。
- Streamable HTTP。
- legacy SSE。
- bearer env。
- OAuth credential store。
- tools/list、tool call、timeout 和错误分类。

验收：同一 server 在官方 `/mcp-config` 与 GUI 中得到一致的 auth status、连接结果和工具列表。

### D6. 非默认环境 OAuth/账号管理

当前为了避免误操作默认 credentials，非默认环境账号槽位管理被安全禁用。剩余目标：

1. 所有账号/OAuth command 显式接收活动 `KIMI_CODE_HOME`。
2. credentials slot、数据库记录和标准 credentials path 均按环境隔离。
3. 目录 `0700`、文件 `0600`，复制采用 staging + atomic swap。
4. 登录失败恢复原 credentials，不留下空或半复制槽位。
5. 无法保证隔离时继续禁用，并在 UI 明确说明，而不是写默认环境。

## 6. Batch E：高级配置管理和 schema 单一化

### E1. `config.toml` 尚未结构化管理的字段

以下字段当前主要依赖 unknown-field passthrough；数据不会丢失不代表管理能力完成：

| 分组 | 字段/section | 实施要求 |
| --- | --- | --- |
| Models | `secondary_model` | 与 default model 一样校验 alias 存在性 |
| Skills | `builtin_product_skills` | 区分显式值与默认 true |
| Agents | `extra_agent_dirs` | 复用 Agents realpath/priority contract |
| Thinking | `[thinking].enabled/effort/keep` | 完整官方枚举与默认值 |
| Token | `[token_counting].strategy` | 不物化默认值 |
| Subagent | `[subagent].timeout_ms` 等 | interactive/print 有效默认差异 |
| MCP global | `[mcp].startup_timeout_ms/tool_timeout_ms` | 1..2147483647，展示 env override |
| Permission | `[permission]` / rules | 顺序敏感、tool pattern 诊断 |
| Tools | `[tools]` | 官方 tool 名称与 unknown passthrough |
| Image | `[image]` | 官方压缩参数范围 |
| Identity | `[identity]` | name 等官方字段 |

每项必须满足：

1. parser、effective default、form、serializer 共用 schema。
2. UI 显示“文件显式值”和“当前有效值”。
3. 清除显式值回到官方默认，不把默认值无条件写盘。
4. 未管理字段和未知 section 继续往返保留。

### E2. TUI explicit/effective 单一 schema

当前 UI 已能编辑主要 0.38 字段并显示 fallback，但 `TuiConfig` 仍偏向“文件显式值”，有效默认与 parser/form 分散维护。

剩余实施：

- `ExplicitTuiConfig` 与 `EffectiveTuiConfig` 分离。
- 单一 normalize/validate schema 产生有效配置和 diagnostics。
- serializer 只写显式字段并保留 unknown。
- malformed 文件继续由 GUI 报告，不静默覆盖。
- 以官方 `normalizeTuiConfig` fixtures 做差分测试。

### E3. project-local config 备份策略

`.kimi-code/local.toml` 含主机绝对路径且属于项目 checkout。当前已经从可移植 full backup 中移除，避免泄露路径和产生“只备不恢复”的死字段。

仍需明确产品方案二选一：

1. 继续明确排除，并在备份清单/文档说明。
2. 提供独立的“项目映射恢复”：用户选择目标 project root 后预览并重新解析 additional dirs。

不得恢复到备份里的原始绝对项目路径。

## 7. Batch F：防漂移、文档和发布验收

### F1. 官方契约 fixtures 与 CI

需要补齐并固定：

- `config.toml` 完整顶层字段/defaults/deprecations。
- Provider catalog list/add/custom registry 输出。
- MCP `{}`、schema、三层覆盖、trust、cwd、runtime_id。
- TUI explicit/effective defaults 和 enum。
- Skills roots、realpath、8 层限制、case-sensitive `.md`、sub-skill、Built-in。
- Plugin installed/manifest/marketplace/trust/lifecycle。
- data home、credentials 和 workspace-trust 文件权限。

CI 不联网跟随 `main`；fixture manifest 必须记录 tag、commit、官方源文件和提取日期。

### F2. 兼容性状态页与升级 SOP

页面至少展示：

- GUI 已验证的 Kimi version/commit。
- 本机 `kimi --version`。
- 支持、只透传、只读、委托 TUI、未支持五类能力。
- 本机版本高于验证基线时的风险提示。
- config/MCP/TUI/Skills/Plugin contract 的最近验证状态。

升级 SOP：发现新版本 → 固定源码 → 更新 manifest/fixtures → 运行差分 → 更新 plan → 实施 → 双审查 → 发布。

### F3. 最终完成审计

在宣布目标完成前必须逐条核对本文件所有 ID，不得以“没有再发现问题”替代完成证明。

#### 必跑命令

```bash
npx tsc --noEmit
npm test
npm run build:web
cd src-tauri && cargo fmt --check && cargo test
npm audit --json
git diff --check
```

涉及 Tauri command/capability/bundle 的改动还必须运行完整 `npm run build`。

#### 必做安全复核

- secrets scan。
- 文件路径授权和 symlink 攻击测试。
- SSRF、redirect、DNS rebinding。
- 不可信备份和 Plugin executable。
- journal/restore 崩溃注入。
- credentials 权限和多环境隔离。

#### 必做官方交叉验证

- 同一 `KIMI_CODE_HOME` 下 GUI save 后官方 CLI 解析等价。
- 官方 CLI mutation 后 GUI reload 展示等价。
- `/plugins`、`/mcp-config`、`/provider` 和 `/settings` 交叉操作。
- workspace trusted/untrusted 切换。
- user/project/extra/plugin/builtin Skills 最终 catalog。

## 8. 推荐实施顺序和提交切片

| 顺序 | 建议提交切片 | 依赖 |
| --- | --- | --- |
| 1 | `fix: enforce native filesystem path grants` | 无 |
| 2 | `fix: recheck directory revisions before restore swap` | 1 |
| 3 | `fix: serialize persistence and quarantine invalid journals` | 1 |
| 4 | `fix: make restore transactions crash recoverable` | 2、3 |
| 5 | `fix: secure provider custom source delegation` | 独立 |
| 6 | `feat: align plugin lifecycle with official service` | 1、4 |
| 7 | `feat: expose builtin skills and custom agents catalogs` | Plugin service、fixtures |
| 8 | `feat: integrate structured MCP OAuth and workbench` | 官方 SDK bridge |
| 9 | `feat: manage advanced kimi configuration schemas` | fixtures |
| 10 | `chore: add compatibility audit and upgrade gates` | 全部前置项 |

每个切片必须独立可回滚、带测试和 changelog 草稿。不得在一个提交中同时混入大规模 UI 重排、版本发布和安全存储迁移。

## 9. 明确不做或需要单独授权的动作

- 不复制 Kimi Agent loop、session runtime 或完整 TUI。
- 不自行实现第二套 Plugin installer/OAuth token store。
- 不把 GUI SQLite 恢复为 Provider/Model/MCP 真相源。
- 不把项目绝对路径静默恢复到另一台机器。
- 未经明确请求，不提交、推送、创建 tag 或发布版本。

## 10. 完成定义

只有同时满足以下条件，才可关闭“按照计划推进 Kimi Code 对齐”目标：

1. B1–F3 全部完成，或某项被用户明确书面排除出范围。
2. 所有 P0/P1 风险关闭，P2 仅允许有已文档化且用户接受的非关键限制。
3. 结构化管理、只读视图和官方 TUI 委托在 UI 中边界清楚，不误报能力。
4. 每项有对应源码、测试、运行结果或官方交叉验证证据。
5. 完整 Tauri build、测试、覆盖率、npm audit、security review 和 upstream diff review 全部通过。
6. 没有真实 secret、未脱敏预览、备份凭据或 OAuth token 进入仓库。
7. 未经用户授权不执行 commit/push/release；这些动作不属于技术完成的默认步骤。

## 12. 2026-09-15 推进轮完成与重开证据

本轮聚焦「发布安全基线 + 验收缺口」，修改仅在工作树（未提交）：

1. **B1 重新修复（Rust + renderer）**：
   - `src-tauri/src/fs_access.rs` 新增 durable grant 持久化 store（`~/.kimi-code-switch-gui/access-grants.json`，目录 0700 / 文件 0600），新增 `pick_backup_directory` 命令（Rust 原生 folder dialog，properties openDirectory+createDirectory，canonicalize 后以 `source=dialog` 登记并落盘）。
   - `reconcile_durable_grants` 不再把 SQLite `backup_local_path` 字符串当作授权来源，仅从 durable grant store 重建；环境 `homePath` 重建前 canonicalize 并通过 `within_managed_root` 校验。
   - renderer：`TabPanels.tsx` 备份本地路径改为只读 + 按钮调 `pickBackupDirectory`（授权只能经 Rust dialog）；`backup.ts` 移除「每次备份前 reconcile 注册授权」逻辑（改启动一次幂等重建）；`kimiSwitch.ts` 暴露 `pickBackupDirectory`。
   - Rust 测试新增 5 项（面板字符串不再产生授权 / pick 后放行、pick 前被拒 / store 重启重建+幂等 / 越界 home 跳过 / 序列化契约）。`cargo test` 113 passed / 1 ignored；`cargo check` 0 警告。
2. **恢复 apply 竞态闭环**：`useSafetyActions.ts::restoreWithDryRun` 不再无条件 `allowOverwrite:true`；apply 保留 preflight，external-change 二次确认后才以该次 snapshot 覆盖，allowRisk 不绕过 preflight，成功后再同步最新 snapshot。`backup.test.ts` 新增 4 条用例覆盖该闭环。
3. **B4 完整风险清单**：删除 `slice(0,20)` 截断；`ConfirmDialog` 支持可滚动 `<pre>` + 复制，风险列表完整可见，保留默认拒绝+allowRisk 重试语义。
4. **C2 人工恢复 UI 补全**：`resolveSaveRecovery` 扩展为 `abandon | export-journal | apply-desired | restore-original`，逐资源写前 revision 复核、成功后才删 journal、返回审计结果；新增 `saveRecovery.ts` 脱敏摘要、`SaveRecoveryDialog.tsx`；i18n 6 语言新增键。测试 17 条（saveRecovery 6 + kimiSwitch 11）。
5. **验证**：`npx tsc --noEmit` 0 错；`npx vitest run` 67 files / 867 tests 全绿；`npm run build:web` 成功；`cd src-tauri && cargo fmt --check && cargo test` 通过。这是阶段性证据，不是最终发布证据——F3 完整门禁（计划第 7 章）待剩余功能主线与收口提交后重跑。

### 仍待推进/待用户决策

- **B3**：接受已文档化的 DNS-rebinding/redirect 残余边界（现状），或停止 GUI 自动 custom registry import 仅委托官方 TUI，两者需在产品层决策。
- **D1–D4、E1 其余字段**：官方运行时管理能力主线仍未开始/部分完成（D5/D6 有限），属需官方 service/SDK/harness 的长期工作。
- **C3/C4/F1 完整证据**：directory/SQLite crash recovery、历史权限/重绑定、契约 fixtures 全面覆盖仍需逐条验收记录。
- **当前工作树收口**：大量 WIP + 本轮改动待按主题拆分提交；`.qoder/` 约 275 个未跟踪生成文件需处理；`CONTRIBUTING.md`/`CLAUDE.md` 文档漂移需修正。

