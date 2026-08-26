import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { initMcpServersStore, migrateMcpFromJson } from "./mcpServersStore";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => mockedInvoke.mockReset());

describe("mcpServersStore", () => {
  it("initializes and forwards the one-time JSON migration", async () => {
    mockedInvoke.mockResolvedValue(undefined as never);
    await initMcpServersStore();
    await migrateMcpFromJson("/env/mcp.json");
    expect(mockedInvoke.mock.calls).toEqual([
      ["init_mcp_servers_store"],
      ["migrate_mcp_from_json", { jsonPath: "/env/mcp.json" }],
    ]);
  });
});
