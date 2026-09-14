import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./fileAccess", () => ({ pathExists: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
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

  it("migrates legacy TOML before any startup code can write default panel settings", async () => {
    mockedPathExists.mockResolvedValue(true);
    mockedInvoke.mockResolvedValue(undefined as never);

    await initPanelSettingsStore();

    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "init_panel_settings_store");
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "migrate_panel_settings_from_toml", {
      tomlPath: "~/.kimi-code-switch-gui/config.panel.toml",
    });
    expect(mockedInvoke).toHaveBeenNthCalledWith(4, "migrate_panel_settings_from_toml", {
      tomlPath: "~/.kimi/config.panel.toml",
    });
  });

  it("returns null for an empty or invalid settings row", async () => {
    mockedInvoke.mockResolvedValueOnce(null as never).mockRejectedValueOnce(new Error("db"));
    await expect(getPanelSettings()).resolves.toBeNull();
    await expect(getPanelSettings()).resolves.toBeNull();
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
