# UI 视觉验证与文档截图

开发环境可通过 `http://127.0.0.1:1420/?ui-fixture=showcase` 打开脱敏 fixture。它提供固定的 Profile、Provider、Model、MCP、Skills 和 Insights 数据，不读取本机 `~/.kimi-code/`。

视觉验收至少检查：

- `1440 × 900`：总览、Provider、Model、MCP、Skills、Insights 与设置页。
- `1100 × 720`：导航、搜索、环境切换和关键工作区仍可达，页面无横向滚动、标题栏遮挡或焦点裁剪。
- 浅色、深色及各 appearance theme：选中、当前激活、未保存、成功、警告、错误和焦点状态仍可区分。
- 中文、英文和最大字号：顶部工具栏、列表行与设置 Tabs 不重叠。

README 截图必须来自该 fixture：`overview.png`、`profile.png`、`providers.png`、`models.png`、`mcp.png`、`skills.png`、`insights.png` 和 `settings.png`。更新截图前，先人工检查画面没有真实名称、端点、密钥或日志内容。

组件级无障碍验收由 `npm run test:a11y` 覆盖；它锁定 Dialog、命令面板、Tabs、资源工作区和表单错误关联的键盘与 ARIA 契约。
