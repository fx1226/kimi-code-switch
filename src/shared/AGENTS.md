# 共享规则

本目录存放纯 TypeScript 类型、配置解析、局部文档修改、校验和脱敏规则，供浏览器与服务端使用。导出小函数、常量与明确类型，不依赖 Node、DOM 或具体运行时。

| 修改内容 | 入口 |
| --- | --- |
| Web API、资源快照、变更计划与操作结果 | `webApi.ts`、`resourceProtocol.ts` |
| TOML / JSON 文本局部修改 | `documentPatch.ts` |
| 原生主配置、预设和私有偏好模型 | `configStore.ts`、`types.ts` |
| MCP、TUI、Skills、Plugins 规则 | `mcpStore.ts`、`tuiStore.ts`、`skillsStore.ts`、`pluginStore.ts` |
| 引用检查、预览脱敏 | `configRelations.ts`、`configSafety.ts` |
| 固定版本兼容判断与样本测试 | `kimiCompatibility.ts`、`kimiCodeContract.test.ts` |

- 解析不代表有权覆盖原文。原生修改由服务端配置内核提交；局部编辑必须保留未知字段、注释、未设置状态和未修改文本，不通过全量序列化补写默认值。
- 外部数据使用 `unknown` 与局部类型检查。MCP 的顶层未知字段与服务器未知字段同样需要保留；无法安全处理的结构给出诊断或只读结果。
- 官方默认值与文件显式值分开，用户／项目／插件来源分开。更改路径、字段、默认值或覆盖顺序前读取根目录 `docs/kimi-code-2.0-contract.md` 并更新对应固定版本 fixtures。
- 预览与错误输出使用 `configSafety.ts`，测试包含密钥不泄露断言。原始备份是不同的敏感数据用途，不拿脱敏展示内容覆盖原生文件。
- 配置读写变更用往返、最小修改、无修改零写入、畸形输入与未知字段测试证明行为；相关服务端测试继续覆盖并发、故障注入和恢复。

旧类型和旧版本样本可能为迁移与回归保留，不意味着旧桌面功能进入生产 API。删除兼容代码前检查显式迁移和历史恢复引用。
