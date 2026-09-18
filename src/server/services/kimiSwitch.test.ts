import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), existsSync: vi.fn(() => false) }));
vi.mock("../native", () => ({ invokeCommand: vi.fn() }));
vi.mock("./cli", () => ({
  detectActiveKimiTarget: vi.fn(async () => ({target:"kimi-code", installed:false, executablePath:"", resolvedPath:"",candidates:[],reason:"test",installSource:"unknown"})),
  runKimiMcpServerTest: vi.fn(),
  listKimiMcpServerTools: vi.fn(),
  callKimiMcpServerTool: vi.fn(),
  getTargetCliVersion: vi.fn(async () => ({installed:false,version:"",latestVersion:"",hasUpdate:false,packageName:"kimi-code",installCommand:"",updateCommand:""})),
}));
import { loadState, loadTargetState, kimiSwitchServices, loadPluginInventory, loadProjectLocalConfig, loadProjectMcpScope, resolveProjectAdditionalDirs } from "./kimiSwitch";
import { invokeCommand as invoke } from "../native";
import { existsSync } from "node:fs";
import { createDefaultPanelSettings } from "@shared/configStore";
import * as cli from "./cli";
import type { AppState } from "@shared/types";
const mockedInvoke=vi.mocked(invoke);
beforeEach(() => { mockedInvoke.mockReset(); vi.mocked(existsSync).mockReturnValue(false); });
describe("Node application services",()=>{
it("loads the nearest project MCP scope without merging it into user configuration", async () => {
    const panelSettings = createDefaultPanelSettings();
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
    const panelSettings = createDefaultPanelSettings();
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

it("loads an empty plugin inventory from the active KIMI_CODE_HOME", async () => {
    const panelSettings = createDefaultPanelSettings();
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
    const panelSettings = createDefaultPanelSettings();
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
    const panelSettings = createDefaultPanelSettings();
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
    const panelSettings = createDefaultPanelSettings();
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
    const panelSettings = createDefaultPanelSettings();
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
  it("does not expose desktop, broad configuration writes, account slots or usage APIs", () => {
    for (const name of ["saveState", "saveStateSafe", "importFullBackup", "restoreBackup", "setTray", "activateOfficialAccount", "usageEnable", "usageQueryOverview", "saveProjectAdditionalDirs"]) {
      expect(kimiSwitchServices).not.toHaveProperty(name);
    }
  });
  it("loads official files without startup migration, recovery or native writes", async () => {
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_panel_settings") return null as never;
      if (command === "read_text") return null as never;
      if (command === "path_exists") return false as never;
      if (command === "list_dir_typed" || command === "list_dir") return [] as never;
      if (command === "real_path") return (args as {path:string}).path as never;
      return undefined as never;
    });
    const state = await loadState();
    expect(state.configPath).toContain(".kimi-code/config.toml");
    const commands = mockedInvoke.mock.calls.map(([command])=>command);
    expect(commands).not.toContain("usage_open");
    expect(commands.some(command => /^(write_|remove_|move_|copy_|migrate_|repair_|save_|prepare_|complete_|activate_)/.test(command))).toBe(false);
    expect(commands).not.toContain("init_official_accounts_store");
    expect(commands).not.toContain("export_legacy_native_config");
  });
  it("reads explicit targets independently when requests overlap", async () => {
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_panel_settings") return null as never;
      if (command === "read_text") return null as never;
      if (command === "path_exists") return false as never;
      if (command === "list_dir_typed" || command === "list_dir") return [] as never;
      if (command === "real_path") return (args as {path:string}).path as never;
      return undefined as never;
    });
    const [one, two] = await Promise.all([
      loadTargetState({id:"one",name:"One",homePath:"/targets/one",kind:"external"}),
      loadTargetState({id:"two",name:"Two",homePath:"/targets/two",kind:"external"}),
    ]);
    expect(one.configPath).toBe("/targets/one/config.toml");
    expect(two.configPath).toBe("/targets/two/config.toml");
    expect(one.panelSettings.active_kimi_code_environment_id).toBe("one");
    expect(two.panelSettings.active_kimi_code_environment_id).toBe("two");
    expect(mockedInvoke.mock.calls.some(([command]) => command === "save_panel_settings")).toBe(false);
  });

  it("uses the explicit target home and working directory for MCP tools", async () => {
    const panelSettings = createDefaultPanelSettings();
    panelSettings.kimi_code_environments = [{ id: "isolated", name: "Isolated", homePath: "/target/kimi", workingDirectory: "/project/target", kind: "external" }];
    panelSettings.active_kimi_code_environment_id = "isolated";
    const state = { panelSettings, mcpConfig: { mcpServers: { example: { transport: "stdio", command: "node", args: [], env: { CUSTOM: "preserved", KIMI_CODE_HOME: "/other/target" }, extra: { cwd: "tools" } } } } } as unknown as AppState;
    await kimiSwitchServices.listMcpServerTools(state, "example");
    expect(cli.listKimiMcpServerTools).toHaveBeenCalledWith("example", expect.objectContaining({ env: { CUSTOM: "preserved", KIMI_CODE_HOME: "/target/kimi" }, extra: { cwd: "/project/target/tools" } }));
    expect(state.mcpConfig.mcpServers.example.env.KIMI_CODE_HOME).toBe("/other/target");
  });

});
