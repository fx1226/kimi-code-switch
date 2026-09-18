# Web UI 实际验收记录

本目录入库内容为经过检查的合成样本截图与验收报告。两份性能 JSON 的本机源码、CLI 绝对路径已替换为 `<workspace>`、`<official-cli>`，并标记 `sanitizedForPublication: true`；测量值、全部样本、失败记录及产物 SHA-256 保持原值。`acceptance-summary.json` 和 `performance-20-preserved.json` 中的报告文件完整性哈希对应本机保全的原始报告，不能用于校验脱敏后的公开 JSON。原始日志、二进制、个人配置首次启动记录与仓库保全快照不随此目录发布；报告中的历史日志文件名仅作本机证据索引。

## 提交前审查修复补验

2026-09-18，Chrome 153.0.8010.52 直接运行新自包含包（SHA-256 `29395990141e157db7aa65d45729ed5c3ca3deca3d5781551c1c906e0b078408`）。结果见 `review-fix-browser.json`，包检查见 `review-fix-package.json`。临时 HOME、原生目录、私有目录全部隔离；配置和 TUI 候选由真实 CLI 2.0.0 doctor 校验，未执行 MCP 命令或访问远端模型服务。

- `review-fix-independent-drafts.png`：保存全局配置后，TUI 草稿仍保留、离页确认仍触发；外部修改已保存模型并重新读取后，仅提交 telemetry 不夹带旧模型。
- `review-fix-redacted-source.png`：敏感 env 多行内容全部隐藏；截图前断言原文视图不包含合成密钥或 canary 内容。
- `review-fix-mcp-768.png`：空白 MCP 文件首次新增成功、最终 JSON 内容与提交一致，768px 无页面横向溢出。同会话另验证隐式 stdio 改 HTTP 后写入 transport，command/type/未知字段保留。
- 带内部注释的 TOML 数组整体替换返回明确错误，并确认文件逐字不变。

此次 7 项浏览器检查全部通过、0 页面异常，测试服务和临时目录已清理。以下是此前较完整矩阵的历史记录；未对本轮产物重跑完整 Safari 与性能矩阵。

测试日期：2026-09-18。服务、HOME、KIMI_CODE_HOME、项目目录、私有数据库与备份均为本次临时测试数据。使用真实 Kimi Code CLI 2.0.0 执行服务端候选配置校验；测试模型地址为 `.invalid`，没有验证远端模型服务或真实账号登录。服务使用重新构建的 `dist-server/server.mjs`，浏览器读取重新构建的 `dist/`。

## 浏览器与覆盖范围

| 浏览器 | 结果 | 证据 |
| --- | --- | --- |
| Chrome 153.0.8010.52 | 下列完整功能流程通过，0 页面异常、0 API 错误 | `browser-checks.json` |
| Playwright WebKit 26.6 | 下列完整功能流程通过，0 页面异常、0 API 错误 | `webkit/browser-checks.json` |
| Safari 27.0 | 通过本机原生辅助功能界面完成 Provider 修改、真实 doctor 预览、保存、创建备份与恢复，最终文件逐字节断言通过 | `safari-native-checks.json`；最终自包含程序；未修改自动化设置 |

WebKit 结果属于引擎覆盖。Safari 成品另以原生界面验证上述核心流程；未重复 Safari 的完整尺寸、键盘、缩放及异常备份矩阵，不将 Chrome/WebKit 的全面结果移作 Safari 结论。

## 已执行的真实用户流程

- 编辑 provider alpha，再编辑 beta；只检查并应用 alpha。读取原生 TOML 断言只有 alpha 改变，beta 原生值未变，页面仍保留 beta 草稿，未知字段保留。
- 用方向键切换页签；用 Escape 关闭原生模态对话框并验证焦点返回触发按钮。
- 编辑 MCP 参数并应用，读取原生 JSON 断言文件顶层和 server 内的未知字段保留。
- 为默认目标设置项目工作目录，选择项目本地 MCP 范围，显示独立的空文件。
- 保留旧构建产生的早期 v1 备份，并加入损坏包。旧包和正常包均可列出；损坏包逐项显示不可恢复、禁用恢复，并通过浏览器下载原文字节。
- 浏览器创建备份，模拟外部修改临时 `config.toml`，浏览器检查恢复计划并应用，断言恢复文件与备份时逐字节相同。
- 1440、1024、768 布局与明暗主题已实际截图核对；1024、768 无 document 横向溢出。

## 200% 缩放

`chrome-native-200-percent.png` 来自独立 headed Chrome 临时 profile。通过 Chrome Settings → Appearance → Page zoom 将真实浏览器网页缩放设为 200%；记录 `outerWidth=1440`、`innerWidth=720`、`scrollWidth=clientWidth=712`。该图由同一隔离会话捕获完整可见视口，未操作用户 Chrome profile。

`200-percent-providers.png` 及 WebKit 对应图片另为 720 CSS 像素、DPR 2 的全页重排模拟，和上述真实 Chrome 缩放证据分别记录。

## 首页可操作耗时

方法和逐样本数据见 `home-timing.json`：服务重启后首个 bootstrap 未预热，从导航开始直到概览可见、目录选择可用、config.toml 查看按钮可用。通过浏览器页面内 MutationObserver 计时，未跳过读取或校验，排除浏览器进程启动耗时。最终冷样本为 **977.8 ms**，五次温样本为 **76.4 / 72.5 / 68.5 / 63.8 / 62.3 ms**，冷样本达到 1500 ms 预算。此前版本的冷启动 2178.2 ms 记录保留在 `home-timing-before-cli-cache.json`。这是本机合成配置、一次冷样本与五次温样本的测量。

## 源码验证

新 Web UI 共 56 项行为测试通过，覆盖资源草稿隔离、不同目标与项目路径、MCP 范围、计划 revision、断网查询 plan ID、轮询断网不重复 apply、配置损坏与空态、恢复处置、不可恢复备份、秘密脱敏及表单验证。`npm run typecheck` 与 `npm run build:web` 通过。图片与 JSON 记录均只包含本次合成测试数据，不包含连接 token 或真实凭据。

## 清理

已关闭本次创建的本地服务、Chrome 和 WebKit 会话，并删除临时 HOME、原生 fixture、工具数据库、备份、浏览器 profile、下载引擎与 npm 缓存。保留本目录有效截图和测量记录；没有修改真实 Kimi 配置、用户 Chrome profile、Safari 设置或系统自动化权限。

## Safari 成品补验

`safaridriver` 因远程自动化未启用而失败后，改用本机原生辅助功能界面，在新标签页访问最终自包含程序的隔离服务。实际输入 Provider URL、检查含官方 doctor 成功说明的计划、应用并核对原生文件保留原注释；随后在 Safari 创建备份，外部修改临时样本，再在 Safari 预览并应用恢复。恢复文件与备份正文逐字节相同，两项持久操作均为 succeeded，MCP 未知根字段未变。程序 SHA-256 与最终候选一致。只关闭本次标签页，保留原有浏览器页面；临时服务及 HOME/配置/备份已清理。没有更改 Safari 设置。
