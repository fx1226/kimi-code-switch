// Tauri 版 FileAccess：把 shared/configStore 的 FileAccess 接口接到 Rust 后端原子命令。
// 运行在 renderer 进程，通过 Tauri command 调用 Rust 原子能力。
import { invoke } from "@tauri-apps/api/core";

import type { FileAccess, NativeHomeSymlinkRepairResult, SaveTransactionRecord } from "@shared/configStore";
import type { PanelSettings } from "@shared/types";
import { sanitizeConfigForEnvironmentClone, sanitizeMcpForEnvironmentClone } from "@shared/environmentClone";
import { remapInstalledPluginRoots } from "@shared/pluginStore";
import { getPanelSettings, importPanelSettings, savePanelSettings } from "./panelSettingsStore";

export const SAVE_TRANSACTION_PATH = "~/.kimi-code-switch-gui/pending-save-transaction.json";
let activeSaveTransactionHash: string | null = null;

export const tauriFileAccess: FileAccess = {
  async readText(path: string): Promise<string | null> {
    return invoke<string | null>("read_text", { path });
  },
  async writeText(path: string, content: string): Promise<void> {
    await invoke("write_text", { path, content });
  },
  async writeTextCas(path: string, content: string, expectedSha256: string): Promise<string> {
    return invoke<string>("write_text_cas", { path, content, expectedSha256 });
  },
  async removeTextCas(path: string, expectedSha256: string): Promise<void> {
    await invoke("remove_file_cas", { path, expectedSha256 });
  },
  async beginSaveTransaction(record: SaveTransactionRecord): Promise<void> {
    activeSaveTransactionHash = await invoke<string>("write_text_cas", {
      path: SAVE_TRANSACTION_PATH,
      content: JSON.stringify(record),
      expectedSha256: "",
    });
  },
  async completeSaveTransaction(): Promise<void> {
    if (activeSaveTransactionHash) {
      await invoke("remove_file_cas", {
        path: SAVE_TRANSACTION_PATH,
        expectedSha256: activeSaveTransactionHash,
      });
    } else {
      await invoke("remove_file", { path: SAVE_TRANSACTION_PATH });
    }
    activeSaveTransactionHash = null;
  },
  async ensureDir(path: string): Promise<void> {
    await invoke("ensure_dir", { path });
  },
  async mergeDirectoryMissing(from: string, to: string) {
    return mergeDirectoryMissing(from, to);
  },
  async repairNativeHomeSymlink(): Promise<NativeHomeSymlinkRepairResult> {
    return invoke<NativeHomeSymlinkRepairResult>("repair_native_home_symlink");
  },
  async readPanelSettings(_path: string): Promise<PanelSettings | null> {
    // 忽略 path 参数，直接从 SQLite 读取（单行存储）
    return getPanelSettings();
  },
  async writePanelSettings(_path: string, settings: PanelSettings): Promise<void> {
    // 忽略 path 参数，直接写入 SQLite
    await savePanelSettings(settings);
  },
};

export function isSaveTransactionRecord(value: unknown): value is SaveTransactionRecord {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { version?: unknown }).version === 1
    && (value as { kind?: unknown }).kind === "save-app-state"
    && Array.isArray((value as { textFiles?: unknown }).textFiles),
  );
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** C3：统一的恢复事务记录 —— 覆盖 full backup / regular restore / history restore 的文件与 SQLite 资源。 */
export interface RestoreTransactionRecord {
  version: 1;
  kind: "restore-app-state";
  createdAt: string;
  textFiles: Array<{ path: string; originalContent: string | null; desiredContent: string }>;
  panelOriginal: string | null;
  panelDesired: string | null;
}

export const RESTORE_TRANSACTION_PATH = "~/.kimi-code-switch-gui/pending-restore-transaction.json";
let activeRestoreTransactionHash: string | null = null;

function isRestoreTransactionRecord(value: unknown): value is RestoreTransactionRecord {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { version?: unknown }).version === 1
    && (value as { kind?: unknown }).kind === "restore-app-state"
    && Array.isArray((value as { textFiles?: unknown }).textFiles),
  );
}

/** 两阶段 restore 的第一步：把 plan 落盘为 journal（prepare）。崩溃后可重放。 */
export async function beginRestoreTransaction(record: RestoreTransactionRecord): Promise<void> {
  activeRestoreTransactionHash = await invoke<string>("write_text_cas", {
    path: RESTORE_TRANSACTION_PATH,
    content: JSON.stringify(record),
    expectedSha256: "",
  });
}

/** 两阶段 restore 的第三步：全部资源已 applied 后清除 journal（commit）。 */
export async function completeRestoreTransaction(): Promise<void> {
  if (activeRestoreTransactionHash) {
    await invoke("remove_file_cas", {
      path: RESTORE_TRANSACTION_PATH,
      expectedSha256: activeRestoreTransactionHash,
    });
  } else {
    await removeFile(RESTORE_TRANSACTION_PATH);
  }
  activeRestoreTransactionHash = null;
}

/**
 * C3：启动时恢复被中断的 restore。逐资源分类 original/desired/unknown/missing：
 * - mixed 且无 unknown：按 journal 规则完成（未写入的补 desired）或回滚（覆盖的还原 original）。
 * - 任一 unknown：停止自动写，返回 unknown 交给 C2 人工恢复 UI。
 */
export async function recoverPendingRestoreTransaction(): Promise<{
  recovered: boolean;
  action: "none" | "commit" | "rollback" | "quarantined" | "unknown";
  reason?: "malformed" | "unsupported";
  quarantinedPath?: string;
  journal?: unknown;
}> {
  const document = await tauriFileAccess.readText(RESTORE_TRANSACTION_PATH);
  if (document === null) return { recovered: false, action: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    const quarantinedPath = await invoke<string>("quarantine_journal", { path: RESTORE_TRANSACTION_PATH });
    return { recovered: false, action: "quarantined", reason: "malformed", quarantinedPath };
  }
  if (!isRestoreTransactionRecord(parsed)) {
    const quarantinedPath = await invoke<string>("quarantine_journal", { path: RESTORE_TRANSACTION_PATH });
    return { recovered: false, action: "quarantined", reason: "unsupported", quarantinedPath };
  }

  const changedTextFiles = parsed.textFiles.filter((file) => file.originalContent !== file.desiredContent);
  const textStatuses = await Promise.all(changedTextFiles.map(async (file) => {
    const current = await tauriFileAccess.readText(file.path);
    if (current === file.originalContent) return { file, status: "original" as const };
    if (current === file.desiredContent) return { file, status: "desired" as const };
    return { file, status: "unknown" as const };
  }));

  const panelChanged = parsed.panelDesired !== null
    && stableJson(parsed.panelOriginal) !== stableJson(parsed.panelDesired);
  const currentPanel = panelChanged ? await getPanelSettings() : null;
  const panelStatus = !panelChanged
    ? null
    : stableJson(currentPanel) === stableJson(parsed.panelOriginal)
      ? "original" as const
      : stableJson(currentPanel) === stableJson(parsed.panelDesired)
        ? "desired" as const
        : "unknown" as const;
  const statuses = [
    ...textStatuses.map((entry) => entry.status),
    ...(panelStatus ? [panelStatus] : []),
  ];
  if (statuses.includes("unknown")) {
    return { recovered: false, action: "unknown", journal: parsed };
  }
  if (statuses.length === 0 || statuses.every((status) => status === "original")) {
    await removeFile(RESTORE_TRANSACTION_PATH);
    return { recovered: true, action: "rollback" };
  }
  if (statuses.every((status) => status === "desired")) {
    await removeFile(RESTORE_TRANSACTION_PATH);
    return { recovered: true, action: "commit" };
  }

  // mixed：应用于"部分 applied、部分 original"的情况——补全 desired。
  const rollbackErrors: string[] = [];
  if (panelStatus === "original" && parsed.panelDesired !== null) {
    try {
      if (!await importPanelSettings(parsed.panelDesired)) {
        rollbackErrors.push("panel: restore commit returned false");
      }
    } catch (error) {
      rollbackErrors.push(`panel: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const { file, status } of textStatuses) {
    if (status !== "original") continue;
    try {
      const expectedSha256 = await sha256Hex(file.originalContent ?? "");
      await tauriFileAccess.writeTextCas!(file.path, file.desiredContent, expectedSha256);
    } catch (error) {
      rollbackErrors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rollbackErrors.length > 0) {
    return { recovered: false, action: "unknown", journal: parsed };
  }
  await removeFile(RESTORE_TRANSACTION_PATH);
  return { recovered: true, action: "commit" };
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Recover a crash-interrupted logical save without overwriting unknown external revisions. */
export async function recoverPendingSaveTransaction(): Promise<{
  recovered: boolean;
  action: "none" | "commit" | "rollback" | "quarantined" | "unknown";
  reason?: "malformed" | "unsupported";
  quarantinedPath?: string;
  journal?: unknown;
}> {
  const document = await tauriFileAccess.readText(SAVE_TRANSACTION_PATH);
  if (document === null) return { recovered: false, action: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    // C2：损坏 journal 不再阻塞启动——原子移动到 quarantine，返回可恢复状态。
    const quarantinedPath = await invoke<string>("quarantine_journal", { path: SAVE_TRANSACTION_PATH });
    return { recovered: false, action: "quarantined", reason: "malformed", quarantinedPath };
  }
  if (!isSaveTransactionRecord(parsed)) {
    const quarantinedPath = await invoke<string>("quarantine_journal", { path: SAVE_TRANSACTION_PATH });
    return { recovered: false, action: "quarantined", reason: "unsupported", quarantinedPath };
  }

  const changedTextFiles = parsed.textFiles.filter((file) => file.originalContent !== file.desiredContent);
  const textStatuses = await Promise.all(changedTextFiles.map(async (file) => {
    const current = await tauriFileAccess.readText(file.path);
    if (current === file.originalContent) return { file, status: "original" as const };
    if (current === file.desiredContent) return { file, status: "desired" as const };
    return { file, status: "unknown" as const };
  }));

  const panelChanged = parsed.panelDesired !== undefined
    && stableJson(parsed.panelOriginal) !== stableJson(parsed.panelDesired);
  const currentPanel = panelChanged ? await getPanelSettings() : null;
  const panelStatus = !panelChanged
    ? null
    : stableJson(currentPanel) === stableJson(parsed.panelOriginal)
      ? "original" as const
      : stableJson(currentPanel) === stableJson(parsed.panelDesired)
        ? "desired" as const
        : "unknown" as const;
  const statuses = [
    ...textStatuses.map((entry) => entry.status),
    ...(panelStatus ? [panelStatus] : []),
  ];
  if (statuses.includes("unknown")) {
    // C2：unknown 进入只读恢复模式，不自动覆盖任何文件；留给 UI 人工决策。
    return { recovered: false, action: "unknown", journal: parsed };
  }
  if (statuses.length === 0 || statuses.every((status) => status === "original")) {
    await removeFile(SAVE_TRANSACTION_PATH);
    return { recovered: true, action: "rollback" };
  }
  if (statuses.every((status) => status === "desired")) {
    await removeFile(SAVE_TRANSACTION_PATH);
    return { recovered: true, action: "commit" };
  }

  const rollbackErrors: string[] = [];
  if (panelStatus === "desired") {
    if (parsed.panelOriginal) {
      try {
        await savePanelSettings(parsed.panelOriginal);
      } catch (error) {
        rollbackErrors.push(`panel: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      rollbackErrors.push("panel: original row was absent and cannot be removed automatically");
    }
  }
  for (const { file, status } of textStatuses.reverse()) {
    if (status !== "desired") continue;
    try {
      const expectedSha256 = await sha256Hex(file.desiredContent);
      if (file.originalContent === null) {
        await tauriFileAccess.removeTextCas!(file.path, expectedSha256);
      } else {
        await tauriFileAccess.writeTextCas!(file.path, file.originalContent, expectedSha256);
      }
    } catch (error) {
      rollbackErrors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new Error(`Pending save rollback incomplete: ${rollbackErrors.join("; ")}`);
  }
  await removeFile(SAVE_TRANSACTION_PATH);
  return { recovered: true, action: "rollback" };
}

export async function removeFile(path: string): Promise<void> {
  await invoke("remove_file", { path });
}

export async function moveFile(from: string, to: string): Promise<void> {
  await invoke("move_file", { from, to });
}

export async function removeDir(path: string): Promise<void> {
  await invoke("remove_dir", { path });
}

export async function copyDir(from: string, to: string): Promise<void> {
  await invoke("copy_dir", { from, to });
}

/** Copy a legacy directory into a native home without replacing native entries. */
export async function mergeDirectoryMissing(
  from: string,
  to: string,
): Promise<{ sourceExists: boolean; copiedEntries: number; skippedConflicts: number }> {
  return invoke("merge_directory_missing", { from, to });
}

/**
 * Copy only portable Kimi configuration into a new environment. Static model
 * credentials and MCP secrets are stripped; runtime identity/state directories
 * are excluded.
 */
export async function copyKimiCodeConfiguration(fromHome: string, toHome: string): Promise<void> {
  await assertKimiCodeHomeEmpty(toHome);
  await tauriFileAccess.ensureDir(toHome);
  for (const name of ["config.toml", "mcp.json", "tui.toml", "AGENTS.md"]) {
    const content = await tauriFileAccess.readText(`${fromHome}/${name}`);
    if (content !== null) {
      const sanitized = name === "config.toml"
        ? sanitizeConfigForEnvironmentClone(content)
        : name === "mcp.json"
          ? sanitizeMcpForEnvironmentClone(content)
          : content;
      await tauriFileAccess.writeText(`${toHome}/${name}`, sanitized);
    }
  }
  const sourceSkills = `${fromHome}/skills`;
  if (await pathExists(sourceSkills)) {
    await copyDir(sourceSkills, `${toHome}/skills`);
  }
  const sourcePlugins = `${fromHome}/plugins`;
  if (await pathExists(sourcePlugins)) {
    const targetPlugins = `${toHome}/plugins`;
    await copyDir(sourcePlugins, targetPlugins);
    const installedPath = `${targetPlugins}/installed.json`;
    const installed = await tauriFileAccess.readText(installedPath);
    if (installed !== null) {
      const resolvedTargetHome = await invoke<string>("resolve_home_path", { path: toHome });
      await tauriFileAccess.writeText(
        installedPath,
        remapInstalledPluginRoots(installed, fromHome, resolvedTargetHome),
      );
    }
  }
}

/** Prevent a newly registered managed environment from inheriting orphaned runtime state. */
export async function assertKimiCodeHomeEmpty(homePath: string): Promise<void> {
  if (await pathExists(homePath)) {
    const existingEntries = await listDir(homePath);
    if (existingEntries.length > 0) {
      throw new Error(`Target KIMI_CODE_HOME is not empty: ${homePath}`);
    }
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

export async function listDir(path: string): Promise<string[]> {
  return invoke<string[]>("list_dir", { path });
}
