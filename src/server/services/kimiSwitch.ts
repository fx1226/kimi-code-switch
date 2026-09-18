// Node application services. Official-file mutations belong to the configuration kernel.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { invokeCommand as invoke } from "../native";
import { isDbOpen } from "../native/usage";
import { getAppPaths, getKimiCodeHome } from "../native/paths";
import parseTomlString from "@iarna/toml/parse-string.js";
import {
  createDefaultPanelSettings, getKimiCodeConfigPath, getKimiCodeEnvironmentHomePath,
  normalizeKimiCodeEnvironments, normalizeStatePaths, loadAppState,
} from "@shared/configStore";
import { parseMcpConfig } from "@shared/mcpStore";
import { resolveNearestGitProjectRoot, scanSkills } from "@shared/skillsStore";
import { scanKimiPlugins } from "@shared/pluginStore";
import type { Target } from "@shared/webApi";
import type { AppState, McpServerConfig } from "@shared/types";
import type { FileAccess } from "@shared/configStore";
import { initPanelSettingsStore, getPanelSettings } from "./panelSettingsStore";
import * as cli from "./cli";

const rejectReadMutation = async (): Promise<never> => { throw new Error("Configuration reads cannot write files."); };
const readFileAccess: FileAccess = {
  readText: (path: string) => invoke<string | null>("read_text", { path }),
  writeText: rejectReadMutation,
  writeTextCas: rejectReadMutation,
  writePanelSettings: rejectReadMutation,
  ensureDir: rejectReadMutation,
};
const skillFileAccess = {
  readText: readFileAccess.readText,
  listDir: (path: string) => invoke<Array<{ name: string; isDirectory: boolean }>>("list_dir_typed", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  realPath: (path: string) => invoke<string>("real_path", { path }),
};

async function sha256Text(content: string | null): Promise<string> {
  return content === null ? "" : createHash("sha256").update(content).digest("hex");
}

function normalizeLexicalPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const unc = normalized.startsWith("//");
  const drive = unc ? "" : normalized.match(/^[A-Za-z]:/u)?.[0] ?? "";
  const absolute = normalized.startsWith("/") || Boolean(drive);
  const body = unc ? normalized.slice(2) : drive ? normalized.slice(drive.length) : normalized;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = unc ? "//" : drive ? `${drive}/` : absolute ? "/" : "";
  return `${prefix}${parts.join("/")}` || (absolute ? prefix : ".");
}

export function normalizeProjectRootMcpServers(
  servers: Record<string, McpServerConfig>,
  projectRoot: string,
): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    if (server.transport !== "stdio") return [name, server];
    const configuredCwd = typeof server.extra?.cwd === "string" ? server.extra.cwd.trim() : "";
    const cwdIsAbsolute = configuredCwd.startsWith("/")
      || configuredCwd.startsWith("\\\\")
      || /^[A-Za-z]:[\\/]/u.test(configuredCwd);
    const resolvedCwd = configuredCwd
      ? normalizeLexicalPath(cwdIsAbsolute ? configuredCwd : `${projectRoot}/${configuredCwd}`)
      : normalizeLexicalPath(projectRoot);
    return [name, {
      ...server,
      extra: { ...(server.extra ?? {}), cwd: resolvedCwd },
    }];
  }));
}

async function workspaceTrustMarkerPath(homePath: string, workingDirectory: string): Promise<string> {
  const normalized = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").at(-1) ?? normalized;
  const slugCandidate = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  const slug = !slugCandidate || slugCandidate === "." || slugCandidate === ".."
    ? "workspace"
    : slugCandidate;
  const hash = (await sha256Text(normalized)).slice(0, 12);
  return `${homePath.replace(/\/+$/, "")}/workspace-trust/wd_${slug}_${hash}`;
}

async function readWorkspaceTrust(markerPath: string): Promise<boolean> {
  try {
    const document = await readFileAccess.readText(markerPath);
    if (document === null) return false;
    JSON.parse(document);
    return true;
  } catch {
    return false;
  }
}

export async function loadProjectMcpScope(state: AppState): Promise<void> {
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  const workingDirectory = environment?.workingDirectory?.trim();
  if (!workingDirectory) {
    state.projectMcpConfig = undefined;
    return;
  }
  const normalizedWorkingDirectory = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const projectRoot = await resolveNearestGitProjectRoot(skillFileAccess, normalizedWorkingDirectory)
    ?? normalizedWorkingDirectory;
  const environmentHome = environment?.homePath ?? (activeId === "default" ? "~/.kimi-code" : getKimiCodeEnvironmentHomePath(activeId));
  const trustPath = await workspaceTrustMarkerPath(environmentHome, normalizedWorkingDirectory);
  const trusted = await readWorkspaceTrust(trustPath);
  const sourceSpecs = [
    { scope: "project-root" as const, path: `${projectRoot}/.mcp.json` },
    { scope: "project-local" as const, path: `${normalizedWorkingDirectory}/.kimi-code/mcp.json` },
  ].filter((source, index, all) => all.findIndex((candidate) => candidate.path === source.path) === index);
  const sources = await Promise.all(sourceSpecs.map(async (source): Promise<{
    scope: "project-root" | "project-local";
    path: string;
    mcpServers: Record<string, McpServerConfig>;
    error?: string;
  }> => {
    const document = await readFileAccess.readText(source.path);
    if (document === null) return { ...source, mcpServers: {} };
    try {
      const parsedServers = parseMcpConfig(document, { sourcePath: source.path }).mcpServers;
      return {
        ...source,
        mcpServers: source.scope === "project-root"
          ? normalizeProjectRootMcpServers(parsedServers, projectRoot)
          : parsedServers,
      };
    } catch (error) {
      return {
        ...source,
        mcpServers: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const declaredMcpServers = Object.assign({}, ...sources.map((source) => source.mcpServers));
  const errors = sources.flatMap((source) => source.error ? [`${source.path}: ${source.error}`] : []);
  state.projectMcpConfig = {
    projectRoot,
    configPath: sources.map((source) => source.path).join(" → "),
    trusted,
    trustPath,
    declaredMcpServers,
    mcpServers: trusted ? declaredMcpServers : {},
    error: errors.length > 0 ? errors.join("; ") : undefined,
    sources,
  };
}

export async function loadPluginInventory(state: AppState): Promise<void> {
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  const home = environment?.homePath ?? (activeId === "default" ? "~/.kimi-code" : getKimiCodeEnvironmentHomePath(activeId));
  state.pluginInventory = await scanKimiPlugins(skillFileAccess, home);
}

export async function loadProjectLocalConfig(state: AppState): Promise<void> {
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? "default";
  const environment = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((candidate) => candidate.id === activeId);
  const workingDirectory = environment?.workingDirectory?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!workingDirectory) {
    state.projectLocalConfig = undefined;
    return;
  }
  const projectRoot = await resolveNearestGitProjectRoot(skillFileAccess, workingDirectory)
    ?? workingDirectory;
  const path = `${projectRoot}/.kimi-code/local.toml`;
  const existingDocument = await readFileAccess.readText(path);
  const document = existingDocument ?? "";
  try {
    const parsed = document.trim() ? parseTomlString(document) as Record<string, unknown> : {};
    if (parsed.workspace !== undefined && (typeof parsed.workspace !== "object" || parsed.workspace === null || Array.isArray(parsed.workspace))) {
      throw new Error("workspace must be a table");
    }
    const workspace = parsed.workspace && typeof parsed.workspace === "object" && !Array.isArray(parsed.workspace)
      ? parsed.workspace as Record<string, unknown>
      : {};
    if (parsed.workspace !== undefined && workspace.additional_dir === undefined) {
      throw new Error("workspace.additional_dir must be an array of strings");
    }
    if (workspace.additional_dir !== undefined && !Array.isArray(workspace.additional_dir)) {
      throw new Error("workspace.additional_dir must be an array of strings");
    }
    const configuredDirs = Array.isArray(workspace.additional_dir)
      ? workspace.additional_dir.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (Array.isArray(workspace.additional_dir) && configuredDirs.length !== workspace.additional_dir.length) {
      throw new Error("workspace.additional_dir must be an array of strings");
    }
    const additionalDirs = await resolveProjectAdditionalDirs(projectRoot, configuredDirs);
    state.projectLocalConfig = {
      projectRoot,
      workingDirectory,
      path,
      additionalDirs,
      document,
      sha256: await sha256Text(existingDocument),
    };
  } catch (error) {
    state.projectLocalConfig = {
      projectRoot,
      workingDirectory,
      path,
      additionalDirs: [],
      document,
      sha256: await sha256Text(existingDocument),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveProjectAdditionalDirs(
  projectRoot: string,
  additionalDirs: string[],
): Promise<string[]> {
  // pathe.normalize("") used by Kimi resolves to "."; whitespace-only values
  // remain invalid after trim. The textarea already removes blank visual rows
  // for new edits, while existing official documents retain this edge case.
  const inputs = additionalDirs.map((entry) => entry === "" ? "." : entry);
  const resolved = await Promise.all(inputs.map((inputPath) => invoke<string>(
    "resolve_workspace_directory",
    { projectRoot, inputPath },
  )));
  return [...new Set(resolved)];
}

async function loadTuiRevision(state: AppState): Promise<void> {
  const normalized = normalizeStatePaths(state);
  const environmentHome = normalized.configPath.replace(/\/config\.toml$/, "");
  state.tuiConfigSha256 = await sha256Text(
    await readFileAccess.readText(`${environmentHome}/tui.toml`),
  );
}

/** Read official files without recovering, migrating or rewriting them on startup. */
export interface LoadStatePaths {
  configPath?: string;
  mcpConfigPath?: string;
  profilesPath?: string;
  panelSettingsPath?: string;
}

export async function loadState(paths?: LoadStatePaths, target?: Target): Promise<AppState> {
  // Inventory reads must not create a competing empty database before legacy migration.
  let savedSettings = null;
  if (existsSync(getAppPaths().databasePath)) {
    if (!isDbOpen()) await invoke("usage_open", { dbPath: getAppPaths().databasePath, schemaSql: "" });
    await initPanelSettingsStore();
    savedSettings = await getPanelSettings();
  }
  const settings = structuredClone(savedSettings ?? createDefaultPanelSettings());
  if (!savedSettings) {
    const homePath = getKimiCodeHome();
    settings.kimi_code_environments = [{ id: "default", name: "默认环境", homePath, kind: "external" }];
    settings.active_kimi_code_environment_id = "default";
    settings.config_path = getKimiCodeConfigPath(homePath);
  }
  if (target) {
    settings.kimi_code_environments = [{
      id: target.id, name: target.name, homePath: target.homePath,
      workingDirectory: target.workingDirectory,
      kind: target.kind === "default" ? "external" : target.kind,
      profiles: (settings.kimi_code_environments ?? []).find((entry) => entry.id === target.id)?.profiles,
      activeProfile: (settings.kimi_code_environments ?? []).find((entry) => entry.id === target.id)?.activeProfile,
    }];
    settings.active_kimi_code_environment_id = target.id;
    settings.config_path = getKimiCodeConfigPath(target.homePath);
  }
  const state = await loadAppState({
    ...readFileAccess,
    readPanelSettings: async () => settings,
  }, paths);
  await Promise.all([loadPluginInventory(state), loadProjectMcpScope(state), loadProjectLocalConfig(state), loadTuiRevision(state)]);
  return state;
}

export function loadTargetState(target: Target): Promise<AppState> {
  return loadState(undefined, target);
}

/** Resolve process context from the explicit request target, never a global active state. */
function mcpServerForTarget(state: AppState, name: string): McpServerConfig {
  const server = state.mcpConfig.mcpServers[name];
  if (!server) throw new Error(`MCP server not found: ${name}`);
  if (server.transport !== "stdio") return server;
  const target = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments)
    .find((entry) => entry.id === state.panelSettings.active_kimi_code_environment_id);
  if (!target) throw new Error("MCP target context is missing.");
  const cwd = target.workingDirectory?.trim() || target.homePath;
  const configuredCwd = typeof server.extra?.cwd === "string" ? server.extra.cwd.trim() : "";
  return {
    ...server,
    env: { ...server.env, KIMI_CODE_HOME: target.homePath },
    extra: { ...server.extra, cwd: configuredCwd ? resolve(cwd, configuredCwd) : cwd },
  };
}

export const kimiSwitchServices = {
  scanSkills: (state: AppState) => {
    const normalized = normalizeStatePaths(state);
    const activeEnvironmentId = normalized.panelSettings.active_kimi_code_environment_id ?? "default";
    const activeEnvironment = normalizeKimiCodeEnvironments(normalized.panelSettings.kimi_code_environments)
      .find((environment) => environment.id === activeEnvironmentId);
    return scanSkills(skillFileAccess, {
      mergeAllAvailableSkills: normalized.mainConfig.merge_all_available_skills,
      // 用户技能跟随 KIMI_CODE_HOME；项目技能按 GUI 启动 Kimi 时相同的 cwd 向上找最近 Git 根。
      envHome: activeEnvironment?.homePath ?? getKimiCodeEnvironmentHomePath(activeEnvironmentId),
      projectWorkingDirectory: activeEnvironment?.workingDirectory,
      pluginSkillRoots: normalized.pluginInventory?.skillRoots ?? [],
      // config.toml extra_skill_dirs 追加目录。
      extraSkillDirs: normalized.mainConfig.extra_skill_dirs ?? [],
    });
  },
  testMcpServer: (state: AppState, name: string) => cli.runKimiMcpServerTest(name, mcpServerForTarget(state, name)),
  listMcpServerTools: (state: AppState, name: string) => cli.listKimiMcpServerTools(name, mcpServerForTarget(state, name)),
  callMcpServerTool: (state: AppState, name: string, toolName: string, argsJson: string) => cli.callKimiMcpServerTool(name, mcpServerForTarget(state, name), toolName, argsJson),
};
