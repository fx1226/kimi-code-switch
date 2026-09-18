# ChatGPT 订阅桥接：实施与决策记录

> **历史记录，2026-09-18 起归档。** 本次 Web 重构将订阅桥接延后，相关桌面与桥接运行链路已退出首版范围。下文保留早期决策和测试证据，不代表当前功能、构建入口或持续授权；当前边界见 [README](../README.md) 和 [重构记录](refactor-execution.md)。

状态：进行中。本文件记录已批准的实施计划、P0 阶段核验的事实与决策，以及各阶段进展。
配套调研背景见 `docs/openai-subscription-kimi-code-research.md`。

## 目标

在我们工具中完成 ChatGPT 登录、模型选择与配置管理，让 Kimi Code 通过本地桥接使用 ChatGPT
订阅模型，同时保留 Kimi 自身的上下文、Skills、工具调用与权限流程。桥接随 GUI 启动、退出；
隐藏到托盘时继续运行。先在当前 macOS 验证完整链路，再完成三平台安装包。

## 已批准的实施计划（阶段）

- P0 兼容性与打包预检：固定参考版本、确认 Kimi/Node、运行时分发、凭据存储、IPC、最低系统版本。
- P1 macOS 纵向原型：单账号 OAuth、独立凭据、最小 Responses 桥接、隔离 `KIMI_CODE_HOME`、模型绑定。
- P2 GUI 与配置管理接入：向导、状态、保存队列、归属、模型刷新、解除绑定、备份、受限探针。
- P3 运行稳定性与故障处理：统一退出、崩溃/端口/父进程退出、有限重启、刷新竞争、单实例控制。
- P4 正式打包与交付：内置运行时、完整性、许可、签名、三平台验证。

范围边界：首版只做单账号、Responses-only、loopback 单实例；不做账号池、不读取 Codex 登录缓存、
不提供 Chat Completions 转换、不做 GUI 退出后的常驻服务、不做社区插件配置自动迁移。

## P0 决策与核验事实（2026-09-15）

### 环境事实

- 本机：macOS 27（arm64）；开发用 Node v26.8.2、npm 11.19.1。
- 本机 Kimi：`~/.kimi-code/bin/kimi` 0.43.0。仓库当前适配基线是 0.38 契约，
  实施时以本机 0.43.0 的 `kimi doctor` 校验为准。
- 参考实现固定版本：`devxia/kimi-gpt-bridge` v0.1.4 = commit `ff4d30826cf621902acc94382914ad103b4aeb71`；
  `P-A-N-52/kimi-codex-oauth` v0.1.1 = commit `6999c151296e7085022ff2a73dfd7e073305e592`。均为 MIT。

### 运行时分发（P0 决策）

- 采用 Tauri 官方 “Node.js as a sidecar” 指南推荐的方式：用 `pkg`（@yao-pkg/pkg）把桥接
  编译成自包含二进制，再作为 `externalBin` 打进安装包；最终用户无需安装 Node/Python。
- 桥接内部使用 Node 内置模块 + `fetch`（Node 18+），零运行时依赖。
- **兼容边界（需独立决策，不应顺带抬高应用整体最低版本）：** 官方 Node 22 的 macOS
  构建要求 macOS ≥ 11.0（BUILDING.md 平台表），而应用 `tauri.conf.json` 声明
  `minimumSystemVersion 10.15`。因此：桥接功能要求 macOS ≥ 11.0；应用整体保持 10.15 声明，
  在 10.15 上启动桥接时给出明确的“该功能需要 macOS 11+”错误，而不是静默失败。
  固定运行时基线：Node 22 LTS（当前 22.23.2），对应 `pkg` 的 node22 基座。
- 构建产物：`src/bridge/`（TS，零运行时依赖）→ esbuild 单文件 → `pkg` 自包含二进制
  → `src-tauri/binaries/bridge-<target-triple>`。

### 凭据存储（P0 决策）

- 生产路径：OAuth 凭据存系统凭据存储，用 Rust `keyring` crate（v3 系）接入；
  桥接进程不持久化凭据。Rust 宿主在启动桥接时经私有通道注入初始凭据，桥接刷新后回传，
  宿主写回。
- 桥接进程本身在 P1 原型（独立运行、隔离临时目录）阶段使用 0600 私密文件 + 原子写；
  该文件仅存在于隔离的临时/开发目录，不是生产持久化路径。生产不得回退明文 token 文件。
- OAuth token 不进入 React 状态、普通设置表、配置预览、日志或任何备份/WebDAV/导出。

### 进程与 IPC（P0 决策）

- Rust 宿主用 `tokio::process::Command` 直接 spawn sidecar（不引入 shell 插件）；
  通过继承的 stdin/stdout 走 JSONL 控制协议。桥接检测 stdin 关闭 → 父进程退出 → 自行退出。
- 桥接 HTTP 只监听 `127.0.0.1:<port>`，提供 `POST /v1/responses` 与 `GET /v1/models`，
  使用随机生成的 bearer 做本机鉴权。健康/管理走控制通道，不开放 HTTP 管理后台。
- 端口首次创建时选定并持久化，之后保持不变；被占用时报告冲突，不连接陌生实例。

### 上游与协议（P0 决策）

- 推理上游固定 `https://chatgpt.com/backend-api/codex/responses`；测试用模拟上游。
- 请求规范化参考 `kimi-codex-oauth`：强制 `store=false`、`stream=true`、默认 instructions、
  剥离后端拒绝的参数（含 `max_output_tokens`）。
- 重试规则：401 在未向下游输出时刷新并重试一次；流式输出开始后不重放；额度错误不循环重试。

### 本地代码（P0 决策）

- `src/bridge/`：Node 侧桥接（入口、认证、模型目录、Responses 转发、控制协议）。
- `src/shared/chatgptBridge.ts`：数据契约与目录正规化（纯 TS）。
- 配置管理复用现有 `configStore` provider/model/profile 保存事务；桥接进程不写配置。
- 配置归属记录在 GUI 结构化设置中，不依赖 TOML 注释或 `chatgpt/*` 前缀。

## 阶段进展

### P0（2026-09-15）

- [x] 固定参考版本并确认 MIT 许可。
- [x] 确认本机环境与 Kimi 0.43.0。
- [x] 确定运行时分发方案（pkg sidecar）与 macOS ≥ 11 兼容边界。
- [x] 确定凭据存储（keyring，Rust 宿主）与 IPC（JSONL over stdio）。
- [x] 确定上游协议与重试规则。

### P1（2026-09-15，已通过验证）

- [x] 桥接 TS 模块与零依赖 esbuild 打包（`dist-bridge/bridge.mjs`，36KB）。
- [x] PKCE OAuth + 刷新：30 个桥接测试通过（pkce/token-store/proxy/upstream/oauth-flow/server/process）。
- [x] Responses 桥接：鉴权、流式透传、非流式聚合、401 单飞刷新重试、429 不循环、模型目录。
- [x] 进程级端到端：spawn 真实 `bridge.mjs`，OAuth 回调登录 → 推理 → SIGTERM 优雅退出。
- [x] 隔离 `KIMI_CODE_HOME` 模型绑定 + `kimi doctor` 校验通过。
- [x] **真实 Kimi CLI 纵向切片**：kimi 0.43.0 → 桥接 → 模拟上游，`kimi -p` 输出 mock 响应、exit 0、单次请求无重试。

P1 验证脚本：`scripts/verify-kimi-through-bridge.mjs`（只操作临时目录与模拟上游）。

**P1 关键发现：**
1. TOML 里 `default_model` 必须位于任何 `[table]` 之前（否则归属到子表，kimi 读不到默认模型）；
   GUI 的 `serializeMainConfigToRaw` 本来就把默认字段放文件顶部，产品路径无此问题。
2. 模型记录不要设 `provider_id`/`protocol` 覆盖 `provider`（会把 provider 解析成未配置的字符串）。
3. 上游 SSE 必须包含 `response.output_item.done`（message）与 `response.output_text.delta`，
   否则 kimi 解析器拿不到 assistant 回合内容会空回合重试。

### P2（2026-09-15，已实现并通过验证）

- [x] `src/shared/chatgptBridge.ts`：绑定数据契约 + 纯逻辑（provider/model 生成、目录 diff、引用保留解除、secret 脱敏）；7 个单测。
- [x] `PanelSettings.chatgpt_bridge_bindings`：按环境 id 记录绑定（OAuth token 不入表）。
- [x] Rust 宿主 `src-tauri/src/bridge.rs`：JSONL 控制客户端、进程 spawn/stop、keyring 凭据存取（macOS Keychain/Windows Credential Manager）、受限连通性探针（仅 127.0.0.1+显式端口）；120 个 cargo 测试全绿。
- [x] 渲染层适配 `tauri/chatgptBridge.ts` + `chatgptBridgePanel.tsx`，挂载于 设置 → Kimi Code → 账号；六语言 i18n。
- [x] 应用/解除绑定复用 `updateState` 自动持久化与 `configRelations` 引用保留。
- [x] `npx tauri build --no-bundle --debug` 通过，sidecar 正确 staging。

### P3（2026-09-15，核心已实现）

- [x] 无孤儿进程：桥接检测 stdin 关闭（宿主退出）自行退出；`process.test.ts` 新增“parent closes stdin → exit 0”测试。
- [x] 单实例控制：`BridgeState` 只持有一个句柄，`bridge_start` 重复调用返回既有状态。
- [x] SIGTERM 优雅退出（已验证）；端口占用由桥接 listen 失败上抛。
- [x] 退出策略：随 GUI 退出（stdin 关闭机制，无需常驻服务）。

### P4（2026-09-15，管线已就绪，完整 bundle 验证待发布时执行）

- [x] `pkg`（@yao-pkg/pkg）把桥接编译成自包含二进制（node22 基座，macOS ≥ 11 兼容边界已在 P0 记录）。
- [x] `scripts/build-bridge-sidecar.mjs`：按 target triple 产出 `src-tauri/binaries/bridge-<triple>`（macOS arm64/x64、Windows x64 三目标）。
- [x] `tauri.conf.json` `externalBin: ["binaries/bridge"]`；`.gitignore` 排除 `src-tauri/binaries`、`dist-bridge`。
- [x] `release.yml`：每个矩阵目标在 `tauri build` 前先构建对应 sidecar。
- [x] 本机已实测：pkg 二进制可独立完成 start/status/shutdown 控制协议；debug 构建成功 staging sidecar。
- [ ] 完整 dmg/nsis 发布构建 + 三平台签名/升级验证：需打 `v*` 标签在 CI 执行（本次未运行）。

## 尚未完成 / 明确排除

- 真实 ChatGPT 账号的端到端登录（需要用户实际账号授权；本次用模拟上游验证了完整协议链）。
- 完整 release bundle 三平台构建验证（需 CI 标签触发）。
- keyring 在无系统凭据服务的 Linux CI 上仅编译不运行（cargo test 用内存 store 覆盖）。
- 多账号、Chat Completions 转换、GUI 退出后常驻服务：按计划不纳入首版。
