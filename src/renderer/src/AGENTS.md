# 浏览器界面

`main.tsx` 启动 `web/WebApp.tsx`；`http/webApi.ts` 是显式异步 HTTP / SSE 客户端。浏览器只依赖共享类型和纯规则，文件、CLI 与 SQLite 操作都交给服务端。

- `web/WebApp.tsx` 组合五个一级入口与目标选择；`ResourceForms.tsx`、`ConfigurationPanel.tsx`、`ToolsPanels.tsx` 承载具体任务。
- `web/drafts.ts` 管理资源草稿。一次应用、删除、预设或恢复仅处理其明确范围；其他草稿保持不变。提交结果不明时按操作 ID 查询，不能自动重发写请求。
- 原生配置显式应用；仅工具偏好自动保存。文件缺失、读取失败、鉴权失效、服务断开和版本只读分别显示，读取失败不能回退成可编辑默认配置。
- 顶部显示原生目录和工作目录，编辑区显示实际文件及作用域。文案区分已写入文件、校验通过与客户端验证；浏览器下载仅报告“已发起下载”。
- `web/messages.ts` 与面板内字典覆盖 `Locale` 的六种语言；`web/web.css` 使用 CSS 变量与 `data-theme`，支持浅色、深色和系统主题。优先系统字体，保留 `assets/logo-light.png` 与 `logo-dark.png`。
- 服务通知用于提示资源变化，不能无提示覆盖用户草稿。原文与变更预览使用共享脱敏规则。

修改表单或保存交互时验证独立草稿、错误关联、键盘操作与焦点恢复；涉及布局时按照根目录 `docs/ui-visual-regression.md` 检查真实浏览器和窄窗。测试放在相邻文件，使用注入的 `WebApi`；真实 HTTP 与最终文件一致性由服务端集成测试另行覆盖。
