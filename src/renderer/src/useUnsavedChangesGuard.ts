import { useCallback, useRef } from "react";

import { buildManagedDocuments } from "@shared/configSafety";
import type { AppState, Locale } from "@shared/types";
import type { RequestConfirm, UnsavedDecision } from "./dialogs";
import { collectDirtyKeys, isEqualValue } from "./appHelpers";
import { t } from "./i18n";

interface UnsavedChangesGuardContext {
  state: AppState;
  savedState: AppState | null;
  locale: Locale;
  requestConfirm: RequestConfirm;
  persistState: (nextState: AppState) => Promise<void>;
  restoreSavedState: (nextSavedState: AppState) => void;
}

export function useUnsavedChangesGuard(ctx: UnsavedChangesGuardContext) {
  const {
    state,
    savedState,
    locale,
    requestConfirm,
    persistState,
    restoreSavedState,
  } = ctx;
  const unsavedResolutionRef = useRef(false);
  const hasUnsavedChanges = Boolean(state && savedState) && !areManagedDocumentsEqual(state, savedState);
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
    const currentState = state;
    if (!currentState || !hasUnsavedChanges || !savedState) {
      return "unchanged";
    }
    if (unsavedResolutionRef.current) {
      return "cancel";
    }
    unsavedResolutionRef.current = true;
    try {
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
        await persistState(currentState);
      } else if (decision === "discard") {
        restoreSavedState(savedState);
      }
      return decision;
    } finally {
      unsavedResolutionRef.current = false;
    }
  }, [
    hasUnsavedChanges,
    locale,
    persistState,
    requestConfirm,
    restoreSavedState,
    savedState,
    state,
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

function areManagedDocumentsEqual(state: AppState, savedState: AppState | null): boolean {
  if (!savedState) {
    return false;
  }
  return isEqualValue(buildManagedDocuments(state), buildManagedDocuments(savedState));
}
