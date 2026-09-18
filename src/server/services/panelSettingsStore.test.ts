import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({ invokeCommand: vi.fn() }));
vi.mock("./fileAccess", () => ({ pathExists: vi.fn() }));

import { invokeCommand as invoke } from "../native";
import { createDefaultPanelSettings } from "@shared/configStore";
import { pathExists } from "./fileAccess";
import {
  exportPanelSettings,
  getPanelSettings,
  importPanelSettings,
  initPanelSettingsStore,
  migratePanelSettingsFromToml,
  savePanelSettings,
} from "./panelSettingsStore";

const mockedInvoke = vi.mocked(invoke);
const mockedPathExists = vi.mocked(pathExists);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedPathExists.mockReset();
});

describe("panelSettingsStore", () => {
  it("initializes and parses persisted settings", async () => {
    const settings = createDefaultPanelSettings();
    mockedInvoke
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(JSON.stringify(settings) as never);

    await initPanelSettingsStore();
    await expect(getPanelSettings()).resolves.toEqual(settings);
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "init_panel_settings_store");
  });

  it("initializes without migrating or rewriting legacy files", async () => {
    mockedPathExists.mockResolvedValue(true);
    mockedInvoke.mockResolvedValue(undefined as never);
    await initPanelSettingsStore();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("init_panel_settings_store");
    expect(mockedPathExists).not.toHaveBeenCalled();
  });

  it("returns null only for an empty settings row and preserves storage failures", async () => {
    mockedInvoke.mockResolvedValueOnce(null as never).mockRejectedValueOnce(new Error("db"));
    await expect(getPanelSettings()).resolves.toBeNull();
    await expect(getPanelSettings()).rejects.toThrow("Failed to read panel settings.");
  });

  it("saves settings without deferring startup migration until after a write", async () => {
    const settings = createDefaultPanelSettings();
    mockedInvoke.mockResolvedValue(undefined as never);

    await expect(savePanelSettings(settings)).resolves.toBe(true);

    expect(mockedInvoke).toHaveBeenCalledWith("save_panel_settings", {
      settingsJson: JSON.stringify(settings),
    });
    expect(mockedPathExists).not.toHaveBeenCalled();
  });

  it("supports export, import and explicit migration failure semantics", async () => {
    const settings = createDefaultPanelSettings();
    mockedInvoke
      .mockResolvedValueOnce("exported" as never)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error("import failed"))
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error("migration failed"));

    await expect(exportPanelSettings()).resolves.toBe("exported");
    await expect(importPanelSettings("{}" )).resolves.toBe(true);
    await expect(importPanelSettings("{}" )).resolves.toBe(false);
    await expect(migratePanelSettingsFromToml("/old.toml", settings)).resolves.toBe(true);
    await expect(migratePanelSettingsFromToml("/old.toml", settings)).resolves.toBe(false);
  });
});
