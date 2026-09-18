import { afterEach, describe, expect, it, vi } from "vitest";

import { isDesktopRuntime } from "./runtime";

describe("isDesktopRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("returns false in the plain browser environment", () => {
    expect(isDesktopRuntime()).toBe(false);
  });

  it("returns false when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    expect(isDesktopRuntime()).toBe(false);
  });

  it("returns true when __TAURI_INTERNALS__ is injected", () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    expect(isDesktopRuntime()).toBe(true);
  });
});
