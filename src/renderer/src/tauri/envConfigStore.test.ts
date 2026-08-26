import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  deleteEnvConfig,
  exportAllEnvConfigs,
  getEnvConfig,
  importAllEnvConfigs,
  initEnvConfigStore,
  migrateEnvConfigFromToml,
  saveEnvConfig,
} from "./envConfigStore";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => mockedInvoke.mockReset());

describe("envConfigStore", () => {
  it("initializes, reads defaults, saves, deletes and migrates scoped data", async () => {
    mockedInvoke
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(JSON.stringify({ providers: { p: { type: "openai" } } }) as never)
      .mockResolvedValue(undefined as never);

    await initEnvConfigStore();
    await expect(getEnvConfig("work")).resolves.toEqual({
      providers: { p: { type: "openai" } },
      models: {},
    });
    const data = { providers: {}, models: {} };
    await saveEnvConfig("work", data);
    await deleteEnvConfig("work");
    await migrateEnvConfigFromToml("work", "/work/config.toml");

    expect(mockedInvoke).toHaveBeenCalledWith("save_env_config", {
      environmentId: "work",
      configJson: JSON.stringify(data),
    });
    expect(mockedInvoke).toHaveBeenCalledWith("migrate_env_config_from_toml", {
      environmentId: "work",
      configTomlPath: "/work/config.toml",
    });
  });

  it("handles empty and malformed rows without leaking another environment", async () => {
    mockedInvoke
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce("not-json" as never)
      .mockResolvedValueOnce("not-json" as never);

    await expect(getEnvConfig("empty")).resolves.toBeNull();
    await expect(getEnvConfig("broken")).resolves.toBeNull();
    await expect(exportAllEnvConfigs()).resolves.toEqual({});
  });

  it("round-trips the complete environment map", async () => {
    const all = { work: { providers: {}, models: {} } };
    mockedInvoke.mockResolvedValueOnce(JSON.stringify(all) as never).mockResolvedValueOnce(undefined as never);

    await expect(exportAllEnvConfigs()).resolves.toEqual(all);
    await importAllEnvConfigs(all);
    expect(mockedInvoke).toHaveBeenLastCalledWith("import_all_env_configs", {
      allJson: JSON.stringify(all),
    });
  });
});
