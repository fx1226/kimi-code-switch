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

function renderGuard(decision: "save" | "discard" | "cancel", saveResult = true) {
  const { state, savedState } = createStates();
  const requestConfirm = vi.fn().mockResolvedValue(decision);
  const persistState = vi.fn().mockResolvedValue(saveResult);
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
  it("ignores auto-saved UI view state differences", async () => {
    const savedState = createFallbackState();
    const state = structuredClone(savedState);
    state.panelSettings.uiState = { activeTab: "insights" };
    const requestConfirm = vi.fn();
    const hook = renderHook(() => useUnsavedChangesGuard({
      state,
      savedState,
      locale: "zh-CN",
      requestConfirm,
      persistState: vi.fn(),
      restoreSavedState: vi.fn(),
    }));

    expect(hook.result.current.hasUnsavedChanges).toBe(false);
    await expect(hook.result.current.resolveUnsavedChanges()).resolves.toBe("unchanged");
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ["profile", (state: AppState) => {
      state.profiles.draft = {
        name: "draft",
        label: "Edited",
        default_model: "",
        default_plan_mode: false,
        default_permission_mode: "manual",
        merge_all_available_skills: false,
      };
    }],
    ["tui", (state: AppState) => { state.tuiConfig = { theme: "dark" }; }],
    ["model pricing", (state: AppState) => {
      state.mainConfig.models["provider/model"] = {
        provider: "provider",
        model: "model",
        max_context_size: 1024,
        capabilities: [],
        pricing: {
          input_per_mtok: 1,
          output_per_mtok: 2,
          cache_read_per_mtok: 0.1,
          cache_creation_per_mtok: 0.2,
        },
      };
    }],
    ["project dirs", (state: AppState) => {
      state.projectLocalConfig = {
        projectRoot: "/tmp/project",
        workingDirectory: "/tmp/project",
        path: "/tmp/project/.kimi/local.toml",
        additionalDirs: ["/tmp/extra"],
        document: "",
        sha256: "baseline",
      };
    }],
  ])("detects a real %s draft", (_label, mutate) => {
    const savedState = createFallbackState();
    const state = structuredClone(savedState);
    mutate(state);
    const hook = renderHook(() => useUnsavedChangesGuard({
      state,
      savedState,
      locale: "zh-CN",
      requestConfirm: vi.fn(),
      persistState: vi.fn(),
      restoreSavedState: vi.fn(),
    }));

    expect(hook.result.current.hasUnsavedChanges).toBe(true);
  });

  it("waits for an in-flight save and rechecks the latest state before prompting", async () => {
    const { state, savedState } = createStates();
    const stateRef = { current: state };
    const savedStateRef = { current: savedState as AppState | null };
    let releaseSave: (() => void) | undefined;
    const waitForPendingSaves = vi.fn(() => new Promise<void>((resolve) => {
      releaseSave = () => {
        savedStateRef.current = structuredClone(stateRef.current);
        resolve();
      };
    }));
    const requestConfirm = vi.fn();
    const hook = renderHook(() => useUnsavedChangesGuard({
      state,
      savedState,
      stateRef,
      savedStateRef,
      waitForPendingSaves,
      locale: "zh-CN",
      requestConfirm,
      persistState: vi.fn(),
      restoreSavedState: vi.fn(),
    }));

    const resolution = hook.result.current.resolveUnsavedChanges();
    expect(requestConfirm).not.toHaveBeenCalled();
    releaseSave?.();
    await expect(resolution).resolves.toBe("unchanged");
    expect(requestConfirm).not.toHaveBeenCalled();
  });

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

  it("treats a failed save as cancel and does not run the guarded action", async () => {
    const guard = renderGuard("save", false);

    await expect(guard.result.current.resolveUnsavedChanges()).resolves.toBe("cancel");
    act(() => guard.result.current.runAfterUnsavedHandled(guard.action));

    await waitFor(() => expect(guard.persistState).toHaveBeenCalled());
    expect(guard.action).not.toHaveBeenCalled();
  });

  it("does not prompt or resolve changes merely because the window blurs", () => {
    const guard = renderGuard("discard");

    act(() => window.dispatchEvent(new Event("blur")));

    expect(guard.requestConfirm).not.toHaveBeenCalled();
    expect(guard.persistState).not.toHaveBeenCalled();
    expect(guard.restoreSavedState).not.toHaveBeenCalled();
  });
});
