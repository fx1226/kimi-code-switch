// C2：save journal 人工恢复对话框。
// 展示脱敏摘要（哪些文件、original/desired 两侧内容、reason），并提供
// 导出 journal / 应用保存内容(desired) / 恢复为编辑前(original) / 放弃 / 关闭。
import { useState } from "react";
import { AlertTriangle, Download, RotateCcw, Save, Trash2, X } from "lucide-react";

import type { Locale } from "@shared/types";

import { DialogShell } from "./dialogs";
import { t } from "./i18n";
import type { SaveRecoveryFileSummary } from "./saveRecovery";
import { summarizeSaveRecoveryJournal } from "./saveRecovery";
import type { SaveRecoveryDecision, SaveRecoveryInfo } from "./tauri/kimiSwitch";
import { formatMessage } from "./tabComponents";

/** unknown 只读恢复场景下的 save journal 信息。 */
export type SaveRecoveryUnknownInfo = SaveRecoveryInfo & { action: "unknown" };

function formatDateTime(locale: Locale, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(locale);
}

export function SaveRecoveryDialog(props: {
  locale: Locale;
  recovery: SaveRecoveryUnknownInfo;
  busy: boolean;
  message: { tone: "success" | "error"; text: string } | null;
  onResolve: (decision: SaveRecoveryDecision) => void;
  onClose: () => void;
}): JSX.Element {
  const { locale, busy, message, onResolve, onClose } = props;
  const summary = summarizeSaveRecoveryJournal(props.recovery.journal);
  const [activePreview, setActivePreview] = useState<{
    path: string;
    side: "original" | "desired";
  } | null>(null);

  const togglePreview = (path: string, side: "original" | "desired"): void => {
    setActivePreview((current) =>
      current?.path === path && current.side === side ? null : { path, side });
  };

  return (
    <DialogShell
      backdropClassName="save-recovery-backdrop"
      dialogClassName="save-recovery-dialog glass-panel"
      ariaLabelledBy="save-recovery-title"
      onClose={onClose}
    >
      <div className="save-recovery-header">
        <div className="save-recovery-title">
          <div className="save-recovery-icon">
            <AlertTriangle size={18} />
          </div>
          <div>
            <h3 id="save-recovery-title">{t(locale, "saveRecoveryTitle")}</h3>
            <p>
              {t(locale, "saveRecoveryReason")}: {t(locale, "saveRecoveryReasonExternal")}
              {summary.createdAt
                ? ` · ${t(locale, "saveRecoveryCreatedAt")} ${formatDateTime(locale, summary.createdAt)}`
                : ""}
            </p>
          </div>
        </div>
        <button
          className="action-button compact icon-only"
          type="button"
          aria-label={t(locale, "close")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div className="save-recovery-count">
        {formatMessage(t(locale, "saveRecoveryFilesCount"), { count: summary.changedFiles.length })}
        {summary.unchangedCount > 0
          ? ` · ${formatMessage(t(locale, "saveRecoveryUnchangedFiles"), { count: summary.unchangedCount })}`
          : ""}
      </div>

      <div className="save-recovery-files">
        {summary.changedFiles.length === 0 ? (
          <div className="save-recovery-empty">{t(locale, "saveRecoveryNoChangedFiles")}</div>
        ) : (
          summary.changedFiles.map((file) => (
            <SaveRecoveryFileRow
              key={file.path}
              file={file}
              locale={locale}
              activePreview={activePreview}
              onToggle={togglePreview}
            />
          ))
        )}
      </div>

      {message ? (
        <div className={`save-recovery-message ${message.tone === "error" ? "is-error" : "is-success"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="save-recovery-actions">
        <button
          className="action-button"
          type="button"
          data-dialog-initial-focus
          disabled={busy}
          onClick={() => onResolve("export-journal")}
        >
          <Download size={14} />
          {t(locale, "saveRecoveryExport")}
        </button>
        <button
          className="action-button"
          type="button"
          disabled={busy}
          onClick={() => onResolve("apply-desired")}
        >
          <Save size={14} />
          {t(locale, "saveRecoveryApplyDesired")}
        </button>
        <button
          className="action-button"
          type="button"
          disabled={busy}
          onClick={() => onResolve("restore-original")}
        >
          <RotateCcw size={14} />
          {t(locale, "saveRecoveryRestoreOriginal")}
        </button>
        <button
          className="action-button danger"
          type="button"
          disabled={busy}
          onClick={() => onResolve("abandon")}
        >
          <Trash2 size={14} />
          {t(locale, "saveRecoveryAbandon")}
        </button>
        <button className="action-button" type="button" disabled={busy} onClick={onClose}>
          {t(locale, "close")}
        </button>
      </div>
    </DialogShell>
  );
}

function SaveRecoveryFileRow(props: {
  file: SaveRecoveryFileSummary;
  locale: Locale;
  activePreview: { path: string; side: "original" | "desired" } | null;
  onToggle: (path: string, side: "original" | "desired") => void;
}): JSX.Element {
  const { file, locale, activePreview, onToggle } = props;
  const openOriginal = activePreview?.path === file.path && activePreview.side === "original";
  const openDesired = activePreview?.path === file.path && activePreview.side === "desired";
  return (
    <article className="save-recovery-file">
      <div className="save-recovery-file-head">
        <code className="save-recovery-file-path" title={file.path}>{file.redactedPath}</code>
        <div className="save-recovery-file-actions">
          <button
            className={openOriginal ? "is-active" : ""}
            type="button"
            onClick={() => onToggle(file.path, "original")}
          >
            {t(locale, "saveRecoveryFileOriginal")}
            {file.hasOriginal ? "" : ` (${t(locale, "saveRecoveryNoPreview")})`}
          </button>
          <button
            className={openDesired ? "is-active" : ""}
            type="button"
            onClick={() => onToggle(file.path, "desired")}
          >
            {t(locale, "saveRecoveryFileDesired")}
          </button>
        </div>
      </div>
      {openOriginal ? (
        <pre className="save-recovery-preview">{file.originalPreview || t(locale, "saveRecoveryNoPreview")}</pre>
      ) : null}
      {openDesired ? (
        <pre className="save-recovery-preview">{file.desiredPreview || t(locale, "saveRecoveryNoPreview")}</pre>
      ) : null}
    </article>
  );
}
