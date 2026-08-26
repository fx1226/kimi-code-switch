import { useCallback, useEffect, useRef, useState } from "react";

import type { Locale } from "@shared/types";
import type {
  ConfirmDialogState,
  RequestConfirm,
  UnsavedConfirmDialogState,
  UnsavedDecision,
} from "./dialogs";
import { t } from "./i18n";
import { formatMessage } from "./tabComponents";

export function useConfirmDialog(locale: Locale): {
  confirmDialog: ConfirmDialogState | null;
  requestConfirm: RequestConfirm;
  requestUnsavedDecision: (options: UnsavedConfirmDialogState) => Promise<UnsavedDecision>;
  closeConfirmDialog: (confirmed: boolean) => void;
  confirmDeleteResource: (resourceLabel: string, name: string) => Promise<boolean>;
} {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const confirmResolverRef = useRef<
    | { kind: "boolean"; resolve: (value: boolean) => void }
    | { kind: "unsaved"; resolve: (value: UnsavedDecision) => void }
    | null
  >(null);

  const cancelPendingRequest = useCallback((): void => {
    const pending = confirmResolverRef.current;
    confirmResolverRef.current = null;
    if (pending?.kind === "boolean") {
      pending.resolve(false);
    } else if (pending?.kind === "unsaved") {
      pending.resolve("cancel");
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelPendingRequest();
    };
  }, [cancelPendingRequest]);

  const closeUnsavedDecision = useCallback((decision: UnsavedDecision): void => {
    const pending = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    if (pending?.kind === "unsaved") {
      pending.resolve(decision);
    }
  }, []);

  const requestUnsavedDecision = useCallback((options: UnsavedConfirmDialogState): Promise<UnsavedDecision> =>
    new Promise((resolve) => {
      cancelPendingRequest();
      confirmResolverRef.current = { kind: "unsaved", resolve };
      setConfirmDialog({
        ...options,
        onDiscard: () => closeUnsavedDecision("discard"),
      });
    }), [cancelPendingRequest, closeUnsavedDecision]);

  const requestConfirm = useCallback(((options: ConfirmDialogState): Promise<boolean | UnsavedDecision> => {
    if (options.kind === "unsaved") {
      return requestUnsavedDecision(options as UnsavedConfirmDialogState);
    }
    return new Promise<boolean>((resolve) => {
      cancelPendingRequest();
      confirmResolverRef.current = { kind: "boolean", resolve };
      setConfirmDialog(options);
    });
  }) as RequestConfirm, [cancelPendingRequest, requestUnsavedDecision]);

  const closeConfirmDialog = useCallback((confirmed: boolean): void => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    if (resolver?.kind === "boolean") {
      resolver.resolve(confirmed);
    } else if (resolver?.kind === "unsaved") {
      resolver.resolve(confirmed ? "save" : "cancel");
    }
  }, []);

  const confirmDeleteResource = useCallback((resourceLabel: string, name: string): Promise<boolean> =>
    requestConfirm({
      title: formatMessage(t(locale, "deleteResourceConfirm"), {
        resource: resourceLabel,
        name,
      }),
      confirmLabel: t(locale, "delete"),
      cancelLabel: t(locale, "cancel"),
      tone: "danger",
      kind: "delete",
    }), [locale, requestConfirm]);

  return {
    confirmDialog,
    requestConfirm,
    requestUnsavedDecision,
    closeConfirmDialog,
    confirmDeleteResource,
  };
}
