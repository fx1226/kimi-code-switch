// window.kimiSwitch 的 Tauri 适配器。
// 业务逻辑（@shared/*）直接在 renderer 跑，通过注入 tauriFileAccess 完成 I/O；
// 系统集成走 Rust 命令或 Tauri 插件。
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import parseTomlString from "@iarna/toml/parse-string.js";
import stringifyToml from "@iarna/toml/stringify.js";

import {
  createDefaultPanelSettings,
  PANEL_APP_DIRECTORY,
  getKimiCodeConfigPath,
  getKimiCodeMcpConfigPath,
  getKimiCodeEnvironmentHomePath,
  normalizeKimiCodeEnvironments,
  getDefaultConfigPath,
  getDefaultMcpConfigPath,
  loadAppState,
  migrateLegacyKimiCliConfigToKimiCode,
  migrateLegacyManagedDefaultEnvironmentToNativeHome,
  repairLegacyManagedDefaultHomeSymlink,
  normalizeStatePaths,
  saveAppState,
  cloneState,
  applyProfile,
  buildFullBackup,
  buildConfigDocument,
  parseMainConfigDocument,
  rebuildPanelSettingsFromBackup,
} from "@shared/configStore";
import { buildMcpConfigDocument, parseMcpConfig } from "@shared/mcpStore";
import { buildConfigDoctorReport, buildManagedDocuments, buildRedactedPreviewBundle } from "@shared/configSafety";
import { resolveNearestGitProjectRoot, scanSkills } from "@shared/skillsStore";
import { remapInstalledPluginRoots, scanKimiPlugins } from "@shared/pluginStore";
import { compareReleaseVersions } from "@shared/versionUtils";
import { computeEventCost, resolveModelPricing } from "@shared/pricing";
import type { Bucket, CostSeriesPoint, EventFilter, GroupBy, TimeRange, TokenUsageTotals, TrendTokenPoint } from "@shared/usageTypes";
import type { AppState, FullBackupBundle, KimiCodeEnvironment, KimiCodeEnvironmentPreferenceResult, ManagedFileId, McpServerConfig, ModelConfig, PanelSettings, PortableDirectoryBundle, PreviewBundle, OpenKimiTerminalRequest, FileSnapshotBundle, SaveStateConflictResult, SaveStateResult } from "@shared/types";
import type { SaveTransactionRecord } from "@shared/configStore";

import {
  SAVE_TRANSACTION_PATH,
  RESTORE_TRANSACTION_PATH,
  isSaveTransactionRecord,
  pathExists,
  recoverPendingRestoreTransaction,
  recoverPendingSaveTransaction,
  removeFile,
  stableJson,
  tauriFileAccess,
} from "./fileAccess";
import * as usageDb from "./usageDb";
import { UsageLogWatcher } from "./usageLogWatcher";
import * as cli from "./cli";
import { openKimiInTerminal, openKimiMcpLoginInTerminal, openSessionTerminal } from "./terminal";
import { captureSnapshotForState, detectExternalChangeConflict, readManagedDocuments } from "./fileSnapshots";
import { initConfigHistory, captureSnapshot, cleanupOldSnapshots } from "./configHistory";
import { getPanelSettings, initPanelSettingsStore, savePanelSettings } from "./panelSettingsStore";
import * as backup from "./backup";
import { setupTray, teardownTray } from "./tray";
import * as officialAccounts from "./officialAccounts";
import { recordStartupTiming, startupTimingNow } from "../startupTiming";

const skillFileAccess = {
  readText: (path: string) => tauriFileAccess.readText(path),
  listDir: (path: string) => invoke<Array<{ name: string; isDirectory: boolean }>>("list_dir_typed", { path }),
  pathExists,
  realPath: (path: string) => invoke<string>("real_path", { path }),
};

// ── 使用统计运行时（log watcher + db 生命周期）──
// 全局应用数据库：包含 usage 数据、config_history、panel_settings
const PANEL_APP_DIR = PANEL_APP_DIRECTORY;
const USAGE_DB_PATH = `${PANEL_APP_DIR}/app.db`;
const USAGE_JSONL_DIR = `${PANEL_APP_DIR}/usage`;
let logWatcher: UsageLogWatcher | null = null;
let usageOpen = false;
// 单飞守卫：避免并发/重复 loadState 同时跑数据库打开与建表迁移
// （首次启动 React.StrictMode 双调用会触发 schema_versions UNIQUE 等并发写冲突）。
let storesInitTask: Promise<void> | null = null;
let currentAppState: AppState | null = null;
let shortcutSyncTask: Promise<void> = Promise.resolve();
let startupKimiCodeDetection: AppState["kimiTargetDetection"] | null = null;
let startupKimiCodeDetectionTask: Promise<AppState["kimiTargetDetection"]> | null = null;

/** C2：启动时发现的待人工恢复 journal 状态（unknown → 只读恢复；quarantined → 提示）。 */
let pendingSaveRecovery: SaveRecoveryInfo | null = null;

export type SaveRecoveryInfo =
  | { action: "unknown" | "unknown-restore"; journal: unknown }
  | { action: "quarantined" | "quarantined-restore"; reason?: "malformed" | "unsupported"; quarantinedPath?: string };

/** C2：save journal 的人工恢复决策。 */
export type SaveRecoveryDecision = "abandon" | "export-journal" | "apply-desired" | "restore-original";

export interface SaveRecoveryFailure {
  path: string;
  message: string;
}

/**
 * `resolveSaveRecovery` 的审计结果（时间/决策/路径数），供 UI 展示或 toast。
 * 每个决策只影响 journal 里列出的路径；`ok:true` 且 `failures` 为空时才会删除 save journal，
 * 失败（冲突/复核失败）时 journal 保留，UI 应回到只读横幅。
 */
export interface ResolveSaveRecoveryResult {
  ok: boolean;
  decision: SaveRecoveryDecision;
  completedAt: string;
  /** 本次实际写入（含覆盖外部修改）的文件数。 */
  writtenFiles: number;
  /** 本次删除的文件数（restore-original 且 original 为 null 的资源）。 */
  removedFiles: number;
  /** 已处于目标状态而跳过的文件数。 */
  unchangedFiles: number;
  /** 0 = 全部成功；非 0 = 存在失败/冲突，journal 保留。 */
  failures: SaveRecoveryFailure[];
  /** export-journal：null = 用户取消；string = 落盘路径。 */
  exportedPath?: string | null;
  /** abandon：实际删除的 journal 文件。 */
  deletedJournals?: string[];
}

async function readCurrentSaveJournal(): Promise<SaveTransactionRecord | null> {
  const document = await tauriFileAccess.readText(SAVE_TRANSACTION_PATH);
  if (document === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  return isSaveTransactionRecord(parsed) ? parsed : null;
}

type SaveRecoveryResourceRead = {
  file: SaveTransactionRecord["textFiles"][number];
  current: string | null;
  status: "original" | "desired" | "external";
};

/**
 * C2 复核：逐资源读取当前盘上内容并分类（original / desired / external）。
 * 任一目标文件无法读取 → 视为复核失败，整批放弃（不动任何文件），回到只读模式。
 */
async function preflightSaveRecovery(
  record: SaveTransactionRecord,
): Promise<{ reads: SaveRecoveryResourceRead[]; failures: SaveRecoveryFailure[] }> {
  const changedFiles = record.textFiles.filter((file) => file.originalContent !== file.desiredContent);
  const reads: SaveRecoveryResourceRead[] = [];
  const failures: SaveRecoveryFailure[] = [];
  for (const file of changedFiles) {
    let current: string | null;
    try {
      current = await tauriFileAccess.readText(file.path);
    } catch (error) {
      failures.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let status: SaveRecoveryResourceRead["status"];
    if (current === file.originalContent) status = "original";
    else if (current === file.desiredContent) status = "desired";
    else status = "external";
    reads.push({ file, current, status });
  }
  return { reads, failures };
}

async function classifySavePanel(record: SaveTransactionRecord): Promise<{
  changed: boolean;
  status: "original" | "desired" | "unknown";
}> {
  const changed = record.panelDesired !== undefined
    && stableJson(record.panelOriginal) !== stableJson(record.panelDesired);
  if (!changed) return { changed: false, status: "original" };
  const current = await getPanelSettings();
  let status: "original" | "desired" | "unknown";
  if (stableJson(current) === stableJson(record.panelOriginal)) status = "original";
  else if (stableJson(current) === stableJson(record.panelDesired)) status = "desired";
  else status = "unknown";
  return { changed, status };
}

/**
 * C2：把 save journal 朝 desired 或 original 方向收敛。
 * - apply-desired：目标 = desiredContent（覆盖 external 修改，CAS 以当前盘上 hash 为准）。
 * - restore-original：目标 = originalContent（original 为 null 时删除文件）。
 * - 成功后才由调用方删除 save journal；任何失败（含 panel unknown）都保留 journal。
 */
async function applySaveRecoveryDecision(
  record: SaveTransactionRecord,
  decision: "apply-desired" | "restore-original",
  completedAt: string,
): Promise<ResolveSaveRecoveryResult> {
  // 复核：逐个目标（文本文件 + panel）确认当前 revisions。任一无法确认 → 整批放弃（不动任何文件），回到只读。
  const { reads, failures: preflightFailures } = await preflightSaveRecovery(record);
  const panel = await classifySavePanel(record);
  if (preflightFailures.length > 0 || (panel.changed && panel.status === "unknown")) {
    const failures = preflightFailures.length > 0
      ? preflightFailures
      : [{ path: "panel", message: "Panel settings were changed externally; keep the journal for manual review." }];
    return {
      ok: false,
      decision,
      completedAt,
      writtenFiles: 0,
      removedFiles: 0,
      unchangedFiles: 0,
      failures,
    };
  }

  const applyingDesired = decision === "apply-desired";
  let writtenFiles = 0;
  let removedFiles = 0;
  let unchangedFiles = 0;
  const writeFailures: SaveRecoveryFailure[] = [];

  for (const { file, current, status } of reads) {
    const needsWrite = applyingDesired
      ? status !== "desired"
      : status === "desired";
    const target = applyingDesired ? file.desiredContent : file.originalContent;
    const willRemove = !applyingDesired && target === null;
    if (!needsWrite) {
      unchangedFiles += 1;
      continue;
    }
    try {
      // CAS expected = 当前盘上内容 hash（文件不存在时为空 revision，表示创建）。
      const expectedSha256 = await sha256Text(current);
      if (willRemove) {
        await tauriFileAccess.removeTextCas!(file.path, expectedSha256);
        removedFiles += 1;
      } else {
        await tauriFileAccess.writeTextCas!(file.path, target ?? "", expectedSha256);
        writtenFiles += 1;
      }
    } catch (error) {
      writeFailures.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Panel（SQLite）资源：已在复核阶段排除 unknown；仅在明确 original/desired 状态时随决策变化。
  if (panel.changed) {
    if (applyingDesired && panel.status === "original" && record.panelDesired !== undefined) {
      try {
        await savePanelSettings(record.panelDesired);
        writtenFiles += 1;
      } catch (error) {
        writeFailures.push({ path: "panel", message: error instanceof Error ? error.message : String(error) });
      }
    } else if (!applyingDesired && panel.status === "desired" && record.panelOriginal != null) {
      try {
        await savePanelSettings(record.panelOriginal);
        writtenFiles += 1;
      } catch (error) {
        writeFailures.push({ path: "panel", message: error instanceof Error ? error.message : String(error) });
      }
    } else {
      unchangedFiles += 1;
    }
  }

  return {
    ok: writeFailures.length === 0,
    decision,
    completedAt,
    writtenFiles,
    removedFiles,
    unchangedFiles,
    failures: writeFailures,
  };
}

type LoadStatePaths = {
  configTarget?: AppState["configTarget"];
  configPath?: string;
  profilesPath?: string;
  panelSettingsPath?: string;
  mcpConfigPath?: string;
};

async function sha256Text(content: string | null): Promise<string> {
  if (content === null) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64Text(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function encodeBase64Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function remapPluginDirectoryForRestore(
  bundle: PortableDirectoryBundle,
  sourceHome: string,
  targetHome: string,
): PortableDirectoryBundle {
  const next = structuredClone(bundle);
  const installed = next.files.find((file) => file.relativePath === "installed.json");
  if (!installed) return next;
  try {
    const document = remapInstalledPluginRoots(
      decodeBase64Text(installed.contentBase64),
      sourceHome,
      targetHome,
    );
    installed.contentBase64 = encodeBase64Text(document);
    next.sha256 = undefined;
  } catch {
    // Rust restore validation will preserve the original bytes; plugin inventory
    // will surface the malformed installed.json instead of silently dropping it.
  }
  return next;
}

export type EndpointReachabilityResult = {
  ok: boolean;
  status: number;
  message: string;
};

function activeProfile(): string {
  return currentAppState?.activeProfile ?? "default";
}

function activeKimiCodeEnvironmentId(): string {
  return currentAppState?.panelSettings.active_kimi_code_environment_id ?? "default";
}

function activeKimiCodeEnvironmentHome(): string {
  const environmentId = activeKimiCodeEnvironmentId();
  return normalizeKimiCodeEnvironments(currentAppState?.panelSettings.kimi_code_environments)
    .find((environment) => environment.id === environmentId)?.homePath ?? "~/.kimi-code";
}

function supportsCredentialSlots(settings: PanelSettings): boolean {
  if (!settings.official_account_vault_enabled) return false;
  const activeId = settings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(settings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  return activeId === "default" && environment?.homePath === "~/.kimi-code";
}

function normalizeLexicalPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const unc = normalized.startsWith("//");
  const drive = unc ? "" : normalized.match(/^[A-Za-z]:/u)?.[0] ?? "";
  const absolute = normalized.startsWith("/") || Boolean(drive);
  const body = unc ? normalized.slice(2) : drive ? normalized.slice(drive.length) : normalized;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = unc ? "//" : drive ? `${drive}/` : absolute ? "/" : "";
  return `${prefix}${parts.join("/")}` || (absolute ? prefix : ".");
}

function normalizeProjectRootMcpServers(
  servers: Record<string, McpServerConfig>,
  projectRoot: string,
): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    if (server.transport !== "stdio") return [name, server];
    const configuredCwd = typeof server.extra?.cwd === "string" ? server.extra.cwd.trim() : "";
    const cwdIsAbsolute = configuredCwd.startsWith("/")
      || configuredCwd.startsWith("\\\\")
      || /^[A-Za-z]:[\\/]/u.test(configuredCwd);
    const resolvedCwd = configuredCwd
      ? normalizeLexicalPath(cwdIsAbsolute ? configuredCwd : `${projectRoot}/${configuredCwd}`)
      : normalizeLexicalPath(projectRoot);
    return [name, {
      ...server,
      extra: { ...(server.extra ?? {}), cwd: resolvedCwd },
    }];
  }));
}

async function workspaceTrustMarkerPath(homePath: string, workingDirectory: string): Promise<string> {
  const normalized = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").at(-1) ?? normalized;
  const slugCandidate = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  const slug = !slugCandidate || slugCandidate === "." || slugCandidate === ".."
    ? "workspace"
    : slugCandidate;
  const hash = (await sha256Text(normalized)).slice(0, 12);
  return `${homePath.replace(/\/+$/, "")}/workspace-trust/wd_${slug}_${hash}`;
}

async function readWorkspaceTrust(markerPath: string): Promise<boolean> {
  try {
    const document = await tauriFileAccess.readText(markerPath);
    if (document === null) return false;
    JSON.parse(document);
    return true;
  } catch {
    return false;
  }
}

export async function loadProjectMcpScope(state: AppState): Promise<void> {
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  const workingDirectory = environment?.workingDirectory?.trim();
  if (!workingDirectory) {
    state.projectMcpConfig = undefined;
    return;
  }
  const normalizedWorkingDirectory = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const projectRoot = await resolveNearestGitProjectRoot(skillFileAccess, normalizedWorkingDirectory)
    ?? normalizedWorkingDirectory;
  const environmentHome = environment?.homePath ?? (activeId === "default" ? "~/.kimi-code" : getKimiCodeEnvironmentHomePath(activeId));
  const trustPath = await workspaceTrustMarkerPath(environmentHome, normalizedWorkingDirectory);
  const trusted = await readWorkspaceTrust(trustPath);
  const sourceSpecs = [
    { scope: "project-root" as const, path: `${projectRoot}/.mcp.json` },
    { scope: "project-local" as const, path: `${normalizedWorkingDirectory}/.kimi-code/mcp.json` },
  ].filter((source, index, all) => all.findIndex((candidate) => candidate.path === source.path) === index);
  const sources = await Promise.all(sourceSpecs.map(async (source): Promise<{
    scope: "project-root" | "project-local";
    path: string;
    mcpServers: Record<string, McpServerConfig>;
    error?: string;
  }> => {
    const document = await tauriFileAccess.readText(source.path);
    if (document === null) return { ...source, mcpServers: {} };
    try {
      const parsedServers = parseMcpConfig(document, { sourcePath: source.path }).mcpServers;
      return {
        ...source,
        mcpServers: source.scope === "project-root"
          ? normalizeProjectRootMcpServers(parsedServers, projectRoot)
          : parsedServers,
      };
    } catch (error) {
      return {
        ...source,
        mcpServers: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const declaredMcpServers = Object.assign({}, ...sources.map((source) => source.mcpServers));
  const errors = sources.flatMap((source) => source.error ? [`${source.path}: ${source.error}`] : []);
  state.projectMcpConfig = {
    projectRoot,
    configPath: sources.map((source) => source.path).join(" → "),
    trusted,
    trustPath,
    declaredMcpServers,
    mcpServers: trusted ? declaredMcpServers : {},
    error: errors.length > 0 ? errors.join("; ") : undefined,
    sources,
  };
}

export async function loadPluginInventory(state: AppState): Promise<void> {
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  const home = environment?.homePath ?? (activeId === "default" ? "~/.kimi-code" : getKimiCodeEnvironmentHomePath(activeId));
  state.pluginInventory = await scanKimiPlugins(skillFileAccess, home);
}

export async function loadProjectLocalConfig(state: AppState): Promise<void> {
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  const workingDirectory = environment?.workingDirectory?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!workingDirectory) {
    state.projectLocalConfig = undefined;
    return;
  }
  const projectRoot = await resolveNearestGitProjectRoot(skillFileAccess, workingDirectory)
    ?? workingDirectory;
  const path = `${projectRoot}/.kimi-code/local.toml`;
  const existingDocument = await tauriFileAccess.readText(path);
  const document = existingDocument ?? "";
  try {
    const parsed = document.trim() ? parseTomlString(document) as Record<string, unknown> : {};
    if (parsed.workspace !== undefined && (typeof parsed.workspace !== "object" || parsed.workspace === null || Array.isArray(parsed.workspace))) {
      throw new Error("workspace must be a table");
    }
    const workspace = parsed.workspace && typeof parsed.workspace === "object" && !Array.isArray(parsed.workspace)
      ? parsed.workspace as Record<string, unknown>
      : {};
    if (parsed.workspace !== undefined && workspace.additional_dir === undefined) {
      throw new Error("workspace.additional_dir must be an array of strings");
    }
    if (workspace.additional_dir !== undefined && !Array.isArray(workspace.additional_dir)) {
      throw new Error("workspace.additional_dir must be an array of strings");
    }
    const configuredDirs = Array.isArray(workspace.additional_dir)
      ? workspace.additional_dir.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (Array.isArray(workspace.additional_dir) && configuredDirs.length !== workspace.additional_dir.length) {
      throw new Error("workspace.additional_dir must be an array of strings");
    }
    const additionalDirs = await resolveProjectAdditionalDirs(projectRoot, configuredDirs);
    state.projectLocalConfig = {
      projectRoot,
      workingDirectory,
      path,
      additionalDirs,
      document,
      sha256: await sha256Text(existingDocument),
    };
  } catch (error) {
    state.projectLocalConfig = {
      projectRoot,
      workingDirectory,
      path,
      additionalDirs: [],
      document,
      sha256: await sha256Text(existingDocument),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveProjectAdditionalDirs(
  projectRoot: string,
  additionalDirs: string[],
): Promise<string[]> {
  // pathe.normalize("") used by Kimi resolves to "."; whitespace-only values
  // remain invalid after trim. The textarea already removes blank visual rows
  // for new edits, while existing official documents retain this edge case.
  const inputs = additionalDirs.map((entry) => entry === "" ? "." : entry);
  const resolved = await Promise.all(inputs.map((inputPath) => invoke<string>(
    "resolve_workspace_directory",
    { projectRoot, inputPath },
  )));
  return [...new Set(resolved)];
}

async function loadTuiRevision(state: AppState): Promise<void> {
  const normalized = normalizeStatePaths(state);
  const environmentHome = normalized.configPath.replace(/\/config\.toml$/, "");
  state.tuiConfigSha256 = await sha256Text(
    await tauriFileAccess.readText(`${environmentHome}/tui.toml`),
  );
}

function requireDefaultEnvironmentForCredentialSlots(): void {
  if (!currentAppState || !supportsCredentialSlots(currentAppState.panelSettings)) {
    throw new Error("Credential slots only support the legacy default environment. Log in separately for this environment.");
  }
}

async function getStartupKimiCodeDetection(
  force = false,
): Promise<AppState["kimiTargetDetection"]> {
  // force 时清空已完成的缓存，触发重新检测（如用户安装 Kimi Code 后点"刷新检测"）。
  // 若已有进行中的检测任务则复用它，避免重复打断。
  if (force) {
    startupKimiCodeDetection = null;
  }
  if (startupKimiCodeDetection) return startupKimiCodeDetection;
  if (startupKimiCodeDetectionTask) return startupKimiCodeDetectionTask;
  const startedAt = startupTimingNow();
  startupKimiCodeDetectionTask = Promise.all([
    cli.detectActiveKimiTarget(),
    cli.getTargetCliVersion("kimi-code"),
  ]).then(([detection, version]) => {
    startupKimiCodeDetection = {
      ...detection,
      installed: version.installed,
      status: version.installed ? "detected" : "not-installed",
      version: version.version,
      latestVersion: version.latestVersion,
      hasUpdate: version.hasUpdate,
      packageName: version.packageName,
      installCommand: version.installCommand,
      updateCommand: version.updateCommand,
      installSource: version.installSource ?? detection.installSource,
    };
    return startupKimiCodeDetection;
  }).finally(() => {
    startupKimiCodeDetectionTask = null;
    recordStartupTiming("kimiSwitch.getStartupKimiCodeDetection", startedAt);
  });
  return startupKimiCodeDetectionTask;
}

function createPendingKimiCodeDetection(): NonNullable<AppState["kimiTargetDetection"]> {
  return {
    target: "kimi-code",
    installed: false,
    status: "checking",
    version: "",
    executablePath: "",
    resolvedPath: "",
    candidates: [],
    reason: "startup-detection-pending",
    installSource: "unknown",
    packageName: "Kimi Code",
    installCommand: "brew install kimi-code",
    updateCommand: "brew upgrade kimi-code",
  };
}

function syncDetectedKimiTargetToState(detection: AppState["kimiTargetDetection"]): void {
  if (!detection || !currentAppState) return;
  currentAppState = {
    ...currentAppState,
    kimiTargetDetection: detection,
  };
  window.dispatchEvent(new CustomEvent("kimi-target-detection", { detail: detection }));
}

function refreshStartupKimiCodeDetection(
  force = false,
): Promise<AppState["kimiTargetDetection"]> {
  return getStartupKimiCodeDetection(force).then((detection) => {
    syncDetectedKimiTargetToState(detection);
    return detection;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nativeModelUiMetadata(value: unknown): Pick<ModelConfig, "auth_mode" | "official_account_scope" | "pricing"> {
  if (!isRecord(value)) return {};
  return {
    ...(value.auth_mode === "api-key" || value.auth_mode === "official-account"
      ? { auth_mode: value.auth_mode }
      : {}),
    ...(value.official_account_scope === "global" ? { official_account_scope: "global" as const } : {}),
    ...(isRecord(value.pricing) ? { pricing: value.pricing as unknown as ModelConfig["pricing"] } : {}),
  };
}

function isExplicitlyDisabledLegacyResource(value: unknown): boolean {
  return isRecord(value) && value.enabled === false;
}

/** Recover missing native entries from deprecated SQLite mirrors. */
export async function recoverLegacyNativeConfig(state: AppState): Promise<void> {
  const { clearRecoveredLegacyNativeConfig, exportLegacyNativeConfig } = await import("./legacyNativeConfig");
  const legacy = await exportLegacyNativeConfig();
  const environments = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments);
  let metadataChanged = false;
  const recoveredEnvironmentIds: string[] = [];
  const nextMetadata = structuredClone(state.panelSettings.model_ui_metadata ?? {});

  for (const environment of environments) {
    const cached = legacy.environments[environment.id];
    if (!cached) continue;

    const configPath = getKimiCodeConfigPath(environment.homePath);
    const mcpPath = getKimiCodeMcpConfigPath(environment.homePath);
    const currentMain = parseMainConfigDocument(await tauriFileAccess.readText(configPath));
    const legacyMain = parseMainConfigDocument(stringifyToml({
      providers: cached.providers,
      models: cached.models,
    }));
    const disabledProviderNames = new Set(Object.entries(cached.providers)
      .filter(([, provider]) => isExplicitlyDisabledLegacyResource(provider))
      .map(([name]) => name));
    const preservesDisabledResources = disabledProviderNames.size > 0
      || Object.values(cached.models).some(isExplicitlyDisabledLegacyResource);
    let configChanged = false;
    for (const [name, provider] of Object.entries(legacyMain.providers)) {
      if (currentMain.providers[name] !== undefined || disabledProviderNames.has(name)) continue;
      currentMain.providers[name] = provider;
      configChanged = true;
    }
    for (const [name, model] of Object.entries(legacyMain.models)) {
      if (
        currentMain.models[name] !== undefined
        || currentMain.providers[model.provider] === undefined
        || disabledProviderNames.has(model.provider)
        || isExplicitlyDisabledLegacyResource(cached.models[name])
      ) continue;
      currentMain.models[name] = model;
      configChanged = true;
    }

    const metadata: Record<string, Pick<ModelConfig, "auth_mode" | "official_account_scope" | "pricing">> = {};
    for (const [name, rawModel] of Object.entries(cached.models)) {
      if (currentMain.models[name] === undefined || isExplicitlyDisabledLegacyResource(rawModel)) continue;
      const ui = nativeModelUiMetadata(rawModel);
      if (Object.keys(ui).length > 0) metadata[name] = ui;
    }
    if (JSON.stringify(nextMetadata[environment.id] ?? {}) !== JSON.stringify(metadata)) {
      if (Object.keys(metadata).length > 0) nextMetadata[environment.id] = metadata;
      else delete nextMetadata[environment.id];
      metadataChanged = true;
    }

    const currentMcp = parseMcpConfig(await tauriFileAccess.readText(mcpPath), { sourcePath: mcpPath });
    let mcpChanged = false;
    let mcpRecoverable = true;
    try {
      const legacyMcp = parseMcpConfig(JSON.stringify({ mcpServers: cached.mcpServers }), { sourcePath: "legacy SQLite" });
      for (const [name, server] of Object.entries(legacyMcp.mcpServers)) {
        if (currentMcp.mcpServers[name] !== undefined) continue;
        currentMcp.mcpServers[name] = server;
        mcpChanged = true;
      }
    } catch (error) {
      mcpRecoverable = false;
      console.warn(`Skipped invalid legacy MCP mirror for ${environment.id}:`, error);
    }

    if (configChanged) {
      await tauriFileAccess.ensureDir(environment.homePath);
      await tauriFileAccess.writeText(configPath, buildConfigDocument({ ...state, configPath, mainConfig: currentMain }));
    }
    if (mcpChanged) {
      await tauriFileAccess.ensureDir(environment.homePath);
      await tauriFileAccess.writeText(mcpPath, buildMcpConfigDocument(currentMcp));
    }
    if (environment.id === state.panelSettings.active_kimi_code_environment_id) {
      state.mainConfig = currentMain;
      state.mcpConfig = currentMcp;
    }
    if (mcpRecoverable && !preservesDisabledResources) recoveredEnvironmentIds.push(environment.id);
  }

  if (metadataChanged) {
    state.panelSettings.model_ui_metadata = nextMetadata;
    await savePanelSettings(state.panelSettings);
  }
  await clearRecoveredLegacyNativeConfig(recoveredEnvironmentIds);
}

async function runPostLoadMaintenance(): Promise<void> {
  const startedAt = startupTimingNow();
  try {
    try {
      const result = await invoke<string>("migrate_legacy_database");
      if (result.includes("Migrated")) {
        console.log("Legacy database migration:", result);
        // A merged legacy DB may contribute historical snapshots whose files
        // still live in an old GUI directory. Re-run the idempotent history
        // initializer so it relocates those files and repairs their metadata.
        await initConfigHistory();
      }
    } catch (err) {
      console.warn("Legacy database migration skipped:", err);
    }

    try {
      const absoluteNativeHome = await invoke<string>("resolve_home_path", {
        path: "~/.kimi-code",
      }).catch(() => "");
      const repair = await repairLegacyManagedDefaultHomeSymlink(
        tauriFileAccess,
        absoluteNativeHome || undefined,
      );
      if (repair.repaired) {
        console.log("Legacy managed default home symlink materialized:", repair);
      }
    } catch (err) {
      console.warn("Legacy managed default home symlink repair skipped:", err);
    }

    try {
      const migration = await migrateLegacyManagedDefaultEnvironmentToNativeHome(tauriFileAccess);
      if (migration.migrated) {
        console.log("Legacy managed default environment migrated to the native Kimi Code home:", migration);
      }
    } catch (err) {
      console.warn("Legacy managed default environment migration skipped:", err);
    }

    try {
      const migration = await migrateLegacyKimiCliConfigToKimiCode(tauriFileAccess);
      if (migration.migrated) {
        console.log("Legacy Kimi CLI config migrated to Kimi Code:", migration);
      }
    } catch (err) {
      console.warn("Legacy Kimi CLI config migration skipped:", err);
    }

  } finally {
    recordStartupTiming("kimiSwitch.runPostLoadMaintenance", startedAt);
  }
}

/**
 * 把内存 state 同步回 panel_settings（SQLite）。
 *
 * 必须在 loadState 返回前 await 完成：它会写 SQLite 改变 panel 文档，
 * 若放到后台异步执行，会在「快照基线已捕获」之后再改盘，导致首次保存时
 * 误判 panel 配置被外部修改（首次启动复现）。
 */
async function syncPanelSettingsAfterLoad(state: AppState): Promise<void> {
  const currentSettings = await getPanelSettings();
  if (!currentSettings) {
    await savePanelSettings({
      ...state.panelSettings,
      config_target: state.panelSettings.config_target,
      config_path: state.panelSettings.config_path,
      profiles: state.profiles,
      active_profile: state.activeProfile,
      kimi_code_environments: state.panelSettings.kimi_code_environments,
      active_kimi_code_environment_id: state.panelSettings.active_kimi_code_environment_id,
      active_official_account_id: state.panelSettings.active_official_account_id ?? "",
      profiles_path: "",
      follow_config_profiles: true,
    });
    return;
  }
  const needsPanelSync =
    currentSettings.config_target !== state.panelSettings.config_target ||
    currentSettings.config_path !== state.panelSettings.config_path ||
    currentSettings.active_profile !== state.activeProfile ||
    JSON.stringify(currentSettings.profiles ?? {}) !== JSON.stringify(state.profiles ?? {}) ||
    JSON.stringify(currentSettings.kimi_code_environments ?? []) !== JSON.stringify(state.panelSettings.kimi_code_environments ?? []) ||
    (currentSettings.active_kimi_code_environment_id ?? "") !== (state.panelSettings.active_kimi_code_environment_id ?? "") ||
    (currentSettings.active_official_account_id ?? "") !== (state.panelSettings.active_official_account_id ?? "");
  if (needsPanelSync) {
    await savePanelSettings({
      ...currentSettings,
      config_target: state.panelSettings.config_target,
      config_path: state.panelSettings.config_path,
      profiles: state.profiles,
      active_profile: state.activeProfile,
      kimi_code_environments: state.panelSettings.kimi_code_environments,
      active_kimi_code_environment_id: state.panelSettings.active_kimi_code_environment_id,
      active_official_account_id: state.panelSettings.active_official_account_id ?? "",
      profiles_path: "",
      follow_config_profiles: true,
    });
  }
}

/**
 * Compute the estimated cost of a per-model token-sum row using the model's
 * *current* pricing (user override → built-in default → null). Cost is derived
 * at read time so changing a model's price re-prices history. Returns `null`
 * when no price is known for the model.
 */
function costForModelTokens(row: usageDb.ModelTokenSums, models: Record<string, ModelConfig>): number | null {
  const configured = models[row.model];
  const pricing = configured
    ? resolveModelPricing(configured)
    : resolveModelPricing({ model: row.model });
  return computeEventCost(
    {
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
      reasoning_tokens: row.reasoning_tokens,
    },
    pricing,
  );
}

/**
 * Aggregates per-model token sums into a cost map keyed by a chosen dimension
 * (`""` for the grand total, the day string for a daily bucket, or the model
 * id). A key's cost is `null` whenever any contributing model has no known
 * price; reporting only the priced subset as a total would understate cost.
 */
function aggregateCost(
  rows: usageDb.ModelTokenSums[],
  models: Record<string, ModelConfig>,
  keyOf: (row: usageDb.ModelTokenSums) => string,
): Record<string, number | null> {
  const out: Record<string, { total: number; anyKnown: boolean; anyUnknown: boolean }> = {};
  for (const row of rows) {
    const key = keyOf(row);
    const cost = costForModelTokens(row, models);
    const bucket = out[key] ?? (out[key] = { total: 0, anyKnown: false, anyUnknown: false });
    if (cost !== null) {
      bucket.total += cost;
      bucket.anyKnown = true;
    } else {
      bucket.anyUnknown = true;
    }
  }
  const result: Record<string, number | null> = {};
  for (const [key, { total, anyKnown, anyUnknown }] of Object.entries(out)) {
    result[key] = anyKnown && !anyUnknown ? total : null;
  }
  return result;
}

async function ensureUsageRuntime(): Promise<void> {
  if (!usageOpen) {
    await usageDb.open(USAGE_DB_PATH);
    await initConfigHistory();
    usageOpen = true;
  }
  if (!logWatcher) {
    logWatcher = new UsageLogWatcher({
      getActiveProfile: activeProfile,
      getActiveEnvironmentId: activeKimiCodeEnvironmentId,
      getActiveEnvironmentHome: activeKimiCodeEnvironmentHome,
    });
    await logWatcher.start();
  }
}

/**
 * 打开数据库 + 初始化所有 SQLite store（单飞）。
 * 并发或重复的 loadState 共享同一次初始化，避免首次启动 StrictMode 双调用时
 * 两路同时建表/写 schema_versions 触发 UNIQUE 冲突。
 */
function ensureStoresInitialized(): Promise<void> {
  if (!storesInitTask) {
    storesInitTask = (async () => {
      // 旧库由后端在打开新库后逐表合并。这里不能移动或删除任何候选
      // 文件，否则多份旧数据库共存时会丢失尚未合并的数据。
      const { tauriFileAccess } = await import("./fileAccess");
      try {
        await tauriFileAccess.ensureDir(PANEL_APP_DIR);
      } catch (err) {
        console.warn("Database file migration skipped:", err);
      }

      if (!usageOpen) {
        await usageDb.open(USAGE_DB_PATH);
        usageOpen = true;
      }

      await initPanelSettingsStore();
      await initConfigHistory();
      await officialAccounts.initOfficialAccountsStore();
    })();
    // 失败时清空 task，允许下次 loadState 重试初始化。
    storesInitTask.catch(() => { storesInitTask = null; });
  }
  return storesInitTask;
}

function stopUsageRuntime(): void {
  logWatcher?.stop();
  logWatcher = null;
}

function extractInsightsSettings(state: AppState | null): PanelSettings["insights_status"] extends never ? never : Record<string, unknown> {
  const ps = state?.panelSettings;
  return {
    insights_status: ps?.insights_status ?? "disabled",
    insights_proxy_port: ps?.insights_proxy_port ?? "auto",
    insights_retention_days: ps?.insights_retention_days ?? 90,
    insights_disk_warn_threshold_mb: ps?.insights_disk_warn_threshold_mb ?? 100,
    insights_store_prompt_preview: ps?.insights_store_prompt_preview ?? false,
    insights_onboarding_shown_at: ps?.insights_onboarding_shown_at ?? "",
    insights_last_known_port: ps?.insights_last_known_port ?? null,
    insights_display_currency: ps?.insights_display_currency ?? "USD",
    insights_currency_rates: { ...(ps?.insights_currency_rates ?? {}) },
  } as never;
}

function notImplemented(name: string): never {
  throw new Error(`[tauri] ${name} 尚未迁移`);
}

export const kimiSwitchTauri = {
  // ── 核心状态链路 ──
  loadState: async (paths?: LoadStatePaths): Promise<AppState> => {
    const loadStartedAt = startupTimingNow();
    // 打开数据库 + 初始化所有 store（单飞，防并发重复初始化）。
    const storeStartedAt = startupTimingNow();
    await ensureStoresInitialized();
    const recovery = await recoverPendingSaveTransaction();
    if (recovery.action === "unknown") {
      // C2：unknown 状态进入只读恢复模式——不自动覆盖任何文件；UI 通过 getPendingSaveRecovery 呈现。
      pendingSaveRecovery = {
        action: "unknown",
        journal: recovery.journal,
      };
    } else if (recovery.action === "quarantined") {
      pendingSaveRecovery = {
        action: "quarantined",
        reason: recovery.reason,
        quarantinedPath: recovery.quarantinedPath,
      };
    } else {
      pendingSaveRecovery = null;
    }
    // C3：恢复被 crash 中断的 restore 事务（full/regular/history 恢复的统一 journal）。
    const restoreRecovery = await recoverPendingRestoreTransaction();
    if (restoreRecovery.action === "unknown") {
      pendingSaveRecovery = {
        action: "unknown-restore",
        journal: restoreRecovery.journal,
      };
    } else if (restoreRecovery.action === "quarantined") {
      pendingSaveRecovery = {
        action: "quarantined-restore",
        reason: restoreRecovery.reason,
        quarantinedPath: restoreRecovery.quarantinedPath,
      };
    }
    recordStartupTiming("kimiSwitch.loadState.stores", storeStartedAt);

    const currentSettings = await getPanelSettings();
    if (!currentSettings) {
      const detectedHome = await invoke<string>("get_kimi_code_home");
      if (detectedHome && detectedHome !== "~/.kimi-code") {
        const initialSettings = createDefaultPanelSettings();
        initialSettings.kimi_code_environments = [{
          id: "default",
          name: "默认环境",
          homePath: detectedHome,
          kind: "external",
          description: "Inherited from KIMI_CODE_HOME",
        }];
        initialSettings.config_path = getKimiCodeConfigPath(detectedHome);
        await savePanelSettings(initialSettings);
      }
    }

    const effectiveTarget = "kimi-code";
    const effectivePaths: LoadStatePaths = {
      ...paths,
      configTarget: effectiveTarget,
    };

    // Configuration migrations may write native files. They must complete
    // before loadAppState returns so the renderer's first snapshot captures
    // their final revision rather than reporting our own write as external.
    await runPostLoadMaintenance();

    const stateStartedAt = startupTimingNow();
    const state = await loadAppState(tauriFileAccess, effectivePaths);
    try {
      await recoverLegacyNativeConfig(state);
    } catch (err) {
      console.warn("Legacy GUI configuration recovery skipped:", err);
    }
    await loadPluginInventory(state);
    await loadProjectMcpScope(state);
    await loadProjectLocalConfig(state);
    await loadTuiRevision(state);
    recordStartupTiming("kimiSwitch.loadState.loadAppState", stateStartedAt);
    state.kimiTargetDetection = startupKimiCodeDetection ?? createPendingKimiCodeDetection();
    try {
      const accountStartedAt = startupTimingNow();
      if (supportsCredentialSlots(state.panelSettings)) {
        const accountStatus = await officialAccounts.getOfficialAccountCredentialsStatus();
        state.panelSettings.active_official_account_id = accountStatus.active_account_id;
      } else {
        state.panelSettings.active_official_account_id = "";
      }
      recordStartupTiming("kimiSwitch.loadState.accountStatus", accountStartedAt);
    } catch (err) {
      console.warn("Official account status load skipped:", err);
    }
    currentAppState = structuredClone(state);

    // 在快照基线捕获前，先 await 同步 panel_settings，确保返回的 state 与盘上一致，
    // 避免首次启动时后台改盘导致误报「配置被外部修改」。
    try {
      await syncPanelSettingsAfterLoad(state);
    } catch (err) {
      console.warn("Panel settings sync after load skipped:", err);
    }

    void refreshStartupKimiCodeDetection()
      .catch((err) => console.warn("Kimi Code detection skipped:", err));

    if (state.panelSettings.insights_status === "enabled") {
      void ensureUsageRuntime().catch((e) => console.error("usage runtime", e));
    }
    if (state.panelSettings.tray_icon) {
      void setupTray(() => currentAppState, () => window.dispatchEvent(new Event("kimi-tray-reload"))).catch((e) => console.error("tray", e));
    }
    void syncWindowToggleShortcut().catch((e) => console.error("shortcut", e));
    recordStartupTiming("kimiSwitch.loadState.total", loadStartedAt);
    return state;
  },
  getPendingSaveRecovery: (): SaveRecoveryInfo | null => pendingSaveRecovery,
  dismissSaveRecovery: (): void => {
    pendingSaveRecovery = null;
  },
  // C2：人工选择后执行恢复决策。
  // - abandon：删除 save 与 restore 两个 journal（restore 共用此入口），保留现有行为。
  // - export-journal：用 saveFile 把 save journal 原样导出留档，不自动删除；banner 保持，由用户再点放弃。
  // - apply-desired / restore-original：先复核当前 revisions，再逐资源写回；成功后才删 save journal。
  resolveSaveRecovery: async (decision: SaveRecoveryDecision): Promise<ResolveSaveRecoveryResult> => {
    const completedAt = new Date().toISOString();
    if (decision === "abandon") {
      const deletedJournals: string[] = [];
      for (const journal of [SAVE_TRANSACTION_PATH, RESTORE_TRANSACTION_PATH]) {
        await removeFile(journal)
          .then(() => deletedJournals.push(journal))
          .catch(() => {
            // 不存在忽略
          });
      }
      pendingSaveRecovery = null;
      return { ok: true, decision, completedAt, writtenFiles: 0, removedFiles: 0, unchangedFiles: 0, failures: [], deletedJournals };
    }

    if (decision === "export-journal") {
      const document = await tauriFileAccess.readText(SAVE_TRANSACTION_PATH);
      if (document === null) {
        pendingSaveRecovery = null;
        return {
          ok: false,
          decision,
          completedAt,
          writtenFiles: 0,
          removedFiles: 0,
          unchangedFiles: 0,
          failures: [{ path: SAVE_TRANSACTION_PATH, message: "Save journal is no longer available." }],
        };
      }
      const saved = await kimiSwitchTauri.saveFile(document, { defaultPath: "pending-save-transaction.json" });
      return {
        ok: true,
        decision,
        completedAt,
        writtenFiles: 0,
        removedFiles: 0,
        unchangedFiles: 0,
        failures: [],
        exportedPath: saved.canceled ? null : saved.filePath,
      };
    }

    // apply-desired / restore-original
    const record = await readCurrentSaveJournal();
    if (!record) {
      pendingSaveRecovery = null;
      return {
        ok: false,
        decision,
        completedAt,
        writtenFiles: 0,
        removedFiles: 0,
        unchangedFiles: 0,
        failures: [{ path: SAVE_TRANSACTION_PATH, message: "Save journal is not available for recovery." }],
      };
    }
    const result = await applySaveRecoveryDecision(record, decision, completedAt);
    if (result.ok) {
      // 成功后才删除 save journal；restore journal 的 original/desired 人工选择属 C3，不在此删除。
      await removeFile(SAVE_TRANSACTION_PATH).catch(() => {
        // journal 可能已被并发移除；文件已收敛到目标状态，仍视为成功。
      });
      pendingSaveRecovery = null;
    }
    return result;
  },
  saveState: async (state: AppState): Promise<SaveStateResult> => {
    // 保存前捕获快照（Kimi 标准配置 + GUI SQLite 导出）
    const workingState = structuredClone(state);
    const normalized = normalizeStatePaths(workingState);
    const writeBaseline = await captureSnapshotForState(normalized);
    const environmentId = normalized.panelSettings.active_kimi_code_environment_id ?? "";
    const environmentHome = normalized.configPath.replace(/\/config\.toml$/, "");
    const tuiBaselineHash = workingState.tuiConfigSha256
      ?? await sha256Text(await tauriFileAccess.readText(`${environmentHome}/tui.toml`));
    await Promise.all([
      captureSnapshot("config", normalized.configPath, undefined, environmentId),
      captureSnapshot("panel", normalized.panelSettingsPath, undefined, environmentId),
      captureSnapshot("mcp", normalized.mcpConfigPath, undefined, environmentId),
      captureSnapshot("tui", `${environmentHome}/tui.toml`, undefined, environmentId),
      captureSnapshot("agents", `${environmentHome}/AGENTS.md`, undefined, environmentId),
      captureSnapshot("skills", `${environmentHome}/skills`, undefined, environmentId),
    ]);

    await saveAppState(tauriFileAccess, workingState, {
      expectedSha256: {
        config: writeBaseline.files.config.sha256,
        mcp: writeBaseline.files.mcp.sha256,
        tui: tuiBaselineHash,
      },
    });
    await loadTuiRevision(workingState);
    currentAppState = structuredClone(workingState);

    await syncWindowToggleShortcut();

    // 保存后清理旧快照（30 天前）
    void cleanupOldSnapshots();

    return {
      ok: true,
      snapshot: await captureSnapshotForState(normalized),
      doctor: buildConfigDoctorReport(normalized),
    };
  },
  saveStateSafe: async (
    state: AppState,
    options?: { expectedSnapshot?: FileSnapshotBundle; allowOverwrite?: boolean },
  ): Promise<SaveStateResult | SaveStateConflictResult> => {
    const workingState = structuredClone(state);
    const normalized = normalizeStatePaths(workingState);
    let writeBaseline: FileSnapshotBundle | undefined;
    if (options?.allowOverwrite !== true) {
      const conflict = await detectExternalChangeConflict({
        expectedSnapshot: options?.expectedSnapshot,
        targetPaths: {
          config: normalized.configPath,
          panel: normalized.panelSettingsPath,
          mcp: normalized.mcpConfigPath,
        },
        draftDocuments: buildManagedDocuments(normalized),
      });
      if (conflict.conflict) {
        return {
          ok: false,
          reason: "external-change",
          snapshot: conflict.snapshot,
          doctor: buildConfigDoctorReport(normalized),
          conflict: conflict.conflict,
        };
      }
      writeBaseline = conflict.snapshot;
    }

    // 保存前捕获快照（Kimi 标准配置 + GUI SQLite 导出）
    const environmentId = normalized.panelSettings.active_kimi_code_environment_id ?? "";
    const environmentHome = normalized.configPath.replace(/\/config\.toml$/, "");
    const tuiBaselineHash = workingState.tuiConfigSha256
      ?? await sha256Text(await tauriFileAccess.readText(`${environmentHome}/tui.toml`));
    await Promise.all([
      captureSnapshot("config", normalized.configPath, undefined, environmentId),
      captureSnapshot("panel", normalized.panelSettingsPath, undefined, environmentId),
      captureSnapshot("mcp", normalized.mcpConfigPath, undefined, environmentId),
      captureSnapshot("tui", `${environmentHome}/tui.toml`, undefined, environmentId),
      captureSnapshot("agents", `${environmentHome}/AGENTS.md`, undefined, environmentId),
      captureSnapshot("skills", `${environmentHome}/skills`, undefined, environmentId),
    ]);

    await saveAppState(tauriFileAccess, workingState, writeBaseline ? {
      expectedSha256: {
        config: writeBaseline.files.config.sha256,
        mcp: writeBaseline.files.mcp.sha256,
        tui: tuiBaselineHash,
      },
    } : undefined);
    await loadTuiRevision(workingState);
    currentAppState = structuredClone(workingState);

    await syncWindowToggleShortcut();

    // 保存后清理旧快照（30 天前）
    void cleanupOldSnapshots();

    return {
      ok: true,
      snapshot: await captureSnapshotForState(normalized),
      doctor: buildConfigDoctorReport(normalized),
    };
  },
  saveConfigTargetPreference: async (): Promise<{ ok: true }> => {
    const currentSettings = (await getPanelSettings())
      ?? currentAppState?.panelSettings
      ?? createDefaultPanelSettings();
    const configTarget = "kimi-code" as const;
    const configPath = getDefaultConfigPath(configTarget);
    const saved = await savePanelSettings({
      ...currentSettings,
      config_target: configTarget,
      config_path: configPath,
      profiles_path: "",
      follow_config_profiles: true,
    });
    if (!saved) {
      throw new Error("Failed to save config target preference.");
    }
    if (currentAppState) {
      currentAppState = {
        ...currentAppState,
        configTarget,
        panelSettings: {
          ...currentAppState.panelSettings,
          config_target: configTarget,
          config_path: configPath,
          profiles_path: "",
          follow_config_profiles: true,
        },
      };
    }
    return { ok: true };
  },
  saveKimiCodeEnvironmentPreference: async (
    environments: KimiCodeEnvironment[],
    activeEnvironmentId: string,
  ): Promise<KimiCodeEnvironmentPreferenceResult> => {
    const restartUsageWatcher = logWatcher?.isRunning() ?? false;
    const currentSettings = (await getPanelSettings())
      ?? currentAppState?.panelSettings
      ?? createDefaultPanelSettings();
    const currentActiveEnvironmentId = currentAppState?.panelSettings.active_kimi_code_environment_id
      ?? currentSettings.active_kimi_code_environment_id;
    const normalizedEnvironments = normalizeKimiCodeEnvironments(environments, currentSettings.kimi_code_environments)
      .map((environment) => (
        currentAppState && environment.id === currentActiveEnvironmentId
          ? {
              ...environment,
              profiles: currentAppState.profiles,
              activeProfile: currentAppState.activeProfile,
            }
          : environment
      ));
    const activeEnvironment = normalizedEnvironments.find((environment) => environment.id === activeEnvironmentId)
      ?? normalizedEnvironments[0];
    if (!activeEnvironment) {
      throw new Error("No Kimi Code environment is available.");
    }
    const configPath = getKimiCodeConfigPath(activeEnvironment.homePath);
    const saved = await savePanelSettings({
      ...currentSettings,
      config_target: "kimi-code",
      config_path: configPath,
      profiles_path: "",
      follow_config_profiles: true,
      kimi_code_environments: normalizedEnvironments,
      active_kimi_code_environment_id: activeEnvironment.id,
    });
    if (!saved) {
      throw new Error("Failed to save Kimi Code environment preference.");
    }

    const nextState = normalizeStatePaths(await loadAppState(tauriFileAccess, {
      configTarget: "kimi-code",
      configPath,
      mcpConfigPath: getKimiCodeMcpConfigPath(activeEnvironment.homePath),
    }));
    await loadPluginInventory(nextState);
    await loadProjectMcpScope(nextState);
    await loadProjectLocalConfig(nextState);
    await loadTuiRevision(nextState);
    nextState.kimiTargetDetection = currentAppState?.kimiTargetDetection
      ?? startupKimiCodeDetection
      ?? createPendingKimiCodeDetection();
    try {
      if (supportsCredentialSlots(nextState.panelSettings)) {
        const accountStatus = await officialAccounts.getOfficialAccountCredentialsStatus();
        nextState.panelSettings.active_official_account_id = accountStatus.active_account_id;
      } else {
        nextState.panelSettings.active_official_account_id = "";
      }
    } catch (err) {
      console.warn("Official account status load skipped:", err);
    }

    const finalPanelSettings: PanelSettings = {
      ...nextState.panelSettings,
      config_target: "kimi-code",
      config_path: nextState.configPath,
      profiles: nextState.profiles,
      active_profile: nextState.activeProfile,
      profiles_path: "",
      follow_config_profiles: true,
      kimi_code_environments: nextState.panelSettings.kimi_code_environments,
      active_kimi_code_environment_id: activeEnvironment.id,
      active_official_account_id: nextState.panelSettings.active_official_account_id ?? "",
    };
    await savePanelSettings(finalPanelSettings);
    currentAppState = {
      ...nextState,
      panelSettings: finalPanelSettings,
    };
    if (restartUsageWatcher) {
      stopUsageRuntime();
      await ensureUsageRuntime();
    }
    const normalizedState = normalizeStatePaths(currentAppState);
    return {
      ok: true,
      snapshot: await captureSnapshotForState(normalizedState),
      doctor: buildConfigDoctorReport(normalizedState),
    };
  },
  captureSnapshot: (state: AppState): Promise<FileSnapshotBundle> => captureSnapshotForState(state),
  runDoctor: async (state: AppState) => {
    // 读取并解析磁盘原始文档，供 buildConfigDoctorReport 做配置漂移（未知字段）探测。
    // 单文件解析失败不阻断体检——跳过该文件的漂移检测即可。
    const normalized = normalizeStatePaths(state);
    const disk = await readManagedDocuments({
      config: normalized.configPath,
      panel: normalized.panelSettingsPath,
      mcp: normalized.mcpConfigPath,
    });
    const safeToml = (text?: string): unknown => {
      if (!text) return undefined;
      try { return parseTomlString(text); } catch { return undefined; }
    };
    const safeJson = (text?: string): unknown => {
      if (!text) return undefined;
      try { return JSON.parse(text); } catch { return undefined; }
    };
    const rawDocs: Partial<Record<ManagedFileId, unknown>> = {
      config: safeToml(disk.config),
      panel: safeJson(disk.panel),
      mcp: safeJson(disk.mcp),
    };
    return buildConfigDoctorReport(state, rawDocs);
  },
  previewState: async (state: AppState): Promise<PreviewBundle> => {
    const normalized = normalizeStatePaths(state);
    const disk = await readManagedDocuments({
      config: normalized.configPath,
      panel: normalized.panelSettingsPath,
      mcp: normalized.mcpConfigPath,
    });
    return buildRedactedPreviewBundle(normalized, disk as never);
  },
  scanSkills: (state: AppState) => {
    const normalized = normalizeStatePaths(state);
    const activeEnvironmentId = normalized.panelSettings.active_kimi_code_environment_id ?? "default";
    const activeEnvironment = normalizeKimiCodeEnvironments(normalized.panelSettings.kimi_code_environments)
      .find((environment) => environment.id === activeEnvironmentId);
    return scanSkills(skillFileAccess, {
      mergeAllAvailableSkills: normalized.mainConfig.merge_all_available_skills,
      // 用户技能跟随 KIMI_CODE_HOME；项目技能按 GUI 启动 Kimi 时相同的 cwd 向上找最近 Git 根。
      envHome: activeEnvironment?.homePath ?? getKimiCodeEnvironmentHomePath(activeEnvironmentId),
      projectWorkingDirectory: activeEnvironment?.workingDirectory,
      pluginSkillRoots: normalized.pluginInventory?.skillRoots ?? [],
      // config.toml extra_skill_dirs 追加目录。
      extraSkillDirs: normalized.mainConfig.extra_skill_dirs ?? [],
    });
  },
  defaultSettings: (): Promise<PanelSettings> => Promise.resolve(createDefaultPanelSettings()),

  // ── dialog / shell ──
  pickFile: async (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: Array<string> }) => {
    // 从 renderer 打开仅用于"读取"；写路径一律走 Rust 组合命令（save_file_with_dialog 等）。
    const selected = await openDialog({ title: options?.title, multiple: false, filters: options?.filters, directory: options?.properties?.includes("openDirectory"), canCreateDirectories: options?.properties?.includes("createDirectory") });
    return typeof selected === "string" ? { canceled: false, filePath: selected } : { canceled: true };
  },
  saveFile: async (content: string, options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    // 对话框由 Rust 打开，并在同一命令内写入；renderer 无法把任意绝对路径当作"对话框授权"。
    const filePath = await invoke<string | null>("save_file_with_dialog", {
      content,
      defaultPath: options?.defaultPath ?? null,
    });
    return filePath == null ? { canceled: true } : { canceled: false, filePath };
  },
  readFile: async (filePath: string) => {
    const content = await tauriFileAccess.readText(filePath);
    return content === null ? { ok: false, error: "File not found." } : { ok: true, content };
  },
  // B1：Rust 仅从 Rust durable grant store 重建授权，不信任 SQLite/面板字符串。
  reconcileDurableGrants: () => invoke<void>("reconcile_durable_grants"),
  // B1：目录选择必须由 Rust 原生 dialog 完成，并在 Rust 侧登记 durable 写授权。
  // renderer 不得凭任意字符串（含 SQLite 里的 backup_local_path）扩大写授权。
  pickBackupDirectory: (title: string, defaultPath?: string) =>
    invoke<{ canceled: boolean; path?: string }>("pick_backup_directory", { title, defaultPath }),
  openExternal: async (url: string): Promise<{ ok: true }> => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
      throw new Error("Only HTTPS and mailto URLs can be opened.");
    }
    await openUrl(url);
    return { ok: true };
  },
  openKimiInTerminal: (request: PanelSettings | OpenKimiTerminalRequest) => openKimiInTerminal(request),
  saveProjectAdditionalDirs: async (additionalDirs: string[]) => {
    if (!currentAppState?.projectLocalConfig) {
      throw new Error("Set a project working directory before editing additional workspace directories.");
    }
    const config = currentAppState.projectLocalConfig;
    if (config.error) throw new Error(`Cannot update invalid project local config: ${config.error}`);
    const normalizedDirs = await resolveProjectAdditionalDirs(config.workingDirectory, additionalDirs);
    const parsed = config.document.trim()
      ? parseTomlString(config.document) as Record<string, unknown>
      : {};
    const workspace = parsed.workspace && typeof parsed.workspace === "object" && !Array.isArray(parsed.workspace)
      ? parsed.workspace as Record<string, unknown>
      : {};
    parsed.workspace = { ...workspace, additional_dir: normalizedDirs };
    const nextDocument = stringifyToml(parsed);
    // Rust 侧组合命令：仅允许写 <projectRoot>/.kimi-code/local.toml，路径在 Rust 端拼接。
    const sha256 = await invoke<string>("write_project_local_config", {
      projectRoot: config.projectRoot,
      content: nextDocument,
      expectedSha256: config.sha256,
    });
    currentAppState = {
      ...currentAppState,
      projectLocalConfig: {
        ...config,
        additionalDirs: normalizedDirs,
        document: nextDocument,
        sha256,
      },
    };
    return { ok: true as const };
  },

  // ── CLI / MCP / 连通性 ──
  getInstallSource: (): Promise<"homebrew" | "manual" | "development"> => Promise.resolve("manual"),
  getCliVersion: (options?: { checkLatest?: boolean; latestTimeoutMs?: number; target?: AppState["configTarget"] }) =>
    cli.getTargetCliVersion(options?.target ?? "kimi-code", {
      checkLatest: options?.checkLatest,
      latestTimeoutMs: options?.latestTimeoutMs,
    }),
  refreshKimiTargetDetection: () => refreshStartupKimiCodeDetection(true),
  runProvidersHealthCheck: (state: AppState) => cli.runProvidersHealthCheck(state),
  listProviderCatalog: (filter?: string, url?: string) =>
    cli.listKimiProviderCatalog(activeKimiCodeEnvironmentHome(), { filter, url }),
  getProviderCatalogModels: (providerId: string, url?: string) =>
    cli.getKimiProviderCatalogModels(activeKimiCodeEnvironmentHome(), providerId, { url }),
  importProviderCatalog: (options: {
    providerId: string;
    apiKey: string;
    defaultModel?: string;
    baseUrl?: string;
    url?: string;
  }) => cli.importKimiProviderCatalog(activeKimiCodeEnvironmentHome(), options),
  importProviderRegistry: (options: { url: string; apiKey: string }) =>
    cli.importKimiProviderRegistry(activeKimiCodeEnvironmentHome(), options),
  upgradeKimiCli: (target?: AppState["configTarget"], options?: { install?: boolean }) =>
    cli.upgradeTargetCli(target ?? "kimi-code", options),
  startKimiOAuthLogin: (target: AppState["configTarget"], onEvent?: (event: cli.KimiOAuthLoginEvent) => void, options?: { accountId?: string; activate?: boolean }) => {
    if (options?.accountId) requireDefaultEnvironmentForCredentialSlots();
    return cli.startKimiOAuthLogin(target ?? "kimi-code", onEvent, {
      ...options,
      homePath: activeKimiCodeEnvironmentHome(),
    });
  },
  startKimiCodeOAuthLogin: (onEvent?: (event: cli.KimiOAuthLoginEvent) => void) =>
    cli.startKimiOAuthLogin("kimi-code", onEvent, { homePath: activeKimiCodeEnvironmentHome() }),
  listOfficialAccounts: () => officialAccounts.listOfficialAccounts(),
  getOfficialAccountCredentialsStatus: () => officialAccounts.getOfficialAccountCredentialsStatus(),
  createOfficialAccount: (displayName: string) => officialAccounts.createOfficialAccount(displayName),
  renameOfficialAccount: (id: string, displayName: string) => officialAccounts.renameOfficialAccount(id, displayName),
  captureCurrentOfficialAccount: (displayName: string) => {
    requireDefaultEnvironmentForCredentialSlots();
    return officialAccounts.captureCurrentOfficialAccount(displayName);
  },
  activateOfficialAccount: async (id: string) => {
    requireDefaultEnvironmentForCredentialSlots();
    const result = await officialAccounts.activateOfficialAccount(id);
    currentAppState = currentAppState
      ? {
        ...currentAppState,
        panelSettings: {
          ...currentAppState.panelSettings,
          active_official_account_id: result.active_account_id,
        },
      }
      : currentAppState;
    return result;
  },
  deleteOfficialAccount: (id: string) => {
    requireDefaultEnvironmentForCredentialSlots();
    return officialAccounts.deleteOfficialAccount(id);
  },
  testMcpServer: (name: string) => {
    const server = currentAppState?.mcpConfig.mcpServers[name];
    if (!server) throw new Error(`MCP server not found: ${name}`);
    return cli.runKimiMcpServerTest(name, server);
  },
  listMcpServerTools: (name: string, server?: AppState["mcpConfig"]["mcpServers"][string]) => {
    const target = server ?? currentAppState?.mcpConfig.mcpServers[name];
    if (!target) throw new Error(`MCP server not found: ${name}`);
    return cli.listKimiMcpServerTools(name, target);
  },
  callMcpServerTool: (name: string, toolName: string, argsJson: string, server?: AppState["mcpConfig"]["mcpServers"][string]) => {
    const target = server ?? currentAppState?.mcpConfig.mcpServers[name];
    if (!target) throw new Error(`MCP server not found: ${name}`);
    return cli.callKimiMcpServerTool(name, target, toolName, argsJson);
  },
  authMcpServer: (name: string) => {
    if (!currentAppState) throw new Error("Kimi state is not loaded.");
    return openKimiMcpLoginInTerminal(name, currentAppState.panelSettings);
  },
  resetMcpServerAuth: (name: string) => {
    void name;
    throw new Error("Kimi Code does not expose MCP authorization reset commands in the current CLI.");
  },
  testProfileConnectivity: (state: AppState, profileName: string, modelName?: string) => {
    const draft = cloneState(state);
    applyProfile(draft, profileName);
    return cli.runKimiConnectivityTest(draft, modelName ?? draft.mainConfig.default_model);
  },
  testEndpointReachability: async (url: string): Promise<EndpointReachabilityResult> => {
    let endpoint: URL;
    try {
      endpoint = new URL(url.trim());
    } catch {
      return { ok: false, status: 0, message: "Invalid endpoint URL." };
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      return { ok: false, status: 0, message: "Endpoint URL must use http or https." };
    }
    try {
      const resp = await Promise.race([
        invoke<{ status: number; ok: boolean; body: string }>("http_request", {
          method: "GET",
          url: endpoint.toString(),
          headers: { Accept: "*/*", "User-Agent": "kimi-code-switch-gui" },
          body: null,
        }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("Endpoint health check timed out.")), 8000);
        }),
      ]);
      return {
        ok: resp.status === 200,
        status: resp.status,
        message: `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  // ── 更新 / changelog ──
  checkForUpdates: async () => {
    const currentVersion = await getVersion();
    const resp = await invoke<{ status: number; ok: boolean; body: string }>("http_request", {
      method: "GET",
      url: "https://api.github.com/repos/fx1226/kimi-code-switch-gui/releases/latest",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "kimi-code-switch-gui" },
      body: null,
    });
    const payload = resp.ok ? (JSON.parse(resp.body) as { tag_name?: string; name?: string; html_url?: string; body?: string; published_at?: string }) : {};
    const latestVersion = (payload.tag_name ?? "").replace(/^v/i, "");
    return {
      currentVersion,
      latestVersion,
      hasUpdate: latestVersion ? compareReleaseVersions(latestVersion, currentVersion) > 0 : false,
      releaseUrl: payload.html_url ?? "https://github.com/fx1226/kimi-code-switch-gui/releases",
      releaseName: payload.name ?? `v${latestVersion}`,
      releaseBody: payload.body ?? "",
      publishedAt: payload.published_at ?? "",
      homebrewCommand: "brew upgrade --cask kimi-code-switch-gui",
      installSource: "manual" as const,
    };
  },
  readChangelog: async (locale: string): Promise<string | null> => {
    const resp = await invoke<{ status: number; ok: boolean; body: string }>("http_request", {
      method: "GET",
      url: `https://raw.githubusercontent.com/fx1226/kimi-code-switch-gui/master/CHANGELOGS/${locale}.md`,
      headers: { "User-Agent": "kimi-code-switch-gui" },
      body: null,
    });
    return resp.ok ? resp.body : null;
  },

  // ── 托盘 ──
  setTray: async (enabled: boolean) => {
    if (currentAppState) {
      currentAppState = {
        ...currentAppState,
        panelSettings: { ...currentAppState.panelSettings, tray_icon: enabled },
      };
    }
    if (enabled) {
      await setupTray(() => currentAppState, () => window.dispatchEvent(new Event("kimi-tray-reload")));
    } else {
      await teardownTray();
    }
    return { ok: true as const };
  },
  refreshTrayMenu: async () => {
    if (currentAppState?.panelSettings.tray_icon) {
      await setupTray(() => currentAppState, () => window.dispatchEvent(new Event("kimi-tray-reload")));
    }
    return { ok: true as const };
  },

  // ── 使用统计 ──
  usageGetStatus: async () => {
    const stats = logWatcher?.getStats() ?? { sessionsTracked: 0, eventsIngested: 0 };
    return {
      ok: true as const,
      settings: extractInsightsSettings(currentAppState) as never,
      proxy: {
        status: logWatcher?.isRunning() ? "running" : "stopped",
        sessionsTracked: stats.sessionsTracked,
        eventsIngested: stats.eventsIngested,
      },
    };
  },
  usageIngestNow: async () => {
    await logWatcher?.ingestNow();
    return { ok: true as const };
  },
  usageEnable: async () => {
    await ensureUsageRuntime();
    if (currentAppState) {
      const panelSettings = { ...currentAppState.panelSettings, insights_status: "enabled" as const };
      currentAppState = { ...currentAppState, panelSettings };
      await savePanelSettings(panelSettings);
    }
    return { ok: true };
  },
  usageDisable: async () => {
    stopUsageRuntime();
    if (currentAppState) {
      const panelSettings = { ...currentAppState.panelSettings, insights_status: "disabled" as const };
      currentAppState = { ...currentAppState, panelSettings };
      await savePanelSettings(panelSettings);
    }
    return { ok: true as const };
  },
  usagePause: async () => {
    stopUsageRuntime();
    return { ok: true as const };
  },
  usageSetConfig: async (patch: Partial<PanelSettings>) => {
    if (currentAppState) {
      const safePatch = structuredClone(patch);
      const panelSettings = { ...currentAppState.panelSettings, ...safePatch };
      currentAppState = { ...currentAppState, panelSettings };
      await savePanelSettings(panelSettings);
    }
    return { ok: true as const, settings: extractInsightsSettings(currentAppState) as never };
  },
  usageQueryOverview: async (range: TimeRange) => {
    if (!usageOpen) return { ok: true as const, slice: { totalCalls: 0, totalTokens: 0, cacheHitRate: 0, reasoningTokens: 0, avgLatencyMs: 0, latencySamples: 0, errorRate: 0 } };
    return { ok: true as const, slice: await usageDb.queryOverview(range, activeKimiCodeEnvironmentId()) };
  },
  usageQueryTrend: async (args: { range: TimeRange; bucket: Bucket; groupBy: GroupBy | null }) => {
    if (!usageOpen) return { ok: true as const, series: [] };
    return { ok: true as const, series: await usageDb.queryTrend(args.range, args.bucket, args.groupBy, activeKimiCodeEnvironmentId()) };
  },
  usageQueryBreakdown: async (args: { dim: "profile" | "model"; range: TimeRange; limit: number; orderBy: usageDb.BreakdownOrder }) => {
    if (!usageOpen) return { ok: true as const, rows: [] };
    return { ok: true as const, rows: await usageDb.queryBreakdown(args.dim, args.range, args.limit, args.orderBy, activeKimiCodeEnvironmentId()) };
  },
  usageQuerySessions: async (args: { range: TimeRange; limit: number }) => {
    if (!usageOpen) return { ok: true as const, rows: [] };
    return { ok: true as const, rows: await usageDb.queryHeaviestSessions(args.range, args.limit, activeKimiCodeEnvironmentId()) };
  },
  usageQueryEvents: async (args: { filter: EventFilter; cursor: string | null; pageSize: number }) => {
    if (!usageOpen) return { ok: true as const, page: { rows: [], nextCursor: null } };
    return { ok: true as const, page: await usageDb.queryEvents(args.filter, args.cursor, args.pageSize, activeKimiCodeEnvironmentId()) };
  },
  usageQueryCost: async (range: TimeRange) => {
    const empty = { ok: true as const, total: null as number | null, byDay: {} as Record<string, number | null>, byModel: {} as Record<string, number | null> };
    if (!usageOpen) return empty;
    const models = currentAppState?.mainConfig.models ?? {};
    const environmentId = activeKimiCodeEnvironmentId();
    const [modelSums, modelDaySums] = await Promise.all([
      usageDb.queryModelTokenSums(range, "none", environmentId),
      usageDb.queryModelTokenSums(range, "day", environmentId),
    ]);
    const byModel = aggregateCost(modelSums, models, (r) => r.model);
    const byDay = aggregateCost(modelDaySums, models, (r) => String(r.bucketMs));
    const totalMap = aggregateCost(modelSums, models, () => "");
    return { ok: true as const, total: totalMap[""] ?? null, byDay, byModel };
  },
  usageQueryTokenTotals: async (range: TimeRange) => {
    if (!usageOpen) return { ok: true as const, totals: { promptTokens: 0, completionTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } };
    return { ok: true as const, totals: await usageDb.queryTokenTotals(range, activeKimiCodeEnvironmentId()) };
  },
  usageQueryTrendTokens: async (args: { range: TimeRange; granularity?: "hour" | "day" }) => {
    if (!usageOpen) return { ok: true as const, series: [] };
    const granularity = args.granularity ?? usageDb.resolveTrendGranularity(args.range);
    return { ok: true as const, series: await usageDb.queryTrendTokens(args.range, granularity, activeKimiCodeEnvironmentId()) };
  },
  usageQueryCostSeries: async (range: TimeRange) => {
    if (!usageOpen) return { ok: true as const, points: [], series: [] };
    const models = currentAppState?.mainConfig.models ?? {};
    const environmentId = activeKimiCodeEnvironmentId();
    const granularity = usageDb.resolveTrendGranularity(range);
    const rows = await usageDb.queryModelTokenSums(range, granularity, environmentId);
    const byBucket = aggregateCost(rows, models, (r) => String(r.bucketMs));
    const tokensByBucket = new Map<number, { prompt: number; completion: number; cacheCreation: number; cacheRead: number }>();
    for (const row of rows) {
      const bucket = tokensByBucket.get(row.bucketMs) ?? { prompt: 0, completion: 0, cacheCreation: 0, cacheRead: 0 };
      tokensByBucket.set(row.bucketMs, {
        prompt: bucket.prompt + row.prompt_tokens,
        completion: bucket.completion + row.completion_tokens,
        cacheCreation: bucket.cacheCreation + row.cache_creation_tokens,
        cacheRead: bucket.cacheRead + row.cache_read_tokens,
      });
    }
    const series = usageDb.fillTrendTokenBuckets(
      [...tokensByBucket.entries()].map(([bucket, tokens]) => ({ bucket, ...tokens })),
      range as never,
      granularity,
    );
    return {
      ok: true as const,
      points: Object.entries(byBucket).map(([bucket, cost]) => ({ bucket: Number(bucket), cost })),
      series,
    };
  },
  usageGetStorageInfo: async () => {
    const dbStat = await invoke<{ size: number } | null>("file_stat", { path: USAGE_DB_PATH });
    const sqliteBytes = dbStat?.size ?? 0;
    const warnMb = currentAppState?.panelSettings.insights_disk_warn_threshold_mb ?? 100;
    return {
      ok: true as const,
      info: { sqliteBytes, jsonlBytes: 0, totalBytes: sqliteBytes, warnThresholdMb: warnMb, exceedsWarn: sqliteBytes > warnMb * 1024 * 1024 },
    };
  },
  usageCleanup: async (retentionDays: number) => {
    if (!usageOpen) return { ok: true as const, eventsDeleted: 0, jsonlFilesDeleted: 0 };
    const eventsDeleted = await usageDb.pruneOldEvents(Math.max(1, Math.floor(retentionDays)));
    return { ok: true as const, eventsDeleted, jsonlFilesDeleted: 0 };
  },
  usageResetAllData: async () => {
    if (usageOpen) await usageDb.purgeAll();
    return { ok: true as const };
  },
  usageOpenSessionTerminal: async (sessionId: string) => {
    const app = currentAppState?.panelSettings.terminal_app ?? "system-terminal";
    await openSessionTerminal(sessionId, app, activeKimiCodeEnvironmentHome());
    return { ok: true as const };
  },

  // ── backup ──
  runBackup: (state: AppState, trigger?: string) => backup.runBackup(state, trigger),
  listBackups: (state: AppState) => backup.listBackups(state),
  deleteBackup: (state: AppState, backupName: string) => backup.deleteBackup(state, backupName),
  restoreBackup: (state: AppState, backupName: string) => backup.restoreBackup(state, backupName),
  restoreBackupSafe: (state: AppState, backupName: string, options?: { expectedSnapshot?: FileSnapshotBundle; allowOverwrite?: boolean; allowRisk?: boolean }) => backup.restoreBackupSafe(state, backupName, options),
  restoreBackupDryRun: (state: AppState, backupName: string, options?: { expectedSnapshot?: FileSnapshotBundle }) => backup.restoreBackupDryRun(state, backupName, options),
  testBackupWebdav: (state: AppState) => backup.testBackupWebdav(state),
  migrateLegacyWebDavBackup: (state: AppState, backupName: string, legacyEncryptionPassword?: string) =>
    backup.migrateLegacyWebDavBackup(state, backupName, legacyEncryptionPassword),
  exportBackupEncryptionKey: async () => {
    const secret = await invoke<string>("get_or_create_backup_encryption_secret");
    const filePath = await invoke<string | null>("save_file_with_dialog", {
      content: `${secret}\n`,
      defaultPath: "kimi-backup-recovery-key.txt",
    });
    return filePath == null ? { canceled: true as const } : { canceled: false as const, filePath };
  },
  importBackupEncryptionKey: async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Recovery key", extensions: ["txt", "key"] }],
    });
    if (typeof selected !== "string") return { canceled: true as const };
    const secret = await tauriFileAccess.readText(selected);
    if (secret === null) throw new Error("Backup recovery key file could not be read.");
    const keyPath = await invoke<string>("import_backup_encryption_secret", { secret, replace: true });
    return { canceled: false as const, filePath: selected, keyPath };
  },

  // ── 全量导出/导入（所有环境的 Provider/Model/MCP/Profile + 全局面板设置）──
  exportFullBackup: async (state: AppState): Promise<FullBackupBundle> => {
    const standardEntries = await Promise.all(
      normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments).map(async (environment) => {
        const configPath = getKimiCodeConfigPath(environment.homePath);
        const mcpPath = getKimiCodeMcpConfigPath(environment.homePath);
        const [configDocument, mcpDocument, tuiDocument, agentsDocument, skillsDirectory, pluginsDirectory] = await Promise.all([
          tauriFileAccess.readText(configPath),
          tauriFileAccess.readText(mcpPath),
          tauriFileAccess.readText(`${environment.homePath}/tui.toml`),
          tauriFileAccess.readText(`${environment.homePath}/AGENTS.md`),
          invoke<PortableDirectoryBundle>("export_portable_directory", { path: `${environment.homePath}/skills` }),
          invoke<PortableDirectoryBundle>("export_portable_directory", { path: `${environment.homePath}/plugins` }),
        ]);
        try {
          return [environment.id, {
            mainConfig: parseMainConfigDocument(configDocument),
            mcpServers: parseMcpConfig(mcpDocument, { sourcePath: mcpPath }).mcpServers,
            tuiDocument: tuiDocument ?? undefined,
            agentsDocument: agentsDocument ?? undefined,
            skillsDirectory,
            pluginsDirectory,
          }] as const;
        } catch (error) {
          throw new Error(`Cannot export environment ${environment.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    return buildFullBackup(state, Object.fromEntries(standardEntries));
  },
  importFullBackup: async (bundle: FullBackupBundle): Promise<AppState> => {
    const rebuiltPanelSettings = rebuildPanelSettingsFromBackup(bundle);
    const previousPanelSettings = currentAppState?.panelSettings ?? await getPanelSettings();
    rebuiltPanelSettings.backup_webdav_password = previousPanelSettings?.backup_webdav_password ?? "";
    const restoredEnvironments = normalizeKimiCodeEnvironments(rebuiltPanelSettings.kimi_code_environments);
    const originalDocuments = await Promise.all(restoredEnvironments.flatMap((environment) => [
      getKimiCodeConfigPath(environment.homePath),
      getKimiCodeMcpConfigPath(environment.homePath),
      `${environment.homePath}/tui.toml`,
      `${environment.homePath}/AGENTS.md`,
    ]).map(async (path) => {
      const content = await tauriFileAccess.readText(path);
      return { path, content, expectedHash: await sha256Text(content), writtenHash: undefined as string | undefined };
    }));
    const originalDocumentByPath = new Map(originalDocuments.map((document) => [document.path, document]));
    const writeImportedDocument = async (path: string, content: string): Promise<void> => {
      const original = originalDocumentByPath.get(path);
      if (!original) throw new Error(`Missing import baseline for ${path}`);
      original.writtenHash = await tauriFileAccess.writeTextCas!(path, content, original.expectedHash);
    };
    const originalSkillsDirectories = await Promise.all(restoredEnvironments.map(async (environment) => ({
      path: `${environment.homePath}/skills`,
      bundle: await invoke<PortableDirectoryBundle>("export_portable_directory", { path: `${environment.homePath}/skills` }),
      writtenHash: undefined as string | undefined,
    })));
    const originalSkillsByPath = new Map(originalSkillsDirectories.map((directory) => [directory.path, directory]));
    const originalPluginDirectories = await Promise.all(restoredEnvironments.map(async (environment) => ({
      path: `${environment.homePath}/plugins`,
      bundle: await invoke<PortableDirectoryBundle>("export_portable_directory", { path: `${environment.homePath}/plugins` }),
      writtenHash: undefined as string | undefined,
    })));
    const originalPluginsByPath = new Map(originalPluginDirectories.map((directory) => [directory.path, directory]));
    try {
      for (const environmentBundle of bundle.environments) {
        const environment = restoredEnvironments.find((candidate) => candidate.id === environmentBundle.environment.id);
        if (!environment) continue;
        const fallbackConfig = parseMainConfigDocument(null);
        const mainConfig = environmentBundle.mainConfig
          ? structuredClone(environmentBundle.mainConfig)
          : {
              ...fallbackConfig,
              default_model: environmentBundle.profiles[environmentBundle.activeProfile]?.default_model
                ?? Object.keys(environmentBundle.models)[0]
                ?? "",
              providers: structuredClone(environmentBundle.providers),
              models: structuredClone(environmentBundle.models),
            };
        mainConfig.providers = structuredClone(environmentBundle.providers);
        mainConfig.models = structuredClone(environmentBundle.models);
        const stateForDocument = { ...(currentAppState ?? await loadAppState(tauriFileAccess)), mainConfig } as AppState;
        await tauriFileAccess.ensureDir(environment.homePath);
        // Keep writes sequential: Promise.all rejection does not cancel sibling
        // writes and can otherwise race with the rollback below.
        await writeImportedDocument(
          getKimiCodeConfigPath(environment.homePath),
          buildConfigDocument(stateForDocument),
        );
        await writeImportedDocument(
          getKimiCodeMcpConfigPath(environment.homePath),
          buildMcpConfigDocument({ mcpServers: environmentBundle.mcpServers }),
        );
        if (environmentBundle.tuiDocument !== undefined) {
          await writeImportedDocument(`${environment.homePath}/tui.toml`, environmentBundle.tuiDocument);
        }
        if (environmentBundle.agentsDocument !== undefined) {
          await writeImportedDocument(`${environment.homePath}/AGENTS.md`, environmentBundle.agentsDocument);
        }
        if (environmentBundle.skillsDirectory !== undefined) {
          const path = `${environment.homePath}/skills`;
          const original = originalSkillsByPath.get(path);
          if (!original?.bundle.sha256) throw new Error(`Missing Skills import baseline for ${path}`);
          original.writtenHash = await invoke<string>("replace_portable_directory", {
            path,
            bundle: environmentBundle.skillsDirectory,
            expectedSha256: original.bundle.sha256,
          });
        }
        if (environmentBundle.pluginsDirectory !== undefined) {
          const path = `${environment.homePath}/plugins`;
          const original = originalPluginsByPath.get(path);
          if (!original?.bundle.sha256) throw new Error(`Missing Plugins import baseline for ${path}`);
          const resolvedTargetHome = await invoke<string>("resolve_home_path", { path: environment.homePath });
          const remapped = remapPluginDirectoryForRestore(
            environmentBundle.pluginsDirectory,
            environmentBundle.environment.homePath,
            resolvedTargetHome,
          );
          original.writtenHash = await invoke<string>("replace_portable_directory", {
            path,
            bundle: remapped,
            expectedSha256: original.bundle.sha256,
          });
        }
      }
      await savePanelSettings(rebuiltPanelSettings);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const original of originalDocuments.reverse()) {
        if (original.writtenHash === undefined) continue;
        try {
          if (original.content === null) {
            await tauriFileAccess.removeTextCas!(original.path, original.writtenHash);
          } else {
            await tauriFileAccess.writeTextCas!(original.path, original.content, original.writtenHash);
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${original.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      for (const original of originalSkillsDirectories.reverse()) {
        if (original.writtenHash === undefined) continue;
        try {
          await invoke("replace_portable_directory", {
            path: original.path,
            bundle: original.bundle,
            expectedSha256: original.writtenHash,
          });
        } catch (rollbackError) {
          rollbackErrors.push(`${original.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      for (const original of originalPluginDirectories.reverse()) {
        if (original.writtenHash === undefined) continue;
        try {
          await invoke("replace_portable_directory", {
            path: original.path,
            bundle: original.bundle,
            expectedSha256: original.writtenHash,
          });
        } catch (rollbackError) {
          rollbackErrors.push(`${original.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (previousPanelSettings) {
        try {
          await savePanelSettings(previousPanelSettings);
        } catch (rollbackError) {
          rollbackErrors.push(`panel settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(rollbackErrors.length > 0
        ? `${message} (rollback incomplete: ${rollbackErrors.join("; ")})`
        : message);
    }
    const reloaded = await loadAppState(tauriFileAccess);
    currentAppState = structuredClone(reloaded);
    return reloaded;
  },

  void: () => { void USAGE_JSONL_DIR; void notImplemented; },
};

export function installKimiSwitchTauri(): void {
  window.kimiSwitch = kimiSwitchTauri;

  // 监听窗口关闭事件：根据 close_behavior 决定是隐藏到托盘还是退出
  const mainWindow = getCurrentWindow();
  let allowConfirmedClose = false;
  void mainWindow.onCloseRequested(async (event) => {
    if (allowConfirmedClose) return;
    // 读取当前设置
    const closeBehavior = currentAppState?.panelSettings.close_behavior ?? "quit";
    const trayEnabled = currentAppState?.panelSettings.tray_icon ?? false;

    // 如果设置为隐藏到托盘且托盘已启用，则隐藏窗口而不是退出
    if (closeBehavior === "keep-in-tray" && trayEnabled) {
      event.preventDefault();
      await mainWindow.hide();

      // 隐藏到托盘时自动隐藏 Dock 图标
      await invoke("set_dock_icon_visibility", { visible: false }).catch((err) => {
        console.error("Failed to hide dock icon:", err);
      });
      return;
    }

    // 真正退出前交给 renderer 的未保存守卫处理；取消时保持窗口打开。
    event.preventDefault();
    const shouldClose = await new Promise<boolean>((resolve) => {
      let settled = false;
      let handled = false;
      const finish = (allow: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(allow);
      };
      window.dispatchEvent(new CustomEvent("kimi-before-close", {
        detail: {
          acknowledge: () => { handled = true; },
          resolve: finish,
        },
      }));
      window.setTimeout(() => {
        if (!handled) finish(true);
      }, 0);
    });
    if (shouldClose) {
      allowConfirmedClose = true;
      await mainWindow.close();
    }
  });

  // 监听窗口显示事件：恢复 Dock 图标
  void mainWindow.listen("tauri://show", async () => {
    const closeBehavior = currentAppState?.panelSettings.close_behavior ?? "quit";
    const trayEnabled = currentAppState?.panelSettings.tray_icon ?? false;

    // 如果是托盘模式，恢复 Dock 图标
    if (closeBehavior === "keep-in-tray" && trayEnabled) {
      await invoke("set_dock_icon_visibility", { visible: true }).catch((err) => {
        console.error("Failed to show dock icon:", err);
      });
    }
  });

  void syncWindowToggleShortcut();
}

function syncWindowToggleShortcut(): Promise<void> {
  shortcutSyncTask = shortcutSyncTask
    .catch(() => undefined)
    .then(() => syncWindowToggleShortcutOnce());
  return shortcutSyncTask;
}

async function syncWindowToggleShortcutOnce(): Promise<void> {
  if (!currentAppState) {
    return;
  }

  const windowToggle = currentAppState.panelSettings.shortcuts["window.toggle"];
  const accelerator = windowToggle?.enabled && windowToggle.scope === "global"
    ? windowToggle.accelerator.trim() || null
    : null;

  await invoke("sync_window_toggle_shortcut", {
    accelerator,
    closeBehavior: currentAppState.panelSettings.close_behavior,
    trayEnabled: currentAppState.panelSettings.tray_icon,
  }).catch((err) => {
    console.error("[Global Shortcut] sync failed:", err);
  });
}
