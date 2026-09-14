# Kimi Code 官方兼容性升级 SOP

本文档描述当官方 `@moonshot-ai/kimi-code` 发布新版本时，如何在本仓库（kimi-code-switch-gui）固定基线、更新契约 fixtures、验证并发布兼容性结论。请严格遵循 `plan_kimi_code_alignment_remaining.md` 第 1.1 节「固定官方基线」与第 7 章 Batch F 的防漂移约束。

## 升级前：确认新版本

1. 查看官方发布与 tag：`@moonshot-ai/kimi-code` 的最新版本与对应 commit。
2. 只有用户明确请求「对齐新版本」时才执行本 SOP；日常不跟随 `main`。

## SOP 步骤

1. **发现新版本**：记录官方版本号 `vX.Y.Z`、发布 commit、发布日期。
2. **固定源码**：将官方源码副本固定到该 commit（只读副本，如 `/private/tmp/kimi-code-upstream-<ver>-audit`），不再直接以 `main` 为基线。
3. **更新 manifest/fixtures**：
   - 在 `tests/fixtures/kimi-code/<version>/` 新建受审计 fixture（config.toml / mcp.json / tui.toml / skills / plugins 等）。
   - 更新 `contract-manifest.json`：`release_tag`、`release_commit`（不可变 commit URL）、`release_date`、官方源文件列表。
   - 保持可追溯性：fixture 只能来自固定 commit，绝不来自 `main`。
4. **运行差分**：执行 `npx vitest run src/shared/kimiCodeContract.test.ts` 与相关契约测试，对比 GUI 生产解析器/序列化器与官方 fixture 的一致性，记录差异。
5. **更新本计划**：将 `plan_kimi_code_alignment_remaining.md` 第 1.1 节基线与各 Batch 的完成证据更新为新版本结论。
6. **实施**：按差异改造 structured management / parser / serializer / UI，逐项带测试。
7. **双审查**：本地代码审查 + 官方源码差异复核（与官方同一 commit 源码逐字段比对）。
8. **发布**：走既有发布流程（版本号、CHANGELOG、tag、CI）。发布前必须完成 F3 完整门禁。

## 兼容性状态页基线

`src/renderer/src/aboutPage.tsx` 中的 `OFFICIAL_BASELINE` 与 `CAPABILITY_TIERS` 是兼容性状态页（F2）的数据来源，升级后必须同步更新：

- 已验证官方版本 / commit / 发布日期。
- 各能力五档分类（supported / passthrough / readonly / delegated-tui / unsupported）。

本机版本的比对由总览页 `getCliVersion` 完成；本机版本高于基线时，页面会给出风险提示。

## 退出条件

- 新版本基线已固定（tag+commit）。
- fixtures 与 manifest 已更新并纳入版本控制。
- 契约差分测试通过。
- 兼容性状态页展示新的已验证基线。
- 完整门禁（F3）通过。
