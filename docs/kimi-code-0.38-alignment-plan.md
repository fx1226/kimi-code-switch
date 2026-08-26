# Kimi Code 0.38 对齐计划

## 1. 基线与目标

- 官方基线：`@moonshot-ai/kimi-code@0.38.0`
- 发布提交：`0999454bdcb5ddd98f39bffee434dcf0a810f394`
- 基线日期：2026-08-20
- 本地复核副本：`/private/tmp/kimi-code-upstream-038-audit`
- 官方文档：
  - [配置文件](https://github.com/MoonshotAI/kimi-code/blob/main/docs/zh/configuration/config-files.md)
  - [数据位置](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md)
  - [Providers](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/providers.md)
  - [MCP](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md)
  - [Plugins](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/plugins.md)
  - [Skills](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/skills.md)

本项目的目标不是复制 Kimi Code 的 Agent runtime，而是成为与官方契约一致的桌面控制面：

1. 配置路径、文件格式、覆盖优先级和默认值与官方一致。
2. GUI 保存的数据可被同一 `KIMI_CODE_HOME` 下的官方 CLI 直接使用。
3. 需要执行官方运行时逻辑时优先调用官方入口，不自行维护第二套隐式状态。
4. GUI 专属的多环境、备份、历史和用量能力不得破坏官方文件的真实性与安全边界。

## 2. 当前对齐状态

### 已完成，可进入回归维护

| 领域 | 当前状态 |
| --- | --- |
| 数据根 | 默认使用 `~/.kimi-code`，支持每环境独立 `KIMI_CODE_HOME`；`~/.kimi/` 仅作为迁移来源。 |
| 官方文件 | `config.toml`、`mcp.json`、`tui.toml`、`AGENTS.md`、`skills/`、`plugins/` 已纳入读取、备份或历史范围。 |
| Config | 官方 TOML 为真相源；未知的新字段/section 原样往返；旧死键不再生成。 |
| Providers | 支持官方字段、协议探测、catalog list/add 和自定义 registry add；密钥不进入 argv。 |
| MCP | 支持 user、project-root、project-local 声明层，严格校验主要 0.38 字段，支持 OAuth 登录入口和 bearer env。 |
| TUI | 可编辑 0.38 已知字段，保留未知字段，显示解析诊断和有效默认值。 |
| Skills | 使用标准 YAML frontmatter；支持 user/project/extra/plugin、扁平 skill、分类和 gated sub-skill。 |
| Plugins | 可读取 `installed.json`、manifest、Skills、MCP、hooks、能力覆盖，并参与环境克隆和全量备份。 |
| 写入 | 单文件原子写、revision 检查、保存事务日志和启动恢复已实现。 |
| 安全 | WebDAV 独立加密密钥、恢复密钥轮换、预览脱敏、portable directory 路径穿越防护已实现。 |
| 验证 | 723 项前端/共享测试和 93 项 Rust 测试通过；语句/行覆盖率 80.29%；npm audit 为 0 漏洞。 |

### 已兼容但尚未完整管理

以下内容不会在 GUI 保存时丢失，但还没有完整的结构化编辑或有效状态展示：

- `builtin_product_skills`
- `extra_agent_dirs`
- `secondary_model`
- `[thinking].keep`
- `[token_counting]`
- `[subagent]`
- `[permission]`
- `[tools]`
- `[image]`
- `[identity]`
- `[mcp].startup_timeout_ms` / `[mcp].tool_timeout_ms`

“原样透传”只能判定为数据兼容，不能判定为管理能力已经拉齐。

## 3. 尚未拉齐的差异

### R0：发布阻断——安全和数据完整性

#### R0.1 文件系统授权边界

现状：Rust 文件命令允许任意绝对路径；symlink 解析后未再次验证最终目标。被攻陷或存在 XSS 的 renderer 可以修改当前用户可访问的任意文件。

改造：

1. 将路径分为受管根、项目工作区和用户经 file dialog 授权的临时 grant。
2. 所有 write/remove/move/copy/CAS 命令在 canonicalize 后重新验证最终目标。
3. 禁止目录 symlink 将受管路径逃逸到授权范围外。
4. grant 绑定操作类型、目标路径和当前应用会话，不落入长期配置。

主要位置：`src-tauri/src/fs_access.rs`、renderer file access adapter。

验收：覆盖绝对路径越权、父目录穿越、文件/目录 symlink 逃逸、grant 过期和合法导入导出。

#### R0.2 不可信全量备份的可执行内容

现状：全量备份可包含 plugin 可执行文件、plugin hooks、stdio MCP、Skills scripts；导入后 Kimi 可能在下次启动加载它们。

改造：

1. 导入预览单独列出可执行文件、plugin source、hooks、stdio command、MCP cwd 和脚本型 Skill。
2. 默认不恢复可执行内容；用户明确确认后才允许恢复。
3. 第三方 plugin 使用与官方 `/plugins` 相同的 trust 分类；不得静默等同为官方或 curated。
4. 远程 WebDAV 恢复同样执行上述审查，不因备份已加密而跳过来源确认。

主要位置：`src/renderer/src/tauri/backup.ts`、`configSafety.ts`、备份导入 UI。

验收：构造含危险 hook、绝对 command、可执行二进制和路径逃逸的备份，验证默认拒绝且确认清单完整。

#### R0.3 跨文件恢复的崩溃一致性

现状：普通保存已有 crash journal；全量恢复仍是多个 CAS、目录替换和 SQLite 更新加补偿回滚，进程崩溃可能留下混合版本。

改造：

1. 为 regular/full/history restore 使用统一恢复 journal。
2. journal 记录每个资源的 original、desired、revision、完成状态和回滚状态。
3. 启动时按“全部 desired / 全部 original / mixed / unknown”恢复；unknown 必须停止自动覆盖。
4. SQLite 元数据与文件恢复使用可重放的两阶段状态，不宣称跨文件系统和 SQLite 的伪原子事务。

主要位置：`backup.ts`、`fileAccess.ts`、`config_history.rs`、SQLite stores。

验收：在每个写入步骤注入崩溃，重启后只能得到一致的旧版本或新版本；未知外部修改不得被覆盖。

#### R0.4 默认环境 legacy 迁移路径

现状：迁移逻辑仍可能把默认环境写到 `~/.kimi-code-switch-gui/.env/default`，而官方和 GUI 默认环境实际读取 `~/.kimi-code`；marker 落盘后会形成不可重试的孤儿迁移。

改造：默认环境目标固定为 `~/.kimi-code`；只有命名的 managed 环境使用 `.env/<id>`。marker 必须包含目标路径和各资源结果，错误或孤儿结果不得标记成功。

主要位置：`src/shared/configStore.ts` 及 legacy migration 测试。

验收：从仅有 `~/.kimi/` 的干净主目录升级后，官方 `kimi` 与 GUI 读取到同一迁移结果；重复启动幂等。

#### R0.5 Project local config 的首次创建与合法性

现状：文件不存在时 GUI 把空内容 SHA 当作 CAS revision，而 Rust 用空 revision 表示不存在，导致首次创建必然冲突。GUI 还没有完整执行官方 `workspace.additional_dir` 解析：相对路径和 `~`、目录存在性、目录类型及规范化去重均可能与官方不同。

改造：

1. 在状态中区分 missing file 与 empty file，首次创建使用官方约定的 missing revision。
2. 与官方 `workspace-local.ts` 一致：相对路径以 project root 解析、`~` 展开、最终目标必须存在且为目录。
3. 保存规范化且去重的目录；保留文件内未知 table。
4. `projectLocalDocument` 不再作为“只导出不恢复”的死字段：默认从可移植备份中移除主机绝对路径，或设计明确的目标项目映射恢复流程。

验收：首次创建、空文件、外部并发创建、相对路径、home 路径、不存在路径、普通文件和重复路径均与官方行为一致。

#### R0.6 保存调度与 journal 可恢复性

现状：即时设置可并发触发 fire-and-forget 保存，但只有一个全局 save journal；后发请求可能直接失败且最新值不重试。损坏、未知版本或遇到外部合法修改的残留 journal 会在正常状态加载前持续抛错，使应用每次启动都失败。

改造：

1. 所有持久化请求进入单一队列；相邻可合并状态采用 latest-wins，显式用户保存保留结果 Promise。
2. Provider 导入等破坏未保存状态的操作必须等待保存成功；保存失败时不得继续 reload。
3. 未知/损坏/不可自动恢复 journal 移入 quarantine，进入只读恢复界面，不阻塞整个应用启动。
4. UI 提供查看、导出、放弃和人工选择 original/desired 的入口；操作产生审计记录。

验收：高频输入、保存冲突、应用崩溃、损坏 journal、未知版本和 CLI 外部修改下均不丢最后一次确认状态，应用可启动进入恢复模式。

#### R0.7 Provider 导入与 registry 网络边界

现状：自定义 registry 接受 HTTP 和私网地址，同时把 API key 注入官方命令环境；官方命令会把它作为 bearer token 发往目标。Provider ID 也需要防止以 `-` 开头被 CLI 当作选项。

改造：

1. 带凭据的 registry 默认只允许 HTTPS；统一复用 HTTP 层的 DNS/IP/redirect SSRF 校验。
2. 本机/私网访问需要独立高级开关、无凭据默认值和逐次确认，且不得发生 HTTPS → HTTP 降级跳转。
3. Provider/catalog ID 使用官方允许的 ID schema，并在 CLI positional 参数前使用 `--`（若上游命令支持）或拒绝 option-like 输入。
4. 导入前 unsaved guard 必须真实等待保存结果；失败后保持当前编辑和 dialog。

验收：HTTP、loopback、RFC1918、link-local、DNS rebinding、redirect 降级、`--help` ID 和保存冲突都有测试。

#### R0.8 MCP OAuth 调用边界

现状：GUI 把 server name 拼入 `kimi -p "/mcp-config login <name>"`。`-p` 是模型 print turn，不是结构化 OAuth 子命令；配置中的恶意名称可能成为模型提示注入，shell quoting 无法消除这一层风险。

改造：

1. 停止通过 `kimi -p` 发起 OAuth。
2. 优先调用官方结构化 MCP auth service/API；若当前版本没有稳定入口，只打开交互式 Kimi TUI 并让用户在其中选择服务器。
3. server name 使用与官方 MCP key 一致的严格值域；不得把外部配置值拼入自动权限模型 prompt。

验收：含空格、斜杠、引号、命令样式和自然语言指令的 server name 均不能进入模型回合或 shell command。

#### R0.9 目录替换的并发保护

现状：Skills/Plugins portable directory restore 在创建 staging 前检查 revision，但大型 staging 完成后替换目标前不复核；期间 CLI 或编辑器产生的新文件可能被无提示删除。

改造：替换目标前再次计算 revision，并对 directory swap 建立与 text restore 相同的 journal/recovery 状态；复核失败只保留 staging 供用户检查，不触碰目标。

验收：在导出、staging 构建和最终 swap 的每个阶段注入并发写入，目标中的外部变化不得丢失。

#### R0.10 Plugin 跨环境路径与 containment

现状：managed root 重映射使用字符串前缀，`~/.kimi-code` 与 `installed.json` 中绝对 root 无法匹配；跨环境克隆可能继续引用原环境。plugin root 内的 symlink 也可能逃逸，而 GUI 仅做字符串路径判断。

改造：

1. 重映射前将 source/target home 规范化为绝对路径，写回目标环境的绝对 managed root。
2. plugin skills、MCP command/cwd 和 manifest 路径均在 realpath 后验证 containment。
3. `state !== ok` 的 plugin 不进入有效 MCP/Skills；UI 只在 diagnostics 区展示其声明。

验收：默认 home、命名环境、跨设备恢复、外部 plugin、文件/目录 symlink 逃逸和 error plugin 均有 fixture。

### R1：运行语义对齐

#### R1.1 `extra_skill_dirs` 路径解析

现状：`~` 可正确展开，但普通相对路径没有按官方规则相对最近 Git project root 解析。

改造：绝对路径原样、`~` 相对 OS home、普通相对路径相对 project root；不存在的目录只产生可解释的 skipped 项。

验收：覆盖 monorepo 子目录、无 Git fallback、Windows 盘符和相对目录优先级。

#### R1.2 Skills 发现边界和 Built-in catalog

现状：本地存在固定 8 层扫描上限；Built-in Skills 只有说明项，没有参与实际 catalog、override 和 `builtin_product_skills` 过滤。

改造：

1. 对齐官方递归终止条件，不使用无来源的 8 层语义限制；保留循环/规模保护但作为诊断而非静默截断。
2. 从已安装官方 Kimi Code 获取 built-in catalog；无法解析版本时显示“不可验证”，不得伪造列表。
3. 合并顺序固定为 project > user > extra > plugin > builtin，并展示 shadow/override 关系。
4. 逐目录、逐文件容错；权限错误、扫描中删除、名为 `SKILL.md` 的目录不能让整个 catalog 失败。
5. frontmatter fence 按官方逐行 trim 语义处理，支持带空白 fence 和 closing fence 位于 EOF。

验收：使用官方 fixtures 对比最终 skill 名称、scope、path、shadowedBy 和 sub-skill dotted name。

#### R1.3 Project MCP trust 与 cwd

现状：GUI 无条件把项目 MCP 显示为有效；官方仅在 workspace trusted 时启用。Git-root `.mcp.json` 的 stdio 默认 cwd 和相对 cwd 也未按 project root 归一化。

改造：

1. 区分“已声明”和“当前有效”，接入或读取官方 workspace trust 状态。
2. 未信任项目的 MCP 不进入 GUI tool workbench，只显示待信任诊断。
3. root `.mcp.json` 的缺省/相对 cwd 以 Git root 解析；cwd-local 配置以相应工作目录解析。

验收：trusted/untrusted、root/local 覆盖、相对 cwd 和同名 server 覆盖均与官方 fixture 一致。

#### R1.4 MCP schema 尾差

现状：`runtime_id` 仅作为 opaque extra 往返，没有按 stdio schema 检查非空；`executor: local|kaos` 已检查。

改造：增加 `runtime_id` 结构化字段和官方同值域验证；doctor 与编辑表单共用同一个 schema。

同时允许官方视为空集合的 `{}` 文档；一个项目 MCP 层解析失败时仍展示另一个成功层，并分别标注 declared/effective/error。

验收：官方合法配置全部通过，非法空 `runtime_id` 在载入和保存前均有明确错误；`{}`、单层错误和混合层诊断行为与官方一致。

#### R1.5 CAS 语义命名和边界

现状：revision check 能显著缩小覆盖窗口，但外部进程仍可能在最终 hash 检查与 rename 之间写盘，因此不是 OS 级原子 CAS。

改造：

1. 文档和 API 将其称为 optimistic revision guard，不宣称 lock-free CAS。
2. 评估 per-path advisory lock；如官方 CLI 不遵守该锁，则保留启动/保存前后 revision 复核和冲突恢复。
3. 对不可消除的竞态给出明确错误模型和恢复路径。

### R2：管理能力对齐

#### R2.1 Plugin 完整生命周期

现状：GUI 只有 inventory，安装、更新、启停、删除、marketplace 和单 MCP 能力开关仍需回到 `/plugins`。

改造原则：不得由 GUI 直接手写 `installed.json` 实现第二套 installer。优先调用官方 plugin service/API；无法稳定调用时，提供明确的官方 TUI 跳转并保持只读。

目标能力：

- Official / Third-party / Custom marketplace
- install / update / remove
- enable / disable / reload
- plugin MCP enable / disable
- trust badge、更新状态、manifest diagnostics
- 操作后提示 `/reload` 或新会话生效

验收：与官方 `/plugins` 针对同一 `KIMI_CODE_HOME` 交叉操作，`installed.json` 和有效能力状态一致。

#### R2.2 高级 Config 结构化管理

按官方 schema 分批增加设置页：

1. 模型和推理：`secondary_model`、`thinking.keep`、`token_counting`。
2. Skills/Agents：`builtin_product_skills`、`extra_agent_dirs`。
3. Runtime：`subagent`、全局 `mcp` timeout。
4. Policy：`permission.rules`、`tools`、`image`、`identity`。

每个字段必须区分“文件显式值”和“官方有效默认值”，删除显式值时应回到 CLI 默认而不是物化默认。

#### R2.3 MCP GUI workbench

现状：配置可供官方 Kimi 使用，但 GUI 的 SSE 测试、OAuth credential runtime 和工具调用能力不完整。

改造：复用官方 MCP client/service 或正式协议库，禁止自行读取/复制 OAuth token；SSE、streamable HTTP、OAuth 和 bearer env 使用同一执行路径。

验收：同一 server 在官方 `/mcp-config` 与 GUI 中得到一致的连接、鉴权、工具列表和错误分类。

### R3：长期防漂移

#### R3.1 TUI normalized schema

将“显式文件值”和“normalized effective config”分成两个类型；默认值、枚举诊断和 serializer 由单一 schema 生成，避免 UI fallback 与 parser 各维护一套。

#### R3.2 官方契约 fixtures

每次升级 Kimi Code 时固定 tag/commit，并更新以下 fixtures：

- config 默认值与完整顶层字段
- provider 类型和 catalog 输出
- MCP schema、layers、trust、cwd
- TUI 默认值和枚举
- Skills roots、优先级、递归和 built-in
- Plugin installed/manifest/marketplace contract
- 数据目录和 credentials 权限

CI 只依赖仓库内已审计 fixture，不在测试期间跟随 `main` 或联网拉取不固定内容。

#### R3.3 升级检查机制

新增“官方兼容性状态”页面，展示：

- 已验证官方版本和 commit
- 本机 `kimi --version`
- 当前 GUI 支持的 contract 版本
- 本机版本更新时需要重新验证的领域
- 只透传但未结构化管理的字段

## 4. 实施顺序

| 批次 | 内容 | 退出条件 |
| --- | --- | --- |
| A | R0.4、R0.5、R0.7、R0.8、R1.1、R1.3、R1.4 | 明确语义 bug 和直接注入面修复，focused + full tests 通过。 |
| B | R0.1、R0.2、R0.10 | 路径授权、plugin containment 和不可信可执行内容默认安全；安全审查无 P0/P1。 |
| C | R0.3、R0.6、R0.9、R1.5 | 所有保存/恢复进入调度器和可重放 journal；崩溃/并发注入测试通过。 |
| D | R1.2、R2.1 | Skills 有效 catalog 和 Plugin 生命周期与官方交叉验证一致。 |
| E | R2.2、R2.3、R3.1 | 高级配置和 MCP workbench 使用统一 schema/runtime。 |
| F | R3.2、R3.3 | 固定契约 fixtures、兼容性状态、升级 SOP 和发布说明完成。 |

## 5. 每批通用质量门槛

1. TDD：先增加官方 fixture 或失败用例，再实现。
2. TypeScript：focused Vitest、`npx tsc --noEmit`、`npm test`、`npm run build:web`。
3. Rust：`cargo fmt --check`、`cargo test`；涉及 bundle 时运行完整 Tauri build。
4. 覆盖率：语句和行不低于 80%，不得通过降低 threshold 过关。
5. 安全：无真实 credentials、API key、WebDAV 密码或未脱敏配置进入 fixture/日志。
6. 兼容：旧配置升级幂等，未知字段和未知 section 不丢失。
7. 外部变更：所有写入都有 revision 冲突路径；冲突不静默覆盖。
8. Review：每批完成后做本地代码审查和官方源码差异复核。

## 6. 明确不纳入本轮

- 复制 Kimi Code 的 Agent loop、session runtime、OAuth token store 或完整 TUI。
- 绕过官方 trust/install 流程直接实现私有 plugin installer。
- 为了兼容 GUI 而修改官方 `~/.kimi-code` 文件格式。
- 将 GUI SQLite 缓存重新变成 Provider/Model/MCP 的真相源。
- 在未明确授权时提交、推送、打 tag 或发布版本。

## 7. 完成定义

只有同时满足以下条件，才能宣布“与 Kimi Code 0.38 拉齐”：

1. R0 无未关闭项。
2. R1 的有效配置、路径解析、优先级和 trust 语义均通过官方 fixture。
3. R2 中无法原生实现的能力有稳定的官方委托入口，并在 UI 中明确边界。
4. GUI 读取—编辑—保存后，官方 CLI 对同一环境的解析结果等价。
5. 备份、恢复、迁移、环境切换和外部并发修改不会产生未告知的数据丢失。
6. 全量测试、构建、覆盖率、安全审计和双重代码审查通过。
