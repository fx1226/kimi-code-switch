// 本地备份/恢复服务；原生文件经统一授权和 revision 校验后修改。
import { createHash } from "node:crypto";
import { invokeCommand as invoke } from "../native";
import parseToml from "@iarna/toml/parse-string.js";

import {
  buildConfigDocument,
  createLineDiff,
  buildPanelSettingsSnapshot,
  loadAppState,
  normalizeStatePaths,
  parsePanelSettingsDocument,
  parseProfiles,
  getKimiCodeTuiConfigPath,
} from "@shared/configStore";
import { buildConfigDoctorReport, redactDocumentText, assessRestoreDocumentsRisk } from "@shared/configSafety";
import { buildMcpConfigDocument } from "@shared/mcpStore";
import { normalizeShortcuts } from "@shared/shortcutStore";
import type {
  AppState,
  BackupRecord,
  BackupResult,
  FileSnapshotBundle,
  ManagedFileId,
  RestoreBackupResult,
  RestoreDryRunFilePlan,
  RestoreDryRunResult,
  RestoreRiskBlockedResult,
  SaveStateConflictResult,
} from "@shared/types";

import { beginRestoreTransaction, completeRestoreTransaction, serverFileAccess } from "./fileAccess";
import { captureSnapshotForState, detectExternalChangeConflict } from "./fileSnapshots";
import { exportPanelSettings, importPanelSettings } from "./panelSettingsStore";

const SHORTCUTS_BACKUP_FILENAME = "shortcuts.json";
const BACKUP_METADATA_FILENAME = "backup.meta.json";

function removeDir(path: string): Promise<void> {
  return invoke<void>("remove_dir", { path });
}
function listSubdirs(path: string): Promise<string[]> {
  return invoke<string[]>("list_subdirs", { path });
}
function hostname(): Promise<string> {
  return invoke<string>("hostname");
}

function sha256Text(content: string | null): string {
  return content === null ? "" : createHash("sha256").update(content, "utf8").digest("hex");
}

function backupDirectory(state: AppState, backupName: string): string {
  if (!/^backup-[a-zA-Z0-9._-]+$/.test(backupName)) {
    throw new Error("Invalid local backup name.");
  }
  return `${state.panelSettings.backup_local_path}/${backupName}`;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}
function formatBackupStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}
function sanitizeMachineName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "") || "unknown-host";
}

function environmentHomeFromState(state: AppState): string {
  const configPath = normalizeStatePaths(state).configPath.replace(/\/+$/, "");
  const separator = configPath.lastIndexOf("/");
  return separator > 0 ? configPath.slice(0, separator) : configPath;
}

async function buildBackupFiles(state: AppState): Promise<Array<{ name: string; content: string }>> {
  const s = normalizeStatePaths(state);
  const environmentHome = environmentHomeFromState(s);
  const [rawConfig, rawMcp, rawTui, rawAgents] = await Promise.all([
    serverFileAccess.readText(s.configPath),
    serverFileAccess.readText(s.mcpConfigPath),
    serverFileAccess.readText(getKimiCodeTuiConfigPath(environmentHome)),
    serverFileAccess.readText(`${environmentHome}/AGENTS.md`),
  ]);
  // 项目 local.toml 含项目内绝对路径，不属于当前环境备份的恢复范围。
  const files = [
    { name: "config.toml", content: rawConfig ?? buildConfigDocument(s) },
    {
      name: "config.panel.json",
      content: buildPanelSettingsSnapshot(s.panelSettings),
    },
    { name: SHORTCUTS_BACKUP_FILENAME, content: JSON.stringify(normalizeShortcuts(s.panelSettings.shortcuts), null, 2) },
    { name: "mcp.json", content: rawMcp ?? buildMcpConfigDocument(s.mcpConfig) },
  ];
  if (rawTui !== null) files.push({ name: "tui.toml", content: rawTui });
  if (rawAgents !== null) files.push({ name: "AGENTS.md", content: rawAgents });
  return files;
}

async function buildMetadata(state: AppState, backupName: string, trigger: string): Promise<string> {
  const s = normalizeStatePaths(state);
  return JSON.stringify({
    formatVersion: 2,
    name: backupName,
    createdAt: new Date().toISOString(),
    trigger,
    sourceHost: sanitizeMachineName(await hostname()),
    environmentId: s.panelSettings.active_kimi_code_environment_id ?? "default",
    kimiCodeVersion: s.kimiTargetDetection?.version ?? "",
    paths: { config: s.configPath, panel: s.panelSettingsPath, mcp: s.mcpConfigPath },
  }, null, 2);
}

// ── 创建备份 ──
async function createLocalBackup(state: AppState, backupName: string, trigger: string): Promise<BackupResult> {
  const s = normalizeStatePaths(state);
  const backupRoot = s.panelSettings.backup_local_path;
  const dir = backupDirectory(s, backupName);
  const files = await buildBackupFiles(s);
  try {
    await invoke("ensure_private_dir", { path: dir });
  } catch (error) {
    // 备份目录必须已获授权，不能由备份操作隐式扩大写入范围。
    throw new Error(
      `Backup directory is not authorized for writes (${backupRoot}). Authorize it in Settings → Backup. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const f of files) await serverFileAccess.writeText(`${dir}/${f.name}`, f.content);
  await serverFileAccess.writeText(`${dir}/${BACKUP_METADATA_FILENAME}`, await buildMetadata(s, backupName, trigger));

  // 轮转
  const subdirs = (await listSubdirs(backupRoot)).filter((n) => n.startsWith("backup-")).sort().reverse();
  for (const obsolete of subdirs.slice(s.panelSettings.backup_retention_count)) {
    await removeDir(`${backupRoot}/${obsolete}`);
  }
  return { ok: true, backupPath: dir, files: files.map((f) => `${dir}/${f.name}`) };
}

export async function createBackupSnapshot(state: AppState, trigger = "manual"): Promise<BackupResult & { backupName: string }> {
  const s = normalizeStatePaths(state);
  const backupName = `backup-${formatBackupStamp(new Date())}-${sanitizeMachineName(await hostname())}`;
  const result = await createLocalBackup(s, backupName, trigger);
  return { ...result, backupName };
}

export async function runBackup(state: AppState, trigger = "manual"): Promise<BackupResult> {
  return createBackupSnapshot(state, trigger);
}

// ── 列表/删除 ──
export async function listBackups(state: AppState): Promise<BackupRecord[]> {
  const s = normalizeStatePaths(state);
  const backupRoot = s.panelSettings.backup_local_path;
  const subdirs = (await listSubdirs(backupRoot)).filter((n) => n.startsWith("backup-"));
  return subdirs
    .map((name) => ({ name, createdAt: name, path: `${backupRoot}/${name}` }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteBackup(state: AppState, backupName: string): Promise<{ ok: true }> {
  await removeDir(backupDirectory(normalizeStatePaths(state), backupName));
  return { ok: true };
}

// ── 读取备份文档 ──
interface RestoreDocuments {
  configDocument: string;
  profilesDocument?: string;
  panelSettingsDocument: string;
  mcpDocument: string;
  tuiDocument?: string;
  agentsDocument?: string;
}

function mergeShortcuts(panelDoc: string, shortcutsDoc: string | null): string {
  if (!shortcutsDoc?.trim()) return panelDoc;
  try {
    const ps = parsePanelSettingsDocument(panelDoc);
    ps.shortcuts = normalizeShortcuts(JSON.parse(shortcutsDoc) as unknown);
    return buildPanelSettingsSnapshot(ps);
  } catch {
    return panelDoc;
  }
}

async function readBackupDocuments(state: AppState, backupName: string): Promise<RestoreDocuments> {
  const s = normalizeStatePaths(state);
  const dir = backupDirectory(s, backupName);
  const read = (n: string): Promise<string | null> => serverFileAccess.readText(`${dir}/${n}`);
  // 优先读取 JSON 格式，兼容旧 TOML 格式
  let pa = await read("config.panel.json");
  if (!pa) pa = await read("config.panel.toml");
  const [c, p, sh, m, tui, agents] = await Promise.all([
    read("config.toml"), read("config.profiles.toml"), read(SHORTCUTS_BACKUP_FILENAME),
    read("mcp.json"), read("tui.toml"), read("AGENTS.md"),
  ]);
  return {
    configDocument: c ?? "", profilesDocument: p ?? undefined,
    panelSettingsDocument: mergeShortcuts(pa ?? "", sh), mcpDocument: m ?? "",
    tuiDocument: tui ?? undefined, agentsDocument: agents ?? undefined,
  };
}

function validate(docs: RestoreDocuments): void {
  if (!docs.configDocument.trim()) throw new Error("Backup is missing config.toml.");
}

function parseTomlCompat(document: string): Record<string, unknown> {
  try {
    return (parseToml(document) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

// 用内存 FileAccess 把备份文档喂给 loadAppState，得到 draftState
function memoryFileAccess(map: Record<string, string>): typeof serverFileAccess {
  return {
    async readText(path: string) { return map[path] ?? null; },
    async writeText(path: string, content: string) { map[path] = content; },
    async ensureDir() { /* no-op */ },
    async readPanelSettings(path: string) {
      return map[path] === undefined ? null : parsePanelSettingsDocument(map[path]);
    },
  };
}

interface ResolvedTargets {
  paths: Record<ManagedFileId, string>;
  documents: Record<ManagedFileId, string>;
  draftState: AppState;
  supplementalDocuments: Array<{ id: "tui" | "agents"; path: string; content: string }>;
}

async function resolveRestoreTargets(state: AppState, backupName: string): Promise<ResolvedTargets> {
  const s = normalizeStatePaths(state);
  const docs = await readBackupDocuments(s, backupName);
  validate(docs);
  const restoredPanel = parsePanelSettingsDocument(docs.panelSettingsDocument);
  const legacyProfilesRaw = docs.profilesDocument?.trim()
    ? parseTomlCompat(docs.profilesDocument)
    : {};
  const legacyProfiles = Object.keys(legacyProfilesRaw).length > 0
    ? parseProfiles(s.mainConfig, legacyProfilesRaw)
    : {};
  const legacyActiveProfile = legacyProfilesRaw.active_profile;
  const restoredProfiles = restoredPanel.profiles ?? {};
  const panelProfiles = Object.keys(restoredProfiles).length > 0 ? restoredProfiles : legacyProfiles;
  const panelDoc = buildPanelSettingsSnapshot({
    ...restoredPanel,
    config_path: s.configPath,
    profiles: panelProfiles,
    active_profile: typeof legacyActiveProfile === "string" && !restoredPanel.active_profile
      ? legacyActiveProfile
      : restoredPanel.active_profile,
    profiles_path: "",
    follow_config_profiles: true,
  });
  const mem = memoryFileAccess({
    [s.configPath]: docs.configDocument,
    [s.panelSettingsPath]: panelDoc,
    [s.mcpConfigPath]: docs.mcpDocument,
    ...(docs.tuiDocument !== undefined
      ? { [getKimiCodeTuiConfigPath(environmentHomeFromState(s))]: docs.tuiDocument }
      : {}),
  });
  const draftState = await loadAppState(mem, {
    configPath: s.configPath, panelSettingsPath: s.panelSettingsPath, mcpConfigPath: s.mcpConfigPath,
  });
  return {
    paths: { config: s.configPath, panel: s.panelSettingsPath, mcp: s.mcpConfigPath },
    documents: { config: docs.configDocument, panel: panelDoc, mcp: docs.mcpDocument },
    draftState,
    supplementalDocuments: [
      ...(docs.tuiDocument !== undefined
        ? [{ id: "tui" as const, path: getKimiCodeTuiConfigPath(environmentHomeFromState(s)), content: docs.tuiDocument }]
        : []),
      ...(docs.agentsDocument !== undefined
        ? [{ id: "agents" as const, path: `${environmentHomeFromState(s)}/AGENTS.md`, content: docs.agentsDocument }]
        : []),
    ],
  };
}

async function readCurrentDocuments(paths: Record<ManagedFileId, string>): Promise<Record<ManagedFileId, string>> {
  const [c, pa, m] = await Promise.all([
    serverFileAccess.readText(paths.config),
    exportPanelSettings(), serverFileAccess.readText(paths.mcp),
  ]);
  return { config: c ?? "", panel: pa ?? "", mcp: m ?? "" };
}

export async function restoreBackupDryRun(
  state: AppState,
  backupName: string,
  options?: { expectedSnapshot?: FileSnapshotBundle },
): Promise<RestoreDryRunResult | SaveStateConflictResult> {
  const resolved = await resolveRestoreTargets(state, backupName);
  const doctor = buildConfigDoctorReport(resolved.draftState);
  // 与 restoreBackupSafe 同口径：dry-run 也要报告外部变更冲突，
  // 否则预览全绿、真正恢复时才暴露冲突。
  const conflict = await detectExternalChangeConflict({
    expectedSnapshot: options?.expectedSnapshot,
    targetPaths: resolved.paths,
    draftDocuments: resolved.documents,
  });
  if (conflict.conflict) {
    return { ok: false, reason: "external-change", snapshot: conflict.snapshot, doctor, conflict: { changedFiles: conflict.conflict.changedFiles } };
  }
  const current = await readCurrentDocuments(resolved.paths);
  const filePlans: RestoreDryRunFilePlan[] = (Object.keys(resolved.paths) as ManagedFileId[]).map((id) => {
    const rawCur = current[id] ?? "";
    const rawNext = resolved.documents[id] ?? "";
    const cur = redactDocumentText(rawCur).text;
    const next = redactDocumentText(rawNext).text;
    return {
      id, path: resolved.paths[id],
      action: (rawCur ? (rawCur === rawNext ? "unchanged" : "replace") : "create") as "unchanged" | "replace" | "create",
      currentDocument: cur, nextDocument: next,
      diff: cur === next ? "" : createLineDiff(cur, next),
    };
  });
  for (const supplemental of resolved.supplementalDocuments) {
    const rawCur = await serverFileAccess.readText(supplemental.path) ?? "";
    const cur = redactDocumentText(rawCur).text;
    const next = redactDocumentText(supplemental.content).text;
    filePlans.push({
      id: supplemental.id,
      path: supplemental.path,
      action: rawCur ? (rawCur === supplemental.content ? "unchanged" : "replace") : "create",
      currentDocument: cur,
      nextDocument: next,
      diff: cur === next ? "" : createLineDiff(cur, next),
    });
  }
  return {
    backupName, doctor, filePlans,
    warnings: doctor.issues.filter((i) => i.severity !== "info").map((i) => `${i.scope}: ${i.message}`),
  };
}

export async function restoreBackupSafe(
  state: AppState,
  backupName: string,
  options?: { expectedSnapshot?: FileSnapshotBundle; allowOverwrite?: boolean; allowRisk?: boolean },
): Promise<RestoreBackupResult | SaveStateConflictResult | RestoreRiskBlockedResult> {
  const resolved = await resolveRestoreTargets(state, backupName);
  const doctor = buildConfigDoctorReport(resolved.draftState);

  // 恢复在写盘前做危险内容审查；非交互默认拒绝，绝不自动恢复
  // executable Plugin/Skill/hook。UI 在调用时把审查结果展示给用户，并由用户显式确认后
  // 以 allowRisk:true 再次调用。
  const riskSummary = assessRestoreDocumentsRisk({
    configDocument: resolved.documents.config,
    mcpDocument: resolved.documents.mcp,
    agentsDocument: resolved.supplementalDocuments.find((doc) => doc.id === "agents")?.content,
  });

  if (options?.allowOverwrite !== true) {
    const conflict = await detectExternalChangeConflict({
      expectedSnapshot: options?.expectedSnapshot,
      targetPaths: resolved.paths,
      draftDocuments: resolved.documents,
    });
    if (conflict.conflict) {
      return { ok: false, reason: "external-change", snapshot: conflict.snapshot, doctor, conflict: { changedFiles: conflict.conflict.changedFiles } };
    }
  }

  // 危险内容门禁：有风险且未显式放行 → 拒绝恢复（默认安全）。
  if (riskSummary.items.length > 0 && options?.allowRisk !== true) {
    return { ok: false, reason: "dangerous-content", doctor, risk: riskSummary };
  }

  // 恢复前先快照回滚备份
  const rollback = await createBackupSnapshot(state, "pre-restore");

  const textDocuments = [
    { path: resolved.paths.config, content: resolved.documents.config },
    { path: resolved.paths.mcp, content: resolved.documents.mcp },
    ...resolved.supplementalDocuments.map(({ path, content }) => ({ path, content })),
  ];
  const baselines = await Promise.all(textDocuments.map(async (document) => {
    const original = await serverFileAccess.readText(document.path);
    return { ...document, original, expectedHash: sha256Text(original), writtenHash: undefined as string | undefined };
  }));
  const originalPanelSettings = await exportPanelSettings();

  // C3：prepare——先把整个恢复 plan 落盘为 crash journal，进程崩溃时可启动重放。
  try {
    await beginRestoreTransaction({
      version: 1,
      kind: "restore-app-state",
      createdAt: new Date().toISOString(),
      textFiles: baselines.map((baseline) => ({
        path: baseline.path,
        originalContent: baseline.original,
        desiredContent: baseline.content,
      })),
      panelOriginal: originalPanelSettings,
      panelDesired: resolved.documents.panel,
    });
  } catch (journalError) {
    throw new Error(`Cannot prepare restore journal: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
  }

  try {
    for (const baseline of baselines) {
      baseline.writtenHash = await serverFileAccess.writeTextCas!(baseline.path, baseline.content, baseline.expectedHash);
    }
    const imported = await importPanelSettings(resolved.documents.panel);
    if (!imported) throw new Error("Failed to restore panel settings to SQLite.");
    // 全部资源 applied 后提交 journal（避免留下"已成功但 journal 仍存在"的误恢复）
    await completeRestoreTransaction();
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (originalPanelSettings) {
      try {
        if (!await importPanelSettings(originalPanelSettings)) {
          rollbackErrors.push("panel settings rollback returned false");
        }
      } catch (rollbackError) {
        rollbackErrors.push(`panel settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    for (const baseline of baselines.reverse()) {
      if (baseline.writtenHash === undefined) continue;
      try {
        if (baseline.original === null) {
          await serverFileAccess.removeTextCas!(baseline.path, baseline.writtenHash);
        } else {
          await serverFileAccess.writeTextCas!(baseline.path, baseline.original, baseline.writtenHash);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${baseline.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    // 只有全部资源已回滚才清除 journal；回滚失败时留给启动恢复处理。
    if (rollbackErrors.length === 0) {
      try {
        await completeRestoreTransaction();
      } catch (cleanupError) {
        // journal 清理失败不掩盖原始错误
        console.warn("Restore journal cleanup failed:", cleanupError);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length > 0
      ? `${message} (rollback incomplete: ${rollbackErrors.join("; ")})`
      : message);
  }

  const restoredState = await loadAppState(serverFileAccess, {
    configPath: resolved.paths.config,
    panelSettingsPath: resolved.paths.panel, mcpConfigPath: resolved.paths.mcp,
  });

  return {
    ok: true,
    state: restoredState,
    snapshot: await captureSnapshotForState(restoredState),
    doctor: buildConfigDoctorReport(restoredState),
    rollbackBackupName: rollback.backupName,
  };
}

export async function restoreBackup(state: AppState, backupName: string): Promise<AppState> {
  const result = await restoreBackupSafe(state, backupName, { allowOverwrite: true });
  if (result.ok) return result.state;
  throw new Error(`Restore blocked: ${result.reason}`);
}
