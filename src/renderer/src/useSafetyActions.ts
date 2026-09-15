import type { Dispatch, SetStateAction } from "react";
import type { MutableRefObject } from "react";

import { normalizeStatePaths } from "@shared/configStore";
import type {
  AppState,
  ConfigDoctorReport,
  FileSnapshotBundle,
  Locale,
  SaveStateConflictResult,
} from "@shared/types";
import { getApi } from "./appHelpers";
import { t, translateError } from "./i18n";
import { applyPrimarySelections, getRetainedPrimarySelections } from "./primarySelections";
import { applyAppearanceMode, applyAppearanceTheme, applyUiFontSize, formatMessage } from "./tabComponents";

interface SafetyActionsContext {
  locale: Locale;
  setState: Dispatch<SetStateAction<AppState>>;
  setSavedState: Dispatch<SetStateAction<AppState | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
  fileSnapshot: FileSnapshotBundle | null;
  fileSnapshotRef?: MutableRefObject<FileSnapshotBundle | null>;
  setFileSnapshot: Dispatch<SetStateAction<FileSnapshotBundle | null>>;
  doctorReport: ConfigDoctorReport | null;
  setDoctorReport: Dispatch<SetStateAction<ConfigDoctorReport | null>>;
  currentSelections: {
    provider: string;
    model: string;
    profile: string;
    mcpServer: string;
  };
  setSelectedProvider: Dispatch<SetStateAction<string>>;
  setSelectedModel: Dispatch<SetStateAction<string>>;
  setSelectedProfile: Dispatch<SetStateAction<string>>;
  setSelectedMcpServer: Dispatch<SetStateAction<string>>;
  refreshPreview: (draft?: AppState) => Promise<void>;
  requestConfirm: (options: {
    title: string;
    description?: string;
    confirmLabel: string;
    cancelLabel: string;
    tone: "primary" | "danger";
    kind: "save" | "delete";
    /** B4：以完整（不截断）可滚动 <pre> 形式展示的内容，例如危险内容完整清单；可选复制导出。 */
    scrollableContent?: string;
    scrollableCopyLabel?: string;
  }) => Promise<boolean>;
}

export function isExternalChangeConflict(value: unknown): value is SaveStateConflictResult {
  return isRecord(value) && value.ok === false && value.reason === "external-change";
}

export function useSafetyActions(ctx: SafetyActionsContext) {
  const {
    locale,
    setState,
    setSavedState,
    setError,
    setNotice,
    fileSnapshot,
    fileSnapshotRef,
    setFileSnapshot,
    doctorReport,
    setDoctorReport,
    currentSelections,
    setSelectedProvider,
    setSelectedModel,
    setSelectedProfile,
    setSelectedMcpServer,
    refreshPreview,
    requestConfirm,
  } = ctx;

  const refreshSafetyState = async (state: AppState): Promise<void> => {
    const api = getApi();
    if (!api?.captureSnapshot || !api?.runDoctor) {
      return;
    }
    const normalized = normalizeStatePaths(state);
    const [snapshot, report] = await Promise.all([
      api.captureSnapshot(normalized),
      api.runDoctor(normalized),
    ]);
    setFileSnapshot(snapshot);
    setDoctorReport(report);
  };

  const runDoctor = (state: AppState): void => {
    const api = getApi();
    if (!api?.runDoctor) {
      setNotice("");
      setError(t(locale, "doctorRuntimeOutdated"));
      return;
    }

    void (async () => {
      try {
        const report = await api.runDoctor(normalizeStatePaths(state));
        setDoctorReport(report);
        setError("");
        setNotice(
          formatMessage(t(locale, "doctorRunComplete"), {
            errors: report.errorCount,
            warnings: report.warningCount,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice("");
        setError(translateError(locale, message));
      }
    })();
  };

  const confirmExternalOverwrite = async (conflict: SaveStateConflictResult): Promise<boolean> => {
    const first = conflict.conflict.changedFiles[0];
    const changedList = conflict.conflict.changedFiles
      .map((file) => `${file.id}: ${file.reason}`)
      .join(" / ");
    return requestConfirm({
      title: t(locale, "externalChangeTitle"),
      description: formatMessage(t(locale, "externalChangeDescription"), {
        count: conflict.conflict.changedFiles.length,
        file: first?.path ?? "",
        files: changedList,
      }),
      confirmLabel: t(locale, "externalChangeOverwrite"),
      cancelLabel: t(locale, "cancel"),
      tone: "danger",
      kind: "save",
    });
  };

  const restoreWithDryRun = async (state: AppState, backupName: string): Promise<void> => {
    const api = getApi();
    if (!api?.restoreBackupDryRun || !api?.restoreBackupSafe) {
      setNotice("");
      setError(t(locale, "backupRuntimeOutdated"));
      return;
    }

    const normalizedState = normalizeStatePaths(state);
    const defaultExpected = (): FileSnapshotBundle | undefined => fileSnapshotRef?.current ?? fileSnapshot ?? undefined;
    const applyRestoredState = (restored: {
      state: AppState;
      snapshot: FileSnapshotBundle;
      doctor: ConfigDoctorReport;
      rollbackBackupName: string;
    }): void => {
      const normalizedRestored = normalizeStatePaths(restored.state);
      setState(normalizedRestored);
      setSavedState(normalizedRestored);
      setFileSnapshot(restored.snapshot);
      setDoctorReport(restored.doctor);
      applyAppearanceMode(normalizedRestored.panelSettings.theme);
      applyAppearanceTheme(normalizedRestored.panelSettings.appearance_theme);
      applyUiFontSize(normalizedRestored.panelSettings.ui_font_size);
      applyPrimarySelections(
        getRetainedPrimarySelections(normalizedRestored, currentSelections),
        {
          setSelectedProvider,
          setSelectedModel,
          setSelectedProfile,
          setSelectedMcpServer,
        },
      );
      void refreshPreview(normalizedRestored);
      setError("");
      setNotice(
        formatMessage(t(locale, "backupRestoreSuccessWithRollback"), {
          name: backupName,
          rollback: restored.rollbackBackupName,
        }),
      );
    };
    // dry-run 以当前最新快照为基线；后续各阶段只以用户确认过的具体冲突版本推进。
    let expectedSnapshot = defaultExpected();
    const dryRun = await api.restoreBackupDryRun(normalizedState, backupName, {
      expectedSnapshot,
    });
    if (isExternalChangeConflict(dryRun)) {
      const overwrite = await confirmExternalOverwrite(dryRun);
      if (!overwrite) {
        setDoctorReport(dryRun.doctor);
        setFileSnapshot(dryRun.snapshot);
        return;
      }
      // 用户已确认该具体冲突版本 → 用 dry-run 返回的 snapshot 作 apply 基线。
      expectedSnapshot = dryRun.snapshot;
    } else {
      const changedFiles = dryRun.filePlans.filter((plan) => plan.action !== "unchanged");
      const confirmed = await requestConfirm({
        title: formatMessage(t(locale, "backupRestoreDryRunTitle"), { name: backupName }),
        description: formatMessage(t(locale, "backupRestoreDryRunDescription"), {
          count: changedFiles.length,
          warnings: dryRun.warnings.length,
        }),
        confirmLabel: t(locale, "restore"),
        cancelLabel: t(locale, "cancel"),
        tone: dryRun.doctor.errorCount > 0 ? "danger" : "primary",
        kind: "save",
      });
      if (!confirmed) {
        setDoctorReport(dryRun.doctor);
        return;
      }
    }

    // ① apply 第一次：不传 allowOverwrite，保留 preflight（外部变更与危险内容授权分离）。
    let restored = await api.restoreBackupSafe(normalizedState, backupName, {
      expectedSnapshot,
    });

    // ② 外部变更：dry-run 确认后、apply 前若外部再次修改，仍返回 external-change，
    // 必须二次确认该具体冲突版本，绝不静默覆盖。确认后以本次 snapshot 为新 expected 重调。
    if (isExternalChangeConflict(restored)) {
      const overwrite = await confirmExternalOverwrite(restored);
      if (!overwrite) {
        setDoctorReport(restored.doctor);
        setFileSnapshot(restored.snapshot);
        return;
      }
      expectedSnapshot = restored.snapshot;
      restored = await api.restoreBackupSafe(normalizedState, backupName, {
        expectedSnapshot,
        allowOverwrite: true,
      });
    }

    // ③ B4：危险内容门禁——展示完整风险清单（不截断，可滚动/复制导出），
    // 由用户显式确认后才 allowRisk:true 重调。
    if (isDangerousContentBlocked(restored)) {
      const riskItems = restored.risk.items;
      const confirmed = await requestConfirm({
        title: t(locale, "backupRestoreRiskTitle"),
        description: formatMessage(t(locale, "backupRestoreRiskDescription"), {
          count: riskItems.length,
        }),
        scrollableContent: riskItems.map((item, index) => `${index + 1}. ${item}`).join("\n"),
        scrollableCopyLabel: t(locale, "copy"),
        confirmLabel: t(locale, "backupRestoreRiskAllow"),
        cancelLabel: t(locale, "cancel"),
        tone: "danger",
        kind: "delete",
      });
      if (!confirmed) {
        setDoctorReport(restored.doctor);
        throw new Error(t(locale, "backupRestoreRiskDenied"));
      }
      // ④ allowRisk 重调：继续传 allowRisk 前最新 snapshot、不传 allowOverwrite——
      // preflight 始终保留；若期间又出现外部变更，再单独确认覆盖。
      restored = await api.restoreBackupSafe(normalizedState, backupName, {
        expectedSnapshot,
        allowRisk: true,
      });
      if (isExternalChangeConflict(restored)) {
        const overwrite = await confirmExternalOverwrite(restored);
        if (!overwrite) {
          setDoctorReport(restored.doctor);
          setFileSnapshot(restored.snapshot);
          return;
        }
        expectedSnapshot = restored.snapshot;
        restored = await api.restoreBackupSafe(normalizedState, backupName, {
          expectedSnapshot,
          allowOverwrite: true,
          allowRisk: true,
        });
      }
      if (isDangerousContentBlocked(restored)) {
        setDoctorReport(restored.doctor);
        throw new Error(t(locale, "backupRestoreRiskDenied"));
      }
      applyRestoredState(restored);
      return;
    }

    applyRestoredState(restored);
  };

  return {
    doctorReport,
    refreshSafetyState,
    runDoctor,
    confirmExternalOverwrite,
    restoreWithDryRun,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDangerousContentBlocked(result: unknown): result is {
  ok: false;
  reason: "dangerous-content";
  doctor: ConfigDoctorReport;
  risk: { items: string[]; tiers: Record<string, string[]> };
} {
  return Boolean(
    result
    && typeof result === "object"
    && (result as { ok?: unknown }).ok === false
    && (result as { reason?: unknown }).reason === "dangerous-content"
    && Array.isArray((result as { risk?: { items?: unknown } }).risk?.items),
  );
}
