import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  assertKimiCodeHomeEmpty,
  copyDir,
  copyKimiCodeConfiguration,
  listDir,
  mergeDirectoryMissing,
  moveFile,
  pathExists,
  recoverPendingSaveTransaction,
  recoverPendingRestoreTransaction,
  removeDir,
  removeFile,
  tauriFileAccess,
} from "./fileAccess";

const mockedInvoke = vi.mocked(invoke);

describe("copyKimiCodeConfiguration", () => {
  beforeEach(() => mockedInvoke.mockReset());

  it("refuses to clone into a non-empty runtime root", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "path_exists") return true as never;
      if (command === "list_dir") return ["credentials", "sessions"] as never;
      return undefined as never;
    });

    await expect(copyKimiCodeConfiguration("/source", "/target"))
      .rejects.toThrow(/not empty/);
    expect(mockedInvoke).not.toHaveBeenCalledWith("ensure_dir", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("copy_dir", expect.anything());
  });

  it("refuses a fresh managed environment when its generated root has orphaned state", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "path_exists") return true as never;
      if (command === "list_dir") return ["credentials"] as never;
      return undefined as never;
    });

    await expect(assertKimiCodeHomeEmpty("/managed/env-2"))
      .rejects.toThrow(/not empty/);
  });

  it("forwards atomic file operations to the native shell", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "read_text") return "body" as never;
      if (command === "write_text_cas") return "new-hash" as never;
      if (command === "path_exists") return true as never;
      if (command === "list_dir") return ["one"] as never;
      if (command === "merge_directory_missing") {
        return { sourceExists: true, copiedEntries: 2, skippedConflicts: 1 } as never;
      }
      return undefined as never;
    });

    await expect(tauriFileAccess.readText("/a")).resolves.toBe("body");
    await tauriFileAccess.writeText("/a", "next");
    await expect(tauriFileAccess.writeTextCas!("/a", "next", "old")).resolves.toBe("new-hash");
    await tauriFileAccess.removeTextCas!("/a", "new-hash");
    await tauriFileAccess.ensureDir("/dir");
    await removeFile("/a");
    await moveFile("/a", "/b");
    await removeDir("/dir");
    await copyDir("/from", "/to");
    await expect(mergeDirectoryMissing("/from", "/to")).resolves.toEqual({
      sourceExists: true,
      copiedEntries: 2,
      skippedConflicts: 1,
    });
    await expect(pathExists("/a")).resolves.toBe(true);
    await expect(listDir("/dir")).resolves.toEqual(["one"]);

    expect(mockedInvoke).toHaveBeenCalledWith("remove_file_cas", { path: "/a", expectedSha256: "new-hash" });
    expect(mockedInvoke).toHaveBeenCalledWith("move_file", { from: "/a", to: "/b" });
    expect(mockedInvoke).toHaveBeenCalledWith("merge_directory_missing", { from: "/from", to: "/to" });
  });

  it("clones only portable configuration, strips secrets, and copies Skills", async () => {
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = args as { path?: string } | undefined;
      if (command === "path_exists") {
        return (input?.path === "/source/skills" || input?.path === "/source/plugins") as never;
      }
      if (command === "read_text") {
        if (input?.path?.endsWith("config.toml")) {
          return '[providers.p]\ntype = "openai"\napi_key = "secret"\n' as never;
        }
        if (input?.path?.endsWith("mcp.json")) {
          return '{"mcpServers":{"x":{"url":"https://x","headers":{"Authorization":"secret"}}}}' as never;
        }
        if (input?.path?.endsWith("tui.toml")) return 'theme = "dark"' as never;
        if (input?.path?.endsWith("AGENTS.md")) return "# Agent" as never;
        if (input?.path === "/target/plugins/installed.json") {
          return JSON.stringify({
            version: 1,
            plugins: [{ id: "demo", root: "/source/plugins/managed/demo" }],
          }) as never;
        }
        return null as never;
      }
      if (command === "resolve_home_path") return "/target" as never;
      return undefined as never;
    });

    await copyKimiCodeConfiguration("/source", "/target");

    const writes = mockedInvoke.mock.calls
      .filter((call) => call[0] === "write_text")
      .map((call) => call[1] as { path: string; content: string });
    expect(writes.find((write) => write.path.endsWith("config.toml"))?.content).not.toContain("secret");
    expect(writes.find((write) => write.path.endsWith("mcp.json"))?.content).not.toContain("secret");
    expect(mockedInvoke).toHaveBeenCalledWith("copy_dir", {
      from: "/source/skills",
      to: "/target/skills",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("copy_dir", {
      from: "/source/plugins",
      to: "/target/plugins",
    });
    expect(writes.find((write) => write.path === "/target/plugins/installed.json")?.content)
      .toContain("/target/plugins/managed/demo");
  });

  it("clears a crash journal when every changed file reached the desired revision", async () => {
    const journal = JSON.stringify({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [{ path: "/config", originalContent: "old", desiredContent: "new" }],
    });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "read_text" && path?.endsWith("pending-save-transaction.json")) return journal as never;
      if (command === "read_text" && path === "/config") return "new" as never;
      return undefined as never;
    });

    await expect(recoverPendingSaveTransaction()).resolves.toEqual({ recovered: true, action: "commit" });
    expect(mockedInvoke).toHaveBeenCalledWith("remove_file", expect.objectContaining({
      path: expect.stringContaining("pending-save-transaction.json"),
    }));
  });

  it("CAS-rolls back only desired files from a half-completed crash journal", async () => {
    const contents: Record<string, string | null> = { "/config": "new", "/mcp": "old-mcp" };
    const journal = JSON.stringify({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [
        { path: "/config", originalContent: "old", desiredContent: "new" },
        { path: "/mcp", originalContent: "old-mcp", desiredContent: "new-mcp" },
      ],
    });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = args as { path?: string; content?: string } | undefined;
      if (command === "read_text" && input?.path?.endsWith("pending-save-transaction.json")) return journal as never;
      if (command === "read_text" && input?.path) return contents[input.path] as never;
      if (command === "write_text_cas" && input?.path) {
        contents[input.path] = input.content ?? null;
        return "rollback-hash" as never;
      }
      return undefined as never;
    });

    await expect(recoverPendingSaveTransaction()).resolves.toEqual({ recovered: true, action: "rollback" });
    expect(contents["/config"]).toBe("old");
    expect(contents["/mcp"]).toBe("old-mcp");
  });

  it("enters read-only recovery mode when a file has an unknown external revision", async () => {
    const journal = JSON.stringify({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [{ path: "/config", originalContent: "old", desiredContent: "new" }],
    });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "read_text" && path?.endsWith("pending-save-transaction.json")) return journal as never;
      if (command === "read_text" && path === "/config") return "external" as never;
      return undefined as never;
    });

    // C2：unknown 进入只读恢复模式，不自动覆盖、不隔离、不抛错阻塞启动。
    const result = await recoverPendingSaveTransaction();
    expect(result.action).toBe("unknown");
    expect(result.journal).toBeDefined();
    expect(mockedInvoke).not.toHaveBeenCalledWith("remove_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("write_text_cas", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("quarantine_journal", expect.anything());
  });

  it("handles absent journals and quarantines malformed/unsupported journal JSON", async () => {
    mockedInvoke.mockResolvedValueOnce(null as never);
    await expect(recoverPendingSaveTransaction()).resolves.toEqual({ recovered: false, action: "none" });

    mockedInvoke
      .mockResolvedValueOnce("{bad-json" as never)
      .mockResolvedValueOnce("~/.kimi-code-switch-gui/quarantine/pending-save-transaction.json.abc123" as never);
    await expect(recoverPendingSaveTransaction()).resolves.toMatchObject({
      recovered: false,
      action: "quarantined",
      reason: "malformed",
    });

    mockedInvoke
      .mockResolvedValueOnce(JSON.stringify({ version: 99, kind: "unknown", textFiles: [] }) as never)
      .mockResolvedValueOnce("~/.kimi-code-switch-gui/quarantine/pending-save-transaction.json.def456" as never);
    await expect(recoverPendingSaveTransaction()).resolves.toMatchObject({
      recovered: false,
      action: "quarantined",
      reason: "unsupported",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("quarantine_journal", {
      path: expect.stringContaining("pending-save-transaction.json"),
    });
  });

  it("rolls SQLite panel settings back when only the panel half committed", async () => {
    const panelOriginal = { version: 1, config_path: "/old" };
    const panelDesired = { version: 1, config_path: "/new" };
    const journal = JSON.stringify({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [{ path: "/config", originalContent: "old", desiredContent: "new" }],
      panelOriginal,
      panelDesired,
    });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "read_text" && path?.endsWith("pending-save-transaction.json")) return journal as never;
      if (command === "read_text" && path === "/config") return "old" as never;
      if (command === "get_panel_settings") return JSON.stringify(panelDesired) as never;
      if (command === "path_exists") return false as never;
      return undefined as never;
    });

    await expect(recoverPendingSaveTransaction()).resolves.toEqual({ recovered: true, action: "rollback" });
    expect(mockedInvoke).toHaveBeenCalledWith("save_panel_settings", {
      settingsJson: JSON.stringify(panelOriginal),
    });
  });

  it("C3: recovers a crashed restore transaction by completing desired revisions", async () => {
    const panelOriginal = { version: 1, config_path: "/old" };
    const panelDesired = { version: 1, config_path: "/new" };
    const journal = JSON.stringify({
      version: 1,
      kind: "restore-app-state",
      createdAt: "now",
      textFiles: [
        { path: "/config", originalContent: "old", desiredContent: "new" },
        { path: "/mcp", originalContent: "old-mcp", desiredContent: "new-mcp" },
      ],
      panelOriginal,
      panelDesired,
    });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = args as { path?: string } | undefined;
      if (command === "read_text" && input?.path?.endsWith("pending-restore-transaction.json")) return journal as never;
      if (command === "read_text" && input?.path) return { "/config": "new", "/mcp": "old-mcp" }[input.path] as never;
      if (command === "get_panel_settings") return JSON.stringify(panelDesired) as never;
      if (command === "write_text_cas" && input?.path) return "hash" as never;
      return undefined as never;
    });

    // mixed: /config=desired, /mcp=original, panel=desired → 补全 /mcp 的 desired，即 commit。
    const result = await recoverPendingRestoreTransaction();
    expect(result.action).toBe("commit");
    const writeCall = mockedInvoke.mock.calls.find((call) => call[0] === "write_text_cas")?.[1] as { path?: string; content?: string; expectedSha256?: string } | undefined;
    expect(writeCall?.path).toBe("/mcp");
    expect(writeCall?.content).toBe("new-mcp");
    expect(writeCall?.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mockedInvoke).toHaveBeenCalledWith("remove_file", expect.objectContaining({
      path: expect.stringContaining("pending-restore-transaction.json"),
    }));
  });

  it("C3: enters read-only unknown mode when restore target has unknown external revision", async () => {
    const journal = JSON.stringify({
      version: 1,
      kind: "restore-app-state",
      createdAt: "now",
      textFiles: [{ path: "/config", originalContent: "old", desiredContent: "new" }],
      panelOriginal: null,
      panelDesired: null,
    });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = args as { path?: string } | undefined;
      if (command === "read_text" && input?.path?.endsWith("pending-restore-transaction.json")) return journal as never;
      if (command === "read_text" && input?.path === "/config") return "external-edited" as never;
      return undefined as never;
    });

    const result = await recoverPendingRestoreTransaction();
    expect(result.action).toBe("unknown");
    expect(mockedInvoke).not.toHaveBeenCalledWith("quarantine_journal", expect.anything());
  });
});
