# Kimi Code 官方兼容性升级

当前基线与验收证据位于 [2.0 原生文件契约](kimi-code-2.0-contract.md)。本流程用于明确授权的官方版本升级，不持续追随上游 `main`。

## 固定与对照

1. 记录官方 release tag、完整 commit、发布日期和产品（CLI / Desktop）。后续所有源码链接固定到该 commit。
2. 在 `tests/fixtures/kimi-code/<version>/` 新建样本及 `contract-manifest.json`，记录来源路径、哈希、字段、默认值、作用域和验证入口。合成样本标明合成原因，不冒充官方原文件。
3. 对照当前基线核查数据根、config、TUI、项目配置、MCP、Skills 与 Plugins。标出能安全编辑、仅透传、只读以及交给官方命令的能力。
4. 保留旧版本样本用于回归；旧样本测试通过不代表该版本仍开放编辑。

## 实现与验证

- 更新 `src/shared/kimiCompatibility.ts` 和相关规则、表单及参数校验。可写兼容范围按明确验证版本确定，不使用“版本较新”推断兼容。
- 原生写入统一经过 `src/server/configuration/`。测试单字段修改、未知字段与注释保留、未设置状态、无修改零写入、并发冲突和失败恢复。
- 执行对应契约测试、`npm run typecheck`、全量测试及 Web / server 构建。实际 API 验证应读取、预览、应用并断言最终文件内容。
- 使用独立的临时 HOME、KIMI_CODE_HOME、cwd 和候选文件运行官方消费验证，不使用个人真实配置或凭据。

```bash
npx vitest run src/shared/kimiCodeContract.test.ts
node scripts/verify-kimi-contract.mjs /absolute/path/to/kimi
```

`verify-kimi-contract.mjs` 的版本及样本路径也必须随升级明确更新。`kimi doctor config <candidate>` 与 `kimi doctor tui <candidate>` 只验证它们对应的文件；MCP、Skills、Plugins 需各自的 parser / discovery / consumer 证据，不能用 doctor 成功代替。保留失败样本，确认错误类型和畸形文档确实被拒绝。

桌面版按具体版本单独验证共享配置，不将静态源码相同或 CLI 校验成功写成桌面运行验收。报告分别标明固定源码契约、本项目测试、官方消费验证和未验证范围。

## 出口条件

- 所有开放编辑的新增能力都有固定官方依据、样本与测试。
- 保存、并发与恢复检查通过；页面准确展示兼容状态和真实目标。
- 验证记录包含产品、版本、执行命令、结果及限制。
- [原生文件契约](kimi-code-2.0-contract.md) 和 fixture manifest 已同步。

升级实现不自动发布。用户请求发布时再执行 [维护者工作流](maintainer-workflow.md)。
