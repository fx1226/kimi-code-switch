import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEventHandler, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { FileText, History, LoaderCircle, Save, Trash2, X } from "lucide-react";

import type { BackupDestinationType, BackupRecord, Locale } from "@shared/types";

import { CodePanel } from "./codePanel";
import { t } from "./i18n";

export type ConfirmDialogTone = "primary" | "danger";
export type ConfirmDialogKind = "save" | "delete" | "unsaved";
export type UnsavedDecision = "save" | "discard" | "cancel";

export interface ConfirmDialogState {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: ConfirmDialogTone;
  kind: ConfirmDialogKind;
  discardLabel?: string;
  onDiscard?: () => void;
}

export type UnsavedConfirmDialogState = ConfirmDialogState & {
  kind: "unsaved";
  discardLabel: string;
};

export interface RequestConfirm {
  (options: UnsavedConfirmDialogState): Promise<UnsavedDecision>;
  (options: ConfirmDialogState): Promise<boolean>;
}

export interface DocumentViewerState {
  title: string;
  format: "TOML" | "JSON";
  content: string;
}

export interface BackupRecordsDialogState {
  destinationType: BackupDestinationType;
  records: BackupRecord[];
  isLoading: boolean;
  errorMessage: string;
  deletingName?: string;
  restoringName?: string;
  migratingName?: string;
  legacyEncryptionPassword?: string;
}

const dialogStack: HTMLElement[] = [];

function isTopmostDialog(dialog: HTMLElement | null): boolean {
  return Boolean(dialog) && dialogStack[dialogStack.length - 1] === dialog;
}

export function useDialogEscape(
  onClose: () => void,
  dialogRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || (dialogRef && !isTopmostDialog(dialogRef.current))) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialogRef, onClose]);
}

export function DialogShell(props: {
  onClose?: () => void;
  backdropClassName: string;
  dialogClassName: string;
  dialogRef?: RefObject<HTMLElement | null>;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  closeOnBackdrop?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  children: ReactNode;
}): JSX.Element {
  const internalDialogRef = useRef<HTMLElement>(null);
  useDialogEscape(props.onClose ?? (() => {}), internalDialogRef);
  useFocusTrap(internalDialogRef);

  return createPortal(
    <div
      className={props.backdropClassName}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && props.closeOnBackdrop !== false && props.onClose) {
          props.onClose();
        }
      }}
    >
      <section
        ref={(element) => {
          internalDialogRef.current = element;
          if (props.dialogRef) {
            props.dialogRef.current = element;
          }
        }}
        className={props.dialogClassName}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel}
        aria-labelledby={props.ariaLabelledBy}
        aria-describedby={props.ariaDescribedBy}
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </section>
    </div>,
    document.body,
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(dialogRef: RefObject<HTMLElement | null>): void {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || !dialogRef.current || !isTopmostDialog(dialogRef.current)) {
        return;
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    [dialogRef],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogStack.push(dialog);
    const inertedSiblings: Array<{ element: HTMLElement; previousAriaHidden: string | null }> = [];
    let branch: HTMLElement | null = dialog;
    while (branch?.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.hasAttribute("inert")) {
          const previousAriaHidden = sibling.getAttribute("aria-hidden");
          sibling.setAttribute("inert", "");
          sibling.setAttribute("aria-hidden", "true");
          inertedSiblings.push({ element: sibling, previousAriaHidden });
        }
      }
      branch = parent;
      if (parent === document.body) break;
    }
    const initialFocus = dialog.querySelector<HTMLElement>(
      `[data-dialog-initial-focus], ${FOCUSABLE_SELECTOR}`,
    );
    if (initialFocus) {
      initialFocus.focus();
    } else {
      dialog.tabIndex = -1;
      dialog.focus();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const stackIndex = dialogStack.lastIndexOf(dialog);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      for (const { element, previousAriaHidden } of inertedSiblings) {
        element.removeAttribute("inert");
        if (previousAriaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", previousAriaHidden);
        }
      }
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [handleKeyDown]);
}

function parseBackupDisplayDate(value: string): Date | null {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const match = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})(?:-.+)?$/.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, millisecond] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
}

function formatBackupDisplayDate(value: string): string {
  const parsed = parseBackupDisplayDate(value);
  if (!parsed) {
    return value;
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function ConfirmDialog(
  props: ConfirmDialogState & {
    onConfirm: () => void;
    onCancel: () => void;
  },
): JSX.Element {
  const Icon = props.kind === "delete" ? Trash2 : Save;

  return (
    <DialogShell
      backdropClassName="confirm-dialog-backdrop"
      dialogClassName="confirm-dialog glass-panel"
      ariaLabelledBy="confirm-dialog-title"
      ariaDescribedBy={props.description ? "confirm-dialog-description" : undefined}
      onClose={props.onCancel}
    >
        <div className="confirm-dialog-header">
          <div className={props.tone === "danger" ? "confirm-dialog-icon danger" : "confirm-dialog-icon"}>
            <Icon size={20} />
          </div>
          <div className="confirm-dialog-copy">
            <h3 id="confirm-dialog-title">{props.title}</h3>
            {props.description ? <p id="confirm-dialog-description">{props.description}</p> : null}
          </div>
        </div>
        <div className="confirm-dialog-actions">
          <button className="action-button" type="button" data-dialog-initial-focus={props.tone === "danger" || props.kind === "unsaved" ? "true" : undefined} onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
          {props.kind === "unsaved" && props.discardLabel && props.onDiscard ? (
            <button className="action-button danger" type="button" onClick={props.onDiscard}>
              {props.discardLabel}
            </button>
          ) : null}
          <button
            className={
              props.tone === "danger"
                ? "action-button confirm-dialog-confirm danger"
                : "action-button action-button-primary confirm-dialog-confirm"
            }
            type="button"
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
    </DialogShell>
  );
}

export function DocumentViewerDialog(
  props: DocumentViewerState & {
    locale: Locale;
    onClose: () => void;
  },
): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(props.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <DialogShell
      backdropClassName="document-viewer-backdrop"
      dialogClassName="document-viewer glass-panel"
      ariaLabelledBy="document-viewer-title"
      onClose={props.onClose}
    >
        <div className="document-viewer-header">
          <div className="document-viewer-title">
            <div className="document-viewer-icon">
              <FileText size={18} />
            </div>
            <div>
              <h3 id="document-viewer-title">{props.title}</h3>
              <p>{props.format}</p>
            </div>
          </div>
          <div className="document-viewer-actions">
            <button className="action-button compact icon-only" type="button" aria-label={t(props.locale, "close")} onClick={props.onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <CodePanel
          title={props.format}
          content={props.content}
          locale={props.locale}
          onCopy={handleCopy}
          copied={copied}
        />
    </DialogShell>
  );
}

export function BackupRecordsDialog(
  props: BackupRecordsDialogState & {
    locale: Locale;
    onDelete: (record: BackupRecord) => void;
    onRestore: (record: BackupRecord) => void;
    onMigrateLegacy: (record: BackupRecord, legacyEncryptionPassword: string) => void;
    onLegacyEncryptionPasswordChange: (value: string) => void;
    onClose: () => void;
  },
): JSX.Element {
  const sourceLabel =
    props.destinationType === "webdav"
      ? t(props.locale, "backupRecordsSourceWebdav")
      : t(props.locale, "backupRecordsSourceLocal");

  return (
    <DialogShell
      backdropClassName="backup-records-backdrop"
      dialogClassName="backup-records-dialog glass-panel"
      ariaLabelledBy="backup-records-title"
      onClose={props.onClose}
    >
        <div className="backup-records-header">
          <div className="backup-records-title">
            <div className="backup-records-icon">
              <History size={18} />
            </div>
            <div>
              <h3 id="backup-records-title">{t(props.locale, "backupRecordsTitle")}</h3>
              <p>{sourceLabel}</p>
            </div>
          </div>
          <button className="action-button compact icon-only" type="button" aria-label={t(props.locale, "cancel")} onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        {props.destinationType === "webdav" ? (
          <label className="field">
            <span>{t(props.locale, "backupLegacyEncryptionPassword")}</span>
            <input
              type="password"
              value={props.legacyEncryptionPassword ?? ""}
              placeholder={t(props.locale, "backupLegacyEncryptionPasswordHint")}
              onChange={(event) => props.onLegacyEncryptionPasswordChange(event.target.value)}
            />
          </label>
        ) : null}
        {props.isLoading ? (
          <div className="backup-records-empty">
            <LoaderCircle size={18} className="button-spinner" />
            <span>{t(props.locale, "backupRecordsLoading")}</span>
          </div>
        ) : props.errorMessage ? (
          <div className="backup-records-empty is-error">
            <span>{props.errorMessage}</span>
          </div>
        ) : props.records.length ? (
          <div className="backup-records-list">
            <div className="backup-records-table-head">
              <span>{t(props.locale, "backupRecordsPath")}</span>
              <span>{t(props.locale, "backupRecordsCreatedAt")}</span>
              <span>{t(props.locale, "backupRecordsItems")}</span>
            </div>
            {props.records.map((record) => (
              <article key={`${record.name}-${record.path}`} className="backup-record-card">
                <div className="backup-record-meta">
                  <div>
                    <span>{record.name}</span>
                  </div>
                  <div>
                    <span>{formatBackupDisplayDate(record.createdAt)}</span>
                  </div>
                  <div className="backup-record-action-cell">
                    <div className="backup-record-actions">
                      {props.destinationType === "webdav" ? (
                        <button
                          className={props.migratingName === record.name ? "action-button compact is-loading" : "action-button compact secondary"}
                          type="button"
                          disabled={Boolean(props.restoringName || props.deletingName || props.migratingName)}
                          onClick={() => props.onMigrateLegacy(record, props.legacyEncryptionPassword ?? "")}
                        >
                          {props.migratingName === record.name ? <LoaderCircle size={16} className="button-spinner" /> : null}
                          <span>{t(props.locale, "backupLegacyMigrateAction")}</span>
                        </button>
                      ) : null}
                      <button
                        className={
                          props.restoringName === record.name
                            ? "action-button compact is-loading"
                            : "action-button compact"
                        }
                        type="button"
                        disabled={
                          Boolean(props.restoringName || props.deletingName || props.migratingName)
                        }
                        onClick={() => props.onRestore(record)}
                      >
                        {props.restoringName === record.name ? (
                          <LoaderCircle size={16} className="button-spinner" />
                        ) : null}
                        <span>
                          {props.restoringName === record.name
                            ? t(props.locale, "backupRestoring")
                            : t(props.locale, "restore")}
                        </span>
                      </button>
                      <button
                        className={props.deletingName === record.name ? "action-button compact danger is-loading" : "action-button compact danger"}
                        type="button"
                        disabled={
                          Boolean(props.deletingName || props.restoringName || props.migratingName)
                        }
                        onClick={() => props.onDelete(record)}
                      >
                        {props.deletingName === record.name ? <LoaderCircle size={16} className="button-spinner" /> : null}
                        <span>{t(props.locale, "delete")}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="backup-records-empty">
            <span>{t(props.locale, "backupRecordsEmpty")}</span>
          </div>
        )}
    </DialogShell>
  );
}
