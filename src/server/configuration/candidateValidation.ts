import { isDeepStrictEqual } from "node:util";
import parseToml from "@iarna/toml/parse-string.js";
import { KIMI_EDITABLE_FIELDS, type KimiEditableField } from "../../shared/kimiCompatibility";
import type { NativeResource } from "../../shared/resourceProtocol";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function get(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = record(value)[key];
  return value;
}
function parse(content: string | null): Record<string, unknown> { return content?.trim() ? parseToml(content) : {}; }
function assertChangedType(before: unknown, after: unknown, valid: (value: unknown) => boolean, label: string): void {
  if (after !== undefined && !isDeepStrictEqual(before, after) && !valid(after)) throw new Error(`Invalid value for ${label}.`);
}
const table = (value: unknown): boolean => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
function validateMcpCandidate(beforeText: string | null, afterText: string | null): void {
  let before: Record<string, unknown> = {};
  try { before = record(beforeText?.trim() ? JSON.parse(beforeText) : {}); } catch { /* A reviewed restore may repair an invalid old document. */ }
  const after = record(afterText?.trim() ? JSON.parse(afterText) : {});
  if (isDeepStrictEqual(before.mcpServers, after.mcpServers)) return;
  if (after.mcpServers === undefined) return;
  if (!after.mcpServers || typeof after.mcpServers !== "object" || Array.isArray(after.mcpServers)) throw new Error("mcpServers must be an object.");
  const previousServers = record(before.mcpServers);
  // Kimi Code 2.0.0, commit 1b89e4b: packages/agent-core-v2/src/mcpCore/config-schema.ts.
  const string = (value: unknown): boolean => typeof value === "string";
  const strings = (value: unknown): boolean => Array.isArray(value) && value.every(string);
  const stringMap = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(string);
  for (const [name, value] of Object.entries(after.mcpServers)) {
    if (isDeepStrictEqual(previousServers[name], value)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An MCP server must be an object.");
    const server = record(value);
    const require = (valid: boolean, label: string): void => { if (!valid) throw new Error(`Invalid MCP server ${label}.`); };
    const optional = (key: string, valid: (entry: unknown) => boolean): void => { if (server[key] !== undefined) require(valid(server[key]), key); };
    const transport = Object.hasOwn(server, "transport") ? server.transport : typeof server.command === "string" ? "stdio" : typeof server.url === "string" ? "http" : undefined;
    require(transport === "stdio" || transport === "http" || transport === "sse", "transport");
    for (const key of ["enabled", "deferred"]) optional(key, (entry) => typeof entry === "boolean");
    for (const key of ["startupTimeoutMs", "toolTimeoutMs"]) optional(key, (entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 1 && entry <= 2_147_483_647);
    for (const key of ["enabledTools", "disabledTools"]) optional(key, strings);
    if (transport === "stdio") {
      require(typeof server.command === "string" && server.command.length > 0, "command");
      optional("args", strings); optional("env", stringMap); optional("cwd", string);
      optional("executor", (entry) => entry === "local" || entry === "kaos");
      optional("runtime_id", (entry) => typeof entry === "string" && entry.length > 0);
    } else {
      let validUrl = false;
      try { if (typeof server.url === "string") { new URL(server.url); validUrl = true; } } catch { /* no candidate data in diagnostics */ }
      require(validUrl, "url"); optional("headers", stringMap); optional("auth", (entry) => entry === "oauth");
      optional("bearerTokenEnvVar", (entry) => typeof entry === "string" && entry.length > 0);
    }
  }
}
/** Validate changed supported fields; leave unrelated future fields and existing invalid values untouched. */
export function validateNativeCandidate(resource: NativeResource, beforeText: string | null, afterText: string | null): void {
  if (resource === "mcp" || resource === "mcp-project" || resource === "mcp-local") return validateMcpCandidate(beforeText, afterText);
  if (resource !== "config" && resource !== "tui" && resource !== "project-local") return;
  let before: Record<string, unknown>;
  try { before = parse(beforeText); } catch { before = {}; }
  const after = parse(afterText);
  const fields: readonly KimiEditableField[] = KIMI_EDITABLE_FIELDS[resource === "project-local" ? "project" : resource];
  for (const field of fields) {
    for (let depth = 1; depth < field.path.length; depth++) {
      const parent = field.path.slice(0, depth);
      assertChangedType(get(before, parent), get(after, parent), table, parent.join("."));
    }
    assertChangedType(get(before, field.path), get(after, field.path), (value) => {
      if (field.type === "string-array") return Array.isArray(value) && value.every((item) => typeof item === "string" && (!field.values || field.values.includes(item)));
      // Official ThinkingConfigSchema intentionally accepts model-specific effort strings.
      return typeof value === field.type && (field.path.join(".") === "thinking.effort" || !field.values || field.values.includes(value as string));
    }, field.path.join("."));
  }
  if (resource !== "config") return;
  const beforeProviders = record(before.providers);
  const providers = record(after.providers);
  const beforeModels = record(before.models);
  const models = record(after.models);
  const string = (value: unknown): boolean => typeof value === "string";
  const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every(string);
  const positiveInteger = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
  assertChangedType(before.providers, after.providers, table, "providers");
  assertChangedType(before.models, after.models, table, "models");
  for (const [name, value] of Object.entries(providers)) {
    const previous = record(beforeProviders[name]);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (!isDeepStrictEqual(beforeProviders[name], value)) throw new Error("A provider must be a table.");
      continue;
    }
    for (const key of ["type", "base_url", "api_key"] as const) assertChangedType(previous[key], record(value)[key], string, `providers.${key}`);
  }
  for (const [name, value] of Object.entries(models)) {
    const previous = record(beforeModels[name]);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (!isDeepStrictEqual(beforeModels[name], value)) throw new Error("A model must be a table.");
      continue;
    }
    const model = record(value);
    for (const key of ["provider", "provider_id", "model", "name", "display_name", "default_effort"] as const) assertChangedType(previous[key], model[key], string, `models.${key}`);
    for (const key of ["capabilities", "support_efforts", "aliases"] as const) assertChangedType(previous[key], model[key], stringArray, `models.${key}`);
    for (const key of ["max_context_size", "max_input_size", "max_output_size"]) assertChangedType(previous[key], model[key], positiveInteger, `models.${key}`);
    const provider = model.provider_id ?? model.provider;
    const previousProvider = previous.provider_id ?? previous.provider;
    if (typeof provider === "string" && Object.hasOwn(beforeProviders, provider) && !Object.hasOwn(providers, provider)) throw new Error("A provider is still referenced by a model; update its references in the same plan.");
    if (typeof provider === "string" && provider !== previousProvider && !Object.hasOwn(providers, provider)) throw new Error("The changed model provider does not refer to a configured provider.");
  }
  assertChangedType(before.secondary_model, after.secondary_model, table, "secondary_model");
  assertChangedType(get(before, ["secondary_model", "default_model"]), get(after, ["secondary_model", "default_model"]), string, "secondary_model.default_model");
  assertChangedType(get(before, ["secondary_model", "force"]), get(after, ["secondary_model", "force"]), (value) => typeof value === "boolean", "secondary_model.force");
  const aliases = (items: Record<string, unknown>): Set<string> => new Set(Object.entries(items).flatMap(([name, model]) => [name, ...(Array.isArray(record(model).aliases) ? (record(model).aliases as unknown[]).filter((alias): alias is string => typeof alias === "string") : [])]));
  const beforeAliases = aliases(beforeModels);
  const candidateAliases = aliases(models);
  for (const path of [["default_model"], ["secondary_model", "default_model"]]) {
    const reference = get(after, path);
    if (typeof reference === "string" && reference !== "" && !candidateAliases.has(reference)
      && (reference !== get(before, path) || beforeAliases.has(reference))) throw new Error("The changed default or secondary model does not refer to a configured model or model alias. Runtime-discovered models must be verified before selecting them.");
  }
}
