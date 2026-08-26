export type Locale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "de-DE" | "es-ES";
export type LocalizedText = Partial<Record<Locale, string>> & Record<"en-US", string>;
export type AppearanceMode = "auto" | "dark" | "light";
export type ConfigTarget = "kimi-code";
export type KimiTargetDetectionStatus = "checking" | "detected" | "not-installed";
export type KimiCodeInstallSource = "homebrew" | "official-script" | "npm" | "pnpm" | "unknown";
export type ModelAuthMode = "api-key" | "official-account";
export type OfficialAccountStatus = "empty" | "logged-in" | "invalid";
export type AppearanceTheme = "aurora" | "ocean" | "violet" | "sunset" | "forest" | "sakura" | "mint" | "cosmos" | "amber";
export type UiFontSize = "mini" | "compact" | "small" | "standard" | "large" | "extra-large";
export type DisplayOpenMode = "random" | "remember-last" | "active-display";
export type CloseBehavior = "quit" | "keep-in-tray";
export type TerminalApp = "system-terminal" | "iterm2";
export type TrayCommand = "reload";
export type McpTransport = "sse" | "stdio" | "streamable-http";
export type BackupFrequency = "hourly" | "daily" | "weekly";
export type BackupDestinationType = "local" | "webdav";
export type BackupStrategy = "manual" | "scheduled" | "on-change";
export type ShortcutScope = "global" | "window";
export type ShortcutAction =
  | "window.toggle"
  | "profile.next"
  | "profile.previous"
  | "app.reloadConfig"
  | "app.save"
  | "app.globalSearch"
  | "app.refresh"
  | "tab.overview"
  | "tab.profiles"
  | "tab.providers"
  | "tab.models"
  | "tab.mcp"
  | "tab.skills"
  | "tab.insights"
  | "tab.settings";

export interface ProviderConfig {
  type: string;
  base_url: string;
  api_key: string;
  /**
   * 0.38.0：凭据回退变量名 → 环境变量名 的映射（config-file-only）。
   * 用于在 api_key 缺省或需要时从指定环境变量取凭据，不写入 config.toml。
   */
  env?: Record<string, string>;
  /** 0.38.0：自定义请求头（子表，例如 Authorization / Cookie 等）。 */
  custom_headers?: Record<string, string>;
  /**
   * 是否启用。SQLite 为唯一真源，此开关决定是否投影写入 Kimi Code config.toml。
   * 缺省（旧数据）视为 true。
   */
  enabled?: boolean;
}

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok?: number;
  cache_creation_per_mtok?: number;
}

/**
 * 成本展示币种。定价始终以 USD 存储，展示时按用户设定汇率换算（显示层转换，
 * 不改 ModelPricing schema，零迁移风险）。
 */
export type DisplayCurrency = "USD" | "CNY" | "EUR";

export interface ModelConfig {
  provider: string;
  model: string;
  max_context_size: number;
  capabilities: string[];
  auth_mode?: ModelAuthMode;
  official_account_scope?: "global";
  pricing?: ModelPricing;
  /**
   * 0.38.0：最大输出 token 数。仅 anthropic 系生效（其余 provider 忽略）。
   */
  max_output_size?: number;
  /** 0.38.0：模型显示名（UI 向）。 */
  display_name?: string;
  /** 0.38.0：支持的 thinking effort 值域（low/medium/high/xhigh/max）。 */
  support_efforts?: string[];
  /** 0.38.0：默认 effort（openai 系为 default_reasoning_effort）。 */
  default_effort?: string;
  /** 0.38.0：openai 系 reasoning 字段键名（替换默认 reasoning_effort 键）。 */
  reasoning_key?: string;
  /** 0.38.0：anthropic 系自适应 thinking 开关。 */
  adaptive_thinking?: boolean;
  /** 0.38.0：任意子表透传（能存活 registry refresh）。 */
  overrides?: Record<string, unknown>;
  /**
   * 是否启用。仅当自身启用且其 Provider 也启用时，才投影写入 config.toml。
   * 缺省（旧数据）视为 true。
   */
  enabled?: boolean;
}

export interface OfficialAccount {
  id: string;
  display_name: string;
  account_hint: string;
  status: OfficialAccountStatus;
  is_active: boolean;
  credentials_slot_path: string;
  last_login_at: string;
  last_checked_at: string;
  last_used_at: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface OfficialAccountCredentialsStatus {
  active_account_id: string;
  credentials_present: boolean;
  standard_credentials_path: string;
}

export interface OfficialAccountOperationResult {
  account: OfficialAccount;
  active_account_id: string;
  credentials_present: boolean;
}

/**
 * Kimi Code config.toml 权限模式（0.38.0 取代旧 default_yolo 布尔）。
 */
export type PermissionMode = "manual" | "auto" | "yolo";

export interface MainConfig {
  default_model: string;
  default_plan_mode: boolean;
  /**
   * 0.38.0 取代 default_yolo。缺省视为 manual（沿用默认配置时为空串，由 CLI 兜底）。
   */
  default_permission_mode: PermissionMode | "";
  merge_all_available_skills: boolean;
  /**
   * 只读遗留字段：0.38.0 引擎忽略 profile_label，GUI 不再写入 config.toml，
   * 仅用于在加载时作为默认 profile 的显示名提示。
   */
  profile_label?: string;
  /** 0.38.0：extra_skill_dirs，追加的技能目录列表。 */
  extra_skill_dirs?: string[];
  /** 0.38.0：telemetry（默认 true）。 */
  telemetry?: boolean;
  hooks: Array<Record<string, unknown>>;
  models: Record<string, ModelConfig>;
  providers: Record<string, ProviderConfig>;
  loop_control: Record<string, unknown>;
  background: Record<string, unknown>;
  notifications: Record<string, unknown>;
  services: Record<string, unknown>;
  mcp: Record<string, unknown>;
  /**
   * 未知顶层 section 透传。Kimi Code 0.38.0 新增的思考/权限/镜像/子代理等节
   * （[thinking]/[permission]/[image]/[subagent] 等）在此原样保存，避免 GUI 保存时抹掉
   * CLI 能识别而 GUI 尚未管理的字段。
   */
  extra?: Record<string, unknown>;
}

export interface Profile {
  name: string;
  label: string;
  default_model: string;
  default_plan_mode: boolean;
  default_permission_mode: PermissionMode | "";
  merge_all_available_skills: boolean;
  /**
   * 0.38.0 起 thinking 配置在 [thinking] 表。true = thinking.enabled。
   * 缺省（undefined）= CLI 默认（enabled=true），避免误关闭用户显式配置。
   */
  thinking_enabled?: boolean;
  /** [thinking].effort：low|medium|high|xhigh|max。缺省 = 沿用 CLI 默认。 */
  thinking_effort?: string;
  /** tui.toml theme（Kimi Code 0.38.0 中主题迁移至 tui.toml）。 */
  tui_theme?: string;
  /** tui.toml [editor].command。 */
  tui_editor_command?: string;
}

export interface McpServerConfig {
  enabled: boolean;
  transport: McpTransport;
  url: string;
  headers: Record<string, string>;
  command: string;
  args: string[];
  env: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface ShortcutBinding {
  action: ShortcutAction;
  accelerator: string;
  enabled: boolean;
  scope: ShortcutScope;
}

export interface KimiCodeEnvironment {
  id: string;
  name: string;
  homePath: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  mainConfig?: MainConfig;
  profiles?: Record<string, Profile>;
  activeProfile?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sourceEnvironmentId?: string;
}

export interface PanelSettings {
  version: number;
  config_target?: ConfigTarget;
  config_path: string;
  profiles: Record<string, Profile>;
  active_profile: string;
  /** @deprecated Profiles are stored in SQLite panel settings. Kept only for legacy imports. */
  profiles_path: string;
  /** @deprecated Profiles are stored in SQLite panel settings. Kept only for legacy imports. */
  follow_config_profiles: boolean;
  theme: AppearanceMode;
  appearance_theme: AppearanceTheme;
  ui_font_size: UiFontSize;
  locale: Locale;
  tray_icon: boolean;
  sidebar_collapsed: boolean;
  display_open_mode: DisplayOpenMode;
  close_behavior: CloseBehavior;
  terminal_app: TerminalApp;
  backup_strategy: BackupStrategy;
  backup_frequency: BackupFrequency;
  backup_retention_count: number;
  backup_destination_type: BackupDestinationType;
  backup_local_path: string;
  backup_webdav_url: string;
  backup_webdav_username: string;
  backup_webdav_password: string;
  backup_webdav_path: string;
  shortcuts: Record<ShortcutAction, ShortcutBinding>;
  mcp_servers: Record<string, McpServerConfig>;
  kimi_code_environments?: KimiCodeEnvironment[];
  active_kimi_code_environment_id?: string;
  last_display_id?: number;
  uiState?: {
    activeTab?: string;
    providerSortBy?: string;
    profileSortBy?: string;
  };
  favorites?: {
    providers?: string[];
    profiles?: string[];
  };
  active_official_account_id?: string;
  insights_status?: import("./usageTypes").InsightsStatus;
  insights_proxy_port?: number | "auto";
  insights_retention_days?: number;
  insights_disk_warn_threshold_mb?: number;
  insights_store_prompt_preview?: boolean;
  insights_onboarding_shown_at?: string;
  insights_last_known_port?: number | null;
  insights_display_currency?: DisplayCurrency;
  insights_currency_rates?: Partial<Record<DisplayCurrency, number>>;
}

export interface AppState {
  configTarget?: ConfigTarget;
  kimiTargetDetection?: {
    target: ConfigTarget;
    installed: boolean;
    status: KimiTargetDetectionStatus;
    version: string;
    latestVersion?: string;
    hasUpdate?: boolean;
    packageName?: string;
    installCommand?: string;
    updateCommand?: string;
    executablePath: string;
    resolvedPath: string;
    candidates: string[];
    reason: string;
    installSource: KimiCodeInstallSource;
  };
  configPath: string;
  profilesPath: string;
  panelSettingsPath: string;
  mcpConfigPath: string;
  mainConfig: MainConfig;
  profiles: Record<string, Profile>;
  activeProfile: string;
  panelSettings: PanelSettings;
  mcpConfig: McpConfig;
}

export interface OpenKimiTerminalRequest {
  settings: PanelSettings;
  state?: AppState;
  profileName?: string;
}

export interface ProfileConnectivityTestResult {
  ok: true;
  stdout: string;
  stderr: string;
  profileName: string;
  modelName: string;
  providerName: string;
  providerType: string;
  prompt: string;
  endpoint: string;
  firstTokenMs: number;
  totalMs: number;
  status: number;
}

export interface ProfileDiffEntry {
  field: keyof Profile;
  leftValue: unknown;
  rightValue: unknown;
  isSame: boolean;
}

export interface ProfileDiff {
  left: Profile;
  right: Profile;
  differences: ProfileDiffEntry[];
}

export interface PreviewBundle {
  configDocument: string;
  panelSettingsDocument: string;
  mcpDocument: string;
  configDiff: string;
  panelDiff: string;
  mcpDiff: string;
}

export type ManagedFileId = "config" | "panel" | "mcp";

export interface FileFingerprint {
  id: ManagedFileId;
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface FileSnapshotBundle {
  capturedAt: string;
  files: Record<ManagedFileId, FileFingerprint>;
}

export interface RedactionSummary {
  maskedCount: number;
  maskedPaths: string[];
}

export interface RedactedPreviewBundle extends PreviewBundle {
  redaction: RedactionSummary;
}

export type DoctorSeverity = "error" | "warning" | "info";

export interface DoctorIssue {
  id: string;
  severity: DoctorSeverity;
  scope: ManagedFileId | "state" | "backup" | "shortcuts" | "webdav";
  message: string;
  fieldPath?: string;
  suggestedAction?: string;
}

export interface ConfigDriftEntry {
  file: ManagedFileId;
  path: string;
  key: string;
}

export interface ConfigDoctorReport {
  ok: boolean;
  generatedAt: string;
  issues: DoctorIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  drift?: ConfigDriftEntry[];
}

export interface ExternalChangeDetail {
  id: ManagedFileId;
  path: string;
  reason: "created" | "deleted" | "modified";
  expected: FileFingerprint;
  actual: FileFingerprint;
  diskDocument: string;
  draftDocument: string;
  diff: string;
}

export interface ExternalChangeConflict {
  changedFiles: ExternalChangeDetail[];
}

export interface SaveStateResult {
  ok: true;
  snapshot: FileSnapshotBundle;
  doctor: ConfigDoctorReport;
}

export interface KimiCodeEnvironmentPreferenceResult {
  ok: true;
  snapshot: FileSnapshotBundle;
  doctor: ConfigDoctorReport;
}

export interface SaveStateConflictResult {
  ok: false;
  reason: "external-change";
  snapshot: FileSnapshotBundle;
  doctor: ConfigDoctorReport;
  conflict: ExternalChangeConflict;
}

export interface ExternalChangeNotifyPayload {
  changedFileIds: ManagedFileId[];
  changedFileNames: string[];
}

export interface RestoreDryRunFilePlan {
  id: ManagedFileId;
  path: string;
  action: "create" | "replace" | "unchanged";
  currentDocument: string;
  nextDocument: string;
  diff: string;
}

export interface RestoreDryRunResult {
  backupName: string;
  doctor: ConfigDoctorReport;
  filePlans: RestoreDryRunFilePlan[];
  warnings: string[];
}

export interface RestoreBackupResult {
  ok: true;
  state: AppState;
  snapshot: FileSnapshotBundle;
  doctor: ConfigDoctorReport;
  rollbackBackupName: string;
}

export interface BackupMetadata {
  name: string;
  createdAt: string;
  trigger: "manual" | "scheduled" | "on-change" | "pre-restore" | "rollback";
  sourceHost: string;
  paths: Record<ManagedFileId, string>;
}

export interface FileDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface BackupResult {
  ok: true;
  backupPath: string;
  files: string[];
}

export interface BackupRecord {
  name: string;
  createdAt: string;
  path: string;
  itemCount?: number;
}

export type ImportConflictStrategy = "skip" | "overwrite" | "rename" | "replace";

export interface ImportConflict {
  name: string;
  type: "provider" | "model" | "profile" | "mcp_server";
  existing: boolean;
}

export interface ImportPreview {
  conflicts: ImportConflict[];
  newItems: ImportConflict[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ExportBundle {
  version: number;
  exportedAt: string;
  source: string;
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  profiles: Record<string, Profile>;
  mcpServers: Record<string, McpServerConfig>;
  panelSettings?: PanelSettings; // 可选：面板设置（字体、主题等）
}

/**
 * 单个 Kimi Code 环境的配置（用于全量备份的 environments[] 元素）。
 * Provider/Model/MCP/Profile 均按环境隔离，含真实密钥与 enabled 状态。
 */
export interface EnvironmentConfigBundle {
  environment: KimiCodeEnvironment;
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  mcpServers: Record<string, McpServerConfig>;
  profiles: Record<string, Profile>;
  activeProfile: string;
}

/**
 * 全量备份包：覆盖所有环境的配置 + 全局面板设置。
 * 单文件可移植，含真实密钥，可完整还原。
 */
export interface FullBackupBundle {
  version: number;
  kind: "full-backup";
  exportedAt: string;
  source: string;
  environments: EnvironmentConfigBundle[];
  activeEnvironmentId: string;
  panelSettings: PanelSettings;
}
