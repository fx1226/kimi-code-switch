/** Source contract, not a claim that this machine's clients have loaded a change. */
export const KIMI_CODE_CONTRACT_VERSION = "2.0.0";
export const KIMI_CODE_CONTRACT_COMMIT = "1b89e4b039f052d10f258464413b2047acca12ba";
export const KIMI_DESKTOP_INSPECTED_VERSION = "1.0.1";

export type KimiProduct = "cli" | "desktop";
export type KimiCompatibilityStatus =
  | "contract-matched"
  | "static-shared-contract"
  | "unverified-version"
  | "unknown-version";

export interface KimiCompatibility {
  product: KimiProduct;
  detectedVersion: string | null;
  expectedVersion: string;
  status: KimiCompatibilityStatus;
  nativeWritesAllowed: boolean;
  runtimeVerified: false;
}

/** Only an exact stable CLI release unlocks native writes. Newer is not verified. */
export function evaluateKimiCompatibility(
  version: string | null | undefined,
  product: KimiProduct = "cli",
): KimiCompatibility {
  const detectedVersion = version?.trim().replace(/^v/, "") || null;
  const expectedVersion = product === "cli"
    ? KIMI_CODE_CONTRACT_VERSION
    : KIMI_DESKTOP_INSPECTED_VERSION;
  const exact = detectedVersion === expectedVersion;
  const status: KimiCompatibilityStatus = detectedVersion === null
    ? "unknown-version"
    : exact
      ? product === "cli" ? "contract-matched" : "static-shared-contract"
      : "unverified-version";
  return {
    product,
    detectedVersion,
    expectedVersion,
    status,
    nativeWritesAllowed: product === "cli" && exact,
    runtimeVerified: false,
  };
}

export interface KimiFileContract {
  id: string;
  path: string;
  scope: "kimi-home" | "project-root" | "working-directory" | "os-home" | "configured";
  format: "toml" | "json" | "markdown";
  clients: "shared-runtime" | "cli-terminal";
  fields: readonly string[];
  officialValidation: "doctor-config" | "doctor-tui" | "loader";
  sourcePath: string;
}

/** Templates describe official resolution; they are not authorized write paths. */
export const KIMI_NATIVE_FILE_CONTRACTS = [
  {
    id: "config", path: "$KIMI_CODE_HOME/config.toml", scope: "kimi-home", format: "toml",
    clients: "shared-runtime", fields: ["providers", "models", "default_model", "thinking", "secondary_model", "permission", "hooks", "extra_skill_dirs"],
    officialValidation: "doctor-config", sourcePath: "packages/agent-core-v2/src/app/config/config.ts",
  },
  {
    id: "tui", path: "$KIMI_CODE_HOME/tui.toml", scope: "kimi-home", format: "toml",
    clients: "cli-terminal", fields: ["theme", "editor.command", "notifications", "upgrade", "status_line", "disable_feedback_survey", "markdown.mermaid"],
    officialValidation: "doctor-tui", sourcePath: "apps/kimi-code/src/tui/config.ts",
  },
  {
    id: "mcp-user", path: "$KIMI_CODE_HOME/mcp.json", scope: "kimi-home", format: "json",
    clients: "shared-runtime", fields: ["mcpServers"], officialValidation: "loader",
    sourcePath: "packages/agent-core-v2/src/app/mcpConfig/configLoader.ts",
  },
  {
    id: "mcp-project-root", path: "<nearest-git-root>/.mcp.json", scope: "project-root", format: "json",
    clients: "shared-runtime", fields: ["mcpServers"], officialValidation: "loader",
    sourcePath: "packages/agent-core-v2/src/app/mcpConfig/configLoader.ts",
  },
  {
    id: "mcp-project-local", path: "<cwd>/.kimi-code/mcp.json", scope: "working-directory", format: "json",
    clients: "shared-runtime", fields: ["mcpServers"], officialValidation: "loader",
    sourcePath: "packages/agent-core-v2/src/app/mcpConfig/configLoader.ts",
  },
  {
    id: "skills-user", path: "$KIMI_CODE_HOME/skills/", scope: "kimi-home", format: "markdown",
    clients: "shared-runtime", fields: ["name", "description", "type", "whenToUse", "disableModelInvocation", "arguments"],
    officialValidation: "loader", sourcePath: "packages/agent-core-v2/src/features/skill/catalog/fileSkillDiscovery.ts",
  },
  {
    id: "skills-generic-user", path: "~/.agents/skills/", scope: "os-home", format: "markdown",
    clients: "shared-runtime", fields: ["SKILL.md", "*.md"], officialValidation: "loader",
    sourcePath: "packages/agent-core-v2/src/features/skill/catalog/fileSkillDiscovery.ts",
  },
  {
    id: "plugins", path: "$KIMI_CODE_HOME/plugins/installed.json", scope: "kimi-home", format: "json",
    clients: "shared-runtime", fields: ["version", "plugins"], officialValidation: "loader",
    sourcePath: "packages/agent-core-v2/src/app/plugin/store.ts",
  },
] as const satisfies readonly KimiFileContract[];

export const KIMI_NATIVE_RESOLUTION = {
  dataHomeEnv: "KIMI_CODE_HOME",
  defaultDataHome: "~/.kimi-code",
  mcpPrecedenceLowToHigh: ["mcp-user", "mcp-project-root", "mcp-project-local"],
  mcpRootWithoutGit: "cwd",
  projectRootStdioCwdBase: "nearest-git-root-or-cwd",
  skillPrecedenceLowToHigh: ["built-in", "extra", "user", "project"],
  projectSkillDirectories: [".kimi-code/skills", ".agents/skills"],
  extraSkillDirectoriesField: "extra_skill_dirs",
  excludedDesktopPrivateState: ["ui-state.json", "Local Storage/leveldb"],
} as const;

/** A deliberately bounded form catalog. Absence must stay absent on save. */
export interface KimiEditableField {
  path: readonly string[];
  type: "string" | "boolean" | "string-array";
  values?: readonly string[];
}

export const KIMI_EDITABLE_FIELDS = {
  config: [
    { path: ["default_model"], type: "string" },
    { path: ["default_permission_mode"], type: "string", values: ["manual", "yolo", "auto"] },
    { path: ["default_plan_mode"], type: "boolean" },
    { path: ["thinking", "enabled"], type: "boolean" },
    { path: ["thinking", "effort"], type: "string", values: ["low", "medium", "high", "xhigh", "max"] },
    { path: ["merge_all_available_skills"], type: "boolean" },
    { path: ["extra_skill_dirs"], type: "string-array" },
    { path: ["telemetry"], type: "boolean" },
  ],
  tui: [
    { path: ["theme"], type: "string" },
    { path: ["render_latex"], type: "boolean" },
    { path: ["disable_paste_burst"], type: "boolean" },
    { path: ["cache_expiry_hint"], type: "boolean" },
    { path: ["disable_feedback_survey"], type: "boolean" },
    { path: ["editor", "command"], type: "string" },
    { path: ["notifications", "enabled"], type: "boolean" },
    { path: ["notifications", "notification_condition"], type: "string", values: ["unfocused", "always"] },
    { path: ["upgrade", "auto_install"], type: "boolean" },
    { path: ["status_line", "items"], type: "string-array", values: ["mode", "goal", "model", "tasks", "cwd", "git", "tips"] },
    { path: ["status_line", "command"], type: "string" },
    { path: ["markdown", "mermaid"], type: "string", values: ["final", "off"] },
  ],
  project: [
    { path: ["workspace", "additional_dir"], type: "string-array" },
  ],
} as const satisfies Record<"config" | "tui" | "project", readonly KimiEditableField[]>;
