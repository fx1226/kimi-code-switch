# Kimi Code 2.0 原生文件契约

本项目以官方 **CLI `2.0.0`** 为当前可写契约基线；只匹配该稳定版本。更旧、更新、预发布、带自定义构建后缀或无法识别的版本不自动获得写入权限。版本匹配只说明契约选择，不能证明具体客户端已加载配置。

官方发布于 2026-09-17，tag 为 `@moonshot-ai/kimi-code@2.0.0`，固定 commit 为 `1b89e4b039f052d10f258464413b2047acca12ba`。[官方发布记录](https://github.com/MoonshotAI/kimi-code/releases/tag/@moonshot-ai%2Fkimi-code@2.0.0)

## 证据与样本

`tests/fixtures/kimi-code/2.0.0/contract-manifest.json` 记录固定版本来源、下载源码 SHA-256、样本 SHA-256、样本来源方式以及验证入口。旧 `0.38.0` 目录和测试保留为历史回归证据。样本不含用户配置或真实凭据。

| 文件 / 能力 | 官方固定来源 | 本项目验证边界 |
| --- | --- | --- |
| `config.toml` | [配置文档](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/docs/en/configuration/config-files.md)、[providers/models schema](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/app/kosongConfig/configSection.ts) | 文档原样样本、本项目解析/序列化往返、官方 doctor 候选文件校验 |
| `tui.toml` | [TUI parser/defaults](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/apps/kimi-code/src/tui/config.ts) | CLI 终端偏好；不视为 Desktop 的外观设置 |
| MCP | [分层 loader](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/app/mcpConfig/configLoader.ts)、[MCP schema](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/mcpCore/config-schema.ts) | 本项目事务写入后，由固定官方 loader 读取三层文件、验证覆盖和来源；未启动 MCP 进程或访问远端服务 |
| Skills | [discovery](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/features/skill/catalog/fileSkillDiscovery.ts)、[parser](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/features/skill/catalog/parser.ts) | 本项目目录恢复后，由官方 discovery/parser 实际读取；目录式、flat、显式项目/用户根和同名优先验证通过，没有调用技能 |
| Plugins | [安装记录存储](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/app/plugin/store.ts)、[manager](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/app/plugin/manager.ts)、[manifest parser](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/app/plugin/manifest.ts) | 本项目目录恢复后，官方 `PluginManager.load()` 实际消费记录、manifest 与技能；来源、禁用过滤及路径边界验证通过，没有安装或执行插件 |

源码下载哈希用于来源追踪；`upstream/sources.json` 记录消费验收使用的 26 份原文件哈希，原始 MIT 许可证与 Moonshot AI 版权声明一并保留。这些文件只供测试，生产构建不导入。样本单元测试、官方源码消费函数验收、真实 CLI doctor 与 Desktop 静态检查分别记录，不以其中一种替代其他证据。

## 路径、作用域与更新规则

- 数据根为显式选择的原生目录 / `KIMI_CODE_HOME`，缺省 `~/.kimi-code`。项目改名不迁移或改名 Kimi Code 原生目录。[官方路径文档](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/docs/en/configuration/data-locations.md)
- MCP 按用户 `mcp.json` → 最近 Git 根 `.mcp.json` → 当前工作目录 `.kimi-code/mcp.json` 合并，后层同名覆盖前层；没有 Git 根时使用当前目录。只有 Git 根 `.mcp.json` 的 stdio `cwd` 按该根目录归一化。来源路径与可写目标必须分开保存。
- Skills 作用域优先级为 Project > User > Extra > Built-in。Kimi 用户目录随 `KIMI_CODE_HOME` 变化；通用 `~/.agents/skills` 属于操作系统用户 home；项目目录为最近 Git 根的 `.kimi-code/skills` 和 `.agents/skills`；`extra_skill_dirs` 为额外搜索源。目录式 `SKILL.md` 和顶层 `.md` 都可发现。
- `2.0.0` 相对本项目旧基线新增需保留的 TUI 字段是 `disable_feedback_survey`（默认 `false`）和 `[markdown].mermaid`（`final` / `off`，默认 `final`）。未知 Mermaid 值按上游行为给诊断并使用默认有效值，普通保存不得把未知原文替换成默认值。
- 文件显式值与默认生效值分开。`KIMI_EDITABLE_FIELDS` 是有限表单目录，不是完整官方 schema；表单不应把未填写项补写为默认值。未管理字段继续保留。

## 官方 doctor 的适用范围

[doctor 命令入口](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/apps/kimi-code/src/cli/sub/doctor.ts) 提供以下精确候选文件命令：

```text
kimi doctor config <absolute-candidate-config.toml>
kimi doctor tui <absolute-candidate-tui.toml>
```

必须传显式候选路径；裸 `kimi doctor` 对缺省缺失文件可以返回 `SKIP` 和 exit 0。`config` 校验调用 [validateConfigTomlV2](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/apps/kimi-code/src/cli/v2/validate-config.ts)，检查已注册 section 的 schema，未知键和废弃键可能仅告警。`default_model` 等无注册 schema 的域并不因此获得类型或引用完整性保证。本项目仍需验证引用、来源、并发变更与实际写入范围。

`src/server/officialValidation.ts` 在私有临时目录写候选，使用真实 CLI 可执行文件进行 `--version` 和上述命令。HOME、USERPROFILE、KIMI_CODE_HOME、XDG、应用数据目录和 cwd 均隔离；不继承模型覆盖变量、凭据或 NODE_OPTIONS。候选文件权限为 `0600`，调用限时，输出要求明确 `OK`，校验后读回确认候选未改，并清理临时目录。CLI 原始输出可能含候选内容，因此仅返回固定诊断代码和安全说明。

已验证的版本证据按可执行文件真实路径、设备号、inode、大小、纳秒修改/状态时间与权限缓存，最多保留 16 项。每次使用仍重新解析符号链接并核对这些属性；文件替换或链接切换会重新查询版本，校验期间发生变化则拒绝写入。缓存只消除同一可执行文件的重复版本查询，**每份候选仍执行真实 `doctor`**，不缓存配置校验结论。

结果明确分为 `passed`、`rejected`、`unavailable`；未安装、非基线版本、启动失败、超时或无明确 `OK` 均不能当作通过。官方返回警告会保留警告状态。该验证器不执行 hooks、模型请求、MCP 服务或插件，也不证明现有会话重新加载了配置。

独立验收命令：

```bash
node scripts/verify-kimi-contract.mjs /absolute/path/to/kimi
```

2026-09-18 在 macOS 开发机执行，CLI 自报 `2.0.0`：官方 `doctor` 接受固定 `config.toml` / `tui.toml` 样本，拒绝 config 错误类型、TUI 错误类型和畸形 TOML；候选内容未改，临时目录已清理。此结果只证明该次官方解析验收。二进制版本由 `--version` 报告，未作二进制与源码 commit 可复现构建证明。

同日另作隔离边界检查：`default_model = 123` 和指向不存在 alias 的 `default_model` 均获得官方 `doctor` 的 `OK`；`markdown.mermaid = "wrong"` 返回 `OK` 加警告。它们不代表有效配置，服务层必须独立拒绝新引入的已知字段类型、枚举或引用错误。通用文本补丁的语法和局部性检查不能替代此层。

## MCP、Skills、Plugins 官方源码消费验收

[固定 CLI 命令注册](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/apps/kimi-code/src/cli/commands.ts) 未提供可直接用于这三类验证的非交互 `list` 子命令，因此使用固定源码的离线消费函数。运行：

```bash
node scripts/verify-kimi-native-consumption.mjs
```

脚本先逐文件验证官方源码 SHA-256，再把 `pathe@2.0.3`、`zod@4.3.6`、`js-yaml@4.1.1` 安装到临时目录，禁用生命周期脚本，不修改项目依赖。消费子进程使用隔离 HOME、KIMI_CODE_HOME、XDG、cwd 和私有元数据路径，不继承账号、模型覆盖变量或 NODE_OPTIONS。依赖安装需访问 npm；实际消费步骤不联网。

**2026-09-18，macOS / Node `26.8.2` 实际执行通过。** 审查修复后重跑，本项目 `createConfigurationService` 完成 9 次真实事务：用户/项目根/当前工作目录 MCP 各一次，MCP 协议切换一次，空文件与纯空白文件新增各一次，用户与项目 Skills 各一次，Plugins 目录一次。MCP 与插件 JSON 包含本项目 `applyDocumentPatch` 的输出，Skills/Plugins 通过同一事务内核的 portable restore 落盘；官方入口读取这些实际文件，而不是仅验证预先存在的官方样本。

- MCP：官方 `loadMcpServersDetailed` 验证用户 → 项目根 → cwd 覆盖、每个 server 的来源、项目根 stdio `cwd` 归一化、`includeProject=false` 和无 Git 根回退；官方 schema 拒绝无效 URL 与超时值。
- MCP 协议切换：原含 `command`、未知 `type` 的条目先被官方推断为 stdio；局部写入 `transport = http` 与 URL 后，官方读取为 HTTP，原 command/args/type/vendor 文本保留。官方优先读取显式 `transport`，否则按 command、URL 推断；`type` 不参与判断。空与纯空白 `mcp.json` 按空对象管理，无修改时保持原字节，首次添加后由官方 loader 验证。
- Skills：官方 `discoverFileSkills` 与 `parseSkillText` 验证目录式 `SKILL.md`、顶层 `.md`、显式传入的项目/用户搜索根、同名第一根优先，以及缺失目录式 frontmatter 的拒绝。未声称验证完整应用自动收集技能根的服务。
- Plugins：官方 `PluginManager.load` 验证安装记录中的实际 root 可读取 manifest 与技能；`source`、`originalSource`、GitHub 元数据保留；禁用项不输出技能根/MCP；MCP runtime 的 cwd 与 KIMI_PLUGIN_ROOT/KIMI_CODE_HOME 派生正确。官方 manifest parser 验证根 manifest 优先、备用 manifest 来源，以及符号链接指向插件外部时拒绝。来源保留不代表验证了远程仓库真实性。

为避免启动整套应用，验收只抽取官方 `resolveKimiHome`、`resolvePath`、`isWindowsAbsolutePath`、`HookDefSchema` 与 `CONFIG_INVALID_ERROR_CODE` 的原始声明，省略无关 bootstrap/配置注册；DI 日志标记为空装饰器，错误聚合使用原始错误类与域。插件下载/解压/GitHub查询入口若被触发立即抛错。MCP loader/schema、Skills discovery/parser、Plugin manager 的读取/过滤逻辑和 manifest 业务规则保持官方原样。具体适配见 `upstream/README.md` 与脚本。

验收成功与失败后均清理临时目录。这是**官方源码消费函数验收**，不等同于完整 CLI/Desktop 启动、账号认证、MCP 服务连接或插件代码执行；此轮没有进行上述行为。

## Desktop 单独记录

官方说明只承诺 Desktop 与 CLI 共享部分账号、模型、provider 和插件配置。[Desktop 官方说明](https://www.kimi.com/code/docs/en/kimi-code-desktop/getting-started.html#desktop-and-the-cli-on-the-same-machine)

本机安装包 `Info.plist` 与 `app.asar/package.json` 显示 **Desktop `1.0.1`**；bundle 内服务声明 `serverVersion: "2.0.0"`，存在同样的 `KIMI_CODE_HOME` / `config.toml` / MCP loader。上述是安装包静态证据，未作为 CLI 版本或 Desktop 运行验证结果。Desktop 私有 `ui-state.json`、`Local Storage/leveldb` 等状态排除在管理范围之外。当前 `evaluateKimiCompatibility("1.0.1", "desktop")` 返回 `static-shared-contract`，不会单独开放原生写入，也不会宣称 Desktop 全面兼容。

本机安装包哈希、单实例行为及运行验证尚未执行的原因见 [Desktop 验证记录](desktop-compatibility-validation.md)。
