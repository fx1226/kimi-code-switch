# 参与 Kimi Code Switch

本项目以轻量、快速、精准为目标，优先改进原生配置修改的正确性、浏览器交互和恢复能力。较大功能或架构调整先说明实际需求、官方依据与影响范围。

## 开发环境与结构

源码开发需要 Node.js 22.13.0 或更新版本与 npm。发行验收先覆盖 macOS Apple Silicon。

```bash
npm ci
npm run dev
```

开发入口同时启动本机 Node 服务和 Vite。工具私有数据默认使用临时目录，**原生 Kimi 数据并不会因此隔离**；执行可能修改配置的调试时，显式设置临时 `HOME`、`KIMI_CODE_HOME` 和 `KIMI_DEV_DATA_DIR`。

`src/renderer/src/web/` 实现浏览器页面与草稿；`src/server/application.ts` 组合业务 API；`src/server/configuration/` 统一变更和恢复；`src/shared/` 实现纯配置规则。详细约定见 [AGENTS.md](AGENTS.md)，脚本参数以 `package.json` 和 `--help` 为准。

## 修改与验证

1. 先检查工作树和相关实现，保留已有未提交改动。
2. 对原生字段或路径的修改，核对 [固定版本契约](docs/kimi-code-2.0-contract.md)。用最小变更保留未知内容、注释与未设置状态。
3. 配置修改通过 read → plan → commit，不另开绕过版本、恢复点或授权检查的写入路径。
4. 运行对应测试和 `npm run typecheck`。界面变更构建 Web 并检查真实浏览器；配置变更补充文件断言、并发与失败场景。
5. PR 说明实际问题、最终行为、验证结果与仍未验证的部分；截图和日志先脱敏。

```bash
npx vitest run src/server/configuration
npm run typecheck
npm test
npm run build:web
npm run build:server
```

发行相关修改还需 `npm run build` 和 `npm run check:package`。不含 Node、脱离源码目录的真实程序运行结果与普通源码构建是两项证据。浏览器检查按 [UI 验证指南](docs/ui-visual-regression.md) 执行。

保持 TypeScript 2 空格缩进、分号、双引号；公共协议使用明确类型。前端不导入 Node 或服务端实现，shared 不依赖运行时。测试使用临时目录或内存文件系统，不接触个人配置或官方凭据。

## 提交与反馈

提交信息使用 `feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`chore:` 等前缀。只暂存相关文件，不提交密钥、连接 token、未脱敏备份、个人原生文件或生成目录。

报告问题时提供工具版本、Kimi Code 版本、系统与架构、安装方式、复现步骤、实际结果和脱敏片段。发布由维护者按 [维护者工作流](docs/maintainer-workflow.md) 执行；提交代码不会自动授权发布、修改 GitHub 仓库关系或上传个人数据。
