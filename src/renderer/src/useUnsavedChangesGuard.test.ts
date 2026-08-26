import { act, renderHook, waitFor } from "@testing-library/react";

import type { AppState } from "@shared/types";
import { createFallbackState } from "./tabComponents";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";

function createStates(): { state: AppState; savedState: AppState } {
  const savedState = createFallbackState();
  const state = structuredClone(savedState);
  state.mainConfig.default_permission_mode = "yolo";
  return { state, savedState };
}

function renderGuard(decision: "save" | "discard" | "cancel") {
  const { state, savedState } = createStates();
  const requestConfirm = vi.fn().mockResolvedValue(decision);
  const persistState = vi.fn().mockResolvedValue(undefined);
  const restoreSavedState = vi.fn();
  const action = vi.fn();
  const hook = renderHook(() => useUnsavedChangesGuard({
    state,
    savedState,
    locale: "zh-CN",
    requestConfirm,
    persistState,
    restoreSavedState,
  }));

  return {
    ...hook,
    action,
    persistState,
    requestConfirm,
    restoreSavedState,
    savedState,
    state,
  };
}

describe("useUnsavedChangesGuard", () => {
  it("saves and continues after an explicit save decision", async () => {
    const guard = renderGuard("save");

    act(() => guard.result.current.runAfterUnsavedHandled(guard.action));

    await waitFor(() => expect(guard.action).toHaveBeenCalledOnce());
    expect(guard.persistState).toHaveBeenCalledWith(guard.state);
    expect(guard.restoreSavedState).not.toHaveBeenCalled();
  });

  it("discards and continues only after an explicit discard decision", async () => {
    const guard = renderGuard("discard");

    act(() => guard.result.current.runAfterUnsavedHandled(guard.action));

    await waitFor(() => expect(guard.action).toHaveBeenCalledOnce());
    expect(guard.restoreSavedState).toHaveBeenCalledWith(guard.savedState);
    expect(guard.persistState).not.toHaveBeenCalled();
  });

  it("keeps changes and aborts the pending action after cancel", async () => {
    const guard = renderGuard("cancel");

    act(() => guard.result.current.runAfterUnsavedHandled(guard.action));

    await waitFor(() => expect(guard.requestConfirm).toHaveBeenCalledOnce());
    expect(guard.action).not.toHaveBeenCalled();
    expect(guard.persistState).not.toHaveBeenCalled();
    expect(guard.restoreSavedState).not.toHaveBeenCalled();
  });

  it("does not prompt or resolve changes merely because the window blurs", () => {
    const guard = renderGuard("discard");

    act(() => window.dispatchEvent(new Event("blur")));

    expect(guard.requestConfirm).not.toHaveBeenCalled();
    expect(guard.persistState).not.toHaveBeenCalled();
    expect(guard.restoreSavedState).not.toHaveBeenCalled();
  });
});
