import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  clearRecoveredLegacyNativeConfig,
  exportLegacyNativeConfig,
} from "./legacyNativeConfig";

const mockedInvoke = vi.mocked(invoke);

describe("legacyNativeConfig", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("normalizes a read-only legacy export without preserving invalid shapes", async () => {
    mockedInvoke.mockResolvedValueOnce(JSON.stringify({
      environments: {
        work: {
          providers: { gateway: { api_key: "secret" } },
          models: { "gateway/model": { provider: "gateway" } },
          mcpServers: { local: { command: "npx" } },
        },
        invalid: [],
      },
    }) as never);

    await expect(exportLegacyNativeConfig()).resolves.toEqual({
      environments: {
        work: {
          providers: { gateway: { api_key: "secret" } },
          models: { "gateway/model": { provider: "gateway" } },
          mcpServers: { local: { command: "npx" } },
        },
        invalid: { providers: {}, models: {}, mcpServers: {} },
      },
    });
    expect(mockedInvoke).toHaveBeenCalledWith("export_legacy_native_config");
  });

  it("clears only explicitly recovered environment ids", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined as never);

    await clearRecoveredLegacyNativeConfig(["default", "work"]);

    expect(mockedInvoke).toHaveBeenCalledWith("clear_recovered_legacy_native_config", {
      environmentIds: ["default", "work"],
    });
  });
});
