// 文件指纹/快照（前端版，移植自 main/modules/fileSnapshots.ts）。
// sha256 用 Web Crypto；stat 用 Rust file_stat；读取用 fileAccess。
//
// 并发模型（optimistic revision guard，非 OS 级 CAS）：
// - `write_text_cas`/`remove_file_cas` 在写/删前比较 sha256 与期望值，写后再复核；
//   这显著缩小「读-比-写」窗口，但不是原子 compare-and-swap。
// - 外部进程在最终检查与 rename/写入之间的极小窗口内仍可修改文件；此竞态无法仅靠
//   单文件 CAS 消除（官方 CLI 不遵循本应用的 advisory lock）。
// - 用户恢复路径：saveStateSafe 检测到 external-change 后返回 `external-change` 冲突，
//   UI 展示当前盘上内容与预览 diff；用户确认「强制覆盖」才允许覆盖，或取消保留本地修改。
// - 崩溃一致性：跨文件保存先写 journal（C1/C3），启动时仅在 revision 可证明时提交或
//   回滚；未知 revision 进入 C2 只读恢复模式，绝不静默覆盖。
import { invoke } from "@tauri-apps/api/core";

import { buildPanelSettingsDocument, createLineDiff, normalizeStatePaths } from "@shared/configStore";
import { redactDocumentText } from "@shared/configSafety";
import type {
  AppState,
  ExternalChangeConflict,
  ExternalChangeDetail,
  FileFingerprint,
  FileSnapshotBundle,
  ManagedFileId,
} from "@shared/types";

import { tauriFileAccess } from "./fileAccess";
import { getPanelSettings } from "./panelSettingsStore";

interface FileStat {
  size: number;
  mtime_ms: number;
  ino: number;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function resolveManagedPaths(state: AppState): Record<ManagedFileId, string> {
  const s = normalizeStatePaths(state);
  return { config: s.configPath, panel: s.panelSettingsPath, mcp: s.mcpConfigPath };
}

async function readManagedDocument(id: ManagedFileId, path: string): Promise<string | null> {
  if (id === "panel") {
    const settings = await getPanelSettings();
    return settings ? buildPanelSettingsDocument(settings) : null;
  }
  return tauriFileAccess.readText(path);
}

export async function fingerprintFile(id: ManagedFileId, path: string): Promise<FileFingerprint> {
  if (id === "panel") {
    const content = await readManagedDocument(id, path);
    if (content === null) {
      return { id, path, exists: false, size: 0, mtimeMs: 0, sha256: "" };
    }
    return { id, path, exists: true, size: content.length, mtimeMs: 0, sha256: await sha256Hex(content) };
  }

  const stat = await invoke<FileStat | null>("file_stat", { path });
  if (!stat) {
    return { id, path, exists: false, size: 0, mtimeMs: 0, sha256: "" };
  }
  const content = (await readManagedDocument(id, path)) ?? "";
  return { id, path, exists: true, size: stat.size, mtimeMs: stat.mtime_ms, sha256: await sha256Hex(content) };
}

export async function captureSnapshotForPaths(paths: Record<ManagedFileId, string>): Promise<FileSnapshotBundle> {
  const files = await Promise.all(
    (Object.entries(paths) as Array<[ManagedFileId, string]>).map(async ([id, path]) => [id, await fingerprintFile(id, path)] as const),
  );
  return {
    capturedAt: new Date().toISOString(),
    files: Object.fromEntries(files) as Record<ManagedFileId, FileFingerprint>,
  };
}

export async function captureSnapshotForState(state: AppState): Promise<FileSnapshotBundle> {
  return captureSnapshotForPaths(resolveManagedPaths(state));
}

export async function readManagedDocuments(paths: Record<ManagedFileId, string>): Promise<Partial<Record<ManagedFileId, string>>> {
  const entries = await Promise.all(
    (Object.entries(paths) as Array<[ManagedFileId, string]>).map(async ([id, path]) => [id, await readManagedDocument(id, path)] as const),
  );
  return Object.fromEntries(entries) as Partial<Record<ManagedFileId, string>>;
}

export function detectChangeReason(expected: FileFingerprint, actual: FileFingerprint): ExternalChangeDetail["reason"] | null {
  if (!expected.exists && actual.exists) return "created";
  if (expected.exists && !actual.exists) return "deleted";
  if (expected.exists && actual.exists && expected.sha256 !== actual.sha256) return "modified";
  return null;
}

export async function detectExternalChangeConflict(options: {
  expectedSnapshot?: FileSnapshotBundle;
  targetPaths: Record<ManagedFileId, string>;
  draftDocuments: Record<ManagedFileId, string>;
}): Promise<{ snapshot: FileSnapshotBundle; conflict: ExternalChangeConflict | null }> {
  const snapshot = await captureSnapshotForPaths(options.targetPaths);
  if (!options.expectedSnapshot) return { snapshot, conflict: null };

  const changedFiles: ExternalChangeDetail[] = [];
  for (const id of Object.keys(options.targetPaths) as ManagedFileId[]) {
    const expected = options.expectedSnapshot.files[id];
    const actual = snapshot.files[id];
    if (!expected || expected.path !== actual.path) continue;
    const reason = detectChangeReason(expected, actual);
    if (!reason) continue;
    const diskDocument = actual.exists ? (await readManagedDocument(id, actual.path)) ?? "" : "";
    const draftDocument = options.draftDocuments[id] ?? "";
    if (diskDocument === draftDocument) continue;
    const redactedDisk = redactDocumentText(diskDocument).text;
    const redactedDraft = redactDocumentText(draftDocument).text;
    changedFiles.push({
      id, path: actual.path, reason, expected, actual,
      diskDocument: redactedDisk, draftDocument: redactedDraft,
      diff: createLineDiff(redactedDisk, redactedDraft),
    });
  }
  return { snapshot, conflict: changedFiles.length ? { changedFiles } : null };
}
