# Kimi Code Switch 开发约定

本项目是浏览器唯一入口的本机 Kimi Code 配置工具，使用 React、TypeScript、Node 和 SQLite。首个发行目标为 macOS Apple Silicon 自包含程序。面向用户默认使用简体中文。

## 架构边界

```text
src/renderer/src/web + http  →  src/shared/webApi.ts
                           →  src/server/http + application.ts
                           →  src/server/configuration + services + native
                           →  Kimi 原生文件 / 本工具私有数据
```

- 浏览器负责呈现与独立资源草稿；服务端负责文件、CLI、数据库和业务编排。`src/shared/` 保持纯 TypeScript 规则，不依赖 DOM、Node 或 renderer。
- API 方法在 `src/shared/webApi.ts` 显式声明，在 `src/server/http/validation.ts` 逐方法校验。新增方法同时更新服务实现、客户端和参数校验；只暴露需要的业务能力。
- 服务端直接调用 Node 能力，不经过 renderer、Tauri、模拟 `window` 或自动暴露所有对象函数的 RPC。
- 版本以 `package.json` 为来源，构建注入服务和前端；命令为 `kimi-code-switch`。项目历史与来源保留旧名称，其余生产入口使用新名称。

## 原生数据与写入

- Kimi 原生目录按目标与 `KIMI_CODE_HOME` 解析，默认 `~/.kimi-code`。工具私有目录默认 `~/.kimi-code-switch`，由 `src/server/native/paths.ts` 统一落实 `--data-dir`。
- 原生文件是活动 Provider、模型和 MCP 的唯一来源。SQLite 只存偏好、预设、目录引用、历史和迁移元数据。
- 普通编辑、预设应用、导入和恢复统一经过 `src/server/configuration/` 的 read → plan → commit。按资源提交最小变更，保留未知字段、注释和未设置状态；无法安全定位的结构拒绝改写。
- 写入前恢复点必须成功；提交前复核版本，写后读回。多文件操作通过恢复日志协调。服务端恢复总闸覆盖全部写路径，不能用强制保存绕过版本或恢复检查。
- 原生文件读取不触发迁移。旧工具私有数据只经 `src/server/migration/legacy.ts` 的预览与显式应用迁移；旧原生目录保留原路径引用。
- 文件写操作经过 `authorizeMutation`；API 保持 Bearer、Host、Origin 校验及命令白名单。日志、预览、错误和截图使用脱敏内容，备份导出按敏感数据处理。
- 官方登录交给官方 CLI。Plugins 首版提供清单与诊断，不猜测私有管理协议；用量洞察、WebDAV、订阅桥接和凭据轮换暂不进入运行链路。

修改原生字段、路径、作用域、默认值或兼容判断前，读取 [2.0 原生文件契约](docs/kimi-code-2.0-contract.md)。升级官方版本时执行 [兼容性升级流程](docs/kimi-code-upgrade-sop.md)，先固定 tag/commit 和样本再改写规则。旧 0.38 fixtures 作为回归证据保留。

## 验证与交付

- 测试使用临时 HOME、KIMI_CODE_HOME 和 `--data-dir`，不得读取或改写个人原生配置、账号凭据。
- 迭代时先运行对应的 Vitest 文件及 `npm run typecheck`；影响 HTTP 业务链时增加真实 HTTP 流程，影响 UI 时增加 `npm run build:web` 和浏览器检查。
- 发行或打包变更执行 `npm run build` 与 `npm run check:package`，验证不含系统 Node、脱离源码目录的真实程序。脚本列表以 `package.json` 为准。
- UI 检查使用 [浏览器验证指南](docs/ui-visual-regression.md)。保存成功只说明文件已写入和读回；报告区分单元测试、官方 parser 验证和客户端真实使用。
- `dist/`、`dist-server/`、`dist-release/`、`coverage/` 为生成物，修改源文件再重新构建。保留已有未提交工作，只提交本次相关文件。

用户请求提交、推送或发布时，读取并执行 [维护者工作流](docs/maintainer-workflow.md)。本地实现授权不等于发布授权；解除 GitHub fork 关系须先保全 refs、Release 和资产，展示实际损失清单后单独确认，不自动删除仓库重建。
