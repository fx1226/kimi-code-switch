# ChatGPT 官方订阅接入 Kimi Code：可行性调研

> **历史调研，2026-09-18 起归档。** 订阅桥接不在当前 Web 首版范围；本文所述版本、服务政策和旧代码路径仅代表调研时点，未作当前有效性复核。后续重新启动研究需重新核验来源与授权。当前产品范围见 [README](../README.md)。

调研日期：2026-09-15。本文是研究结论与建议，不代表功能已经实现或真实账号验收通过。

## 结论

**技术上可行，而且已经有专门针对 Kimi Code 的社区实现；但不能仅靠静态修改 `config.toml`，就把 ChatGPT Plus/Pro 变成普通 OpenAI API key。**

最符合本工具定位的路径是：

```text
本 GUI：配置、模型选择、连接状态、备份与回滚
                    ↓ 写入普通 provider / model
Kimi Code：保留自己的 agent、上下文、工具与权限管理
                    ↓ 本机 OpenAI-compatible HTTP 接口
本地桥接器：ChatGPT OAuth、刷新、账号头、请求兼容、SSE
                    ↓ HTTPS
ChatGPT Codex 订阅后端
```

建议先做“外部桥接器 + 现有配置功能”的受控验证，再决定是否托管桥接器进程。不要首先 fork Kimi Code、复制其 agent runtime，或向 Kimi 配置写入可轮换的 OpenAI OAuth token。

本文将“官方订阅”理解为本人 ChatGPT Plus/Pro 等包含 Codex 权益的套餐，不包括另行计费的 OpenAI Platform API。不同套餐、账号、地区和工作区的模型权限仍需实际核验。

## 1. 订阅与 API 是两条认证、计费路径

OpenAI 官方认证文档明确区分：ChatGPT 登录使用 subscription access；API key 使用 usage-based access，并按 Platform API 价格计费。官方定价功能矩阵同时列明 Plus/Pro 支持 Codex CLI、SDK、`codex exec` 和脚本化工作流，但用量有套餐限制，不能承诺无限调用或 ChatGPT 网页全部模型均可用。[O1][O2]

OpenCode 的实际实现使用浏览器 PKCE 或 device flow，持有 access/refresh token，生成请求改发 `https://chatgpt.com/backend-api/codex/responses`，注入 `Authorization` 和 `ChatGPT-Account-Id`，并处理刷新和模型筛选。这些是运行时代码，而非几项静态配置。[O3]

**官方集成替代路径：**Codex SDK/App Server 可嵌入自己的产品。App Server 是 agent 级 JSON-RPC 接口，默认 stdio JSONL，不是标准 `/v1/responses` 推理服务器。如果用它接管任务，集成的是 Codex agent，不等于让 Kimi 原有 agent 无缝更换底层模型；中间还需要明确的工具、上下文与权限适配。[O2][O4]

服务边界：未找到 OpenAI 对 Kimi 或下面这些订阅代理的明确授权及私有后端稳定性承诺。开源代码许可证不等于服务访问许可。官方条款禁止共享账户凭据和绕过限额等行为；也不能反过来把官方支持的 SDK/CLI 自动化一概认定为违规。个人实验与对外正式发布应分开评估，不做账号池绕限额、共享订阅或公开转售服务。[O5][O6]

## 2. 已有实现：两个直接命中 Kimi Code 的项目

| 实现及核查版本 | 实际机制 | 适合参考的部分 | 主要限制 |
| --- | --- | --- | --- |
| `devxia/kimi-gpt-bridge` v0.1.4，2026-09-07 | 独立 ChatGPT OAuth；默认本机 1456；生成 `openai` provider，Chat Completions 转 Codex Responses；也提供 Responses 端点 | 独立凭据、跨进程刷新锁、模型/effort 同步、SessionStart 自启动 | 固定公开本地 bearer；配置写入无备份/revision guard；接管所有 `chatgpt/*` 模型；需要 Node，配置校验另需 Python 3.11+ |
| `P-A-N-52/kimi-codex-oauth` v0.1.1，2026-09-06 | 复用并刷新文件型 Codex OAuth；默认本机 8317；生成 `openai_responses` provider | 更小的 Responses 桥、配置备份/验证/并发变更检查、模型元数据、保守卸载 | 不支持仅 keyring 的 Codex 登录；生成端点无本地鉴权；共享 Codex refresh token 的跨程序竞争；依赖配置注释标记 |
| `router-for-me/CLIProxyAPI`，核查 main `7bbfeaf8…`；当时 latest release v7.3.3 | 通用多客户端、多上游协议代理，含 Codex OAuth 与 Responses/Chat Completions 转换 | 独立外部桥接器原型、参数兼容、流式/非流式转换 | 范围较大；示例默认监听所有网卡，必须主动收紧；不能照搬账户池和身份伪装选项 |
| OpenCode 内置 Codex OAuth，核查 dev `e03db9bc…` | 直接集成认证和请求 transport | 将来向 Kimi 上游贡献原生 provider 的参考 | 不能把 OpenCode 插件文件作为 Kimi provider 配置直接加载 |

版本依据与源码：[K1]–[K7]、[G1]–[G6]、[C1]–[C3]、[O3]。分支快照不自动等于对应稳定发布包。

Kimi 上游 issue #1523 明确请求原生 ChatGPT Plus/Pro OAuth，评论中作者推荐 `kimi-gpt-bridge`；#2850 有另一原生实现 fork 的线索；#3579 请求将 `kimi-codex-oauth` 加入 curated marketplace。这三个 issue 在核查时均 open。检查当时主分支 `plugins/marketplace.json` 未匹配到这两个插件，不能把“申请收录”说成“已经官方收录”。[U1][U2][U3]

### 2.1 `kimi-gpt-bridge`：功能匹配，但不要让其无约束接管配置

凭据默认保存在 `~/.kimi-gpt-bridge/auth.json`，不读写 Codex 登录缓存。实现了文件权限收紧、原子写、进程内去重和跨进程刷新锁；生成请求遇到 401 刷新重试一次。这比 GUI、Kimi、Codex 各自复制同一 refresh token 更容易划清责任。[G2][G3]

本机生成接口要求 `Bearer kimi-gpt-bridge` 和 JSON Content-Type，但该值公开且固定，并非强随机访问密钥。其他能访问 loopback 的本机进程仍可消耗额度。`/health`、`/v1/models` 无鉴权；生成请求有大小限制和客户端断开后的上游取消处理。[G4]

`src/models.js` 的 `isBridgeTable()` 把所有 `models."chatgpt/..."` 都当作自己的条目，不检查其 provider。因此不要同时安装两个使用 `chatgpt/*` 别名的插件，也不要在未检查冲突时运行它的 setup/sync/teardown。其写配置路径缺少原始备份和 revision 比较；teardown 对残留默认模型引用警告但不修复。[G5][G6]

该项目的 `/v1/responses` 路径主要补 `stream/store/include` 后透传，而非完整复用 Chat Completions 转换器的参数整理。**不能仅因为提供 Responses 路由，就把它自动生成的 `type="openai"` 改成 `openai_responses` 并宣称等价。**Kimi 可能注入的 `max_output_tokens` 等字段需要单独验证。[G4][G3][U6]

另外，`setup --port N` 与 SessionStart hook 的端口来源不同，hook 读取 `KGB_PORT`；自定义端口需要一致配置。hook 是会话启动时的 best-effort 拉起，不是持续进程守护；升级文件也不保证旧服务立即重启。[G6][G7]

### 2.2 `kimi-codex-oauth`：Responses 路径更小，但与 GUI 保存方式有冲突

代理确实强制 `store=false`、`stream=true`、补默认 instructions，删除包括 `max_output_tokens` 的不兼容参数，带账号头请求 Codex 后端，并将上游 SSE 转发给 Kimi。普通生成端点没有认证检查，也没有下游非流式 JSON 聚合；`local-proxy` 只是占位符。[K2]

刷新有进程内 single-flight 和写回前重读/比较，但没有与 Codex 本体共享的跨进程刷新锁。重读能减少覆盖，不等于避免两个进程同时向 OAuth 服务兑换同一 refresh token。[K2]

配置部分做得较保守：写前校验、私有备份、写回前检查外部修改；只管理带 `# managed-by: kimi-codex-oauth` 的条目，保留被引用或个人 overrides 对应的模型；真实 catalog 获取失败不据此删除模型。[K3][K4]

**本项目特有冲突：**GUI 的 `buildConfigDocument()` 用 `@iarna/toml` 从对象重建 TOML，不保留注释。GUI 保存一次后，上述 marker 会丢失，插件将这些条目视为个人配置，后续自动修复、清理和卸载语义发生变化。这不是纯排版问题。[L2][K3][K4]

本次已使用现有依赖在内存执行合成 TOML 的 parse → stringify：字段值往返相同，但 marker 确认消失。没有读取或写入个人配置。此检查只验证注释丢失，不代表完成插件端到端测试。

作者在 TESTING.md 区分了历史 macOS/Kimi 0.39.0 使用记录、v0.1.1 隔离回归和 Windows/Kimi 0.41.0 配置校验；不能把这些说成当前 macOS/Kimi 0.43.0 完整真实账号验证。[K5]

## 3. Kimi 及本工具现有能力

### 3.1 Kimi 原生协议已够用，OAuth 字段不能直接换厂商

核查 Kimi 主分支 commit `486dcd26c76f2854fc351515a45d8f0fc2d31ed6`（2026-09-14）；当时 latest release 为 `@moonshot-ai/kimi-code@0.43.0`。本工具已有文档兼容基线是 0.38.0，未运行本机 CLI 版本探针，实施前必须核验安装版本。

官方配置支持 `openai`、`openai_responses`、`base_url`、`api_key`、`custom_headers`。Responses 运行时已经使用 `store:false`、`stream:true`，并实现 instructions、function calls、reasoning encrypted content 和 usage，因此不需要重新写 Kimi 的工具循环。[U4][U5][U6]

但 `providers.*.oauth` 只是凭据引用，并不是任意 OAuth provider 的注册配置。当前 App `OAuthToolkitService` 构造 `KimiOAuthToolkit` 时没有注入另一 flowConfig；默认 flow 使用 Kimi client ID。`oauth_host` 可以改主机，却不会自动换成 OpenAI client ID、PKCE/device 协议、account ID 提取和 catalog。[U7][U8][U9]

所以：

- 配置指向已运行桥接器：可行，通常无需修改 Kimi 源码。
- 复制 access token + 改 URL/headers：某些请求可能暂时连通，但不是完整可靠方案；过期、参数及工具续接仍未解决。
- 只加 `oauth_host="https://auth.openai.com"`：不是有效的原生 OpenAI OAuth 集成。
- GUI 定时刷新 token 并覆写 Kimi 配置：不推荐；已有 Kimi 进程不保证立即重读，且引入明文 token、配置备份泄露和多写方竞争。

### 3.2 GUI 已有基础，但三个地方必须区分

1. **配置能力已具备。**`ProviderConfig` 支持上述字段；OpenAI 向导已有 Responses 类型，但默认是 `https://api.openai.com/v1` 的 API-key 路径，不是订阅登录。[L1][L3]
2. **“官方账号”目前指 Kimi，不是 OpenAI。**连通性测试的 official-account 分支检查 Kimi 登录槽，不能直接复用成 ChatGPT 已登录状态。[L4]
3. **GUI 的 HTTP 测试不等于 Kimi 请求。**Rust `http_request` 会拒绝 loopback/private URL；因此现状下 GUI 对 `http://127.0.0.1:PORT` 的连接测试会失败，而 Kimi 自身走独立网络路径，不能据此断言模型不可用。Responses GUI 探针发送非流式请求且按 JSON 提取文本，遇到始终 SSE 的桥接器还需要单独适配。[L4][L5]

不要为本地桥接全局删除 SSRF 防护。若未来增加探针，只允许用户明确确认的本机 endpoint/端口和固定必要路径，禁用重定向，限制响应体与超时，并单独处理 SSE。

## 4. 最小实施路线（尚未执行）

### A. 先证明链路，不改应用架构

在独立 `KIMI_CODE_HOME` 和测试工作目录中，只选一个桥接器，固定版本。

- 若用户希望独立 ChatGPT 登录，优先验证 `kimi-gpt-bridge` 的原生配置路径（`openai`）。
- 若用户已有外部代理，优先复用其已登录实例，例如安全配置后的 CLIProxyAPI；不要同时安装第二套订阅代理。
- `kimi-codex-oauth` 可作较小的 Responses 参考，但将共享凭据刷新和 marker 冲突列为前置限制，不默认接管用户 Codex 缓存。

验收至少包括：普通生成；调用一个无副作用工具并回传结果后继续生成；多轮与并行工具；reasoning effort；断流/取消；令牌刷新；401/429；重启自启动；GUI 保存后配置可用；卸载及回滚。不得把 HTTP 200、health ok 或 `/models` fallback 列表当作模型权限验证。

请求体、工具回传和 token usage 可用合成测试覆盖；真实登录和少量实际生成需要用户明确授权。不要为了测限额主动耗尽订阅，429/刷新失败先用模拟上游验证。

### B. GUI 首版只管理桥接连接

增加明确标注为“社区桥接 / ChatGPT 订阅”的来源，而不是修改现有 OpenAI API 来源的含义：

- 显示桥接器名称/版本、地址、登录状态与故障原因。
- 使用现有 `src/shared/configStore.ts` 的 provider/model/profile 保存流程，提供差异预览和回滚。
- **指定单一配置管理方：**GUI 管理条目时，桥接器只负责 OAuth 和推理，不再同时运行其 setup/sync 配置重写器。这需要验证项目能否按该模式部署；不能假定现在已有禁写开关。
- 独立强随机本机访问 key，不用公开占位值；令牌留在桥接器凭据存储，不进入 `config.toml`、GUI SQLite、预览、导出或 WebDAV。
- 模型 ID、context/effort 来自当前账号的有效 catalog，并经请求确认；不同桥接器采用独立别名命名空间，不共用整片 `chatgpt/*` 所有权。
- 将“配置已写入 / 桥接进程运行 / OAuth 已登录 / 实际推理通过”显示为不同状态。

模型 provider 的形状示意（不是可直接运行的真实配置；假定选择支持标准 Responses 的桥接器）：

```toml
[providers.chatgpt-bridge]
type = "openai_responses"
base_url = "http://127.0.0.1:8317/v1" # 实际端口由桥接器决定
api_key = "REPLACE_WITH_RANDOM_LOCAL_BRIDGE_KEY" # 不是 OpenAI OAuth token

[models."subscription/selected-model"]
provider = "chatgpt-bridge"
model = "REPLACE_WITH_VERIFIED_ACCOUNT_MODEL_ID"
max_context_size = 32768 # 仅为示例保守预算；正式值按账号模型元数据设置
capabilities = ["tool_use"] # 只声明已确认能力
```

对 `kimi-gpt-bridge` 首次验证仍保留其 `openai` 类型；不要把此示意误套到其 Responses 透传路径。

### C. 验证通过后才做进程托管

需要“一键体验”时再增加经过审计的 sidecar 安装、版本固定/校验、登录启动、健康探针、退出策略和升级。UI 不应承担持续 token refresh；隐藏/关闭 WebView 后，Kimi 的上游仍须可用。Rust 只提供受限原生进程和网络能力，配置业务继续留在 shared TS。

CLIProxyAPI 如作为外部实现，至少明确设置 loopback 监听、随机 `api-keys`、关闭不需要的管理端与 discovery、不启用身份混淆、不借助多账户切换规避限制。其示例 `host: ""` 绑定所有网卡，不能原样照抄。[C2]

只有现有桥接器均无法满足真实测试，或上游接受原生支持时，再考虑基于 OpenCode 的认证流程为 Kimi 增加真正的 Codex provider。那属于 Kimi runtime 改动，不是 GUI 配置层的小功能。

## 5. 完成范围与未知项

- 已核查官方文档、Kimi/桥接器/OpenCode 实际源码、版本及相关上游 issue；已复核关键本地调用路径。
- 唯一运行验证是现有 TOML 库的合成内存往返；未安装插件、登录、读取个人凭据、请求模型、修改真实配置或运行真实账号端到端测试。
- 未完成全面安全审计，不承诺桥接器可靠性、账号安全、模型权限或正式服务授权。
- Context7 查询返回额度耗尽，改用官方网页与 GitHub 原始源码；没有因此把未获取材料当作已验证。
- 本仓库存在其他开发中的修改，本文按读取时工作区描述；只新增此文档，不改动既有代码，不提交/推送。

## 来源

### OpenAI 与通用参考

- [O1 — OpenAI Authentication](https://developers.openai.com/codex/auth/)
- [O2 — Codex Pricing 与功能矩阵](https://developers.openai.com/codex/pricing.md)
- [O3 — OpenCode CodexAuthPlugin，e03db9bc](https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/opencode/src/plugin/openai/codex.ts)
- [O4 — Codex App Server](https://developers.openai.com/codex/app-server.md)
- [O5 — OpenAI Terms of Use，页面生效日 2026-01-01](https://openai.com/policies/terms-of-use/)
- [O6 — OpenAI Service Terms，页面更新日 2026-09-10](https://openai.com/policies/service-terms/)
- [C1 — CLIProxyAPI Responses 请求转换源码](https://github.com/router-for-me/CLIProxyAPI/blob/7bbfeaf8a7acf2cd5a834dcb0842539fe6aabc2b/internal/translator/codex/openai/responses/codex_openai-responses_request.go)
- [C2 — CLIProxyAPI 配置示例](https://github.com/router-for-me/CLIProxyAPI/blob/7bbfeaf8a7acf2cd5a834dcb0842539fe6aabc2b/config.example.yaml)
- [C3 — CLIProxyAPI OAuth 实现](https://github.com/router-for-me/CLIProxyAPI/blob/7bbfeaf8a7acf2cd5a834dcb0842539fe6aabc2b/internal/auth/codex/openai_auth.go)

### Kimi 上游

- [U1 — 原生 ChatGPT OAuth 请求 #1523](https://github.com/MoonshotAI/kimi-code/issues/1523)
- [U2 — 原生 Codex OAuth 实现线索 #2850](https://github.com/MoonshotAI/kimi-code/issues/2850)
- [U3 — 插件申请收录 #3579](https://github.com/MoonshotAI/kimi-code/issues/3579)
- [U4 — Provider 文档](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/docs/en/configuration/providers.md)
- [U5 — 配置字段文档](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/docs/en/configuration/config-files.md)
- [U6 — 当前 Responses requester](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/packages/agent-core-v2/src/human/llm/requester/bases/openai-responses/requester.ts)；[format](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/packages/agent-core-v2/src/human/llm/requester/bases/openai-responses/format.ts)
- [U7 — OAuth App service](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/packages/agent-core-v2/src/app/auth/authService.ts)
- [U8 — KimiOAuthToolkit](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/packages/oauth/src/toolkit.ts)
- [U9 — 默认 OAuth flow](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/packages/oauth/src/constants.ts)

### Kimi 专用社区实现

- [K1 — kimi-codex-oauth v0.1.1 README](https://github.com/P-A-N-52/kimi-codex-oauth/blob/6999c151296e7085022ff2a73dfd7e073305e592/README.md)
- [K2 — 代理与 token refresh](https://github.com/P-A-N-52/kimi-codex-oauth/blob/6999c151296e7085022ff2a73dfd7e073305e592/bin/codex-oauth-proxy.mjs)
- [K3 — 配置归属、校验与备份](https://github.com/P-A-N-52/kimi-codex-oauth/blob/6999c151296e7085022ff2a73dfd7e073305e592/bin/config-file.mjs)
- [K4 — 模型同步](https://github.com/P-A-N-52/kimi-codex-oauth/blob/6999c151296e7085022ff2a73dfd7e073305e592/bin/sync-models.mjs)
- [K5 — 测试范围与真实验证记录](https://github.com/P-A-N-52/kimi-codex-oauth/blob/6999c151296e7085022ff2a73dfd7e073305e592/TESTING.md)
- [K6 — v0.1.1 Release](https://github.com/P-A-N-52/kimi-codex-oauth/releases/tag/v0.1.1)
- [K7 — marketplace 检查范围](https://github.com/MoonshotAI/kimi-code/blob/486dcd26c76f2854fc351515a45d8f0fc2d31ed6/plugins/marketplace.json)
- [G1 — kimi-gpt-bridge v0.1.4 Release](https://github.com/devxia/kimi-gpt-bridge/releases/tag/v0.1.4)；[README](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/README.md)
- [G2 — 独立 token store 与刷新锁](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/src/token-store.js)
- [G3 — 上游请求与身份头](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/src/upstream.js)
- [G4 — 本地服务、鉴权与流式转换入口](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/src/server.js)
- [G5 — 模型发现与配置归属](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/src/models.js)
- [G6 — setup/sync/teardown](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/src/cli.js)
- [G7 — SessionStart hook](https://github.com/devxia/kimi-gpt-bridge/blob/ff4d30826cf621902acc94382914ad103b4aeb71/hooks/ensure-running.mjs)

### 本地代码（行号可能随并行开发漂移，函数名为定位依据）

- L1：`src/shared/types.ts:38–57`，`ProviderConfig`。
- L2：`src/shared/configStore.ts`，`buildConfigDocument`、`serializeMainConfigToRaw`；文件开头的 TOML parse/stringify 导入。
- L3：`src/renderer/src/wizards/sourcePresets.ts:38–48`，OpenAI 预设。
- L4：`src/renderer/src/tauri/cli.ts:1047–1200`，`buildRequest`、`extractText`、`runKimiConnectivityTest`。
- L5：`src-tauri/src/system.rs:79–159,1289–1328`，`host_is_loopback_or_private`、`validate_http_url`、`http_request`。
