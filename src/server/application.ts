import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebApi, Target } from "@shared/webApi";
import type { ChangePlan, DocumentEdit, NativeResource, ResourceChangeRequest, TrustedResourceContext } from "@shared/resourceProtocol";
import { parseMcpConfigStrict } from "@shared/mcpStore";
import { evaluateKimiCompatibility } from "@shared/kimiCompatibility";
import { createConfigurationService, ConfigurationError } from "./configuration";
import { validateOfficialDocuments, verifyOfficialExecutable } from "./officialValidation";
import { detectActiveKimiTarget } from "./services/cli";
import { kimiSwitchServices, loadTargetState, normalizeProjectRootMcpServers } from "./services/kimiSwitch";
import { openKimiInTerminal, openKimiLoginInTerminal } from "./services/terminal";
import { readOfficialAccountStatus } from "./services/officialAccount";
import { createWebBackupService } from "./services/webBackup";
import * as metadata from "./metadata";
import { getAppPaths } from "./native/paths";
import { invokeCommand } from "./native";
import { findLegacyProcessBlocker, previewLegacyMigration, applyLegacyMigration } from "./migration/legacy";
import { emitServerEvent } from "./events";
import { serverVersion } from "./runtime";

function projectRoot(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const original = realpathSync(cwd);
  let current = original;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}
export function targetContext(target: Target): TrustedResourceContext {
  return { home: target.homePath, projectRoot: projectRoot(target.workingDirectory), workingDirectory: target.workingDirectory };
}
export function createApplicationApi(): WebApi {
  let detectionTask: ReturnType<typeof detectActiveKimiTarget> | undefined;
  let detectionTime = 0;
  const detect = (fresh = false) => {
    if (fresh || !detectionTask || Date.now() - detectionTime > 30_000) { detectionTime = Date.now(); detectionTask = detectActiveKimiTarget(); detectionTask.catch(() => { detectionTask = undefined; }); }
    return detectionTask;
  };
  const configuration = createConfigurationService({
    dataDir: getAppPaths().dataDir,
    requireOfficialValidation: true,
    officialValidator: async ({ resource, content }) => {
      if (resource !== "config" && resource !== "tui") return { status: "unavailable", diagnostics: [] };
      const detection = await detect();
      const result = await validateOfficialDocuments({ executable: detection.executablePath || detection.resolvedPath, documents: [{ kind: resource, content }] });
      return { status: result.status === "rejected" ? "failed" : result.status, diagnostics: result.diagnostics };
    },
  });
  const backups = createWebBackupService(configuration);
  const planTargets = new Map<string, { id: string; context: string; createdAt: number }>();
  async function assertTargetContext(targetId: string, context: TrustedResourceContext): Promise<void> {
    if (JSON.stringify(targetContext(await metadata.getTarget(targetId))) !== JSON.stringify(context)) {
      throw new ConfigurationError("unknown-plan", "数据目录或工作目录已变化，请重新读取配置并生成预览。");
    }
  }
  async function bindPlan(targetId: string, context: TrustedResourceContext, plan: ChangePlan): Promise<ChangePlan> {
    await assertTargetContext(targetId, context);
    for (const [id, entry] of planTargets) if (Date.now() - entry.createdAt > 15 * 60_000) planTargets.delete(id);
    if (planTargets.size >= 1024) planTargets.delete(planTargets.keys().next().value!);
    planTargets.set(plan.id, { id: targetId, context: JSON.stringify(context), createdAt: Date.now() });
    return plan;
  }
  async function assertWritable(target?: Target, native = true): Promise<void> {
    const blocker = findLegacyProcessBlocker();
    if (blocker) throw new ConfigurationError("legacy-process-running", blocker);
    const migration = previewLegacyMigration();
    if (migration.status === "available" || migration.status === "blocked") throw new ConfigurationError("migration-pending", "请先完成旧版私有数据迁移，再修改配置或保存本工具数据。");
    await configuration.assertWritable(target ? targetContext(target) : undefined);
    if (native) {
      const detection = await detect();
      const verified = await verifyOfficialExecutable(detection.executablePath || detection.resolvedPath);
      if (verified.status !== "passed" || !evaluateKimiCompatibility(verified.version).nativeWritesAllowed) throw new ConfigurationError("unverified-version", "仅已对齐的 Kimi Code CLI 2.0.0 可写入原生配置；当前版本尚未验证。");
    }
    // Grants are loaded from private metadata; no client-provided filesystem path reaches the writer.
    await invokeCommand("reconcile_durable_grants");
  }
  async function nativeTarget(targetId: string): Promise<{ target: Target; context: TrustedResourceContext }> {
    const target = await metadata.getTarget(targetId);
    const context = targetContext(target);
    await assertWritable(target);
    await assertTargetContext(targetId, context);
    return { target, context };
  }
  async function mcpState(targetId: string, resource: "mcp" | "mcp-project" | "mcp-local" = "mcp") {
    const target = await metadata.getTarget(targetId);
    const snapshot = await configuration.read(targetContext(target), resource);
    if (snapshot.diagnostics.some((entry) => entry.severity === "error")) throw new ConfigurationError("invalid-document", "MCP 配置格式有误，请先修复文件。");
    const state = await loadTargetState(target);
    state.mcpConfig = parseMcpConfigStrict(snapshot.content ?? "{}");
    if (resource === "mcp-project") state.mcpConfig.mcpServers = normalizeProjectRootMcpServers(state.mcpConfig.mcpServers, targetContext(target).projectRoot!);
    return state;
  }
  const api: WebApi = {
    async bootstrap() {
      const [{ targets, preferences }, detection, recovery] = await Promise.all([metadata.readMetadata(), detect(), configuration.getRecoveryState()]);
      await verifyOfficialExecutable(detection.executablePath || detection.resolvedPath);
      const blocker = findLegacyProcessBlocker();
      const migration = previewLegacyMigration();
      return { product: "Kimi Code Switch", version: serverVersion, targets, preferences,
        compatibility: evaluateKimiCompatibility(detection.version),
        officialAccount: await readOfficialAccountStatus({ homePath: targets.find((target) => target.id === preferences.activeTargetId)!.homePath, cliVersion: detection.version }),
        recovery: { blocked: recovery.blocked || Boolean(blocker), message: blocker ?? recovery.diagnostics.map((entry) => entry.message).join("\n") },
        migrationAvailable: migration.status === "available" || migration.status === "blocked",
      };
    },
    async readResource({ targetId, resource }) { return configuration.read(targetContext(await metadata.getTarget(targetId)), resource); },
    async planChange(input) {
      const { target, context } = await nativeTarget(input.targetId);
      return bindPlan(target.id, context, await configuration.plan(context, input));
    },
    async applyChange(input) {
      const { target, context } = await nativeTarget(input.targetId);
      const previous = configuration.getOperation(input.planId);
      const binding = planTargets.get(input.planId);
      if (!previous && (binding?.id !== target.id || binding.context !== JSON.stringify(context))) throw new ConfigurationError("unknown-plan", "此变更计划不属于当前数据目录或已经过期。");
      if (previous && previous.path !== join(target.homePath, "config.toml") && !(previous.path.startsWith(`${target.homePath}/`) || (target.workingDirectory && previous.path.startsWith(`${projectRoot(target.workingDirectory)}/`)))) throw new ConfigurationError("wrong-target", "操作结果不属于当前数据目录。");
      const result = await configuration.commit(input.planId, { expectedRevision: input.expectedRevision });
      if (["succeeded", "failed", "conflict"].includes(result.status)) planTargets.delete(input.planId);
      if (result.status === "succeeded") emitServerEvent("resource-changed", { type: "resource-changed", targetId: target.id, resource: result.resource, revision: result.afterRevision });
      return result;
    },
    async getOperation({ id }) { return configuration.getOperation(id); },
    async savePreferences(input) { await assertWritable(undefined, false); return metadata.savePreferences(input); },
    async addTarget(input) { await assertWritable(undefined, false); return metadata.addTarget(input); },
    async updateTarget(input) { await assertWritable(undefined, false); return metadata.updateTarget(input); },
    async forgetTarget(input) { await assertWritable(undefined, false); return metadata.forgetTarget(input); },
    listPresets: metadata.listPresets,
    async savePreset(input) { await assertWritable(undefined, false); await metadata.savePreset(input); },
    async deletePreset(input) { await assertWritable(undefined, false); await metadata.deletePreset(input); },
    async planPreset({ targetId, name }) {
      const { context } = await nativeTarget(targetId);
      const preset = (await metadata.listPresets({ targetId })).find((entry) => entry.name === name);
      if (!preset) throw new Error("配置预设不存在。");
      const config = await configuration.read(context, "config");
      const changes: DocumentEdit[] = preset.nativeEdits ? structuredClone(preset.nativeEdits) : [
        { op: "set", path: ["default_model"], value: preset.default_model },
        { op: "set", path: ["default_plan_mode"], value: preset.default_plan_mode },
        { op: preset.default_permission_mode ? "set" : "delete", path: ["default_permission_mode"], value: preset.default_permission_mode },
        { op: "set", path: ["merge_all_available_skills"], value: preset.merge_all_available_skills },
      ];
      if (!preset.nativeEdits && preset.thinking_enabled !== undefined) changes.push({ op: "set", path: ["thinking", "enabled"], value: preset.thinking_enabled });
      if (!preset.nativeEdits && preset.thinking_effort !== undefined) changes.push({ op: "set", path: ["thinking", "effort"], value: preset.thinking_effort });
      const requests: ResourceChangeRequest[] = [{ resource: "config", expectedRevision: config.revision, changes }];
      if (preset.tui_theme !== undefined || preset.tui_editor_command !== undefined) {
        const tui = await configuration.read(context, "tui");
        const edits: DocumentEdit[] = [];
        if (preset.tui_theme !== undefined) edits.push({ op: "set", path: ["theme"], value: preset.tui_theme });
        if (preset.tui_editor_command !== undefined) edits.push({ op: "set", path: ["editor", "command"], value: preset.tui_editor_command });
        requests.push({ resource: "tui", expectedRevision: tui.revision, changes: edits });
      }
      return bindPlan(targetId, context, await configuration.planBatch(context, requests));
    },
    async scanSkills({ targetId }) { return kimiSwitchServices.scanSkills(await loadTargetState(await metadata.getTarget(targetId))); },
    async listPlugins({ targetId }) {
      const state = await loadTargetState(await metadata.getTarget(targetId));
      return state.pluginInventory ?? { installedPath: join((await metadata.getTarget(targetId)).homePath, "plugins/installed.json"), plugins: [], skillRoots: [], mcpServers: {}, diagnostics: [] };
    },
    async diagnose({ targetId }) {
      const target = await metadata.getTarget(targetId); const context = targetContext(target);
      const kinds: NativeResource[] = ["config", "mcp", "tui", "agents", ...(context.projectRoot ? ["project-local" as const, "mcp-project" as const, "mcp-local" as const] : [])];
      const issues: Array<{ severity: string; message: string; resource?: string }> = [];
      for (const kind of kinds) {
        const snapshot = await configuration.read(context, kind);
        issues.push(...snapshot.diagnostics.map((entry) => ({ ...entry, resource: kind })));
        if (snapshot.exists && snapshot.content !== null && (kind === "config" || kind === "tui") && !snapshot.diagnostics.some((entry) => entry.severity === "error")) {
          const detection = await detect();
          const result = await validateOfficialDocuments({ executable: detection.executablePath || detection.resolvedPath, documents: [{ kind, content: snapshot.content }] });
          issues.push(...result.diagnostics.map((entry) => ({ ...entry, resource: kind })));
        }
      }
      return { ok: !issues.some((entry) => entry.severity === "error"), issues };
    },
    async listBackups({ targetId }) { return backups.listBackups(await metadata.getTarget(targetId)); },
    async createBackup({ targetId }) { const target = await metadata.getTarget(targetId); await assertWritable(target, false); return backups.createBackup(target); },
    async exportBackup({ targetId, id }) { return backups.exportBackup(await metadata.getTarget(targetId), id); },
    async importBackup({ targetId, content }) { const target = await metadata.getTarget(targetId); await assertWritable(target, false); return backups.importBackup(target, content); },
    async planRestore({ targetId, backupId }) {
      const { target, context } = await nativeTarget(targetId);
      return bindPlan(targetId, context, await backups.planRestore(target, backupId));
    },
    async listHistory({ targetId }) { return backups.listHistory(await metadata.getTarget(targetId)); },
    async planHistoryRestore({ targetId, id }) {
      const { target, context } = await nativeTarget(targetId);
      return bindPlan(targetId, context, await backups.planHistoryRestore(target, id));
    },
    async listRecoveryCases() { return configuration.listRecoveryCases(); },
    async exportRecoveryJournal(input) { return configuration.exportRecoveryJournal(input); },
    async resolveRecovery(input) {
      const blocker = findLegacyProcessBlocker(); if (blocker) throw new ConfigurationError("legacy-process-running", blocker);
      return configuration.resolveRecovery(input);
    },
    async previewMigration() { return previewLegacyMigration(); },
    async applyMigration(input) { await configuration.assertWritable(); return applyLegacyMigration(input); },
    async openKimi({ targetId }) { const target = await metadata.getTarget(targetId); const state = await loadTargetState(target); await openKimiInTerminal(state.panelSettings); },
    async login({ targetId }) { const target = await metadata.getTarget(targetId); await assertWritable(target); const state = await loadTargetState(target); await openKimiLoginInTerminal(state.panelSettings); return { opened: true }; },
    async testMcp({ targetId, name, resource }) { return kimiSwitchServices.testMcpServer(await mcpState(targetId, resource), name); },
    async listMcpTools({ targetId, name, resource }) { return kimiSwitchServices.listMcpServerTools(await mcpState(targetId, resource), name); },
    async callMcpTool({ targetId, name, resource, toolName, arguments: argumentsValue }) { return kimiSwitchServices.callMcpServerTool(await mcpState(targetId, resource), name, toolName, JSON.stringify(argumentsValue)); },
  };
  return api;
}
