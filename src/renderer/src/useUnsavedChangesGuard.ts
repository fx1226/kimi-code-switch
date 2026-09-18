import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";

import type { AppState, Locale } from "@shared/types";
import type { RequestConfirm, UnsavedDecision } from "./dialogs";
import { buildManualDraftProjection, collectDirtyKeys, isEqualValue } from "./appHelpers";
import { t } from "./i18n";

interface UnsavedChangesGuardContext {
  state: AppState;
  savedState: AppState | null;
  locale: Locale;
  requestConfirm: RequestConfirm;
  persistState: (nextState: AppState) => Promise<boolean>;
  restoreSavedState: (nextSavedState: AppState) => void;
  stateRef?: MutableRefObject<AppState>;
  savedStateRef?: MutableRefObject<AppState | null>;
  waitForPendingSaves?: () => Promise<void>;
}

export function useUnsavedChangesGuard(ctx: UnsavedChangesGuardContext) {
  const {
    state,
    savedState,
    locale,
    requestConfirm,
    persistState,
    restoreSavedState,
    stateRef,
    savedStateRef,
    waitForPendingSaves,
  } = ctx;
  const unsavedResolutionRef = useRef(false);
  const hasUnsavedChanges = Boolean(state && savedState) && !areManualDraftsEqual(state, savedState);
  const dirtyProviders = state && savedState
    ? collectDirtyKeys(state.mainConfig.providers, savedState.mainConfig.providers)
    : new Set<string>();
  const dirtyModels = state && savedState
    ? collectDirtyKeys(state.mainConfig.models, savedState.mainConfig.models)
    : new Set<string>();
  const dirtyProfiles = state && savedState
    ? collectDirtyKeys(state.profiles, savedState.profiles)
    : new Set<string>();
  const dirtyMcpServers = state && savedState
    ? collectDirtyKeys(state.mcpConfig.mcpServers, savedState.mcpConfig.mcpServers)
    : new Set<string>();

  const resolveUnsavedChanges = useCallback(async (): Promise<UnsavedDecision | "unchanged"> => {
    if (unsavedResolutionRef.current) {
      return "cancel";
    }
    unsavedResolutionRef.current = true;
    try {
      // 自动保存会先更新可见 state，再异步更新 savedState。离开页面/关闭窗口时
      // 先等保存队列真正 idle，并用 refs 的最新值重判，避免把 in-flight 窗口误报为草稿。
      await waitForPendingSaves?.();
      const currentState = stateRef?.current ?? state;
      const currentSavedState = savedStateRef?.current ?? savedState;
      if (!currentState || !currentSavedState || areManualDraftsEqual(currentState, currentSavedState)) {
        return "unchanged";
      }
      const decision = await requestConfirm({
        title: t(locale, "unsavedChangesTitle"),
        description: t(locale, "unsavedChangesDescription"),
        confirmLabel: t(locale, "save"),
        discardLabel: t(locale, "discardChanges"),
        cancelLabel: t(locale, "cancel"),
        tone: "primary",
        kind: "unsaved",
      });
      if (decision === "save") {
        const saved = await persistState(currentState);
        if (!saved) return "cancel";
      } else if (decision === "discard") {
        restoreSavedState(currentSavedState);
      }
      return decision;
    } finally {
      unsavedResolutionRef.current = false;
    }
  }, [
    locale,
    persistState,
    requestConfirm,
    restoreSavedState,
    savedStateRef,
    savedState,
    stateRef,
    state,
    waitForPendingSaves,
  ]);

  const runAfterUnsavedHandled = useCallback((action: () => void | Promise<void>): void => {
    void (async () => {
      const decision = await resolveUnsavedChanges();
      if (decision === "cancel") {
        return;
      }
      await action();
    })();
  }, [resolveUnsavedChanges]);

  // 把脏状态同步广播出去：浏览器形态（kimiSwitchHttp）的 beforeunload 守卫据此同步判定。
  // Tauri 形态没有人监听该事件，多发一次无副作用。
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("kimi-unsaved-changed", { detail: hasUnsavedChanges }));
  }, [hasUnsavedChanges]);

  return {
    unsavedResolutionRef,
    hasUnsavedChanges,
    dirtyProviders,
    dirtyModels,
    dirtyProfiles,
    dirtyMcpServers,
    resolveUnsavedChanges,
    runAfterUnsavedHandled,
  };
}

function areManualDraftsEqual(state: AppState, savedState: AppState | null): boolean {
  if (!savedState) {
    return false;
  }
  return isEqualValue(buildManualDraftProjection(state), buildManualDraftProjection(savedState));
}
