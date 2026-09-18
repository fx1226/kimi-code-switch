// 配置历史服务：通过 Node 原生命令访问 SQLite 和本地快照。
import { invokeCommand as invoke } from "../native";
import type { ManagedFileId } from "@shared/types";

export type HistoryFileId = ManagedFileId | "tui" | "agents" | "skills";

/**
 * 本地配置快照记录
 */
export interface SnapshotRecord {
  id: number;
  snapshot_at: string; // ISO 8601 timestamp
  kimi_code_environment_id: string;
  file_id: HistoryFileId;
  sha256: string;
  size_bytes: number;
  snapshot_path: string;
  target_path: string;
  description: string | null;
}

/**
 * 初始化配置历史表。
 *
 * 调用时机：应用启动时，在 usageOpen 之后。
 * 注意：复用服务端 SQLite 连接，不需要单独的 open 操作。
 */
export async function initConfigHistory(): Promise<void> {
  try {
    await invoke("init_config_history");
  } catch (err) {
    console.error("Failed to init config history.");
    throw err;
  }
}

/**
 * 捕获配置快照。
 *
 * @param fileId - 配置文件 ID（'config' | 'panel' | 'mcp' | 'tui' | 'agents' | 'skills'）
 * @param filePath - 配置文件路径（支持 ~/）
 * @param description - 可选的快照描述
 * @returns 快照 ID，如果去重或失败则返回 null
 */
export async function captureSnapshot(
  fileId: HistoryFileId,
  filePath: string,
  description?: string,
  kimiCodeEnvironmentId?: string,
): Promise<number | null> {
  try {
    const result = await invoke<number | null>("capture_snapshot", {
      fileId,
      filePath,
      description: description ?? null,
      kimiCodeEnvironmentId: kimiCodeEnvironmentId ?? null,
    });
    return result;
  } catch (err) {
    console.error("Failed to capture snapshot.");
    return null; // 快照失败不阻塞调用方
  }
}

/**
 * 列出快照历史。
 *
 * @param fileId - 可选，过滤指定文件类型
 * @param limit - 返回记录数上限（默认 100）
 * @returns 按时间倒序排列的快照列表
 */
export async function listSnapshots(
  kimiCodeEnvironmentId: string,
  fileId?: HistoryFileId,
  limit?: number,
): Promise<SnapshotRecord[]> {
  try {
    const result = await invoke<SnapshotRecord[]>("list_snapshots", {
      fileId: fileId ?? null,
      kimiCodeEnvironmentId,
      limit: limit ?? 100,
    });
    return result;
  } catch (err) {
    console.error("Failed to list snapshots.");
    return [];
  }
}

/**
 * 获取快照内容。
 *
 * @param snapshotId - 快照 ID
 * @returns 解压后的原始配置文本
 */
export async function getSnapshotContent(snapshotId: number): Promise<string | null> {
  try {
    const content = await invoke<string>("get_snapshot_content", {
      snapshotId,
    });
    return content;
  } catch (err) {
    console.error("Failed to get snapshot content.");
    return null;
  }
}

/**
 * 回滚到指定快照。
 *
 * 注意：
 * - 回滚前会自动创建"回滚点"快照，支持撤销回滚
 * - 回滚后需要重新加载 AppState
 *
 * @param snapshotId - 快照 ID
 * @returns 成功返回 true，失败返回 false
 */
export async function restoreSnapshot(snapshotId: number): Promise<boolean> {
  try {
    await invoke("restore_snapshot", { snapshotId });
    return true;
  } catch (err) {
    console.error("Failed to restore snapshot.");
    return false;
  }
}

export async function assignLegacySnapshotEnvironment(
  snapshotId: number,
  kimiCodeEnvironmentId: string,
): Promise<boolean> {
  try {
    await invoke("assign_legacy_snapshot_environment", {
      snapshotId,
      kimiCodeEnvironmentId,
    });
    return true;
  } catch (err) {
    console.error("Failed to assign legacy snapshot.");
    return false;
  }
}

/**
 * 清理旧快照。
 *
 * 删除 30 天前的快照记录和对应的文件系统文件。
 *
 * @returns 删除的记录数
 */
export async function cleanupOldSnapshots(): Promise<number> {
  try {
    const deleted = await invoke<number>("cleanup_old_snapshots");
    return deleted;
  } catch (err) {
    console.error("Failed to cleanup old snapshots.");
    return 0;
  }
}
