import type { McpConfig, McpServerConfig } from "./types";

export const DEFAULT_MCP_CONFIG_PATH = "~/.kimi-code/mcp.json";

export function createDefaultMcpConfig(): McpConfig {
  return {
    mcpServers: {},
  };
}

export async function loadMcpConfig(
  files: { readText(path: string): Promise<string | null> },
  path: string,
): Promise<McpConfig> {
  let document: string | null;
  try {
    document = await files.readText(path);
  } catch (error) {
    throw new Error(`Failed to read MCP config at ${path}: ${formatErrorMessage(error)}`);
  }
  return parseMcpConfig(document, { sourcePath: path });
}

export function parseMcpConfig(document: string | null, options?: { sourcePath?: string }): McpConfig {
  if (!document?.trim()) {
    return createDefaultMcpConfig();
  }

  try {
    return parseMcpConfigStrict(document);
  } catch (error) {
    const location = options?.sourcePath ? ` at ${options.sourcePath}` : "";
    throw new Error(`Invalid MCP config${location}: ${formatErrorMessage(error)}`);
  }
}

export function parseMcpConfigStrict(document: string): McpConfig {
  const parsed = JSON.parse(document) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid MCP config: expected a JSON object.");
  }
  const rawServers = parsed.mcpServers ?? {};
  if (!isRecord(rawServers)) {
    throw new Error("Invalid MCP config: expected an object with mcpServers.");
  }

  const mcpServers = Object.fromEntries(
    Object.entries(rawServers).map(([name, raw]) => {
      validateMcpServer(name, raw);
      return [name, parseMcpServer(raw)];
    }),
  );

  return { mcpServers };
}

export function buildMcpConfigDocument(config: McpConfig): string {
  // 0.38.0：sse 为 legacy transport 仍受支持，保存时原样写回，不再省略；
  // 禁用服务器（enabled:false）直接落盘（CLI 原生语义），仅省略显式删除掉的项。
  const mcpServers = Object.fromEntries(
    Object.entries(config.mcpServers)
      .map(([name, server]) => [name, buildMcpServerDocument(server)]),
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function parseMcpServer(raw: unknown): McpServerConfig {
  const data = raw as Record<string, unknown>;
  const headers = asStringRecord(data.headers);
  const env = asStringRecord(data.env);
  const args = Array.isArray(data.args)
    ? data.args.filter((item): item is string => typeof item === "string")
    : [];
  const enabled = typeof data.enabled === "boolean" ? data.enabled : true;

  const knownKeys = new Set([
    "transport",
    "type",
    "url",
    "auth",
    "headers",
    "command",
    "args",
    "env",
    "enabled",
    "extra",
  ]);
  const derivedExtra = Object.fromEntries(
    Object.entries(data).filter(([key]) => !knownKeys.has(key)),
  );
  // auth 是 0.38.0 的 OAuth 标记，以 extra 形式保留，避免保存时静默丢弃
  if (data.auth !== undefined) {
    derivedExtra.auth = data.auth;
  }
  const explicitExtra = isRecord(data.extra) ? data.extra : {};
  const extra = {
    ...explicitExtra,
    ...derivedExtra,
  };

  const transport = normalizeMcpTransport(data.transport ?? data.type, data.url, data.command);

  if (transport !== "stdio") {
    return {
      enabled,
      transport,
      url: typeof data.url === "string" ? data.url : "",
      headers,
      command: "",
      args: [],
      env: {},
      extra: Object.keys(extra).length ? extra : undefined,
    };
  }

  return {
    enabled,
    transport: "stdio",
    url: "",
    headers: {},
    command: typeof data.command === "string" ? data.command : "",
    args,
    env,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

function buildMcpServerDocument(server: McpServerConfig): Record<string, unknown> {
  // transport/type 只在原始声明需要显式保留时写回：sse（legacy）+ 显式 type 别名。
  // stdio 与按 URL/命令推断出的 transport 不写，保持输出与 CLI 惯例一致且稳定。
  let transportOut: Record<string, unknown> = {};
  if (server.transport === "sse") {
    transportOut = { transport: "sse" };
  } else {
    const typeAlias = server.extra?.type;
    if (typeAlias === "sse" || typeAlias === "streamable-http" || typeAlias === "http") {
      transportOut = { type: typeAlias };
    }
  }

  const base =
    server.transport === "stdio"
      ? {
          ...(server.command ? { command: server.command } : {}),
          ...(server.args.length ? { args: server.args } : {}),
          ...(Object.keys(server.env).length ? { env: server.env } : {}),
        }
      : {
          ...(server.url ? { url: server.url } : {}),
          ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
        };

  return {
    ...sanitizeMcpExtra(server.extra),
    ...base,
    ...transportOut,
    ...(server.enabled === false ? { enabled: false } : {}),
  };
}

export function isUnsupportedSseServer(server: McpServerConfig): boolean {
  // 仅当 transport 解析为 sse 时才视为不支持。URL 启发式（路径含 /sse）只用于
  // normalizeMcpTransport 推断缺省 transport，不应作为过滤依据——否则显式声明为
  // streamable-http 但 URL 恰好含 /sse 的合法端点会被静默丢弃。
  return server.transport === "sse";
}

function sanitizeMcpExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) {
    return {};
  }
  // type 别名保留（写回时由 buildMcpServerDocument 决定输出方式）；
  // transport 直接放进 extra 时也允许（sse 场景在上面统一用顶层 transport 表达，
  // 这里剥掉以免与顶层重复）。
  const blockedKeys = new Set(["transport"]);
  return Object.fromEntries(Object.entries(extra).filter(([key]) => !blockedKeys.has(key)));
}

function normalizeMcpTransport(transport: unknown, url: unknown, command: unknown): McpServerConfig["transport"] {
  if (transport === "stdio") {
    return "stdio";
  }
  if (transport === "sse") {
    return "sse";
  }
  if (transport === "http" || transport === "streamable-http") {
    return "streamable-http";
  }
  if (typeof url === "string" && url.trim()) {
    return "streamable-http";
  }
  if (typeof command === "string" && command.trim()) {
    return "stdio";
  }
  return "streamable-http";
}

function validateMcpServer(name: string, raw: unknown): void {
  if (!isRecord(raw)) throw new Error(`MCP server "${name}" must be an object.`);
  const transportValue = raw.transport ?? raw.type;
  const transport = transportValue === undefined
    ? typeof raw.command === "string"
      ? "stdio"
      : typeof raw.url === "string"
        ? "http"
        : "invalid"
    : transportValue === "streamable-http"
      ? "http"
      : transportValue;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new Error(`MCP server "${name}" has an invalid transport.`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`MCP server "${name}" enabled must be boolean.`);
  }
  for (const key of ["startupTimeoutMs", "toolTimeoutMs"] as const) {
    const value = raw[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647)) {
      throw new Error(`MCP server "${name}" ${key} must be an integer from 1 to 2147483647.`);
    }
  }
  for (const key of ["enabledTools", "disabledTools"] as const) {
    const value = raw[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
      throw new Error(`MCP server "${name}" ${key} must be a string array.`);
    }
  }
  if (transport === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.length) {
      throw new Error(`MCP server "${name}" stdio command must be non-empty.`);
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((entry) => typeof entry !== "string"))) {
      throw new Error(`MCP server "${name}" args must be a string array.`);
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) {
      throw new Error(`MCP server "${name}" env must contain only string values.`);
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
      throw new Error(`MCP server "${name}" cwd must be a string.`);
    }
    if (raw.executor !== undefined && raw.executor !== "local" && raw.executor !== "kaos") {
      throw new Error(`MCP server "${name}" executor must be local or kaos.`);
    }
    if (raw.runtime_id !== undefined && (typeof raw.runtime_id !== "string" || raw.runtime_id.length === 0)) {
      throw new Error(`MCP server "${name}" runtime_id must be a non-empty string.`);
    }
    return;
  }
  if (typeof raw.url !== "string" || !isValidUrl(raw.url)) {
    throw new Error(`MCP server "${name}" URL must be valid.`);
  }
  if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
    throw new Error(`MCP server "${name}" headers must contain only string values.`);
  }
  if (raw.auth !== undefined && raw.auth !== "oauth") {
    throw new Error(`MCP server "${name}" auth must be oauth.`);
  }
  if (raw.bearerTokenEnvVar !== undefined && (typeof raw.bearerTokenEnvVar !== "string" || !raw.bearerTokenEnvVar.length)) {
    throw new Error(`MCP server "${name}" bearerTokenEnvVar must be non-empty.`);
  }
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
