import {
  buildConfigDocument,
  buildPanelSettingsDocument,
  createLineDiff,
  extractSecondaryModel,
  normalizeStatePaths,
} from "./configStore";
import { buildMcpConfigDocument, isUnsupportedSseServer } from "./mcpStore";
import { getShortcutConflicts } from "./shortcutStore";
import type {
  AppState,
  ConfigDoctorReport,
  ConfigDriftEntry,
  DoctorIssue,
  DoctorSeverity,
  ManagedFileId,
  McpServerConfig,
  RedactedPreviewBundle,
  RedactionSummary,
} from "./types";

export const REDACTION_MASK = "[REDACTED]";
const SECRET_NAME_PATTERN = /token|secret|password|api[_-]?key|access[_-]?token|cookie|auth|authorization/i;
const GENERIC_KEY_SEGMENT_PATTERN = /(^|[._-])key($|[._-])/i;
const SECRET_QUERY_PARAM_PATTERN = /^(token|api[_-]?key|access[_-]?token|key)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const VALID_BACKUP_FREQUENCIES = new Set(["hourly", "daily", "weekly"]);
const VALID_BACKUP_STRATEGIES = new Set(["manual", "scheduled", "on-change"]);

export function buildManagedDocuments(state: AppState): Record<ManagedFileId, string> {
  const normalizedState = normalizeStatePaths(state);
  return {
    config: buildConfigDocument(normalizedState),
    panel: buildPanelSettingsDocument(normalizedState.panelSettings),
    mcp: buildMcpConfigDocument(normalizedState.mcpConfig),
  };
}

export function redactAppStateSecrets(state: AppState): { state: AppState; summary: RedactionSummary } {
  const clonedState = structuredClone(state) as AppState;
  const summary = createEmptySummary();
  redactUnknownValue(clonedState as unknown, [], summary);
  return {
    state: clonedState,
    summary,
  };
}

export function redactDocumentText(document: string): { text: string; summary: RedactionSummary } {
  const summary = createEmptySummary();
  let redacted = document;

  redacted = redacted.replace(
    /((["']?)([A-Za-z0-9_.-]+)\2\s*[:=]\s*)(["'])(.*?)\4/g,
    (match, prefix: string, _quoteWrap: string, key: string, valueQuote: string, value: string) => {
      if (!shouldRedactLooseSecretKey(key)) {
        return match;
      }
      addMaskedPath(summary, `text.${key}`);
      redactStringContent(value, `text.${key}`, summary);
      return `${prefix}${valueQuote}${REDACTION_MASK}${valueQuote}`;
    },
  );

  redacted = redacted.replace(
    /((["']?)([A-Za-z0-9_.-]+)\2\s*[:=]\s*)([^#\r\n]+)/g,
    (match, prefix: string, _quoteWrap: string, key: string, value: string) => {
      if (!shouldRedactLooseSecretKey(key)) {
        return match;
      }
      const trimmedValue = value.trim();
      if (!trimmedValue || trimmedValue.startsWith("\"") || trimmedValue.startsWith("'")) {
        return match;
      }
      addMaskedPath(summary, `text.${key}`);
      redactStringContent(trimmedValue, `text.${key}`, summary);
      return `${prefix}${REDACTION_MASK}`;
    },
  );

  redacted = redactUrlsInText(redacted, "text.url", summary);

  return {
    text: redacted,
    summary,
  };
}

export function buildRedactedPreviewBundle(
  state: AppState,
  disk: Partial<Record<ManagedFileId, string>> = {},
): RedactedPreviewBundle {
  const redactedState = redactAppStateSecrets(normalizeStatePaths(state));
  const draftDocuments = buildManagedDocuments(redactedState.state);

  const redactedDisk = {
    config: redactDocumentText(disk.config ?? "").text,
    panel: redactDocumentText(disk.panel ?? "").text,
    mcp: redactDocumentText(disk.mcp ?? "").text,
  };

  return {
    configDocument: draftDocuments.config,
    panelSettingsDocument: draftDocuments.panel,
    mcpDocument: draftDocuments.mcp,
    configDiff: createLineDiff(redactedDisk.config, draftDocuments.config),
    panelDiff: createLineDiff(redactedDisk.panel, draftDocuments.panel),
    mcpDiff: createLineDiff(redactedDisk.mcp, draftDocuments.mcp),
    redaction: redactedState.summary,
  };
}

export function buildConfigDoctorReport(
  state: AppState,
  rawDocs?: Partial<Record<ManagedFileId, unknown>>,
): ConfigDoctorReport {
  const normalizedState = normalizeStatePaths(state);
  const issues: DoctorIssue[] = [];

  validateManagedPaths(normalizedState, issues);
  validateModelReferences(state, issues);
  validateAdvancedConfig(state, issues);
  validateOfficialAccountUsage(state, issues);
  validateMcpServers(state.mcpConfig.mcpServers, issues);
  validateBackupSettings(state, normalizedState, issues);
  validateShortcutConflicts(normalizedState, issues);

  const drift = rawDocs ? detectUnknownFields(rawDocs) : [];

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.filter((issue) => issue.severity === "info").length;

  return {
    ok: errorCount === 0,
    generatedAt: new Date().toISOString(),
    issues,
    errorCount,
    warningCount,
    infoCount,
    drift,
  };
}

function validateManagedPaths(state: AppState, issues: DoctorIssue[]): void {
  const pathEntries: Array<[ManagedFileId, string]> = [
    ["config", state.configPath],
    ["panel", state.panelSettingsPath],
    ["mcp", state.mcpConfigPath],
  ];

  for (let index = 0; index < pathEntries.length; index += 1) {
    const [leftId, leftPath] = pathEntries[index];
    for (let nextIndex = index + 1; nextIndex < pathEntries.length; nextIndex += 1) {
      const [rightId, rightPath] = pathEntries[nextIndex];
      if (leftPath !== rightPath) {
        continue;
      }
      issues.push(
        createDoctorIssue(
          `state.path-collision.${leftId}.${rightId}`,
          "error",
          "state",
          `${labelManagedFile(leftId)} path collides with ${labelManagedFile(rightId)} path.`,
          `${leftId}Path`,
          "Choose a different file for one of the managed documents.",
        ),
      );
    }
  }
}

function validateModelReferences(state: AppState, issues: DoctorIssue[]): void {
  if (state.mainConfig.default_model.trim() && !state.mainConfig.models[state.mainConfig.default_model]) {
    issues.push(
      createDoctorIssue(
        "config.default-model.missing",
        "error",
        "config",
        `Default model "${state.mainConfig.default_model || "(empty)"}" does not exist.`,
        "mainConfig.default_model",
        "Point default_model to an existing key under [models].",
      ),
    );
  }

  // E1：secondary_model.default_model 与 default_model 一样校验 model alias 存在性。
  const secondary = extractSecondaryModel(state.mainConfig.extra);
  if (secondary && secondary.default_model.trim() && !state.mainConfig.models[secondary.default_model]) {
    issues.push(
      createDoctorIssue(
        "config.secondary-model.missing",
        "error",
        "config",
        `Secondary model "${secondary.default_model}" does not exist.`,
        "config.extra.secondary_model.default_model",
        "Point secondary_model.default_model to an existing key under [models].",
      ),
    );
  }

  for (const [modelName, model] of Object.entries(state.mainConfig.models)) {
    if (state.mainConfig.providers[model.provider]) {
      continue;
    }
    issues.push(
      createDoctorIssue(
        `config.model-provider.missing.${modelName}`,
        "error",
        "config",
        `Model "${modelName}" references missing provider "${model.provider}".`,
        `mainConfig.models.${modelName}.provider`,
        "Create the provider first or reassign the model to an existing provider.",
      ),
    );
  }

  for (const [profileName, profile] of Object.entries(state.profiles)) {
    if (!profile.default_model.trim() || state.mainConfig.models[profile.default_model]) {
      continue;
    }
    issues.push(
      createDoctorIssue(
        `profiles.default-model.missing.${profileName}`,
        "error",
        "profiles",
        `Profile "${profileName}" references missing default model "${profile.default_model}".`,
        `profiles.${profileName}.default_model`,
        "Update the profile to use an existing model key.",
      ),
    );
  }

  if (Object.keys(state.profiles).length > 0 && !state.profiles[state.activeProfile]) {
    issues.push(
      createDoctorIssue(
        "profiles.active-profile.missing",
        "error",
        "profiles",
        `Active profile "${state.activeProfile || "(empty)"}" does not exist.`,
        "activeProfile",
        "Pick an existing profile as the active profile.",
      ),
    );
  }
}

/** E1：高级 config 字段的显式/有效语义检查（当前：builtin_product_skills 显式 false）。 */
function validateAdvancedConfig(state: AppState, issues: DoctorIssue[]): void {
  const extra = state.mainConfig.extra;
  if (isRecordShim(extra) && extra.builtin_product_skills === false) {
    issues.push(
      createDoctorIssue(
        "config.builtin-product-skills.disabled",
        "info",
        "config",
        "builtin_product_skills is explicitly false: built-in product Skills are disabled for all sessions.",
        "config.extra.builtin_product_skills",
        "Set it to true (or remove the key to use the official default true) to re-enable product Skills.",
      ),
    );
  }
}

function validateOfficialAccountUsage(state: AppState, issues: DoctorIssue[]): void {
  const usesOfficialAccount = Object.values(state.mainConfig.models)
    .some((model) => model.auth_mode === "official-account");
  if (!usesOfficialAccount) {
    return;
  }
  if (!state.panelSettings.active_official_account_id?.trim()) {
    issues.push(
      createDoctorIssue(
        "official-account.active.missing",
        "warning",
        "state",
        "One or more models use the official account mode, but no active official account is selected.",
        "panelSettings.active_official_account_id",
        "Sign in and activate a Kimi official account in Settings.",
      ),
    );
  }
}

function validateMcpServers(servers: Record<string, McpServerConfig>, issues: DoctorIssue[]): void {
  const semanticNames = new Map<string, string[]>();

  for (const [serverName, server] of Object.entries(servers)) {
    const trimmedName = serverName.trim();
    if (!trimmedName) {
      issues.push(
        createDoctorIssue(
          "mcp.server-name.empty",
          "error",
          "mcp",
          "MCP server names cannot be empty.",
          "mcpConfig.mcpServers",
          "Rename the MCP server to a non-empty identifier.",
        ),
      );
      continue;
    }

    const semanticKey = normalizeSemanticServerName(trimmedName);
    semanticNames.set(semanticKey, [...(semanticNames.get(semanticKey) ?? []), serverName]);

    if (server.transport === "stdio") {
      if (server.command.trim()) {
        continue;
      }
      issues.push(
        createDoctorIssue(
          `mcp.stdio-command.missing.${serverName}`,
          "error",
          "mcp",
          `MCP server "${serverName}" uses stdio transport but has no command.`,
          `mcpConfig.mcpServers.${serverName}.command`,
          "Provide a command for stdio transport.",
        ),
      );
      continue;
    }

    if (isUnsupportedSseServer(server)) {
      issues.push(
        createDoctorIssue(
          `mcp.sse-legacy.${serverName}`,
          "info",
          "mcp",
          `MCP server "${serverName}" uses a legacy SSE endpoint. It still works, but Kimi Code recommends Streamable HTTP.`,
          `mcpConfig.mcpServers.${serverName}.url`,
          "Prefer Streamable HTTP MCP; keep SSE only if the provider has no HTTP endpoint.",
        ),
      );
      continue;
    }

    if (server.url.trim()) {
      continue;
    }
    issues.push(
      createDoctorIssue(
        `mcp.remote-url.missing.${serverName}`,
        "error",
        "mcp",
        `MCP server "${serverName}" uses remote transport but has no URL.`,
        `mcpConfig.mcpServers.${serverName}.url`,
        "Provide a URL for the remote MCP transport.",
      ),
    );
  }

  for (const [semanticKey, names] of semanticNames.entries()) {
    if (names.length < 2) {
      continue;
    }
    issues.push(
      createDoctorIssue(
        `mcp.semantic-name.duplicate.${semanticKey}`,
        "warning",
        "mcp",
        `MCP server names ${names.join(", ")} normalize to the same semantic identifier "${semanticKey}".`,
        "mcpConfig.mcpServers",
        "Rename one of the servers to avoid ambiguous references.",
      ),
    );
  }
}

function validateBackupSettings(
  rawState: AppState,
  normalizedState: AppState,
  issues: DoctorIssue[],
): void {
  if (!Number.isInteger(rawState.panelSettings.backup_retention_count) || rawState.panelSettings.backup_retention_count < 1) {
    issues.push(
      createDoctorIssue(
        "backup.retention.invalid",
        "error",
        "backup",
        "Backup retention count must be an integer greater than or equal to 1.",
        "panelSettings.backup_retention_count",
        "Set backup retention to a value between 1 and 99.",
      ),
    );
  }

  if (!VALID_BACKUP_STRATEGIES.has(rawState.panelSettings.backup_strategy)) {
    issues.push(
      createDoctorIssue(
        "backup.strategy.invalid",
        "error",
        "backup",
        `Backup strategy "${rawState.panelSettings.backup_strategy}" is invalid.`,
        "panelSettings.backup_strategy",
        "Choose manual, scheduled, or on-change backup strategy.",
      ),
    );
  }

  if (rawState.panelSettings.backup_strategy === "scheduled" && !VALID_BACKUP_FREQUENCIES.has(rawState.panelSettings.backup_frequency)) {
    issues.push(
      createDoctorIssue(
        "backup.frequency.invalid",
        "error",
        "backup",
        `Backup frequency "${rawState.panelSettings.backup_frequency}" is invalid for scheduled backups.`,
        "panelSettings.backup_frequency",
        "Choose hourly, daily, or weekly frequency.",
      ),
    );
  }

  if (normalizedState.panelSettings.backup_destination_type === "local") {
    if (normalizedState.panelSettings.backup_local_path.trim()) {
      return;
    }
    issues.push(
      createDoctorIssue(
        "backup.local-path.missing",
        "error",
        "backup",
        "Local backup destination requires a target path.",
        "panelSettings.backup_local_path",
        "Choose a local folder for backups.",
      ),
    );
    return;
  }

  validateWebdavSettings(rawState, normalizedState, issues);
}

function validateWebdavSettings(
  rawState: AppState,
  normalizedState: AppState,
  issues: DoctorIssue[],
): void {
  if (!normalizedState.panelSettings.backup_webdav_url.trim()) {
    issues.push(
      createDoctorIssue(
        "webdav.url.missing",
        "error",
        "webdav",
        "WebDAV backup requires a server URL.",
        "panelSettings.backup_webdav_url",
        "Enter the WebDAV endpoint URL.",
      ),
    );
  }

  if (!normalizedState.panelSettings.backup_webdav_username.trim()) {
    issues.push(
      createDoctorIssue(
        "webdav.username.missing",
        "error",
        "webdav",
        "WebDAV backup requires a username.",
        "panelSettings.backup_webdav_username",
        "Enter the WebDAV username.",
      ),
    );
  }

  if (!normalizedState.panelSettings.backup_webdav_password) {
    issues.push(
      createDoctorIssue(
        "webdav.password.missing",
        "error",
        "webdav",
        "WebDAV backup requires a password.",
        "panelSettings.backup_webdav_password",
        "Enter the WebDAV password.",
      ),
    );
  }

  if (normalizedState.panelSettings.backup_webdav_url.trim()) {
    try {
      const parsed = new URL(normalizedState.panelSettings.backup_webdav_url);
      if (parsed.protocol !== "https:") {
        issues.push(
          createDoctorIssue(
            "webdav.url.protocol",
            "error",
            "webdav",
            `WebDAV URL must use https, received ${parsed.protocol}.`,
            "panelSettings.backup_webdav_url",
            "Use an https WebDAV endpoint.",
          ),
        );
      }
    } catch {
      issues.push(
        createDoctorIssue(
          "webdav.url.invalid",
          "error",
          "webdav",
          "WebDAV URL is not a valid absolute URL.",
          "panelSettings.backup_webdav_url",
          "Enter a valid https URL.",
        ),
      );
    }
  }

  if (rawState.panelSettings.backup_webdav_path.includes("\\")) {
    issues.push(
      createDoctorIssue(
        "webdav.path.invalid",
        "warning",
        "webdav",
        "WebDAV backup path should use forward slashes instead of backslashes.",
        "panelSettings.backup_webdav_path",
        "Replace backslashes with forward slashes in the WebDAV path.",
      ),
    );
  }
}

function validateShortcutConflicts(state: AppState, issues: DoctorIssue[]): void {
  const conflicts = getShortcutConflicts(state.panelSettings.shortcuts);
  for (const conflict of conflicts) {
    issues.push(
      createDoctorIssue(
        `shortcuts.conflict.${conflict.scope}.${conflict.accelerator}`,
        "warning",
        "shortcuts",
        `Shortcut ${conflict.accelerator} conflicts across actions ${conflict.actions.join(", ")}.`,
        `panelSettings.shortcuts.${conflict.actions[0]}.accelerator`,
        "Assign a different accelerator to one of the conflicting actions.",
      ),
    );
  }
}

function createDoctorIssue(
  id: string,
  severity: DoctorSeverity,
  scope: DoctorIssue["scope"],
  message: string,
  fieldPath?: string,
  suggestedAction?: string,
): DoctorIssue {
  return {
    id,
    severity,
    scope,
    message,
    fieldPath,
    suggestedAction,
  };
}

function labelManagedFile(id: ManagedFileId): string {
  if (id === "config") {
    return "Config";
  }
  if (id === "panel") {
    return "Panel settings";
  }
  return "MCP";
}

function createEmptySummary(): RedactionSummary {
  return {
    maskedCount: 0,
    maskedPaths: [],
  };
}

function addMaskedPath(summary: RedactionSummary, path: string): void {
  summary.maskedCount += 1;
  if (!summary.maskedPaths.includes(path)) {
    summary.maskedPaths.push(path);
  }
}

function redactUnknownValue(value: unknown, path: string[], summary: RedactionSummary): unknown {
  if (typeof value === "string") {
    return redactStringContent(value, path.join("."), summary);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = redactUnknownValue(value[index], [...path, String(index)], summary);
    }
    return value;
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const [key, entry] of Object.entries(value)) {
    const childPath = [...path, key];
    if (shouldRedactPath(childPath)) {
      value[key] = REDACTION_MASK;
      addMaskedPath(summary, childPath.join("."));
      continue;
    }
    value[key] = redactUnknownValue(entry, childPath, summary);
  }
  return value;
}

function shouldRedactPath(path: string[]): boolean {
  const joined = path.join(".");
  if (/(^|.)providers\.[^.]+\.api_key$/i.test(joined)) {
    return true;
  }
  if (/(^|.)panelSettings\.backup_webdav_password$/i.test(joined)) {
    return true;
  }
  const key = path[path.length - 1] ?? "";
  const parent = path[path.length - 2] ?? "";
  if (parent === "headers" && isSecretName(key)) {
    return true;
  }
  // providers.<name>.custom_headers 里的敏感 header 同样需屏蔽
  if (parent === "custom_headers" && /^(authorization|cookie)$/i.test(key)) {
    return true;
  }
  // providers.<name>.env / custom_headers 中凭据回退键
  if ((parent === "env" || parent === "custom_headers") && isSecretName(key)) {
    return true;
  }
  if (path.includes("extra") && isSecretName(key)) {
    return true;
  }
  return false;
}

function shouldRedactLooseSecretKey(key: string): boolean {
  return isSecretName(key);
}

function isSecretName(key: string): boolean {
  return SECRET_NAME_PATTERN.test(key) || GENERIC_KEY_SEGMENT_PATTERN.test(key);
}

function redactStringContent(value: string, path: string, summary: RedactionSummary): string {
  const redacted = redactUrlsInText(value, path, summary);
  return redacted;
}

function redactUrlsInText(value: string, path: string, summary: RedactionSummary): string {
  return value.replace(URL_PATTERN, (url) => {
    const redactedUrl = redactUrl(url);
    if (redactedUrl === url) {
      return url;
    }
    addMaskedPath(summary, path || "text.url");
    return redactedUrl;
  });
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    let changed = false;

    if (parsed.username) {
      parsed.username = REDACTION_MASK;
      changed = true;
    }
    if (parsed.password) {
      parsed.password = REDACTION_MASK;
      changed = true;
    }

    for (const [key, currentValue] of parsed.searchParams.entries()) {
      if (!SECRET_QUERY_PARAM_PATTERN.test(key)) {
        continue;
      }
      if (currentValue === REDACTION_MASK) {
        continue;
      }
      parsed.searchParams.set(key, REDACTION_MASK);
      changed = true;
    }

    return changed ? parsed.toString() : value;
  } catch {
    return value;
  }
}

function normalizeSemanticServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_.-]+/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FieldNode {
  known?: string[];
  children?: Record<string, FieldNode>;
  wildcard?: FieldNode;
  open?: boolean;
}

const PROVIDER_NODE: FieldNode = {
  known: [
    "type", "base_url", "api_key", "oauth", "env", "custom_headers",
    "model_source", "default_model", "source",
  ],
};
const MODEL_NODE: FieldNode = {
  known: [
    "provider", "provider_id", "protocol", "model", "aliases", "max_context_size",
    "max_input_size", "max_output_size", "off_effort", "base_url", "beta_api", "capabilities",
    "support_efforts", "default_effort", "display_name", "reasoning_key",
    "adaptive_thinking", "overrides",
  ],
};

const KNOWN_FIELD_SCHEMA: Partial<Record<ManagedFileId, FieldNode>> = {
  config: {
    known: [
      "default_model", "default_plan_mode", "default_permission_mode",
      "merge_all_available_skills", "extra_skill_dirs", "telemetry",
      "hooks", "models", "providers", "loop_control", "background",
      "notifications", "services", "mcp",
    ],
    // 顶层 open：未知 section（[thinking]/[permission]/[image]/[subagent] 等）作为透传保留，
    // 不报 drift；providers/models 子字段仍精确校验。
    open: true,
    children: {
      providers: { wildcard: PROVIDER_NODE },
      models: { wildcard: MODEL_NODE },
      loop_control: { open: true },
      background: { open: true },
      notifications: { open: true },
      services: { open: true },
      mcp: { open: true },
      thinking: { open: true },
      permission: { open: true },
      image: { open: true },
      subagent: { open: true },
    },
  },
  mcp: {
    known: ["mcpServers"],
    children: {
      mcpServers: {
        wildcard: {
          known: [
            "enabled", "transport", "type", "url", "headers", "command", "args", "env",
            "cwd", "bearerTokenEnvVar", "startupTimeoutMs", "toolTimeoutMs",
            "enabledTools", "disabledTools", "auth",
          ],
          // unknown MCP server keys are preserved via McpServerConfig.extra, so treat as open
          open: true,
        },
      },
    },
  },
};

export function detectUnknownFields(
  rawDocs: Partial<Record<ManagedFileId, unknown>>,
): ConfigDriftEntry[] {
  const drift: ConfigDriftEntry[] = [];
  for (const [file, schema] of Object.entries(KNOWN_FIELD_SCHEMA) as Array<[ManagedFileId, FieldNode]>) {
    const raw = rawDocs[file];
    if (raw === undefined || raw === null) {
      continue;
    }
    walkUnknownFields(file, raw, schema, "", drift);
  }
  return drift;
}

function walkUnknownFields(
  file: ManagedFileId,
  value: unknown,
  node: FieldNode,
  path: string,
  drift: ConfigDriftEntry[],
): void {
  if (!isRecord(value)) {
    return;
  }
  // 纯 open 节点（无 children/wildcard）：整个子树视为透传，停止下钻。
  if (node.open && !node.wildcard && !node.children) {
    return;
  }
  const known = new Set(node.known ?? []);
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (node.wildcard) {
      walkUnknownFields(file, child, node.wildcard, childPath, drift);
      continue;
    }
    if (!known.has(key)) {
      // open 节点容忍未知键（GUI 通过 extra 原样透传，保存不丢失）
      if (node.open) {
        continue;
      }
      drift.push({ file, path: path || "(root)", key });
      continue;
    }
    const childNode = node.children?.[key];
    if (childNode) {
      walkUnknownFields(file, child, childNode, childPath, drift);
    }
  }
}

/**
 * B4：对 local / WebDAV / history 恢复的文档级危险内容审查。
 * 与 `assessFullBackupRisk`（外来全量导入）语义一致的降级版：不依赖 FullBackupBundle，
 * 而是从恢复读取到的原始文档中识别自动执行 hook/command、stdio MCP 命令、
 * 远端 MCP endpoint 和 AGENTS instructions 文件。
 * 返回扁平风险行 + 每类计数，供 UI 展示完整清单（可展开/导出）。
 */
export interface RestoreDocumentsRiskSummary {
  /** 扁平风险清单（用于展示/确认/导出）。 */
  items: string[];
  /** 结构化分档。 */
  tiers: {
    configHooks: string[];
    stdioMcpCommands: string[];
    remoteMcpEndpoints: string[];
    agentsDocuments: string[];
  };
}

function redactTrustUrl(value: string): string {
  // 保留 scheme+host，隐匿 query/路径中可能的 token。
  const match = value.match(/^(https?:\/\/[^/\s]+)(.*)$/i);
  if (!match) return value;
  const stripped = match[2].replace(/[?&](token|api[_-]?key|access[_-]?token|key|password|secret)=[^&\s]+/gi, "$1=[REDACTED]");
  return `${match[1]}${stripped}`;
}

export function assessRestoreDocumentsRisk(documents: {
  configDocument?: string;
  mcpDocument?: string;
  agentsDocument?: string;
}): RestoreDocumentsRiskSummary {
  const configHooks: string[] = [];
  const stdioMcpCommands: string[] = [];
  const remoteMcpEndpoints: string[] = [];
  const agentsDocuments: string[] = [];

  const configDocument = documents.configDocument ?? "";
  // config.toml 中的 hooks / command / ProcessWrapper / local_command 自动执行点。
  const hookPatterns = [
    /^\s*\[\[?hooks?\]?/gm,
    /(?:matchers?\s*=\s*\[\s*"[^"]*")/g,
    /(?:command\s*=\s*"[^"]*")/g,
    /(?:ProcessWrapper)/g,
    /(?:local_command|run_command)\s*(?:=|\()/g,
  ];
  for (const pattern of hookPatterns) {
    const matches = configDocument.match(pattern);
    if (matches) {
      configHooks.push(`config.toml: ${matches.length} auto-execute hooks/commands detected`);
      break;
    }
  }
  // 粗略扫描 config.toml 中的绝对命令（不以 https 开头的 = value 含 /usr /bin 等）。
  const commandLines = configDocument
    .split("\n")
    .filter((line) => /(?:command|cmd)\s*=\s*["'\/]/.test(line) && !/https?:\/\//.test(line))
    .slice(0, 20)
    .map((line) => `config.toml: ${line.trim().slice(0, 200)}`);
  for (const line of commandLines) configHooks.push(line);

  const mcpDocument = documents.mcpDocument ?? "";
  if (mcpDocument.trim()) {
    try {
      const parsed = JSON.parse(mcpDocument) as { mcpServers?: Record<string, Record<string, unknown>> };
      if (parsed && Array.isArray((parsed as { mcpServers?: unknown }).mcpServers)) {
        // 白名单「已有 JSON」。实际 mcpStore 结构 mcpServers: Record。
      }
      const servers = isRecordShim(parsed) && parsed.mcpServers && typeof parsed.mcpServers === "object"
        ? parsed.mcpServers
        : {};
      for (const [name, server] of Object.entries(servers)) {
        if (!server || typeof server !== "object") continue;
        const command = typeof (server as { command?: unknown }).command === "string"
          ? (server as { command: string }).command.trim()
          : "";
        const url = typeof (server as { url?: unknown }).url === "string"
          ? (server as { url: string }).url.trim()
          : "";
        if (command) {
          stdioMcpCommands.push(`MCP ${name}: ${command}`);
        } else if (url) {
          remoteMcpEndpoints.push(`MCP ${name}: ${redactTrustUrl(url)}`);
        }
      }
    } catch {
      // 无法解析的 mcp.json 也属于风险（恢复后将破坏官方解析）。
      configHooks.push("mcp.json: not a valid JSON document");
    }
  }

  const agentsDocument = documents.agentsDocument ?? "";
  if (agentsDocument.trim()) {
    agentsDocuments.push(`AGENTS.md (${agentsDocument.length} characters)`);
  }

  return {
    items: [
      ...configHooks,
      ...stdioMcpCommands,
      ...remoteMcpEndpoints,
      ...agentsDocuments,
    ],
    tiers: { configHooks, stdioMcpCommands, remoteMcpEndpoints, agentsDocuments },
  };
}

function isRecordShim(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
