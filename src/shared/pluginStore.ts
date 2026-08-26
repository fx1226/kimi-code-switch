import { parseMcpConfigStrict } from "./mcpStore";
import type {
  McpServerConfig,
  PluginDiagnostic,
  PluginInventoryItem,
  PluginInventoryReport,
  PluginSkillRoot,
} from "./types";

export interface PluginFileAccess {
  readText(path: string): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  realPath?(path: string): Promise<string>;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPath(...segments: string[]): string {
  return segments.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function resolvePluginPath(root: string, value: string): string | null {
  if (!value.startsWith("./")) return null;
  const relative = value.slice(2).replace(/\\/g, "/");
  const components = relative.split("/").filter(Boolean);
  if (components.some((component) => component === "." || component === "..")) return null;
  return components.length > 0 ? joinPath(root, ...components) : root;
}

async function resolveContainedPluginPath(
  files: PluginFileAccess,
  root: string,
  value: string,
): Promise<string | null> {
  const lexical = resolvePluginPath(root, value);
  if (!lexical) return null;
  if (!files.realPath) return lexical;
  const rootReal = await files.realPath(root).catch(() => normalizePath(root));
  const candidateReal = await files.realPath(lexical).catch(() => normalizePath(lexical));
  const normalizedRoot = normalizePath(rootReal);
  const normalizedCandidate = normalizePath(candidateReal);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
    ? normalizedCandidate
    : null;
}

function pluginDiagnostic(severity: PluginDiagnostic["severity"], message: string): PluginDiagnostic {
  return { severity, message };
}

async function readJsonRecord(
  files: PluginFileAccess,
  path: string,
): Promise<{ value?: Record<string, unknown>; error?: string }> {
  const document = await files.readText(path);
  if (document === null) return {};
  try {
    const value = JSON.parse(document) as unknown;
    return isRecord(value) ? { value } : { error: `${path} must contain a JSON object` };
  } catch (error) {
    return { error: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readStringArray(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
  return value === undefined ? [] : null;
}

function clonePluginMcpServer(
  server: McpServerConfig,
  options: { pluginId: string; serverName: string; root: string; home: string; enabled: boolean },
): [string, McpServerConfig] {
  const runtimeName = `plugin-${options.pluginId}:${options.serverName}`;
  if (server.transport !== "stdio") {
    return [runtimeName, {
      ...server,
      enabled: options.enabled,
      headers: { ...server.headers },
      args: [...server.args],
      env: { ...server.env },
      extra: server.extra ? structuredClone(server.extra) : undefined,
    }];
  }
  const existingCwd = typeof server.extra?.cwd === "string" ? server.extra.cwd : "";
  return [runtimeName, {
    ...server,
    enabled: options.enabled,
    headers: { ...server.headers },
    args: [...server.args],
    env: {
      ...server.env,
      KIMI_CODE_HOME: options.home,
      KIMI_PLUGIN_ROOT: options.root,
    },
    extra: {
      ...(server.extra ? structuredClone(server.extra) : {}),
      cwd: existingCwd || options.root,
    },
  }];
}

async function materializePlugin(
  files: PluginFileAccess,
  home: string,
  installed: Record<string, unknown>,
): Promise<PluginInventoryItem> {
  const id = typeof installed.id === "string" ? installed.id.trim().toLocaleLowerCase() : "";
  const root = typeof installed.root === "string" ? normalizePath(installed.root.trim()) : "";
  const diagnostics: PluginDiagnostic[] = [];
  if (!PLUGIN_ID.test(id)) diagnostics.push(pluginDiagnostic("error", `Invalid plugin id: ${id || "<empty>"}`));
  if (!root) diagnostics.push(pluginDiagnostic("error", "Plugin root is required"));

  const rootManifest = joinPath(root, "kimi.plugin.json");
  const nestedManifest = joinPath(root, ".kimi-plugin", "plugin.json");
  const rootManifestExists = Boolean(root) && await files.pathExists(rootManifest);
  const nestedManifestExists = Boolean(root) && await files.pathExists(nestedManifest);
  const manifestPath = rootManifestExists ? rootManifest : nestedManifestExists ? nestedManifest : "";
  if (!manifestPath) diagnostics.push(pluginDiagnostic("error", "No manifest at kimi.plugin.json or .kimi-plugin/plugin.json"));
  if (rootManifestExists && nestedManifestExists) {
    diagnostics.push(pluginDiagnostic("info", `.kimi-plugin/plugin.json is shadowed by ${rootManifest}`));
  }

  const manifestResult = manifestPath ? await readJsonRecord(files, manifestPath) : {};
  if (manifestResult.error) diagnostics.push(pluginDiagnostic("error", manifestResult.error));
  const manifest = manifestResult.value;
  const manifestName = typeof manifest?.name === "string" ? manifest.name.trim() : "";
  if (manifest && !PLUGIN_ID.test(manifestName)) {
    diagnostics.push(pluginDiagnostic("error", `Manifest name must match ${PLUGIN_ID}: ${manifestName || "<empty>"}`));
  }
  if (manifestName && id && manifestName.toLocaleLowerCase() !== id) {
    diagnostics.push(pluginDiagnostic("warn", `Installed id ${id} differs from manifest name ${manifestName}`));
  }

  const skillRoots: PluginSkillRoot[] = [];
  if (manifest) {
    const declaredSkills = readStringArray(manifest.skills);
    if (declaredSkills === null) {
      diagnostics.push(pluginDiagnostic("error", '"skills" must be a string or string[]'));
    } else if (declaredSkills.length > 0) {
      for (const declared of declaredSkills) {
        const path = await resolveContainedPluginPath(files, root, declared);
        if (!path) {
          diagnostics.push(pluginDiagnostic("error", `Plugin skill path must start with ./ and stay inside root: ${declared}`));
          continue;
        }
        if (await files.pathExists(path)) skillRoots.push({ pluginId: id, path });
        else diagnostics.push(pluginDiagnostic("warn", `Plugin skill path does not exist: ${path}`));
      }
    } else if (await files.pathExists(joinPath(root, "SKILL.md"))) {
      skillRoots.push({ pluginId: id, path: root, rootSkillOnly: true });
    }
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  if (manifest?.mcpServers !== undefined) {
    if (!isRecord(manifest.mcpServers)) {
      diagnostics.push(pluginDiagnostic("error", '"mcpServers" must be an object'));
    } else {
      try {
        const parsed = parseMcpConfigStrict(JSON.stringify({ mcpServers: manifest.mcpServers }));
        const capabilityMcp = isRecord(installed.capabilities)
          && isRecord(installed.capabilities.mcpServers)
          ? installed.capabilities.mcpServers
          : {};
        for (const [serverName, server] of Object.entries(parsed.mcpServers)) {
          const override = isRecord(capabilityMcp[serverName])
            && typeof capabilityMcp[serverName].enabled === "boolean"
            ? capabilityMcp[serverName].enabled as boolean
            : server.enabled !== false;
          let normalizedServer = server;
          if (server.transport === "stdio") {
            let command = server.command;
            if (command.startsWith("./")) {
              const resolved = await resolveContainedPluginPath(files, root, command);
              if (!resolved || !await files.pathExists(resolved)) {
                diagnostics.push(pluginDiagnostic("warn", `Plugin MCP command is outside root or missing: ${command}`));
                continue;
              }
              command = resolved;
            } else if (/[\\/]/.test(command) || /^[A-Za-z]:/.test(command)) {
              diagnostics.push(pluginDiagnostic("warn", `Plugin MCP command must be a PATH command or start with ./: ${command}`));
              continue;
            }
            const rawCwd = typeof server.extra?.cwd === "string" ? server.extra.cwd : "";
            let resolvedCwd = rawCwd;
            if (rawCwd) {
              const resolved = await resolveContainedPluginPath(files, root, rawCwd);
              if (!resolved || !await files.pathExists(resolved)) {
                diagnostics.push(pluginDiagnostic("warn", `Plugin MCP cwd is outside root or missing: ${rawCwd}`));
                continue;
              }
              resolvedCwd = resolved;
            }
            normalizedServer = {
              ...server,
              command,
              extra: {
                ...(server.extra ?? {}),
                ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
              },
            };
          }
          const [runtimeName, effective] = clonePluginMcpServer(normalizedServer, {
            pluginId: id,
            serverName,
            root,
            home,
            enabled: installed.enabled !== false && override,
          });
          mcpServers[runtimeName] = effective;
        }
      } catch (error) {
        diagnostics.push(pluginDiagnostic("error", `Invalid plugin MCP config: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const pluginInterface = isRecord(manifest?.interface) ? manifest.interface : {};
  return {
    id,
    root,
    source: typeof installed.source === "string" ? installed.source : "local-path",
    enabled: installed.enabled !== false,
    installedAt: typeof installed.installedAt === "string" ? installed.installedAt : "",
    updatedAt: typeof installed.updatedAt === "string" ? installed.updatedAt : undefined,
    originalSource: typeof installed.originalSource === "string" ? installed.originalSource : undefined,
    state: hasError ? "error" : "ok",
    displayName: typeof pluginInterface.displayName === "string"
      ? pluginInterface.displayName
      : manifestName || id,
    version: typeof manifest?.version === "string" ? manifest.version : undefined,
    description: typeof manifest?.description === "string" ? manifest.description : undefined,
    manifestPath: manifestPath || undefined,
    skillRoots,
    mcpServers,
    hookCount: Array.isArray(manifest?.hooks) ? manifest.hooks.length : 0,
    diagnostics,
  };
}

export async function scanKimiPlugins(
  files: PluginFileAccess,
  home = "~/.kimi-code",
): Promise<PluginInventoryReport> {
  const installedPath = joinPath(home, "plugins", "installed.json");
  const installedResult = await readJsonRecord(files, installedPath);
  if (!installedResult.value) {
    return {
      installedPath,
      plugins: [],
      skillRoots: [],
      mcpServers: {},
      diagnostics: installedResult.error ? [pluginDiagnostic("error", installedResult.error)] : [],
    };
  }
  const rawPlugins = installedResult.value.plugins;
  if (!Array.isArray(rawPlugins)) {
    return {
      installedPath,
      plugins: [],
      skillRoots: [],
      mcpServers: {},
      diagnostics: [pluginDiagnostic("error", "installed.json must contain a plugins array")],
    };
  }
  const plugins: PluginInventoryItem[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of rawPlugins) {
    if (!isRecord(raw)) {
      diagnostics.push(pluginDiagnostic("error", "installed.json contains a non-object plugin record"));
      continue;
    }
    const plugin = await materializePlugin(files, home, raw);
    if (seen.has(plugin.id)) {
      diagnostics.push(pluginDiagnostic("error", `Duplicate installed plugin id: ${plugin.id}`));
      continue;
    }
    seen.add(plugin.id);
    plugins.push(plugin);
  }
  const healthyEnabled = plugins.filter((plugin) => plugin.enabled && plugin.state === "ok");
  return {
    installedPath,
    plugins,
    skillRoots: healthyEnabled.flatMap((plugin) => plugin.skillRoots),
    mcpServers: Object.fromEntries(
      healthyEnabled.flatMap((plugin) => Object.entries(plugin.mcpServers)),
    ),
    diagnostics: [
      ...diagnostics,
      ...plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${plugin.id || "<invalid>"}: ${diagnostic.message}`,
      }))),
    ],
  };
}

export function remapInstalledPluginRoots(
  document: string,
  sourceHome: string,
  targetHome: string,
): string {
  const parsed = JSON.parse(document) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error("installed.json must contain a plugins array");
  }
  const sourcePrefix = `${normalizePath(sourceHome)}/plugins/managed/`;
  const targetPrefix = `${normalizePath(targetHome)}/plugins/managed/`;
  const managedMarker = "/plugins/managed/";
  for (const record of parsed.plugins) {
    if (!isRecord(record) || typeof record.root !== "string") continue;
    const normalizedRoot = normalizePath(record.root);
    const explicitSuffix = normalizedRoot.startsWith(sourcePrefix)
      ? normalizedRoot.slice(sourcePrefix.length)
      : "";
    const markerIndex = normalizedRoot.lastIndexOf(managedMarker);
    const inferredSuffix = markerIndex >= 0
      ? normalizedRoot.slice(markerIndex + managedMarker.length)
      : "";
    const suffix = explicitSuffix || inferredSuffix;
    const installedId = typeof record.id === "string" ? record.id.trim().toLocaleLowerCase() : "";
    const managedId = suffix.split("/")[0]?.toLocaleLowerCase() ?? "";
    if (suffix && installedId && managedId === installedId) {
      record.root = `${targetPrefix}${suffix}`;
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
