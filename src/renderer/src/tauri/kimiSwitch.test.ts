import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
  })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const snapshotMocks = vi.hoisted(() => ({
  captureSnapshotForState: vi.fn(),
  detectExternalChangeConflict: vi.fn(),
  readManagedDocuments: vi.fn(),
}));
vi.mock("./fileSnapshots", () => snapshotMocks);

import { kimiSwitchTauri, loadPluginInventory, loadProjectLocalConfig, loadProjectMcpScope, recoverLegacyNativeConfig, remapPluginDirectoryForRestore, resolveProjectAdditionalDirs } from "./kimiSwitch";
import { RESTORE_TRANSACTION_PATH, SAVE_TRANSACTION_PATH } from "./fileAccess";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppState } from "@shared/types";

const mockedInvoke = vi.mocked(invoke);
const mockedGetVersion = vi.mocked(getVersion);
const mockedOpen = vi.mocked(open);
const mockedOpenUrl = vi.mocked(openUrl);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedGetVersion.mockReset();
  mockedOpen.mockReset();
    mockedOpenUrl.mockReset();
  snapshotMocks.readManagedDocuments.mockReset();
});

describe("kimiSwitchTauri API surface", () => {
  it("recovers only missing legacy SQLite definitions into the registered native home", async () => {
    const settings = await kimiSwitchTauri.defaultSettings();
    const state = {
      configPath: "~/.kimi-code/config.toml",
      mcpConfigPath: "~/.kimi-code/mcp.json",
      panelSettings: settings,
      mainConfig: {
        default_model: "",
        default_plan_mode: false,
        default_permission_mode: "manual",
        merge_all_available_skills: true,
        hooks: [], providers: {}, models: {}, loop_control: {}, background: {}, notifications: {}, services: {}, mcp: {},
      },
      mcpConfig: { mcpServers: {} },
    } as unknown as AppState;
    const writes: Array<{ path: string; content: string }> = [];
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "export_legacy_native_config") {
        return JSON.stringify({
          environments: {
            default: {
              providers: {
                native: { type: "openai", base_url: "https://legacy.example/native", api_key: "legacy-wins-never" },
                recovered: { type: "openai", base_url: "https://legacy.example/recovered", api_key: "legacy-secret" },
              },
              models: {
                "recovered/model": { provider: "recovered", model: "model", max_context_size: 8192, capabilities: [] },
              },
              mcpServers: {
                recovered: { transport: "stdio", command: "npx", args: ["server"], headers: {}, env: {} },
              },
            },
          },
        }) as never;
      }
      if (command === "read_text" && path === "~/.kimi-code/config.toml") {
        return `[providers.native]\ntype = "openai"\nbase_url = "https://native.example"\napi_key = "native-secret"\n` as never;
      }
      if (command === "read_text" && path === "~/.kimi-code/mcp.json") return '{"mcpServers":{}}' as never;
      if (command === "write_text") {
        writes.push(args as { path: string; content: string });
        return undefined as never;
      }
      if (command === "ensure_dir" || command === "clear_recovered_legacy_native_config") return undefined as never;
      return null as never;
    });

    await recoverLegacyNativeConfig(state);

    const config = writes.find((write) => write.path.endsWith("config.toml"))?.content ?? "";
    const mcp = writes.find((write) => write.path.endsWith("mcp.json"))?.content ?? "";
    expect(config).toContain("[providers.recovered]");
    expect(config).toContain('base_url = "https://native.example"');
    expect(config).not.toContain("https://legacy.example/native");
    expect(mcp).toContain('"recovered"');
    expect(mockedInvoke).toHaveBeenCalledWith("clear_recovered_legacy_native_config", {
      environmentIds: ["default"],
    });
  });

  it("does not restore or discard legacy resources that were explicitly disabled", async () => {
    const settings = await kimiSwitchTauri.defaultSettings();
    const state = {
      configPath: "~/.kimi-code/config.toml",
      mcpConfigPath: "~/.kimi-code/mcp.json",
      panelSettings: settings,
      mainConfig: {
        default_model: "",
        default_plan_mode: false,
        default_permission_mode: "manual",
        merge_all_available_skills: true,
        hooks: [], providers: {}, models: {}, loop_control: {}, background: {}, notifications: {}, services: {}, mcp: {},
      },
      mcpConfig: { mcpServers: {} },
    } as unknown as AppState;
    const writes: Array<{ path: string; content: string }> = [];
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "export_legacy_native_config") {
        return JSON.stringify({
          environments: {
            default: {
              providers: {
                disabled: { type: "openai", base_url: "https://legacy.example/disabled", api_key: "secret", enabled: false },
              },
              models: {
                "disabled/model": { provider: "disabled", model: "model", max_context_size: 8192, capabilities: [], enabled: false },
              },
              mcpServers: {},
            },
          },
        }) as never;
      }
      if (command === "read_text" && path === "~/.kimi-code/config.toml") return "" as never;
      if (command === "read_text" && path === "~/.kimi-code/mcp.json") return '{"mcpServers":{}}' as never;
      if (command === "write_text") {
        writes.push(args as { path: string; content: string });
        return undefined as never;
      }
      if (command === "ensure_dir" || command === "clear_recovered_legacy_native_config") return undefined as never;
      return null as never;
    });

    await recoverLegacyNativeConfig(state);

    expect(writes).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalledWith("clear_recovered_legacy_native_config", {
      environmentIds: ["default"],
    });
  });

  it("exposes the aligned state, backup, history, usage, and native integration methods", () => {
    expect(kimiSwitchTauri).toMatchObject({
      loadState: expect.any(Function),
      saveStateSafe: expect.any(Function),
      exportFullBackup: expect.any(Function),
      importFullBackup: expect.any(Function),
      captureSnapshot: expect.any(Function),
      usageOpenSessionTerminal: expect.any(Function),
      scanSkills: expect.any(Function),
      testProfileConnectivity: expect.any(Function),
    });
  });

  it("implements safe dialog, file, and external-link primitives", async () => {
    mockedOpen.mockResolvedValueOnce("/picked/config.toml").mockResolvedValueOnce(null);
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "read_text") return "file-body" as never;
      if (command === "save_file_with_dialog") return "/saved/export.json" as never;
      return undefined as never;
    });

    await expect(kimiSwitchTauri.pickFile()).resolves.toEqual({ canceled: false, filePath: "/picked/config.toml" });
    await expect(kimiSwitchTauri.pickFile()).resolves.toEqual({ canceled: true });
    await expect(kimiSwitchTauri.saveFile("backup")).resolves.toEqual({ canceled: false, filePath: "/saved/export.json" });
    expect(mockedInvoke).toHaveBeenCalledWith("save_file_with_dialog", {
      content: "backup",
      defaultPath: null,
    });
    mockedInvoke.mockResolvedValueOnce(null as never);
    await expect(kimiSwitchTauri.saveFile("backup")).resolves.toEqual({ canceled: true });
    await expect(kimiSwitchTauri.readFile("/picked/config.toml")).resolves.toEqual({ ok: true, content: "file-body" });
    mockedInvoke.mockResolvedValueOnce(null as never);
    await expect(kimiSwitchTauri.readFile("/missing")).resolves.toEqual({ ok: false, error: "File not found." });
    await expect(kimiSwitchTauri.openExternal("http://insecure.example")).rejects.toThrow(/HTTPS/);
    await expect(kimiSwitchTauri.openExternal("https://example.test")).resolves.toEqual({ ok: true });
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.test");
  });

  it("exports and imports the independent WebDAV recovery key through explicit files", async () => {
    mockedOpen.mockResolvedValue("/safe/recovery.key");
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "get_or_create_backup_encryption_secret") return "a".repeat(64) as never;
      if (command === "read_text") return `${"b".repeat(64)}\n` as never;
      if (command === "import_backup_encryption_secret") return "~/.kimi-code-switch-gui/backup-encryption.key" as never;
      if (command === "save_file_with_dialog") return "/safe/recovery.key" as never;
      return undefined as never;
    });

    await expect(kimiSwitchTauri.exportBackupEncryptionKey()).resolves.toEqual({
      canceled: false,
      filePath: "/safe/recovery.key",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("save_file_with_dialog", {
      content: `${"a".repeat(64)}\n`,
      defaultPath: "kimi-backup-recovery-key.txt",
    });

    await expect(kimiSwitchTauri.importBackupEncryptionKey()).resolves.toEqual({
      canceled: false,
      filePath: "/safe/recovery.key",
      keyPath: "~/.kimi-code-switch-gui/backup-encryption.key",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("import_backup_encryption_secret", {
      secret: `${"b".repeat(64)}\n`,
      replace: true,
    });
  });

  it("checks endpoint reachability and update metadata without exposing unsafe schemes", async () => {
    mockedGetVersion.mockResolvedValue("2.2.5");
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command !== "http_request") return undefined as never;
      const url = (args as { url: string }).url;
      if (url.includes("releases/latest")) {
        return {
          status: 200,
          ok: true,
          body: JSON.stringify({
            tag_name: "v2.3.0",
            html_url: "https://github.com/fx1226/kimi-code-switch-gui/releases/tag/v2.3.0",
          }),
        } as never;
      }
      if (url.includes("CHANGELOGS")) return { status: 200, ok: true, body: "# Changelog" } as never;
      return { status: 204, ok: true, body: "" } as never;
    });

    await expect(kimiSwitchTauri.testEndpointReachability("not-a-url")).resolves.toMatchObject({ ok: false, status: 0 });
    await expect(kimiSwitchTauri.testEndpointReachability("file:///tmp/a")).resolves.toMatchObject({ ok: false, status: 0 });
    await expect(kimiSwitchTauri.testEndpointReachability("https://example.test/health")).resolves.toEqual({
      ok: false,
      status: 204,
      message: "HTTP 204",
    });
    await expect(kimiSwitchTauri.checkForUpdates()).resolves.toMatchObject({
      currentVersion: "2.2.5",
      latestVersion: "2.3.0",
      hasUpdate: true,
    });
    await expect(kimiSwitchTauri.readChangelog("zh-CN")).resolves.toBe("# Changelog");
    mockedInvoke.mockResolvedValueOnce({ status: 404, ok: false, body: "" } as never);
    await expect(kimiSwitchTauri.readChangelog("missing")).resolves.toBeNull();
    mockedInvoke.mockResolvedValueOnce({ status: 503, ok: false, body: "" } as never);
    await expect(kimiSwitchTauri.checkForUpdates()).resolves.toMatchObject({
      latestVersion: "",
      hasUpdate: false,
      releaseUrl: "https://github.com/fx1226/kimi-code-switch-gui/releases",
    });
    mockedInvoke.mockRejectedValueOnce(new Error("offline"));
    await expect(kimiSwitchTauri.testEndpointReachability("https://offline.example/health")).resolves.toEqual({
      ok: false,
      status: 0,
      message: "offline",
    });
  });

  it("returns deterministic defaults and safe no-op runtime status before stores start", async () => {
    mockedInvoke.mockResolvedValue({ size: 1024 } as never);

    await expect(kimiSwitchTauri.defaultSettings()).resolves.toMatchObject({ config_target: "kimi-code" });
    await expect(kimiSwitchTauri.getInstallSource()).resolves.toBe("manual");
    await expect(kimiSwitchTauri.usageGetStatus()).resolves.toMatchObject({
      ok: true,
      proxy: { status: "stopped", sessionsTracked: 0, eventsIngested: 0 },
    });
    await expect(kimiSwitchTauri.usageIngestNow()).resolves.toEqual({ ok: true });
    await expect(kimiSwitchTauri.usageCleanup(30)).resolves.toEqual({ ok: true, eventsDeleted: 0, jsonlFilesDeleted: 0 });
    await expect(kimiSwitchTauri.usageResetAllData()).resolves.toEqual({ ok: true });
    await expect(kimiSwitchTauri.usageGetStorageInfo()).resolves.toMatchObject({
      ok: true,
      info: { sqliteBytes: 1024, totalBytes: 1024, exceedsWarn: false },
    });
    expect(() => kimiSwitchTauri.authMcpServer("legacy")).toThrow(/not loaded/);
    expect(() => kimiSwitchTauri.resetMcpServerAuth("legacy")).toThrow(/does not expose MCP authorization reset/);
    expect(() => kimiSwitchTauri.testMcpServer("missing")).toThrow(/MCP server not found/);
    expect(() => kimiSwitchTauri.listMcpServerTools("missing")).toThrow(/MCP server not found/);
    expect(() => kimiSwitchTauri.callMcpServerTool("missing", "tool", "{}")).toThrow(/MCP server not found/);
    await expect(kimiSwitchTauri.setTray(false)).resolves.toEqual({ ok: true });
    await expect(kimiSwitchTauri.refreshTrayMenu()).resolves.toEqual({ ok: true });
  });

  it("builds a doctor report from parseable disk documents and tolerates malformed optional files", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    const state = {
      configTarget: "kimi-code",
      configPath: "~/.kimi-code/config.toml",
      profilesPath: "",
      panelSettingsPath: "~/.kimi-code-switch-gui/config.panel.toml",
      mcpConfigPath: "~/.kimi-code/mcp.json",
      mainConfig: {
        default_model: "",
        default_plan_mode: false,
        default_permission_mode: "",
        merge_all_available_skills: true,
        hooks: [],
        providers: {},
        models: {},
        loop_control: {},
        background: {},
        notifications: {},
        services: {},
        mcp: {},
      },
      profiles: {},
      activeProfile: "",
      panelSettings,
      mcpConfig: { mcpServers: {} },
    } as unknown as AppState;
    snapshotMocks.readManagedDocuments.mockResolvedValue({
      config: 'default_model = ""',
      panel: "not valid toml =",
      mcp: '{"mcpServers":{}}',
    });

    await expect(kimiSwitchTauri.runDoctor(state)).resolves.toMatchObject({
      ok: true,
      issues: expect.any(Array),
      drift: expect.any(Array),
    });
  });

  it("loads the nearest project MCP scope without merging it into user configuration", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "default",
      name: "Default",
      homePath: "~/.kimi-code",
      workingDirectory: "/repo/project/packages/app",
    }];
    panelSettings.active_kimi_code_environment_id = "default";
    const state = {
      panelSettings,
      mcpConfig: { mcpServers: { shared: { transport: "stdio" } } },
    } as unknown as AppState;
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "path_exists") {
        return (path === "/repo/project/.git" || path?.includes("/workspace-trust/wd_app_")) as never;
      }
      if (command === "read_text" && path === "/repo/project/.mcp.json") {
        return JSON.stringify({
          mcpServers: {
            shared: { command: "root-server" },
            rootDefault: { command: "root-default" },
            rootRelative: { command: "root-relative", cwd: "tools/mcp" },
            rootUnc: { command: "root-unc", cwd: "\\\\server\\share\\mcp" },
            projectOnly: { url: "https://project.example/mcp" },
          },
        }) as never;
      }
      if (command === "read_text" && path === "/repo/project/packages/app/.kimi-code/mcp.json") {
        return JSON.stringify({ mcpServers: { shared: { command: "local-server" } } }) as never;
      }
      if (command === "read_text" && path?.includes("/workspace-trust/wd_app_")) {
        return JSON.stringify({ root: "/repo/project/packages/app", trustedAt: 1 }) as never;
      }
      return null as never;
    });

    await loadProjectMcpScope(state);

    expect(state.projectMcpConfig).toMatchObject({
      projectRoot: "/repo/project",
      trusted: true,
      trustPath: "~/.kimi-code/workspace-trust/wd_app_5ea21f888fb8",
    });
    expect(state.projectMcpConfig?.sources?.map((source) => source.scope)).toEqual(["project-root", "project-local"]);
    expect(state.projectMcpConfig?.mcpServers.shared.command).toBe("local-server");
    expect(state.projectMcpConfig?.mcpServers.projectOnly.url).toBe("https://project.example/mcp");
    expect(state.projectMcpConfig?.mcpServers.rootDefault.extra?.cwd).toBe("/repo/project");
    expect(state.projectMcpConfig?.mcpServers.rootRelative.extra?.cwd).toBe("/repo/project/tools/mcp");
    expect(state.projectMcpConfig?.mcpServers.rootUnc.extra?.cwd).toBe("//server/share/mcp");
    expect(state.mcpConfig.mcpServers.shared).toEqual({ transport: "stdio" });
  });

  it("keeps untrusted project MCP declarations out of the effective project set", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "default",
      name: "Default",
      homePath: "~/.kimi-code",
      workingDirectory: "/repo/app",
    }];
    const state = { panelSettings, mcpConfig: { mcpServers: {} } } as unknown as AppState;
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "path_exists") {
        return (path === "/repo/.git" || path?.includes("/workspace-trust/")) as never;
      }
      if (command === "read_text" && path === "/repo/.mcp.json") {
        return '{"mcpServers":{"project":{"command":"node"}}}' as never;
      }
      if (command === "read_text" && path?.includes("/workspace-trust/")) return "{invalid" as never;
      return null as never;
    });

    await loadProjectMcpScope(state);

    expect(state.projectMcpConfig).toMatchObject({ trusted: false, mcpServers: {} });
    expect(state.projectMcpConfig?.declaredMcpServers).toHaveProperty("project");
  });

  it("remaps managed plugin roots when restoring an environment on another home", () => {
    const installed = {
      version: 1,
      plugins: [{
        id: "demo",
        root: "/old/home/plugins/managed/demo",
        source: "github",
        enabled: true,
        installedAt: "now",
      }],
    };
    const bundle = remapPluginDirectoryForRestore({
      exists: true,
      directories: ["managed/demo"],
      files: [{
        relativePath: "installed.json",
        contentBase64: btoa(JSON.stringify(installed)),
        executable: false,
      }],
      sha256: "old-revision",
    }, "/old/home", "/new/home");

    const restored = JSON.parse(atob(bundle.files[0].contentBase64));
    expect(restored.plugins[0].root).toBe("/new/home/plugins/managed/demo");
    expect(bundle.sha256).toBeUndefined();
  });

  it("loads an empty plugin inventory from the active KIMI_CODE_HOME", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "work",
      name: "Work",
      homePath: "/custom/home",
    }];
    panelSettings.active_kimi_code_environment_id = "work";
    const state = { panelSettings } as unknown as AppState;
    mockedInvoke.mockResolvedValue(null as never);

    await loadPluginInventory(state);

    expect(state.pluginInventory).toEqual({
      installedPath: "/custom/home/plugins/installed.json",
      plugins: [],
      skillRoots: [],
      mcpServers: {},
      diagnostics: [],
    });
  });

  it("loads project local.toml additional workspace directories from the nearest Git root", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "default",
      name: "Default",
      homePath: "~/.kimi-code",
      workingDirectory: "/repo/packages/app",
    }];
    const state = { panelSettings } as unknown as AppState;
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "path_exists") return (path === "/repo/.git") as never;
      if (command === "read_text" && path === "/repo/.kimi-code/local.toml") {
        return '[workspace]\nadditional_dir = ["/shared/a", "/shared/b"]\n' as never;
      }
      if (command === "resolve_workspace_directory") {
        return (args as { inputPath: string }).inputPath as never;
      }
      return null as never;
    });

    await loadProjectLocalConfig(state);

    expect(state.projectLocalConfig).toMatchObject({
      projectRoot: "/repo",
      path: "/repo/.kimi-code/local.toml",
      additionalDirs: ["/shared/a", "/shared/b"],
    });
    expect(state.projectLocalConfig?.sha256).toHaveLength(64);
  });

  it("uses the missing-file CAS revision when project local.toml does not exist", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "default",
      name: "Default",
      homePath: "~/.kimi-code",
      workingDirectory: "/repo",
    }];
    const state = { panelSettings } as unknown as AppState;
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "path_exists") return (path === "/repo/.git") as never;
      if (command === "read_text") return null as never;
      return null as never;
    });

    await loadProjectLocalConfig(state);

    expect(state.projectLocalConfig).toMatchObject({
      document: "",
      sha256: "",
    });
  });

  it("surfaces invalid project additional directories instead of claiming an effective config", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "default",
      name: "Default",
      homePath: "~/.kimi-code",
      workingDirectory: "/repo",
    }];
    const state = { panelSettings } as unknown as AppState;
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "path_exists") return (path === "/repo/.git") as never;
      if (command === "read_text") return '[workspace]\nadditional_dir = ["/missing"]\n' as never;
      if (command === "resolve_workspace_directory") {
        throw new Error("workspace.additional_dir must exist and be a directory");
      }
      return null as never;
    });

    await loadProjectLocalConfig(state);

    expect(state.projectLocalConfig).toMatchObject({
      additionalDirs: [],
      error: "workspace.additional_dir must exist and be a directory",
    });
  });

  it("rejects a workspace table that omits the official additional_dir field", async () => {
    const panelSettings = await kimiSwitchTauri.defaultSettings();
    panelSettings.kimi_code_environments = [{
      id: "default",
      name: "Default",
      homePath: "~/.kimi-code",
      workingDirectory: "/repo",
    }];
    const state = { panelSettings } as unknown as AppState;
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path;
      if (command === "path_exists") return (path === "/repo/.git") as never;
      if (command === "read_text") return '[workspace]\nlabel = "missing additional_dir"\n' as never;
      return null as never;
    });

    await loadProjectLocalConfig(state);

    expect(state.projectLocalConfig?.error).toContain("additional_dir");
  });

  it("resolves and deduplicates project additional directories through the native filesystem", async () => {
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command !== "resolve_workspace_directory") return null as never;
      const input = (args as { inputPath: string }).inputPath;
      if (input === "../shared" || input === "/repo/../shared") return "/shared" as never;
      if (input === "~/team") return "/home/user/team" as never;
      throw new Error("workspace.additional_dir must exist and be a directory");
    });

    await expect(resolveProjectAdditionalDirs("/repo", ["../shared", "~/team", "/repo/../shared"]))
      .resolves.toEqual(["/shared", "/home/user/team"]);
    await expect(resolveProjectAdditionalDirs("/repo", ["/missing"]))
      .rejects.toThrow(/must exist and be a directory/);
    expect(mockedInvoke).toHaveBeenCalledWith("resolve_workspace_directory", expect.objectContaining({
      projectRoot: "/repo",
    }));
  });
});

describe("resolveSaveRecovery (C2 manual recovery)", () => {
  const SAVE = SAVE_TRANSACTION_PATH;
  const RESTORE = RESTORE_TRANSACTION_PATH;

  function createFileSystemMock(initial?: Record<string, string | null>) {
    const files: Record<string, string | null> = { ...(initial ?? {}) };
    const calls: Array<{ command: string; args?: Record<string, unknown> | null }> = [];
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = (args ?? {}) as { path?: string; content?: string; expectedSha256?: string; settingsJson?: string };
      calls.push({ command, args: (args ?? null) as Record<string, unknown> | null });
      if (command === "read_text") return files[input.path ?? ""] ?? null as never;
      if (command === "write_text_cas") {
        if (input.path !== undefined) files[input.path] = input.content ?? null;
        return "hash-after" as never;
      }
      if (command === "remove_file_cas") {
        if (input.path !== undefined) delete files[input.path];
        return undefined as never;
      }
      if (command === "remove_file") {
        if (input.path !== undefined) delete files[input.path];
        return undefined as never;
      }
      if (command === "save_file_with_dialog") return "/exported/journal.json" as never;
      if (command === "get_panel_settings") return files["__panel__"] ?? null as never;
      if (command === "save_panel_settings") {
        files["__panel__"] = input.settingsJson ?? null;
        return undefined as never;
      }
      if (command === "import_panel_settings") return true as never;
      return undefined as never;
    });
    return { files, calls };
  }

  const journal = (overrides?: Record<string, unknown>) => JSON.stringify({
    version: 1,
    kind: "save-app-state",
    createdAt: "2026-09-15T00:00:00.000Z",
    textFiles: [
      { path: "/cfg/config.toml", originalContent: "old", desiredContent: "new" },
    ],
    ...overrides,
  });

  const targetWrites = (calls: Array<{ command: string; args?: Record<string, unknown> | null }>) =>
    calls.filter((call) => ["write_text_cas", "remove_file_cas", "write_text"].includes(call.command));

  it("abandon keeps existing behavior: both save and restore journals are removed", async () => {
    const { files, calls } = createFileSystemMock({ [SAVE]: "{}", [RESTORE]: "{}" });

    const result = await kimiSwitchTauri.resolveSaveRecovery("abandon");

    expect(result.ok).toBe(true);
    expect(result.deletedJournals).toEqual([SAVE, RESTORE]);
    expect(SAVE in files).toBe(false);
    expect(RESTORE in files).toBe(false);
    expect(targetWrites(calls)).toEqual([]);
  });

  it("export-journal reuses saveFile and does not delete the journal for later abandon", async () => {
    const raw = journal();
    const { files, calls } = createFileSystemMock({ [SAVE]: raw });

    const result = await kimiSwitchTauri.resolveSaveRecovery("export-journal");

    expect(result.ok).toBe(true);
    expect(result.exportedPath).toBe("/exported/journal.json");
    expect(calls.some((call) => call.command === "save_file_with_dialog")).toBe(true);
    const exportCall = calls.find((call) => call.command === "save_file_with_dialog");
    expect(exportCall?.args?.["content"]).toBe(raw);
    // 导出仅留档：journal 不被自动删除，banner 保持由用户再点放弃。
    expect(files[SAVE]).toBe(raw);
    expect(calls.some((call) => call.command === "remove_file" && call.args?.["path"] === SAVE)).toBe(false);
  });

  it("export-journal reports user-cancel with a null exported path and keeps the journal", async () => {
    const raw = journal();
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = (args ?? {}) as { path?: string };
      if (command === "read_text" && input.path === SAVE) return raw as never;
      if (command === "save_file_with_dialog") return null as never;
      return undefined as never;
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("export-journal");
    expect(result.ok).toBe(true);
    expect(result.exportedPath).toBeNull();
  });

  it("apply-desired writes desired via CAS against the on-disk revision and deletes the save journal", async () => {
    const { files, calls } = createFileSystemMock({
      [SAVE]: journal(),
      "/cfg/config.toml": "old",
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("apply-desired");

    expect(result.ok).toBe(true);
    expect(result.decision).toBe("apply-desired");
    expect(result.writtenFiles).toBe(1);
    expect(result.failures).toEqual([]);
    expect(files["/cfg/config.toml"]).toBe("new");
    expect(SAVE in files).toBe(false);
    const writeCall = targetWrites(calls)[0];
    expect(writeCall.command).toBe("write_text_cas");
    const writeArgs = writeCall.args as { path: string; content: string; expectedSha256: string };
    expect(writeArgs.path).toBe("/cfg/config.toml");
    expect(writeArgs.content).toBe("new");
    expect(writeArgs.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("apply-desired already-desired files are left untouched and counted as unchanged", async () => {
    const { files, calls } = createFileSystemMock({
      [SAVE]: journal(),
      "/cfg/config.toml": "new",
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("apply-desired");

    expect(result.ok).toBe(true);
    expect(result.writtenFiles).toBe(0);
    expect(result.unchangedFiles).toBe(1);
    expect(targetWrites(calls)).toEqual([]);
    expect(files["/cfg/config.toml"]).toBe("new");
  });

  it("apply-desired force-applies desired over an externally modified file (CAS on external revision)", async () => {
    const { files } = createFileSystemMock({
      [SAVE]: journal(),
      "/cfg/config.toml": "external-edit",
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("apply-desired");

    expect(result.ok).toBe(true);
    expect(result.writtenFiles).toBe(1);
    expect(files["/cfg/config.toml"]).toBe("new");
  });

  it("restore-original writes original back and removes files created by the crashed save", async () => {
    const { files, calls } = createFileSystemMock({
      [SAVE]: journal({
        textFiles: [
          { path: "/cfg/config.toml", originalContent: "old", desiredContent: "new" },
          { path: "/cfg/tui.toml", originalContent: null, desiredContent: "theme = \"dark\"" },
        ],
      }),
      "/cfg/config.toml": "new",
      "/cfg/tui.toml": "theme = \"dark\"",
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("restore-original");

    expect(result.ok).toBe(true);
    expect(result.writtenFiles).toBe(1);
    expect(result.removedFiles).toBe(1);
    expect(files["/cfg/config.toml"]).toBe("old");
    expect("/cfg/tui.toml" in files).toBe(false);
    expect(SAVE in files).toBe(false);
    const args = calls
      .filter((call) => call.command === "remove_file_cas")
      .map((call) => call.args as { path: string; expectedSha256: string });
    expect(args).toHaveLength(1);
    expect(args[0].path).toBe("/cfg/tui.toml");
    expect(args[0].expectedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("revision recheck failure (journal vanished) modifies no file and keeps read-only", async () => {
    const { files, calls } = createFileSystemMock({ "/cfg/config.toml": "external" });

    const result = await kimiSwitchTauri.resolveSaveRecovery("apply-desired");

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(targetWrites(calls)).toEqual([]);
    expect(calls.some((call) => call.command === "remove_file")).toBe(false);
    expect(files["/cfg/config.toml"]).toBe("external");
  });

  it("revision recheck failure (target unreadable) modifies no file and keeps read-only", async () => {
    const { files, calls } = createFileSystemMock({ [SAVE]: journal(), "/cfg/config.toml": "old" });
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const input = (args ?? {}) as { path?: string };
      if (command === "read_text" && input.path === SAVE) return journal() as never;
      if (command === "read_text" && input.path === "/cfg/config.toml") throw new Error("read denied");
      if (command === "read_text") return null as never;
      if (command === "get_panel_settings") return null as never;
      return undefined as never;
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("restore-original");

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.path).toBe("/cfg/config.toml");
    expect(targetWrites(calls)).toEqual([]);
    expect(files["/cfg/config.toml"]).toBe("old");
  });

  it("applies the panel resource when it sits at the original revision", async () => {
    const panelOriginal = { version: 1 };
    const panelDesired = { version: 2 };
    const { files, calls } = createFileSystemMock({
      [SAVE]: journal({
        textFiles: [{ path: "/cfg/config.toml", originalContent: "old", desiredContent: "new" }],
        panelOriginal,
        panelDesired,
      }),
      "/cfg/config.toml": "old",
      "__panel__": JSON.stringify(panelOriginal),
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("apply-desired");

    expect(result.ok).toBe(true);
    expect(files["/cfg/config.toml"]).toBe("new");
    const savePanel = calls.find((call) => call.command === "save_panel_settings");
    expect(savePanel).toBeDefined();
    const savePanelArgs = savePanel?.args as { settingsJson: string } | null;
    expect(savePanelArgs).toBeDefined();
    expect((savePanelArgs as { settingsJson: string }).settingsJson).toBe(JSON.stringify(panelDesired));
  });

  it("keeps the journal read-only when the panel resource is externally modified", async () => {
    const { files, calls } = createFileSystemMock({
      [SAVE]: journal({
        textFiles: [{ path: "/cfg/config.toml", originalContent: "old", desiredContent: "new" }],
        panelOriginal: { version: 1 },
        panelDesired: { version: 2 },
      }),
      "/cfg/config.toml": "old",
      "__panel__": JSON.stringify({ version: 999 }),
    });

    const result = await kimiSwitchTauri.resolveSaveRecovery("apply-desired");

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.path).toBe("panel");
    expect(SAVE in files).toBe(true); // journal 保留
    expect(targetWrites(calls).filter((call) => call.command === "write_text_cas")).toEqual([]);
  });
});
