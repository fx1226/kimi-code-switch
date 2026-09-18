import type { WebMethod } from "@shared/webApi";

export class ApiInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(message: string): never { throw new ApiInputError("INVALID_INPUT", message); }
function string(input: RecordValue, key: string, optional = false, allowEmpty = false): void {
  const value = input[key];
  if (value === undefined && optional) return;
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > (key === "content" ? 32 * 1024 * 1024 : 8192) || value.includes("\0")) fail(`Invalid ${key}`);
}
function keys(input: RecordValue, allowed: string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`Unexpected field: ${key}`);
}
function fields(required: string[], optional: string[] = []): (input: RecordValue) => void {
  return (input) => { keys(input, [...required, ...optional]); for (const key of required) string(input, key); for (const key of optional) string(input, key, true); };
}
const target = fields(["targetId"]);
const resources = ["config", "mcp", "tui", "agents", "project-local", "mcp-project", "mcp-local"];
function resource(input: RecordValue): void {
  string(input, "targetId");
  if (!resources.includes(String(input.resource))) fail("Invalid resource");
}
function safeValue(value: unknown, depth = 0): void {
  if (depth > 32) fail("Value is too deeply nested");
  if (typeof value === "number" && !Number.isFinite(value)) fail("Invalid numeric value");
  if (Array.isArray(value)) { if (value.length > 10000) fail("Array is too large"); value.forEach((entry) => safeValue(entry, depth + 1)); }
  else if (object(value)) for (const [key, entry] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail("Unsafe object key");
    safeValue(entry, depth + 1);
  }
}
function mcpScope(input: RecordValue): void {
  if (input.resource !== undefined && !["mcp", "mcp-project", "mcp-local"].includes(String(input.resource))) fail("Invalid MCP scope");
}
const validators: Record<WebMethod, (input: RecordValue) => void> = {
  bootstrap: (input) => keys(input, []),
  readResource: (input) => { keys(input, ["targetId", "resource"]); resource(input); },
  planChange: (input) => {
    keys(input, ["targetId", "resource", "expectedRevision", "changes", "content"]); resource(input); string(input, "expectedRevision", false, true);
    if (input.content !== undefined) { if (input.resource !== "agents" || input.changes !== undefined) fail("Raw editing is only available for AGENTS.md"); string(input, "content", false, true); }
    else {
      if (!Array.isArray(input.changes) || input.changes.length > 1000) fail("Invalid document changes");
      for (const change of input.changes) {
        if (!object(change)) fail("Invalid document change");
        keys(change, ["op", "path", "value"]);
        if (change.op !== "set" && change.op !== "delete") fail("Invalid change operation");
        if (!Array.isArray(change.path) || !change.path.length || change.path.length > 20 || change.path.some((part) => typeof part !== "string" || !part || ["__proto__", "prototype", "constructor"].includes(part))) fail("Invalid field path");
        if (change.op === "set" && !("value" in change)) fail("Missing field value");
        safeValue(change.value);
      }
    }
  },
  applyChange: (input) => { keys(input, ["targetId", "planId", "expectedRevision"]); string(input, "targetId"); string(input, "planId"); string(input, "expectedRevision", false, true); },
  getOperation: fields(["id"]),
  savePreferences: (input) => {
    keys(input, ["theme", "locale", "activeTargetId"]);
    if (input.theme !== undefined && !["auto", "dark", "light"].includes(String(input.theme))) fail("Invalid theme");
    if (input.locale !== undefined && !["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"].includes(String(input.locale))) fail("Invalid locale");
    string(input, "activeTargetId", true);
  },
  addTarget: fields(["name", "homePath"], ["workingDirectory", "copyFromTargetId"]),
  updateTarget: (input) => {
    keys(input, ["targetId", "name", "workingDirectory"]); string(input, "targetId"); string(input, "name", true);
    if (input.workingDirectory !== null) string(input, "workingDirectory", true);
  },
  forgetTarget: target,
  listPresets: target,
  savePreset: (input) => {
    keys(input, ["targetId", "preset"]); string(input, "targetId");
    if (!object(input.preset)) fail("Invalid preset");
    keys(input.preset, ["name", "label", "default_model", "default_plan_mode", "default_permission_mode", "merge_all_available_skills", "thinking_enabled", "thinking_effort", "tui_theme", "tui_editor_command", "nativeEdits"]);
    if (input.preset.nativeEdits !== undefined) {
      if (!Array.isArray(input.preset.nativeEdits) || input.preset.nativeEdits.length > 20) fail("Invalid preset fields");
      const allowed = ["default_model", "default_plan_mode", "default_permission_mode", "merge_all_available_skills", "thinking.enabled", "thinking.effort"];
      for (const edit of input.preset.nativeEdits) {
        if (!object(edit) || edit.op !== "set" || !Array.isArray(edit.path) || !allowed.includes(edit.path.join(".")) || !("value" in edit)) fail("Invalid preset field");
        keys(edit, ["op", "path", "value"]); safeValue(edit.value);
      }
    }
    for (const key of ["name", "label", "default_model"]) string(input.preset, key, false, key !== "name");
    for (const key of ["default_plan_mode", "merge_all_available_skills"]) if (typeof input.preset[key] !== "boolean") fail(`Invalid ${key}`);
    if (!["", "manual", "auto", "yolo"].includes(String(input.preset.default_permission_mode))) fail("Invalid permission mode");
    if (input.preset.thinking_enabled !== undefined && typeof input.preset.thinking_enabled !== "boolean") fail("Invalid thinking flag");
    for (const key of ["thinking_effort", "tui_theme", "tui_editor_command"]) string(input.preset, key, true, true);
  },
  deletePreset: fields(["targetId", "name"]),
  planPreset: fields(["targetId", "name"]),
  scanSkills: target,
  listPlugins: target,
  diagnose: target,
  listBackups: target,
  createBackup: target,
  exportBackup: fields(["targetId", "id"]),
  planRestore: fields(["targetId", "backupId"]),
  importBackup: fields(["targetId", "content"]),
  listHistory: target,
  planHistoryRestore: fields(["targetId", "id"]),
  listRecoveryCases: (input) => keys(input, []),
  exportRecoveryJournal: fields(["id", "journalRevision"]),
  resolveRecovery: (input) => {
    keys(input, ["id", "journalRevision", "expectedRevisions", "decision", "acknowledgeMalformed"]);
    string(input, "id"); string(input, "journalRevision");
    if (input.decision !== "keep-current" || !object(input.expectedRevisions) || Object.values(input.expectedRevisions).some((entry) => typeof entry !== "string")) fail("Invalid recovery decision");
    if (input.acknowledgeMalformed !== undefined && typeof input.acknowledgeMalformed !== "boolean") fail("Invalid recovery acknowledgement");
  },
  previewMigration: (input) => keys(input, []),
  applyMigration: fields(["manifestHash"]),
  openKimi: target,
  login: target,
  testMcp: (input) => { fields(["targetId", "name"], ["resource"])(input); mcpScope(input); },
  listMcpTools: (input) => { fields(["targetId", "name"], ["resource"])(input); mcpScope(input); },
  callMcpTool: (input) => { keys(input, ["targetId", "name", "toolName", "arguments", "resource"]); mcpScope(input); for (const key of ["targetId", "name", "toolName"]) string(input, key); if (!object(input.arguments)) fail("Invalid tool arguments"); safeValue(input.arguments); },
};

export function validateCall(value: unknown): { method: WebMethod; input: RecordValue } {
  if (!object(value)) fail("Request must be an object");
  keys(value, ["method", "input"]);
  if (typeof value.method !== "string" || !Object.hasOwn(validators, value.method)) throw new ApiInputError("UNKNOWN_METHOD", "Unknown API method");
  const input = value.input ?? {};
  if (!object(input)) fail("Input must be an object");
  const method = value.method as WebMethod;
  validators[method](input);
  return { method, input };
}
