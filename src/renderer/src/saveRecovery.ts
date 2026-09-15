// C2：save journal 的脱敏恢复摘要（纯派生逻辑，无磁盘 I/O，供 SaveRecoveryDialog 使用）。
// 文本内容一律经 redactDocumentText 脱敏后再展示，恢复 UI 不泄漏 API keys/token/Authorization 明文。
import type { SaveTransactionRecord } from "@shared/configStore";
import { redactDocumentText } from "@shared/configSafety";
import { isSaveTransactionRecord } from "./tauri/fileAccess";

export const SAVE_RECOVERY_PREVIEW_LIMIT = 400;

export interface SaveRecoveryFileSummary {
  path: string;
  /** 经脱敏的路径展示（路径一般无 secret，防御性处理）。 */
  redactedPath: string;
  hasOriginal: boolean;
  /** 编辑前内容（脱敏 + 截断）。 */
  originalPreview: string;
  /** 保存内容（脱敏 + 截断）。 */
  desiredPreview: string;
}

export interface SaveRecoverySummary {
  record: SaveTransactionRecord | null;
  /** 有变更（original !== desired）的文件。 */
  changedFiles: SaveRecoveryFileSummary[];
  /** journal 中记录为未变更的文件数。 */
  unchangedCount: number;
  createdAt: string;
}

export function redactedPreview(content: string | null): string {
  if (content === null || content === "") return "";
  const redacted = redactDocumentText(content).text;
  return redacted.length > SAVE_RECOVERY_PREVIEW_LIMIT
    ? `${redacted.slice(0, SAVE_RECOVERY_PREVIEW_LIMIT)}…`
    : redacted;
}

export function summarizeSaveRecoveryJournal(journal: unknown): SaveRecoverySummary {
  if (!isSaveTransactionRecord(journal)) {
    return { record: null, changedFiles: [], unchangedCount: 0, createdAt: "" };
  }
  const changed = journal.textFiles.filter((file) => file.originalContent !== file.desiredContent);
  const unchangedCount = journal.textFiles.length - changed.length;
  return {
    record: journal,
    createdAt: journal.createdAt,
    unchangedCount,
    changedFiles: changed.map((file) => ({
      path: file.path,
      redactedPath: redactDocumentText(file.path).text,
      hasOriginal: file.originalContent !== null,
      originalPreview: redactedPreview(file.originalContent),
      desiredPreview: redactedPreview(file.desiredContent),
    })),
  };
}
