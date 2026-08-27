import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MutableRefObject } from "react";

import { cloneState, normalizeStatePaths } from "@shared/configStore";
import type { AppState, ConfigDoctorReport, ConfigTarget, FileSnapshotBundle, Locale, PreviewBundle, SaveStateConflictResult } from "@shared/types";
import { getApi, isEqualValue } from "./appHelpers";
import { t, translateError } from "./i18n";
import type { DiagnosticsState } from "./overviewDashboard";
import { applyPrimarySelections, getDefaultPrimarySelections, getRetainedPrimarySelections } from "./primarySelections";
import { applyAppearanceMode, applyAppearanceTheme, applyUiFontSize, createFallbackState } from "./tabComponents";
import { isExternalChangeConflict } from "./useSafetyActions";
import { initBackupBaseline, maybeBackupAfterSave, maybeRunScheduledBackup } from "./backupAuto";
import { recordStartupTiming, startupTimingNow } from "./startupTiming";
import { createSaveCoordinator } from "./saveCoordinator";
import type { PendingSave } from "./saveCoordinator";

/** B1：把已持久化的用户偏好目录重登记为 Rust 侧 durable grant（跨重启可用）。 */
function reconcileUserDirectories(
  normalized: AppState,
  api: NonNullable<ReturnType<typeof getApi>>,
): Promise<void> {
  const directories = new Set<string>();
  const backupPath = normalized.panelSettings.backup_local_path?.trim();
  if (backupPath) directories.add(backupPath);
  for (const environment of normalized.panelSettings.kimi_code_environments ?? []) {
    const home = environment.homePath?.trim();
    if (home) directories.add(home);
  }
  return api.reconcileDurableGrants?.([...directories]) ?? Promise.resolve();
}

interface AppPersistenceContext {
  state: AppState;
  savedState: AppState | null;
  locale: Locale;
  setState: Dispatch<SetStateAction<AppState>>;
  setSavedState: Dispatch<SetStateAction<AppState | null>>;
  setPreview: Dispatch<SetStateAction<PreviewBundle>>;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setDiagnostics: Dispatch<SetStateAction<DiagnosticsState>>;
  fileSnapshot: FileSnapshotBundle | null;
  stateRef?: MutableRefObject<AppState>;
  fileSnapshotRef?: MutableRefObject<FileSnapshotBundle | null>;
  setFileSnapshot: Dispatch<SetStateAction<FileSnapshotBundle | null>>;
  setDoctorReport: Dispatch<SetStateAction<ConfigDoctorReport | null>>;
  confirmExternalOverwrite: (conflict: SaveStateConflictResult) => Promise<boolean>;
  refreshPreview: (draft?: AppState) => Promise<void>;
  refreshSkills: (draft?: AppState, options?: { silent?: boolean }) => Promise<void>;
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
}

export function useAppPersistence(ctx: AppPersistenceContext) {
  const {
    state,
    savedState,
    locale,
    setState,
    setSavedState,
    setPreview,
    setError,
    setNotice,
    setDiagnostics,
    fileSnapshot,
    stateRef,
    fileSnapshotRef,
    setFileSnapshot,
    setDoctorReport,
    confirmExternalOverwrite,
    refreshPreview,
    refreshSkills,
    currentSelections,
    setSelectedProvider,
    setSelectedModel,
    setSelectedProfile,
    setSelectedMcpServer,
  } = ctx;

  // C1 保存协调器：单一队列，latest-wins 合并即时偏好，显式保存保留结果。
  const persistCoreRef = useRef<(state: AppState) => Promise<boolean>>(async () => false);
  const persistImmediateCoreRef = useRef<(visible: AppState, saved?: AppState) => Promise<void>>(async () => {});
  const coordinatorRef = useRef<ReturnType<typeof createSaveCoordinator> | null>(null);
  coordinatorRef.current ??= createSaveCoordinator(async (save: PendingSave) => {
    if (save.kind === "explicit") {
      return persistCoreRef.current(save.state);
    }
    await persistImmediateCoreRef.current(save.visible, save.saved);
    return true;
  });
  const saveCoordinator = coordinatorRef.current;

  useEffect(() => {
    const onKimiTargetDetection = (event: Event): void => {
      const detection = (event as CustomEvent<AppState["kimiTargetDetection"]>).detail;
      if (!detection) return;
      setState((current) => ({
        ...current,
        kimiTargetDetection: detection,
      }));
      setSavedState((current) => current
        ? {
          ...current,
          kimiTargetDetection: detection,
        }
        : current);
    };
    window.addEventListener("kimi-target-detection", onKimiTargetDetection);
    return () => window.removeEventListener("kimi-target-detection", onKimiTargetDetection);
  }, [setSavedState, setState]);

  const runPostLoadTasks = useCallback((normalized: AppState, api: NonNullable<ReturnType<typeof getApi>>): void => {
    void (async () => {
      const startedAt = startupTimingNow();
      try {
        if (api.runDoctor) {
          const doctorStartedAt = startupTimingNow();
          const doctor = await api.runDoctor(normalized);
          recordStartupTiming("useAppPersistence.runDoctor", doctorStartedAt);
          setDoctorReport(doctor);
        }
      } catch (err) {
        setDiagnostics((current) => ({
          ...current,
          lastError: err instanceof Error ? err.message : String(err),
        }));
      }

      try {
        const skillsStartedAt = startupTimingNow();
        await refreshSkills(normalized, { silent: true });
        recordStartupTiming("useAppPersistence.refreshSkills", skillsStartedAt);
      } catch (err) {
        setDiagnostics((current) => ({
          ...current,
          lastError: err instanceof Error ? err.message : String(err),
        }));
      }

      try {
        const backupStartedAt = startupTimingNow();
        await initBackupBaseline(normalized);
        recordStartupTiming("useAppPersistence.initBackupBaseline", backupStartedAt);
        void maybeRunScheduledBackup(normalized);
      } catch (err) {
        setDiagnostics((current) => ({
          ...current,
          lastError: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        recordStartupTiming("useAppPersistence.postLoadTasks", startedAt);
      }
    })();
  }, [refreshSkills, setDiagnostics, setDoctorReport]);

  const loadState = useCallback(async (): Promise<void> => {
    const loadStartedAt = startupTimingNow();
    const api = getApi();
    if (!api) {
      setState(createFallbackState());
      setError("Electron preload API is unavailable. Check the preload script and packaged entry paths.");
      setDiagnostics({
        preload: "unavailable",
        loadState: "failed",
        previewState: "unavailable",
        lastError: "Electron preload API is unavailable.",
      });
      return;
    }

    try {
      setDiagnostics((current) => ({
        ...current,
        preload: "ok",
        loadState: "pending",
      }));
      const apiLoadStartedAt = startupTimingNow();
      const next = await api.loadState();
      recordStartupTiming("useAppPersistence.api.loadState", apiLoadStartedAt);
      const normalized = normalizeStatePaths(next);
      setState(normalized);
      setSavedState(normalized);
      applyAppearanceMode(normalized.panelSettings.theme);
      applyAppearanceTheme(normalized.panelSettings.appearance_theme);
      applyUiFontSize(normalized.panelSettings.ui_font_size);
      applyPrimarySelections(getDefaultPrimarySelections(normalized), {
        setSelectedProvider,
        setSelectedModel,
        setSelectedProfile,
        setSelectedMcpServer,
      });
      const previewStartedAt = startupTimingNow();
      const nextPreview = await api.previewState(normalized);
      recordStartupTiming("useAppPersistence.api.previewState", previewStartedAt);
      setPreview(nextPreview);
      setError("");
      setNotice("");
      setDiagnostics({
        preload: "ok",
        loadState: "ok",
        previewState: "ok",
        lastError: "",
      });
      // 在 UI 可交互前同步建立快照基线，避免首屏存在「基线未就绪 → 保存时
      // expectedSnapshot 为空 → 外部变更检测被跳过」的窗口。其余较重的后加载任务
      // （doctor / skills / 备份基线）仍后台异步执行，保留首屏性能优化。
      if (api.captureSnapshot) {
        try {
          const snapshotStartedAt = startupTimingNow();
          const snapshot = await api.captureSnapshot(normalized);
          recordStartupTiming("useAppPersistence.captureSnapshot", snapshotStartedAt);
          setFileSnapshot(snapshot);
        } catch (err) {
          setDiagnostics((current) => ({
            ...current,
            lastError: err instanceof Error ? err.message : String(err),
          }));
        }
      }
      // B1：把已持久化的用户偏好目录（备份目录、注册环境 home、项目根）重登记为
      // Rust 侧 durable grant，确保非受管根的备份/项目写入在重启后仍可用。
      if (api.reconcileDurableGrants) {
        void reconcileUserDirectories(normalized, api);
      }
      runPostLoadTasks(normalized, api);
      recordStartupTiming("useAppPersistence.loadState.total", loadStartedAt);
    } catch (loadError) {
      const fallback = createFallbackState();
      setState(fallback);
      setSavedState(fallback);
      applyAppearanceMode(fallback.panelSettings.theme);
      applyAppearanceTheme(fallback.panelSettings.appearance_theme);
      applyUiFontSize(fallback.panelSettings.ui_font_size);
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      setDiagnostics((current) => ({
        preload: current.preload === "pending" ? "ok" : current.preload,
        loadState: "failed",
        previewState: current.previewState,
        lastError: message,
      }));
    }
  }, [
    runPostLoadTasks,
    setDiagnostics,
    setError,
    setFileSnapshot,
    setNotice,
    setPreview,
    setSavedState,
    setSelectedMcpServer,
    setSelectedModel,
    setSelectedProfile,
    setSelectedProvider,
    setState,
  ]);

  const persistState = useCallback(async (nextState: AppState): Promise<boolean> => {
    const api = getApi();
    if (!api) {
      const message = "Electron preload API is unavailable. Save operation cannot continue.";
      setError(message);
      setDiagnostics((current) => ({ ...current, preload: "unavailable", lastError: message }));
      return false;
    }
    try {
      const normalized = normalizeStatePaths(nextState);
      const expectedSnapshot = fileSnapshotRef?.current ?? fileSnapshot ?? undefined;
      const saveResult = api.saveStateSafe
        ? await api.saveStateSafe(normalized, { expectedSnapshot })
        : await api.saveState(normalized);
      if (isExternalChangeConflict(saveResult)) {
        const overwrite = await confirmExternalOverwrite(saveResult);
        if (!overwrite) {
          setFileSnapshot(saveResult.snapshot);
          setDoctorReport(saveResult.doctor);
          return false;
        }
        const overwriteResult = api.saveStateSafe
          ? await api.saveStateSafe(normalized, { expectedSnapshot, allowOverwrite: true })
          : await api.saveState(normalized);
        if (isExternalChangeConflict(overwriteResult)) {
          setFileSnapshot(overwriteResult.snapshot);
          setDoctorReport(overwriteResult.doctor);
          throw new Error("Save blocked: external-change");
        }
        if ("snapshot" in overwriteResult && "doctor" in overwriteResult) {
          setFileSnapshot(overwriteResult.snapshot);
          setDoctorReport(overwriteResult.doctor);
        }
      } else if ("snapshot" in saveResult && "doctor" in saveResult) {
        setFileSnapshot(saveResult.snapshot);
        setDoctorReport(saveResult.doctor);
      }
      if (savedState?.panelSettings.tray_icon !== normalized.panelSettings.tray_icon) {
        await api.setTray(normalized.panelSettings.tray_icon);
      }
      const nextPreview = await api.previewState(normalized);
      const latestVisibleState = stateRef?.current ?? state;
      const hasNewerVisibleState = !isEqualValue(latestVisibleState, nextState);
      if (!hasNewerVisibleState) {
        setState(normalized);
        setPreview(nextPreview);
        void refreshSkills(normalized, { silent: true });
      } else {
        // 保存 D 进行中用户可能已继续编辑成 E。旧保存只能推进 saved baseline，
        // 不能再用 D 覆盖 E 对应的预览/技能报告。
        void refreshPreview(latestVisibleState);
        void refreshSkills(latestVisibleState, { silent: true });
      }
      setSavedState(normalized);
      setError("");
      setNotice("");
      // 修改后备份：核心配置指纹变化时静默触发（指纹去重使纯 UI 操作成为 no-op）。
      void maybeBackupAfterSave(normalized);
      return true;
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(translateError(locale, message));
      setNotice("");
      setDiagnostics((current) => ({ ...current, lastError: message }));
      return false;
    }
  }, [
    confirmExternalOverwrite,
    fileSnapshot,
    fileSnapshotRef,
    locale,
    refreshSkills,
    savedState,
    state,
    stateRef,
    setDiagnostics,
    setDoctorReport,
    setError,
    setFileSnapshot,
    setNotice,
    setPreview,
    setSavedState,
    setState,
  ]);

  const persistConfigTarget = useCallback(async (configTarget: ConfigTarget): Promise<void> => {
    const api = getApi();
    if (!api?.saveConfigTargetPreference) {
      const message = "Kimi Switch API does not support config target switching.";
      setError(message);
      setDiagnostics((current) => ({ ...current, lastError: message }));
      throw new Error(message);
    }

    await api.saveConfigTargetPreference(configTarget);
    const nextState = cloneState(state);
    nextState.configTarget = configTarget;
    nextState.panelSettings.config_target = configTarget;
    const normalized = normalizeStatePaths(nextState);
    setState(normalized);
    setSavedState(normalized);
    setError("");
    setNotice("");
  }, [setDiagnostics, setError, setNotice, setSavedState, setState, state]);

  const persistImmediateState = useCallback(async (
    nextVisibleState: AppState,
    nextSavedStateOverride?: AppState,
  ): Promise<void> => {
    const api = getApi();
    if (!api) {
      const message = "Electron preload API is unavailable. Save operation cannot continue.";
      setError(message);
      setDiagnostics((current) => ({ ...current, preload: "unavailable", lastError: message }));
      return;
    }

    const previousSavedState = savedState;
    const normalizedVisibleState = normalizeStatePaths(nextVisibleState);
    const normalizedSavedState = normalizeStatePaths(nextSavedStateOverride ?? nextVisibleState);

    setState(normalizedVisibleState);
    setSavedState(normalizedSavedState);
    applyAppearanceMode(normalizedVisibleState.panelSettings.theme);
    applyAppearanceTheme(normalizedVisibleState.panelSettings.appearance_theme);
    applyUiFontSize(normalizedVisibleState.panelSettings.ui_font_size);
    void refreshPreview(normalizedVisibleState);
    setError("");
    setNotice("");

    try {
      const expectedSnapshot = fileSnapshotRef?.current ?? fileSnapshot ?? undefined;
      const saveResult = api.saveStateSafe
        ? await api.saveStateSafe(normalizedSavedState, { expectedSnapshot })
        : await api.saveState(normalizedSavedState);
      if (isExternalChangeConflict(saveResult)) {
        const overwrite = await confirmExternalOverwrite(saveResult);
        if (!overwrite) {
          setSavedState(previousSavedState ?? null);
          setFileSnapshot(saveResult.snapshot);
          setDoctorReport(saveResult.doctor);
          return;
        }
        const overwriteResult = api.saveStateSafe
          ? await api.saveStateSafe(normalizedSavedState, { expectedSnapshot, allowOverwrite: true })
          : await api.saveState(normalizedSavedState);
        if (isExternalChangeConflict(overwriteResult)) {
          setFileSnapshot(overwriteResult.snapshot);
          setDoctorReport(overwriteResult.doctor);
          throw new Error("Save blocked: external-change");
        }
        if ("snapshot" in overwriteResult && "doctor" in overwriteResult) {
          setFileSnapshot(overwriteResult.snapshot);
          setDoctorReport(overwriteResult.doctor);
        }
      } else if ("snapshot" in saveResult && "doctor" in saveResult) {
        setFileSnapshot(saveResult.snapshot);
        setDoctorReport(saveResult.doctor);
      }
      if (previousSavedState?.panelSettings.tray_icon !== normalizedSavedState.panelSettings.tray_icon) {
        await api.setTray(normalizedSavedState.panelSettings.tray_icon);
      }
      if (
        previousSavedState?.panelSettings.locale !== normalizedSavedState.panelSettings.locale ||
        previousSavedState?.panelSettings.theme !== normalizedSavedState.panelSettings.theme
      ) {
        await api.refreshTrayMenu?.();
      }
      const nextPreview = await api.previewState(normalizedVisibleState);
      setPreview(nextPreview);
      void refreshSkills(normalizedVisibleState, { silent: true });
      setError("");
      setNotice("");
      // 修改后备份（on-change）：核心配置指纹变化时静默触发，纯 UI 操作为 no-op。
      void maybeBackupAfterSave(normalizedSavedState);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setSavedState(previousSavedState ?? null);
      setError(translateError(locale, message));
      setNotice("");
      setDiagnostics((current) => ({ ...current, lastError: message }));
    }
  }, [
    confirmExternalOverwrite,
    fileSnapshot,
    fileSnapshotRef,
    locale,
    refreshPreview,
    refreshSkills,
    savedState,
    setDiagnostics,
    setDoctorReport,
    setError,
    setFileSnapshot,
    setNotice,
    setPreview,
    setSavedState,
    setState,
  ]);

  const restoreSavedState = useCallback((nextSavedState: AppState): void => {
    const restored = normalizeStatePaths(cloneState(nextSavedState));
    setState(restored);
    applyAppearanceMode(restored.panelSettings.theme);
    applyAppearanceTheme(restored.panelSettings.appearance_theme);
    applyUiFontSize(restored.panelSettings.ui_font_size);
    applyPrimarySelections(
      getRetainedPrimarySelections(restored, currentSelections),
      {
        setSelectedProvider,
        setSelectedModel,
        setSelectedProfile,
        setSelectedMcpServer,
      },
    );
    void refreshSkills(restored, { silent: true });
    void refreshPreview(restored);
    setError("");
    setNotice("");
  }, [
    currentSelections,
    refreshPreview,
    refreshSkills,
    setError,
    setNotice,
    setSelectedMcpServer,
    setSelectedModel,
    setSelectedProfile,
    setSelectedProvider,
    setState,
  ]);

  // C1：把最新 core 挂到协调器用到的 ref；返回给外部的函数改为经协调器进队。
  persistCoreRef.current = persistState;
  persistImmediateCoreRef.current = persistImmediateState;

  const enqueuedPersistState = useCallback(
    (nextState: AppState): Promise<boolean> =>
      saveCoordinator.submit({ kind: "explicit", state: nextState }) as Promise<boolean>,
    [saveCoordinator],
  );

  const enqueuedPersistImmediate = useCallback(
    (nextVisibleState: AppState, nextSavedStateOverride?: AppState): void => {
      saveCoordinator.submit({
        kind: "immediate",
        visible: nextVisibleState,
        saved: nextSavedStateOverride ?? nextVisibleState,
      });
    },
    [saveCoordinator],
  );

  return {
    loadState,
    persistState: enqueuedPersistState,
    onSave: async (): Promise<void> => {
      if (!state) return;
      const success = await enqueuedPersistState(state);
      if (success) setNotice(t(locale, "saveSuccess"));
    },
    persistConfigTarget,
    persistImmediateState: enqueuedPersistImmediate,
    waitForPendingSaves: saveCoordinator.waitForExplicitFlush,
    restoreSavedState,
    saveCoordinator,
  };
}
