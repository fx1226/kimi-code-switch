import parse from "@iarna/toml/parse-string.js";
import stringify from "@iarna/toml/stringify.js";

import { REDACTION_MASK } from "./configSafety";
import { ConfigResolver, ConfigTarget, parseConfigTarget } from "./configTarget";
import { SUPPORTED_CURRENCIES } from "./currency";
import { buildMcpConfigDocument, DEFAULT_MCP_CONFIG_PATH, loadMcpConfig } from "./mcpStore";
import { normalizeEntryName } from "./nameRules";
import { remapInstalledPluginRoots } from "./pluginStore";
import { createDefaultShortcuts, normalizeShortcuts } from "./shortcutStore";
import { TUI_CONFIG_FILENAME, buildTuiConfigDocument, hasTuiConfigValues, mergeTuiConfigDocument, parseTuiConfigDocumentWithDiagnostics, TuiConfigFromProfile } from "./tuiStore";
import type {
  AppState,
  BackupDestinationType,
  BackupStrategy,
  DisplayCurrency,
  EnvironmentConfigBundle,
  ExportBundle,
  FullBackupBundle,
  ImportConflict,
  ImportConflictStrategy,
  ImportPreview,
  KimiCodeEnvironment,
  MainConfig,
  McpServerConfig,
  ModelUiMetadata,
  ModelConfig,
  PanelSettings,
  PortableDirectoryBundle,
  PermissionMode,
  PreviewBundle,
  Profile,
  ProfileDiff,
  ProviderConfig,
  ValidationResult,
} from "./types";

export const PROFILE_VERSION = 1;
export const PANEL_SETTINGS_VERSION = 1;
export const PROFILE_FILENAME = "config.profiles.toml";
export const BACKUP_DIRECTORY_NAME = "backups";
export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_KIMI_CODE_ENVIRONMENT_ID = "default";
export const DEFAULT_KIMI_CODE_ENVIRONMENT_NAME = "默认环境";
export const PANEL_APP_DIRECTORY = "~/.kimi-code-switch-gui";
export const KIMI_CODE_ENVIRONMENTS_DIRECTORY = `${PANEL_APP_DIRECTORY}/.env`;
export const LEGACY_MANAGED_DEFAULT_KIMI_CODE_HOME = `${KIMI_CODE_ENVIRONMENTS_DIRECTORY}/${DEFAULT_KIMI_CODE_ENVIRONMENT_ID}`;

/**
 * 根据目标获取默认配置路径
 */
export function getDefaultConfigPath(target: ConfigTarget): string {
  const resolver = new ConfigResolver(target);
  return `~/${resolver.getConfigPath("config.toml")}`;
}

export function getDefaultMcpConfigPath(target: ConfigTarget): string {
  const resolver = new ConfigResolver(target);
  return `~/${resolver.getConfigPath("mcp.json")}`;
}

/**
 * 根据目标获取默认 panel 路径
 */
export function getDefaultPanelDirectory(target: ConfigTarget): string {
  void target;
  return PANEL_APP_DIRECTORY;
}

export function defaultKimiCodeHomePath(): string {
  return "~/.kimi-code";
}

export function getKimiCodeEnvironmentHomePath(environmentId: string): string {
  const id = sanitizeEnvironmentId(environmentId, DEFAULT_KIMI_CODE_ENVIRONMENT_ID);
  return id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
    ? defaultKimiCodeHomePath()
    : joinPath(KIMI_CODE_ENVIRONMENTS_DIRECTORY, id);
}

export function getKimiCodeConfigPath(homePath = defaultKimiCodeHomePath()): string {
  return joinPath(sanitizePath(homePath, defaultKimiCodeHomePath()), "config.toml");
}

export function getKimiCodeMcpConfigPath(homePath = defaultKimiCodeHomePath()): string {
  return joinPath(sanitizePath(homePath, defaultKimiCodeHomePath()), "mcp.json");
}

export function getKimiCodeSkillsPath(homePath = defaultKimiCodeHomePath()): string {
  return joinPath(sanitizePath(homePath, defaultKimiCodeHomePath()), "skills");
}

/**
 * tui.toml 位于 <homePath>/tui.toml（默认环境 ~/.kimi-code/tui.toml）。
 * 文件名统一取 tuiStore 的 TUI_CONFIG_FILENAME，避免两处常量漂移。
 */
export function getKimiCodeTuiConfigPath(homePath = defaultKimiCodeHomePath()): string {
  return joinPath(sanitizePath(homePath, defaultKimiCodeHomePath()), TUI_CONFIG_FILENAME);
}

export function createDefaultKimiCodeEnvironment(): KimiCodeEnvironment {
  return {
    id: DEFAULT_KIMI_CODE_ENVIRONMENT_ID,
    name: DEFAULT_KIMI_CODE_ENVIRONMENT_NAME,
    homePath: defaultKimiCodeHomePath(),
    kind: "default",
    description: "Default Kimi Code home",
    workingDirectory: "",
  };
}

export const DEFAULT_CONFIG_PATH = getDefaultConfigPath(ConfigTarget.KimiCode);
export const DEFAULT_PANEL_DIRECTORY = getDefaultPanelDirectory(ConfigTarget.KimiCode);
/** Logical database location used by previews/history; not a filesystem config file. */
export const DEFAULT_PANEL_SETTINGS_PATH = `${DEFAULT_PANEL_DIRECTORY}/app.db#panel_settings`;
export const LEGACY_PANEL_SETTINGS_PATH = "~/.kimi/config.panel.toml";
export const LEGACY_KIMI_CODE_PANEL_SETTINGS_PATH = "~/.kimi-code/.panel/config.panel.toml";
export const LEGACY_GUI_PANEL_SETTINGS_PATH = "~/.kimi-code-switch-gui/config.panel.toml";
export const LEGACY_CONFIG_PATH = "~/.kimi/config.toml";
const LEGACY_PROFILES_PATH = "~/.kimi/config.profiles.toml";
const LEGACY_MCP_CONFIG_PATH = "~/.kimi/config.mcp.json";
const LEGACY_MCP_JSON_PATH = "~/.kimi/mcp.json";
const LEGACY_MIGRATION_MARKER_PATH = `${DEFAULT_PANEL_DIRECTORY}/legacy-kimi-cli-config.migrated.json`;
const LEGACY_MANAGED_DEFAULT_ENVIRONMENT_MIGRATION_MARKER_PATH = `${DEFAULT_PANEL_DIRECTORY}/legacy-managed-default-environment.migrated.json`;
const SUPPORTED_LOCALES = new Set<PanelSettings["locale"]>(["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"]);

/**
 * Kimi Code config.toml 顶层键中 GUI 已识别的规范化字段。
 * 其余未知顶层 section 通过 MainConfig.extra 原样透传（避免保存时抹掉 CLI 新键）。
 * 已废弃的死键（profile_label/default_thinking/default_yolo/default_editor/theme/
 * show_thinking_stream）不再生成、保存时剔除、加载时忽略。
 */
export const KNOWN_MAIN_CONFIG_KEYS: readonly string[] = [
  "default_model",
  "default_plan_mode",
  "default_permission_mode",
  "merge_all_available_skills",
  "extra_skill_dirs",
  "telemetry",
  "hooks",
  "models",
  "providers",
  "loop_control",
  "background",
  "notifications",
  "services",
  "mcp",
];

/** 已废弃的顶层死键：0.38.0 由 v2 引擎忽略，save 时从 config.toml 剔除。 */
export const DEAD_MAIN_CONFIG_KEYS: readonly string[] = [
  "profile_label",
  "default_thinking",
  "default_yolo",
  "default_editor",
  "theme",
  "show_thinking_stream",
];

const ACTIVE_MAIN_CONFIG_KEYS = new Set([
  ...KNOWN_MAIN_CONFIG_KEYS,
  ...DEAD_MAIN_CONFIG_KEYS,
]);

type ProfileConfigKey = Exclude<keyof Profile, "name" | "label">;

const PROFILE_KEYS: readonly ProfileConfigKey[] = [
  "default_model",
  "default_plan_mode",
  "default_permission_mode",
  "merge_all_available_skills",
  "thinking_enabled",
  "thinking_effort",
  "tui_theme",
  "tui_editor_command",
];

const DEFAULTS = {
  default_model: "",
  default_plan_mode: false,
  default_permission_mode: "",
  merge_all_available_skills: true,
} as const;

export interface SaveTransactionRecord {
  version: 1;
  kind: "save-app-state";
  createdAt: string;
  textFiles: Array<{
    path: string;
    originalContent: string | null;
    desiredContent: string;
  }>;
  panelOriginal?: PanelSettings | null;
  panelDesired?: PanelSettings;
}

export interface StandardEnvironmentConfig {
  mainConfig: MainConfig;
  mcpServers: Record<string, McpServerConfig>;
  tuiDocument?: string;
  agentsDocument?: string;
  skillsDirectory?: PortableDirectoryBundle;
  pluginsDirectory?: PortableDirectoryBundle;
}

export interface FileAccess {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  writeTextCas?(path: string, content: string, expectedSha256: string): Promise<string>;
  removeTextCas?(path: string, expectedSha256: string): Promise<void>;
  beginSaveTransaction?(record: SaveTransactionRecord): Promise<void>;
  completeSaveTransaction?(): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /** Migrate a legacy directory without replacing files already owned by the native home. */
  mergeDirectoryMissing?(from: string, to: string): Promise<{
    sourceExists: boolean;
    copiedEntries: number;
    skippedConflicts: number;
  }>;
  // 可选：PanelSettings 专用读写（用于 SQLite 存储）
  // 若未提供，回退到 readText/writeText + TOML
  readPanelSettings?(path: string): Promise<PanelSettings | null>;
  writePanelSettings?(path: string, settings: PanelSettings): Promise<void>;
}

/**
 * Return the native Kimi Code document shape. Historical GUI-only fields are
 * stripped, but every native Provider and Model is retained.
 */
export function projectEnabledMainConfig(config: MainConfig): MainConfig {
  const projected = cloneMainConfig(config);
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    const { enabled: _legacyEnabled, ...rest } = provider as ProviderConfig & { enabled?: boolean };
    providers[name] = rest;
  }
  const models: Record<string, ModelConfig> = {};
  for (const [name, model] of Object.entries(config.models)) {
    const {
      enabled: _legacyEnabled,
      auth_mode: _authMode,
      official_account_scope: _officialAccountScope,
      pricing: _pricing,
      ...rest
    } = model as ModelConfig & { enabled?: boolean };
    models[name] = rest;
  }
  projected.providers = providers;
  projected.models = models;
  // extra（含 [thinking]/[permission] 等未知节透传）直接保留
  return projected;
}

function modelUiMetadataForEnvironment(
  settings: PanelSettings,
  environmentId: string,
): Record<string, ModelUiMetadata> {
  return structuredClone(settings.model_ui_metadata?.[environmentId] ?? {});
}

function overlayModelUiMetadata(
  mainConfig: MainConfig,
  settings: PanelSettings,
  environmentId: string,
): void {
  const metadata = modelUiMetadataForEnvironment(settings, environmentId);
  for (const [modelId, model] of Object.entries(mainConfig.models)) {
    const ui = metadata[modelId];
    if (!ui) continue;
    mainConfig.models[modelId] = {
      ...model,
      ...(ui.auth_mode ? { auth_mode: ui.auth_mode } : {}),
      ...(ui.official_account_scope ? { official_account_scope: ui.official_account_scope } : {}),
      ...(ui.pricing ? { pricing: structuredClone(ui.pricing) } : {}),
    };
  }
}

function snapshotModelUiMetadata(
  settings: PanelSettings,
  environmentId: string,
  models: Record<string, ModelConfig>,
): PanelSettings["model_ui_metadata"] {
  const next = structuredClone(settings.model_ui_metadata ?? {});
  const environmentMetadata: Record<string, ModelUiMetadata> = {};
  for (const [modelId, model] of Object.entries(models)) {
    const metadata: ModelUiMetadata = {
      ...(model.auth_mode ? { auth_mode: model.auth_mode } : {}),
      ...(model.official_account_scope ? { official_account_scope: model.official_account_scope } : {}),
      ...(model.pricing ? { pricing: structuredClone(model.pricing) } : {}),
    };
    if (Object.keys(metadata).length > 0) environmentMetadata[modelId] = metadata;
  }
  if (Object.keys(environmentMetadata).length > 0) {
    next[environmentId] = environmentMetadata;
  } else {
    delete next[environmentId];
  }
  return next;
}

export function createDefaultPanelSettings(
  configPath = DEFAULT_CONFIG_PATH,
  _settingsPath = DEFAULT_PANEL_SETTINGS_PATH,
): PanelSettings {
  return {
    version: PANEL_SETTINGS_VERSION,
    config_target: ConfigTarget.KimiCode,
    config_path: configPath,
    profiles: {},
    active_profile: DEFAULT_PROFILE_NAME,
    profiles_path: "",
    follow_config_profiles: true,
    theme: "auto",
    appearance_theme: "aurora",
    ui_font_size: "standard",
    locale: "zh-CN",
    tray_icon: false,
    sidebar_collapsed: false,
    display_open_mode: "remember-last",
    close_behavior: "quit",
    terminal_app: "system-terminal",
    backup_strategy: "manual",
    backup_frequency: "daily",
    backup_retention_count: 10,
    backup_destination_type: "local",
    backup_local_path: defaultBackupPath(),
    backup_webdav_url: "",
    backup_webdav_username: "",
    backup_webdav_password: "",
    backup_webdav_path: "",
    shortcuts: createDefaultShortcuts(),
    model_ui_metadata: {},
    official_account_vault_enabled: false,
    kimi_code_environments: [createDefaultKimiCodeEnvironment()],
    active_kimi_code_environment_id: DEFAULT_KIMI_CODE_ENVIRONMENT_ID,
    insights_status: "disabled",
    insights_proxy_port: "auto",
    insights_retention_days: 90,
    insights_disk_warn_threshold_mb: 100,
    insights_store_prompt_preview: false,
    insights_onboarding_shown_at: "",
    insights_last_known_port: null,
    insights_display_currency: "USD",
    insights_currency_rates: {},
  };
}

export function cloneState(state: AppState): AppState {
  return structuredClone(state) as AppState;
}

export async function loadAppState(
  files: FileAccess,
  paths?: {
    configTarget?: ConfigTarget;
    configPath?: string;
    profilesPath?: string;
    panelSettingsPath?: string;
    mcpConfigPath?: string;
  },
): Promise<AppState> {
  // Panel settings may still contain historical target data, but the GUI now
  // manages Kimi Code only.
  const panelSettingsPath = paths?.panelSettingsPath ?? DEFAULT_PANEL_SETTINGS_PATH;
  const panelSettingsResult = await loadPanelSettingsWithLegacyFallback(files, panelSettingsPath);
  const panelSettings = panelSettingsResult.settings;

  const configTarget = ConfigTarget.KimiCode;
  const activeEnvironment = resolveActiveKimiCodeEnvironment(panelSettings);
  const environmentConfigPath = getKimiCodeConfigPath(activeEnvironment.homePath);
  const environmentMcpConfigPath = getKimiCodeMcpConfigPath(activeEnvironment.homePath);
  const mcpConfigPath = sanitizePath(paths?.mcpConfigPath, environmentMcpConfigPath);
  const configPath = sanitizePath(paths?.configPath, environmentConfigPath);
  const profilesPath = "";
  const resolvedPanelSettingsPath = sanitizePath(
    panelSettingsPath,
    DEFAULT_PANEL_SETTINGS_PATH,
  );
  const mainConfig = normalizeMainConfig(await loadTomlFile(files, configPath, "main config"));
  const tuiResult = parseTuiConfigDocumentWithDiagnostics(
    await safeReadText(files, getKimiCodeTuiConfigPath(activeEnvironment.homePath)),
  );
  const tuiConfig = tuiResult.config;

  // Native config.toml owns all provider/model definitions. The database keeps
  // only display metadata that cannot be represented by Kimi Code itself.
  overlayModelUiMetadata(mainConfig, panelSettings, activeEnvironment.id);
  const fileMcpConfig = await loadMcpConfig(files, mcpConfigPath);
  const environments = parseKimiCodeEnvironments(
    panelSettings.kimi_code_environments,
    [createDefaultKimiCodeEnvironment()],
  );
  const environmentMcpServers = getEnvironmentMcpServers(activeEnvironment, panelSettings, fileMcpConfig.mcpServers);
  const mcpConfig = {
    mcpServers: environmentMcpServers,
  };

  const legacyProfiles = await loadLegacyProfiles(files, paths?.profilesPath, configPath, mainConfig);
  const environmentProfiles = getEnvironmentProfiles(activeEnvironment, panelSettings, mainConfig);
  const profiles = environmentProfiles
    ?? legacyProfiles?.profiles
    ?? bootstrapProfiles(mainConfig);
  const activeProfile = ensureActiveProfile(
    getEnvironmentActiveProfile(activeEnvironment, panelSettings)
      || legacyProfiles?.activeProfile
      || pickActiveProfile(mainConfig, profiles),
    profiles,
  );
  const scopedEnvironments = snapshotActiveKimiCodeEnvironment(environments, activeEnvironment.id, {
    profiles,
    activeProfile,
  });

  return {
    configTarget,
    configPath,
    profilesPath,
    panelSettingsPath: resolvedPanelSettingsPath,
    mcpConfigPath,
    mainConfig,
    profiles,
    activeProfile,
    panelSettings: {
      ...panelSettings,
      config_target: configTarget,
      config_path: configPath,
      profiles,
      active_profile: activeProfile,
      profiles_path: "",
      follow_config_profiles: true,
      kimi_code_environments: scopedEnvironments,
      active_kimi_code_environment_id: activeEnvironment.id,
    },
    mcpConfig,
    tuiConfig,
    tuiDiagnostics: { errors: tuiResult.errors, warnings: tuiResult.warnings },
  };
}

export async function loadPanelSettings(
  files: FileAccess,
  panelSettingsPath: string,
): Promise<PanelSettings> {
  const fallback = createDefaultPanelSettings(DEFAULT_CONFIG_PATH, panelSettingsPath);
  const data = await loadTomlFile(files, panelSettingsPath, "panel settings");
  return panelSettingsFromUnknown(data, fallback);
}

async function loadPanelSettingsWithLegacyFallback(
  files: FileAccess,
  panelSettingsPath: string,
): Promise<{ settings: PanelSettings; migratedFromLegacy: boolean }> {
  // 优先使用 SQLite（若 files.readPanelSettings 存在）
  if (files.readPanelSettings) {
    const settings = await files.readPanelSettings(panelSettingsPath);
    if (settings) {
      return { settings, migratedFromLegacy: false };
    }
    // SQLite 为空，尝试从 TOML 迁移
    const tomlSettings = await tryLoadPanelSettingsFromToml(files, panelSettingsPath);
    if (tomlSettings) {
      // 迁移到 SQLite（files.writePanelSettings 负责 TOML 文件重命名）
      if (files.writePanelSettings) {
        await files.writePanelSettings(panelSettingsPath, tomlSettings.settings);
      }
      return tomlSettings;
    }
    // 都没有，返回默认值
    return {
      settings: createDefaultPanelSettings(DEFAULT_CONFIG_PATH, panelSettingsPath),
      migratedFromLegacy: false,
    };
  }

  // 回退：使用 TOML 文件（测试环境）
  if (panelSettingsPath !== DEFAULT_PANEL_SETTINGS_PATH) {
    return {
      settings: await loadPanelSettings(files, panelSettingsPath),
      migratedFromLegacy: false,
    };
  }

  let primaryDocument: string | null;
  try {
    primaryDocument = await files.readText(panelSettingsPath);
  } catch (error) {
    throw new Error(`Failed to read panel settings at ${panelSettingsPath}: ${formatErrorMessage(error)}`);
  }
  if (primaryDocument?.trim()) {
    try {
      return {
        settings: panelSettingsFromUnknown(
          parseDocument(primaryDocument),
          createDefaultPanelSettings(DEFAULT_CONFIG_PATH, panelSettingsPath),
        ),
        migratedFromLegacy: false,
      };
    } catch (error) {
      throw new Error(`Invalid panel settings TOML at ${panelSettingsPath}: ${formatErrorMessage(error)}`);
    }
  }

  const legacyTomlSettings = await loadLegacyPanelSettings(files, panelSettingsPath);
  if (legacyTomlSettings) {
    return legacyTomlSettings;
  }
  return {
    settings: createDefaultPanelSettings(DEFAULT_CONFIG_PATH, panelSettingsPath),
    migratedFromLegacy: false,
  };
}

// 辅助函数：尝试从 TOML 文件加载（用于迁移）
async function tryLoadPanelSettingsFromToml(
  files: FileAccess,
  panelSettingsPath: string,
): Promise<{ settings: PanelSettings; migratedFromLegacy: boolean } | null> {
  if (panelSettingsPath !== DEFAULT_PANEL_SETTINGS_PATH) {
    try {
      return {
        settings: await loadPanelSettings(files, panelSettingsPath),
        migratedFromLegacy: false,
      };
    } catch {
      return null;
    }
  }

  // 尝试主 TOML
  try {
    const primaryDocument = await files.readText(panelSettingsPath);
    if (primaryDocument?.trim()) {
      return {
        settings: panelSettingsFromUnknown(
          parseDocument(primaryDocument),
          createDefaultPanelSettings(DEFAULT_CONFIG_PATH, panelSettingsPath),
        ),
        migratedFromLegacy: false,
      };
    }
  } catch {
    // 忽略，尝试 legacy
  }

  return loadLegacyPanelSettings(files, panelSettingsPath);
}

async function loadLegacyPanelSettings(
  files: FileAccess,
  panelSettingsPath: string,
): Promise<{ settings: PanelSettings; migratedFromLegacy: boolean } | null> {
  for (const legacyPath of [
    LEGACY_GUI_PANEL_SETTINGS_PATH,
    LEGACY_KIMI_CODE_PANEL_SETTINGS_PATH,
    LEGACY_PANEL_SETTINGS_PATH,
  ]) {
    try {
      const legacyData = await loadTomlFile(files, legacyPath, "legacy panel settings");
      if (Object.keys(legacyData).length) {
        return {
          settings: panelSettingsFromUnknown(legacyData, createDefaultPanelSettings(DEFAULT_CONFIG_PATH, panelSettingsPath)),
          migratedFromLegacy: true,
        };
      }
    } catch {
      // 忽略，继续尝试下一个历史路径。
    }
  }
  return null;
}

export function parsePanelSettingsDocument(document: string, fallback = createDefaultPanelSettings()): PanelSettings {
  // 尝试 JSON 格式（新备份）
  if (document.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(document);
      return panelSettingsFromUnknown(parsed, fallback);
    } catch {
      // 忽略，回退到 TOML
    }
  }
  // 回退到 TOML 格式（旧备份/TOML 文件）
  return panelSettingsFromUnknown(parseDocument(document), fallback);
}

function sanitizeCurrencyRates(
  raw: unknown,
  fallback: Partial<Record<DisplayCurrency, number>> | undefined,
): Partial<Record<DisplayCurrency, number>> {
  if (typeof raw !== "object" || raw === null) {
    return fallback ?? {};
  }
  const source = raw as Record<string, unknown>;
  const out: Partial<Record<DisplayCurrency, number>> = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    const v = source[currency];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[currency] = v;
    }
  }
  return out;
}

function panelSettingsFromUnknown(data: Record<string, unknown>, fallback: PanelSettings): PanelSettings {
  const trayIcon = typeof data.tray_icon === "boolean" ? data.tray_icon : false;
  const configPath =
    typeof data.config_path === "string" && data.config_path.trim()
      ? data.config_path
      : fallback.config_path;
  const backupLocalPathFallback = defaultBackupPath();
  const backupStrategy = (() => {
    if (
      data.backup_strategy === "manual" ||
      data.backup_strategy === "scheduled" ||
      data.backup_strategy === "on-change"
    ) {
      return data.backup_strategy;
    }
    if (asBoolean(data.backup_schedule_enabled, asBoolean(data.backup_enabled, false))) {
      return "scheduled";
    }
    if (asBoolean(data.backup_on_change_enabled, false)) {
      return "on-change";
    }
    return fallback.backup_strategy;
  })();
  return {
    version: PANEL_SETTINGS_VERSION,
    config_target: parseConfigTarget(data.config_target ?? fallback.config_target),
    config_path: configPath,
    profiles: sanitizeProfilesRecord(data.profiles, fallback.profiles),
    active_profile: asString(data.active_profile, fallback.active_profile),
    profiles_path:
      typeof data.profiles_path === "string" ? data.profiles_path : fallback.profiles_path,
    follow_config_profiles:
      typeof data.follow_config_profiles === "boolean"
        ? data.follow_config_profiles
        : true,
    theme: parseAppearanceMode(data.theme, fallback.theme),
    appearance_theme: parseAppearanceTheme(data.appearance_theme, fallback.appearance_theme),
    ui_font_size: parseUiFontSize(data.ui_font_size, fallback.ui_font_size),
    locale: parseLocale(data.locale, fallback.locale),
    tray_icon: trayIcon,
    sidebar_collapsed: asBoolean(data.sidebar_collapsed, fallback.sidebar_collapsed),
    display_open_mode: parseDisplayOpenMode(data.display_open_mode, fallback.display_open_mode),
    close_behavior: trayIcon ? parseCloseBehavior(data.close_behavior, "keep-in-tray") : "quit",
    terminal_app: parseTerminalApp(data.terminal_app, fallback.terminal_app),
    backup_strategy: backupStrategy,
    backup_frequency: parseBackupFrequency(data.backup_frequency, fallback.backup_frequency),
    backup_retention_count: parseBackupRetentionCount(data.backup_retention_count, fallback.backup_retention_count),
    backup_destination_type: parseBackupDestinationType(data.backup_destination_type, fallback.backup_destination_type),
    backup_local_path: sanitizePath(
      asString(data.backup_local_path, asString(data.backup_path, backupLocalPathFallback)),
      backupLocalPathFallback,
    ),
    backup_webdav_url: asString(data.backup_webdav_url, ""),
    backup_webdav_username: asString(data.backup_webdav_username, ""),
    backup_webdav_password: asString(data.backup_webdav_password, ""),
    backup_webdav_path: asString(data.backup_webdav_path, ""),
    shortcuts: normalizeShortcuts(data.shortcuts),
    model_ui_metadata: parseModelUiMetadata(data.model_ui_metadata),
    kimi_code_environments: parseKimiCodeEnvironments(data.kimi_code_environments, fallback.kimi_code_environments),
    active_kimi_code_environment_id: asString(
      data.active_kimi_code_environment_id,
      fallback.active_kimi_code_environment_id ?? DEFAULT_KIMI_CODE_ENVIRONMENT_ID,
    ),
    last_display_id: typeof data.last_display_id === "number" ? data.last_display_id : undefined,
    uiState: parseUiState(data.uiState),
    favorites: parseFavorites(data.favorites),
    official_account_vault_enabled: asBoolean(data.official_account_vault_enabled, false),
    active_official_account_id: asString(data.active_official_account_id, fallback.active_official_account_id ?? ""),
    insights_status:
      data.insights_status === "enabled" || data.insights_status === "paused" || data.insights_status === "disabled"
        ? data.insights_status
        : fallback.insights_status,
    insights_proxy_port:
      data.insights_proxy_port === "auto" || typeof data.insights_proxy_port === "number"
        ? data.insights_proxy_port
        : fallback.insights_proxy_port,
    insights_retention_days:
      typeof data.insights_retention_days === "number"
        ? data.insights_retention_days
        : fallback.insights_retention_days,
    insights_disk_warn_threshold_mb:
      typeof data.insights_disk_warn_threshold_mb === "number"
        ? data.insights_disk_warn_threshold_mb
        : fallback.insights_disk_warn_threshold_mb,
    insights_store_prompt_preview:
      typeof data.insights_store_prompt_preview === "boolean"
        ? data.insights_store_prompt_preview
        : fallback.insights_store_prompt_preview,
    insights_onboarding_shown_at:
      typeof data.insights_onboarding_shown_at === "string"
        ? data.insights_onboarding_shown_at
        : fallback.insights_onboarding_shown_at,
    insights_last_known_port:
      typeof data.insights_last_known_port === "number"
        ? data.insights_last_known_port
        : fallback.insights_last_known_port ?? null,
    insights_display_currency:
      typeof data.insights_display_currency === "string" &&
      (SUPPORTED_CURRENCIES as readonly string[]).includes(data.insights_display_currency)
        ? (data.insights_display_currency as DisplayCurrency)
        : fallback.insights_display_currency,
    insights_currency_rates: sanitizeCurrencyRates(
      data.insights_currency_rates,
      fallback.insights_currency_rates,
    ),
  };
}

export async function saveAppState(
  files: FileAccess,
  state: AppState,
  options?: { expectedSha256?: Partial<Record<"config" | "mcp" | "tui", string>> },
): Promise<void> {
  const normalizedState = normalizeStatePaths(state);
  const stateToPersist: AppState = {
    ...normalizedState,
    panelSettings: {
      ...normalizedState.panelSettings,
      profiles: sanitizeProfilesRecord(normalizedState.profiles),
      active_profile: normalizedState.activeProfile,
      model_ui_metadata: snapshotModelUiMetadata(
        normalizedState.panelSettings,
        normalizedState.panelSettings.active_kimi_code_environment_id ?? DEFAULT_KIMI_CODE_ENVIRONMENT_ID,
        normalizedState.mainConfig.models,
      ),
      profiles_path: "",
      follow_config_profiles: true,
    },
  };

  await files.ensureDir(dirnamePath(normalizedState.configPath));
  await files.ensureDir(dirnamePath(normalizedState.panelSettingsPath));
  await files.ensureDir(dirnamePath(normalizedState.mcpConfigPath));
  const stateForConfig = await restoreRedactedProviderSecrets(files, stateToPersist);

  // Standard Kimi Code files are the sole source for native configuration.
  const projectedConfig: AppState = {
    ...stateForConfig,
    mainConfig: projectEnabledMainConfig(stateForConfig.mainConfig),
  };
  const configDocument = buildConfigDocument(projectedConfig);
  const mcpDocument = buildMcpConfigDocument(stateToPersist.mcpConfig);
  const [originalConfigDocument, originalMcpDocument, originalPanelDocument, originalPanelSettings] = await Promise.all([
    safeReadText(files, normalizedState.configPath),
    safeReadText(files, stateToPersist.mcpConfigPath),
    files.readPanelSettings ? Promise.resolve(null) : safeReadText(files, stateToPersist.panelSettingsPath),
    files.readPanelSettings
      ? files.readPanelSettings(stateToPersist.panelSettingsPath)
      : Promise.resolve(null),
  ]);

  const tuiConfig = stateForConfig.tuiConfig ?? {};
  const tuiConfigPath = getKimiCodeTuiConfigPath(dirnamePath(stateForConfig.configPath));
  const existingTuiDocument = await safeReadText(files, tuiConfigPath);
  const nextTuiDocument = hasTuiConfigValues(tuiConfig)
    ? existingTuiDocument?.trim()
      ? mergeTuiConfigDocument(existingTuiDocument, tuiConfig)
      : buildTuiConfigDocument(tuiConfig)
    : null;
  const transactionTextFiles: SaveTransactionRecord["textFiles"] = [
    {
      path: normalizedState.configPath,
      originalContent: originalConfigDocument,
      desiredContent: configDocument,
    },
    {
      path: stateToPersist.mcpConfigPath,
      originalContent: originalMcpDocument,
      desiredContent: mcpDocument,
    },
    ...(!files.writePanelSettings
      ? [{
          path: stateToPersist.panelSettingsPath,
          originalContent: originalPanelDocument,
          desiredContent: buildPanelSettingsDocument(stateToPersist.panelSettings),
        }]
      : []),
    ...(nextTuiDocument !== null && nextTuiDocument !== existingTuiDocument
      ? [{ path: tuiConfigPath, originalContent: existingTuiDocument, desiredContent: nextTuiDocument }]
      : []),
  ];
  await files.beginSaveTransaction?.({
    version: 1,
    kind: "save-app-state",
    createdAt: new Date().toISOString(),
    textFiles: transactionTextFiles,
    ...(files.writePanelSettings
      ? { panelOriginal: originalPanelSettings, panelDesired: stateToPersist.panelSettings }
      : {}),
  });
  let writtenConfigHash: string | undefined;
  let writtenMcpHash: string | undefined;
  let panelWritten = false;
  try {
    writtenConfigHash = await writeTextWithOptionalCas(
      files,
      normalizedState.configPath,
      configDocument,
      options?.expectedSha256?.config,
    );
    writtenMcpHash = await writeTextWithOptionalCas(
      files,
      stateToPersist.mcpConfigPath,
      mcpDocument,
      options?.expectedSha256?.mcp,
    );

    // Panel settings：优先使用 SQLite（若 writePanelSettings 存在）
    if (files.writePanelSettings) {
      await files.writePanelSettings(stateToPersist.panelSettingsPath, stateToPersist.panelSettings);
    } else {
      await files.writeText(
        stateToPersist.panelSettingsPath,
        buildPanelSettingsDocument(stateToPersist.panelSettings),
      );
    }
    panelWritten = true;

    // TUI is part of the same logical save. It is written last so a failure can
    // roll back config/MCP/panel without any later sibling write racing that
    // rollback. Rust write_text itself is atomic.
    if (nextTuiDocument !== null && nextTuiDocument !== existingTuiDocument) {
      await files.ensureDir(dirnamePath(tuiConfigPath));
      await writeTextWithOptionalCas(
        files,
        tuiConfigPath,
        nextTuiDocument,
        options?.expectedSha256?.tui,
      );
    }
    await files.completeSaveTransaction?.();
  } catch (error) {
    let rollbackComplete = true;
    if (panelWritten) {
      try {
        if (files.writePanelSettings && originalPanelSettings) {
          await files.writePanelSettings(stateToPersist.panelSettingsPath, originalPanelSettings);
        } else if (!files.writePanelSettings && originalPanelDocument !== null) {
          await files.writeText(stateToPersist.panelSettingsPath, originalPanelDocument);
        } else {
          rollbackComplete = false;
        }
      } catch (rollbackError) {
        rollbackComplete = false;
        console.error("Could not roll back panel settings after partial save:", rollbackError);
      }
    }
    rollbackComplete = await rollbackCasWrite(
      files,
      stateToPersist.mcpConfigPath,
      originalMcpDocument,
      writtenMcpHash,
    ) && rollbackComplete;
    rollbackComplete = await rollbackCasWrite(
      files,
      normalizedState.configPath,
      originalConfigDocument,
      writtenConfigHash,
    ) && rollbackComplete;
    if (rollbackComplete) {
      try {
        await files.completeSaveTransaction?.();
      } catch (rollbackError) {
        console.error("Could not clear completed save rollback journal:", rollbackError);
      }
    }
    throw error;
  }

}

async function writeTextWithOptionalCas(
  files: FileAccess,
  path: string,
  content: string,
  expectedSha256: string | undefined,
): Promise<string | undefined> {
  if (expectedSha256 !== undefined && files.writeTextCas) {
    return files.writeTextCas(path, content, expectedSha256);
  }
  await files.writeText(path, content);
  return undefined;
}

async function rollbackCasWrite(
  files: FileAccess,
  path: string,
  originalContent: string | null,
  writtenSha256: string | undefined,
): Promise<boolean> {
  if (writtenSha256 === undefined) return true;
  try {
    if (originalContent === null) {
      if (!files.removeTextCas) return false;
      await files.removeTextCas(path, writtenSha256);
    } else {
      if (!files.writeTextCas) return false;
      await files.writeTextCas(path, originalContent, writtenSha256);
    }
    return true;
  } catch (rollbackError) {
    console.error(`Could not roll back partial save for ${path}:`, rollbackError);
    return false;
  }
}

export interface LegacyKimiCliMigrationResult {
  migrated: boolean;
  configMerged: boolean;
  profilesCopied: boolean;
  mcpMerged: boolean;
  reason?: string;
}

export async function migrateLegacyKimiCliConfigToKimiCode(files: FileAccess): Promise<LegacyKimiCliMigrationResult> {
  const marker = await safeReadText(files, LEGACY_MIGRATION_MARKER_PATH);
  if (marker?.trim()) {
    return { migrated: false, configMerged: false, profilesCopied: false, mcpMerged: false, reason: "already-migrated" };
  }

  const legacyConfigDocument = await safeReadText(files, LEGACY_CONFIG_PATH);
  const legacyMcpJsonDocument = await safeReadText(files, LEGACY_MCP_JSON_PATH);
  const legacyMcpDocument = legacyMcpJsonDocument?.trim()
    ? legacyMcpJsonDocument
    : await safeReadText(files, LEGACY_MCP_CONFIG_PATH);
  if (!legacyConfigDocument?.trim() && !legacyMcpDocument?.trim()) {
    await writeLegacyMigrationMarker(files, { migrated: false, configMerged: false, profilesCopied: false, mcpMerged: false, reason: "legacy-config-missing" });
    return { migrated: false, configMerged: false, profilesCopied: false, mcpMerged: false, reason: "legacy-config-missing" };
  }

  let configMerged = false;
  let profilesCopied = false;
  let mcpMerged = false;

  // 迁移目标显式解析为官方默认环境真实目录 ~/.kimi-code；GUI 不再搬迁该目录
  // 或用软链接切换环境，因此 legacy 数据不会误写到某个托管环境。
  const defaultEnvHome = defaultKimiCodeHomePath();
  const defaultEnvConfigPath = getKimiCodeConfigPath(defaultEnvHome);
  const defaultEnvMcpPath = getKimiCodeMcpConfigPath(defaultEnvHome);

  if (legacyConfigDocument?.trim()) {
    try {
      const legacyConfig = parseDocument(legacyConfigDocument);
      const currentConfigDocument = await safeReadText(files, defaultEnvConfigPath);
      const currentConfig = parseDocument(currentConfigDocument);
      const { value, changed } = mergeLegacyMainConfig(currentConfig, legacyConfig);
      if (changed) {
        await files.ensureDir(dirnamePath(defaultEnvConfigPath));
        await files.writeText(defaultEnvConfigPath, stringify(value));
        configMerged = true;
      }
    } catch (error) {
      await writeLegacyMigrationMarker(files, { migrated: false, configMerged: false, profilesCopied: false, mcpMerged: false, reason: formatErrorMessage(error) });
      throw new Error(`Failed to migrate legacy Kimi CLI config: ${formatErrorMessage(error)}`);
    }
  }

  // Profile data is GUI-private state now. Do not create config.profiles.toml
  // for Kimi Code; loadAppState performs a one-time in-memory legacy import
  // from old files into SQLite panel settings on the next save.
  profilesCopied = false;

  const targetMcpPath = defaultEnvMcpPath;
  const currentMcpDocument = await safeReadText(files, targetMcpPath);
  if (legacyMcpDocument?.trim()) {
    const merged = mergeJsonMcpDocuments(currentMcpDocument, legacyMcpDocument);
    if (merged.changed) {
      await files.ensureDir(dirnamePath(targetMcpPath));
      await files.writeText(targetMcpPath, JSON.stringify(merged.value, null, 2));
      mcpMerged = true;
    }
  }

  const result = {
    migrated: configMerged || profilesCopied || mcpMerged,
    configMerged,
    profilesCopied,
    mcpMerged,
  };
  await writeLegacyMigrationMarker(files, result);
  return result;
}

export interface LegacyManagedDefaultEnvironmentMigrationResult {
  migrated: boolean;
  configMerged: boolean;
  mcpMerged: boolean;
  tuiMerged: boolean;
  agentsCopied: boolean;
  skillsCopied: boolean;
  pluginsMerged: boolean;
  reason?: string;
}

/**
 * One-time recovery for releases that treated the GUI data directory as the
 * default KIMI_CODE_HOME. Native files always win; this only fills missing
 * configuration and directory entries before the default record is normalized
 * back to ~/.kimi-code.
 */
export async function migrateLegacyManagedDefaultEnvironmentToNativeHome(
  files: FileAccess,
): Promise<LegacyManagedDefaultEnvironmentMigrationResult> {
  const marker = await safeReadText(files, LEGACY_MANAGED_DEFAULT_ENVIRONMENT_MIGRATION_MARKER_PATH);
  if (marker?.trim()) {
    return {
      migrated: false,
      configMerged: false,
      mcpMerged: false,
      tuiMerged: false,
      agentsCopied: false,
      skillsCopied: false,
      pluginsMerged: false,
      reason: "already-migrated",
    };
  }

  const sourceHome = LEGACY_MANAGED_DEFAULT_KIMI_CODE_HOME;
  const targetHome = defaultKimiCodeHomePath();
  const sourceConfigPath = getKimiCodeConfigPath(sourceHome);
  const targetConfigPath = getKimiCodeConfigPath(targetHome);
  const sourceMcpPath = getKimiCodeMcpConfigPath(sourceHome);
  const targetMcpPath = getKimiCodeMcpConfigPath(targetHome);
  const sourceTuiPath = getKimiCodeTuiConfigPath(sourceHome);
  const targetTuiPath = getKimiCodeTuiConfigPath(targetHome);
  const sourceAgentsPath = `${sourceHome}/AGENTS.md`;
  const targetAgentsPath = `${targetHome}/AGENTS.md`;
  const sourcePluginsPath = `${sourceHome}/plugins/installed.json`;
  const targetPluginsPath = `${targetHome}/plugins/installed.json`;

  const [
    legacyConfigDocument,
    legacyMcpDocument,
    legacyTuiDocument,
    legacyAgentsDocument,
    legacyPluginsDocument,
  ] = await Promise.all([
    safeReadText(files, sourceConfigPath),
    safeReadText(files, sourceMcpPath),
    safeReadText(files, sourceTuiPath),
    safeReadText(files, sourceAgentsPath),
    safeReadText(files, sourcePluginsPath),
  ]);

  let configMerged = false;
  let mcpMerged = false;
  let tuiMerged = false;
  let agentsCopied = false;
  let skillsCopied = false;
  let pluginsMerged = false;
  // 声明在 try 外：结果摘要要在下方 reason 判定中复用。
  let skillsResult = { sourceExists: false, copiedEntries: 0, skippedConflicts: 0 };
  let pluginsResult = { sourceExists: false, copiedEntries: 0, skippedConflicts: 0 };

  try {
    if (legacyConfigDocument?.trim()) {
      const currentConfig = parseDocument(await safeReadText(files, targetConfigPath));
      const legacyConfig = parseDocument(legacyConfigDocument);
      const merged = mergeLegacyMainConfig(currentConfig, legacyConfig);
      if (merged.changed) {
        await files.ensureDir(targetHome);
        await files.writeText(targetConfigPath, stringify(merged.value));
        configMerged = true;
      }
    }

    if (legacyMcpDocument?.trim()) {
      const merged = mergeJsonMcpDocuments(await safeReadText(files, targetMcpPath), legacyMcpDocument);
      if (merged.changed) {
        await files.ensureDir(targetHome);
        await files.writeText(targetMcpPath, JSON.stringify(merged.value, null, 2));
        mcpMerged = true;
      }
    }

    if (legacyTuiDocument?.trim()) {
      const currentTui = parseDocument(await safeReadText(files, targetTuiPath));
      const legacyTui = parseDocument(legacyTuiDocument);
      const merged = mergeMissingRecordValues(currentTui, legacyTui);
      if (merged.changed) {
        await files.ensureDir(targetHome);
        await files.writeText(targetTuiPath, stringify(merged.value));
        tuiMerged = true;
      }
    }

    if (legacyAgentsDocument?.trim() && !(await safeReadText(files, targetAgentsPath))?.trim()) {
      await files.ensureDir(targetHome);
      await files.writeText(targetAgentsPath, legacyAgentsDocument);
      agentsCopied = true;
    }

    skillsResult = files.mergeDirectoryMissing
      ? await files.mergeDirectoryMissing(`${sourceHome}/skills`, `${targetHome}/skills`)
      : { sourceExists: false, copiedEntries: 0, skippedConflicts: 0 };
    skillsCopied = skillsResult.copiedEntries > 0;

    // Write the remapped installed.json before merging the directory. The
    // directory primitive never overwrites target files, so managed plugin
    // roots cannot retain the retired GUI default-home prefix.
    if (legacyPluginsDocument?.trim()) {
      const merged = mergeInstalledPluginDocuments(
        await safeReadText(files, targetPluginsPath),
        legacyPluginsDocument,
        sourceHome,
        targetHome,
      );
      if (merged.changed) {
        await files.ensureDir(`${targetHome}/plugins`);
        await files.writeText(targetPluginsPath, merged.value);
        pluginsMerged = true;
      }
    }

    pluginsResult = files.mergeDirectoryMissing
      ? await files.mergeDirectoryMissing(`${sourceHome}/plugins`, `${targetHome}/plugins`)
      : { sourceExists: false, copiedEntries: 0, skippedConflicts: 0 };
    pluginsMerged ||= pluginsResult.copiedEntries > 0;
  } catch (error) {
    // A marker would suppress all future recovery attempts, so only write it
    // after every source resource has been processed successfully.
    throw new Error(`Failed to migrate the legacy managed default environment: ${formatErrorMessage(error)}`);
  }

  const result: LegacyManagedDefaultEnvironmentMigrationResult = {
    migrated: configMerged || mcpMerged || tuiMerged || agentsCopied || skillsCopied || pluginsMerged,
    configMerged,
    mcpMerged,
    tuiMerged,
    agentsCopied,
    skillsCopied,
    pluginsMerged,
    reason: legacyConfigDocument?.trim()
      || legacyMcpDocument?.trim()
      || legacyTuiDocument?.trim()
      || legacyAgentsDocument?.trim()
      || legacyPluginsDocument?.trim()
      || skillsResult.sourceExists
      || pluginsResult.sourceExists
      ? undefined
      : "legacy-environment-missing",
  };
  await writeLegacyManagedDefaultEnvironmentMigrationMarker(files, result);
  return result;
}

export function buildConfigDocument(state: AppState): string {
  // config.toml 是 Kimi Code 实际读取的文件，只应包含「启用」项，且不写入 GUI 专用的
  // enabled 标记。这里统一投影，保证「写盘内容 / 预览 / 外部变更检测的 draft」三者一致，
  // 避免 enabled 标记或禁用项造成 draft 与磁盘不一致而误报外部修改。
  const projected = projectEnabledMainConfig(state.mainConfig);
  return normalizeTomlIndentation(stringify(serializeMainConfigToRaw(projected) as Record<string, unknown>));
}

export function parseMainConfigDocument(document: string | null): MainConfig {
  return normalizeMainConfig(parseDocument(document));
}

/**
 * 把 MainConfig 重建为待序列化的扁平记录：
 * - 规范化字段直接放置；
 * - extra（含 [thinking]/[permission]/[image]/[subagent] 等未知节透传）原样写回；
 * - 死键桶（extra.__dead__）整体剔除，实现保存时净化 0.38.0 忽略的废弃键。
 */
function serializeMainConfigToRaw(config: MainConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    default_model: config.default_model,
    default_plan_mode: config.default_plan_mode,
    default_permission_mode: config.default_permission_mode || "manual",
  };
  if (
    config.merge_all_available_skills !== true
    || config.explicit_fields?.includes("merge_all_available_skills")
  ) {
    raw.merge_all_available_skills = config.merge_all_available_skills;
  }
  if (config.extra_skill_dirs && config.extra_skill_dirs.length > 0) {
    raw.extra_skill_dirs = config.extra_skill_dirs;
  }
  if (config.telemetry !== undefined) {
    raw.telemetry = config.telemetry;
  }
  if (config.hooks.length > 0) {
    raw.hooks = config.hooks;
  }
  if (Object.keys(config.models).length > 0) {
    raw.models = config.models;
  }
  if (Object.keys(config.providers).length > 0) {
    raw.providers = config.providers;
  }
  for (const section of ["loop_control", "background", "notifications", "services", "mcp"] as const) {
    if (Object.keys(config[section]).length > 0) {
      raw[section] = config[section];
    }
  }
  if (config.extra) {
    for (const [key, value] of Object.entries(config.extra)) {
      if (key === "__dead__") continue;
      raw[key] = value;
    }
  }
  return raw;
}

export function buildProfilesDocument(state: AppState): string {
  const profiles: Record<string, Omit<Profile, "name">> = {};
  for (const [name, profile] of Object.entries(state.profiles)) {
    const { name: _ignored, ...rest } = profile;
    profiles[name] = rest;
  }
  return stringify({
    version: PROFILE_VERSION,
    active_profile: state.activeProfile,
    profiles,
  });
}

export function buildPanelSettingsDocument(settings: PanelSettings): string {
  // 过滤掉 null/undefined 值，因为 TOML 不支持 null
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return normalizeTomlIndentation(stringify(cleaned));
}

/** Stable JSON representation of GUI-private settings for previews and history. */
export function buildPanelSettingsSnapshot(settings: PanelSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

async function restoreRedactedProviderSecrets(files: FileAccess, state: AppState): Promise<AppState> {
  const providers = state.mainConfig.providers;
  const redactedProviderNames = Object.entries(providers)
    .filter(([, provider]) => provider.api_key === REDACTION_MASK)
    .map(([name]) => name);

  if (!redactedProviderNames.length) {
    return state;
  }

  const diskConfig = await loadTomlFile(files, state.configPath, "main config");
  const diskProviders = isRecord(diskConfig.providers) ? diskConfig.providers : {};
  const next = cloneState(state);

  for (const name of redactedProviderNames) {
    const diskProvider = diskProviders[name];
    if (!isRecord(diskProvider) || typeof diskProvider.api_key !== "string" || !diskProvider.api_key.trim()) {
      continue;
    }
    next.mainConfig.providers[name] = {
      ...next.mainConfig.providers[name],
      api_key: diskProvider.api_key,
    };
  }

  return next;
}

export function bootstrapProfiles(mainConfig: MainConfig): Record<string, Profile> {
  if (!mainConfig.default_model || !mainConfig.models[mainConfig.default_model]) {
    return {};
  }
  // 仅在有显式模型时可提升默认 profile；每个 profile 都能在编辑时补齐值，
  // 无模型时不生成。
  return {
    [DEFAULT_PROFILE_NAME]: normalizeProfile({
      name: DEFAULT_PROFILE_NAME,
      label: mainConfig.profile_label || DEFAULT_PROFILE_NAME,
      default_model: String(mainConfig.default_model ?? DEFAULTS.default_model),
      default_plan_mode: Boolean(mainConfig.default_plan_mode),
      default_permission_mode: mainConfig.default_permission_mode || "manual",
      merge_all_available_skills: Boolean(mainConfig.merge_all_available_skills),
      thinking_enabled: true,
    }),
  };
}

export function applyProfile(state: AppState, profileName: string): void {
  const profile = state.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  if (!state.mainConfig.models[profile.default_model]) {
    throw new Error(
      formatMissingModelError(profile.default_model, state.mainConfig.models, {
        context: `Profile ${profile.name}`,
      }),
    );
  }
  // 写往 config.toml 的直接键
  state.mainConfig.default_model = profile.default_model;
  state.mainConfig.default_plan_mode = profile.default_plan_mode;
  state.mainConfig.default_permission_mode = profile.default_permission_mode || "manual";
  state.mainConfig.merge_all_available_skills = profile.merge_all_available_skills;
  state.mainConfig.explicit_fields = Array.from(new Set([
    ...(state.mainConfig.explicit_fields ?? []),
    "merge_all_available_skills",
  ]));
  // thinking 配置映射到 [thinking] extra 节
  setMainConfigThinking(state.mainConfig, profile.thinking_enabled, profile.thinking_effort);
  // Profile is a GUI preset: applying it explicitly updates the pending native
  // TUI document. Ordinary saves never re-project the active profile.
  state.tuiConfig = {
    ...(state.tuiConfig ?? {}),
    ...TuiConfigFromProfile(profile),
  };
  state.activeProfile = profileName;
}

/**
 * 把 profile 的 thinking 设置投影到 mainConfig.extra.thinking（0.38.0 [thinking] 表）。
 * 保留 extra.thinking 里用户未接管的其他键（如 keep）。
 */
function setMainConfigThinking(
  mainConfig: MainConfig,
  enabled: boolean | undefined,
  effort: string | undefined,
): void {
  const extra = mainConfig.extra ?? {};
  const thinking = isRecord(extra.thinking) ? { ...(extra.thinking as Record<string, unknown>) } : {};
  if (enabled !== undefined) {
    thinking.enabled = enabled;
  } else {
    delete thinking.enabled;
  }
  if (effort && effort.trim()) {
    thinking.effort = effort;
  } else {
    delete thinking.effort;
  }
  if (Object.keys(thinking).length > 0) {
    extra.thinking = thinking;
  } else {
    delete extra.thinking;
  }
  mainConfig.extra = Object.keys(extra).length > 0 ? extra : undefined;
}

/** E1：`[secondary_model]` 表的显式值形态（0.38.0 官方字段）。 */
export interface SecondaryModelConfig {
  default_model: string;
  /** 缺省 false：仅当当前模型不可用时才回退到 secondary。 */
  force?: boolean;
}

/**
 * E1：从 `mainConfig.extra.secondary_model` 解析结构化显式值；缺失/非法返回 undefined。
 * 供 doctor 校验与 UI 展示「文件显式值 / 当前有效值」共用同一 schema。
 */
export function extractSecondaryModel(extra: Record<string, unknown> | undefined): SecondaryModelConfig | undefined {
  const raw = extra?.secondary_model;
  if (!isRecord(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const defaultModel = typeof record.default_model === "string" ? record.default_model.trim() : "";
  if (!defaultModel) {
    return { default_model: "" };
  }
  return {
    default_model: defaultModel,
    ...(typeof record.force === "boolean" ? { force: record.force } : {}),
  };
}

/**
 * E1：把 secondary model 写回 `extra.secondary_model`（结构化 serializer）。
 * `defaultModel` 为空时移除整个 [secondary_model] 表（回到官方默认：无 secondary）。
 */
export function setSecondaryModel(
  mainConfig: MainConfig,
  next: SecondaryModelConfig | undefined,
): void {
  const extra = mainConfig.extra ?? {};
  if (!next || !next.default_model.trim()) {
    delete extra.secondary_model;
  } else {
    extra.secondary_model = {
      default_model: next.default_model.trim(),
      ...(next.force !== undefined ? { force: next.force } : {}),
    };
  }
  mainConfig.extra = Object.keys(extra).length > 0 ? extra : undefined;
}

export function upsertProvider(
  state: AppState,
  name: string,
  provider: { type: string; base_url: string; api_key: string },
): void {
  state.mainConfig.providers[name] = { ...provider };
}

export function deleteProvider(state: AppState, name: string): void {
  for (const [modelName, model] of Object.entries(state.mainConfig.models)) {
    if (model.provider === name) {
      throw new Error(`Provider ${name} is still used by model ${modelName}.`);
    }
  }
  delete state.mainConfig.providers[name];
}

export function upsertModel(
  state: AppState,
  name: string,
  model: MainConfig["models"][string],
): void {
  if (!state.mainConfig.providers[model.provider]) {
    throw new Error(`Provider not found: ${model.provider}`);
  }
  state.mainConfig.models[name] = { ...model };
}

export function deleteModel(state: AppState, name: string): void {
  for (const profile of Object.values(state.profiles)) {
    if (profile.default_model === name) {
      throw new Error(`Model ${name} is still used by profile ${profile.name}.`);
    }
  }
  if (state.mainConfig.default_model === name) {
    throw new Error(`Model ${name} is still used as the current default model.`);
  }
  delete state.mainConfig.models[name];
}

export function upsertProfile(state: AppState, profile: Profile): void {
  const normalizedProfile = normalizeProfile(profile);
  if (!state.mainConfig.models[normalizedProfile.default_model]) {
    throw new Error(
      formatMissingModelError(normalizedProfile.default_model, state.mainConfig.models, {
        context: `Profile ${normalizedProfile.name || "(unnamed)"}`,
      }),
    );
  }
  state.profiles[normalizedProfile.name] = normalizedProfile;
}

export function cloneProfile(
  state: AppState,
  sourceName: string,
  targetName: string,
  label: string,
): void {
  const source = state.profiles[sourceName];
  if (!source) {
    throw new Error(`Profile not found: ${sourceName}`);
  }
  if (state.profiles[targetName]) {
    throw new Error(`Profile already exists: ${targetName}`);
  }
  state.profiles[targetName] = normalizeProfile({
    ...source,
    name: targetName,
    label,
  });
}

export function compareProfiles(left: Profile, right: Profile): ProfileDiff {
  const differences = PROFILE_KEYS.map((key) => ({
    field: key as keyof Profile,
    leftValue: left[key],
    rightValue: right[key],
    isSame: left[key] === right[key],
  }));
  return { left, right, differences };
}

export function copyProfileField(
  state: AppState,
  fromName: string,
  toName: string,
  field: keyof Profile,
): void {
  if (field === "name") {
    return;
  }
  const from = state.profiles[fromName];
  const to = state.profiles[toName];
  if (!from) {
    throw new Error(`Profile not found: ${fromName}`);
  }
  if (!to) {
    throw new Error(`Profile not found: ${toName}`);
  }
  (to as unknown as Record<string, unknown>)[field] = (from as unknown as Record<string, unknown>)[field];
}

export function deleteProfile(state: AppState, name: string): void {
  if (name === state.activeProfile) {
    throw new Error("Cannot delete the active profile.");
  }
  if (Object.keys(state.profiles).length <= 1) {
    throw new Error("At least one profile is required.");
  }
  delete state.profiles[name];
}

export function buildPreviewBundle(state: AppState, disk: {
  configDocument?: string | null;
  panelSettingsDocument?: string | null;
  mcpDocument?: string | null;
}): PreviewBundle {
  const normalizedState = normalizeStatePaths(state);
  const configDocument = buildConfigDocument(normalizedState);
  const panelSettingsDocument = buildPanelSettingsSnapshot(normalizedState.panelSettings);
  const mcpDocument = buildMcpConfigDocument(normalizedState.mcpConfig);

  return {
    configDocument,
    panelSettingsDocument,
    mcpDocument,
    configDiff: createLineDiff(disk.configDocument ?? "", configDocument),
    panelDiff: createLineDiff(disk.panelSettingsDocument ?? "", panelSettingsDocument),
    mcpDiff: createLineDiff(disk.mcpDocument ?? "", mcpDocument),
  };
}

export function createLineDiff(previous: string, next: string): string {
  const before = previous.split("\n");
  const after = next.split("\n");
  const max = Math.max(before.length, after.length);
  const lines: string[] = [];
  for (let index = 0; index < max; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left === right) {
      if (left !== undefined && left !== "") {
        lines.push(`  ${left}`);
      }
      continue;
    }
    if (left !== undefined) {
      lines.push(`- ${left}`);
    }
    if (right !== undefined) {
      lines.push(`+ ${right}`);
    }
  }
  return lines.join("\n");
}

export function formatMissingModelError(
  modelName: string,
  models: Record<string, unknown>,
  options: { context: string },
): string {
  const normalizedName = modelName || "(empty)";
  const modelKeys = Object.keys(models);
  const availableHint = modelKeys.length
    ? ` Available model keys: ${modelKeys.slice(0, 3).join(", ")}${modelKeys.length > 3 ? ` (${modelKeys.length} in total)` : ""}.`
    : " There are no models yet; create one on the Models page first.";
  return `${options.context} references a missing default model: "${normalizedName}". Fill in the [models] key, not the model field value.${availableHint} Please create the model first, or change the profile's default model to an existing one.`;
}

export function parseProfiles(
  mainConfig: MainConfig,
  rawProfiles: Record<string, unknown>,
): Record<string, Profile> {
  if (rawProfiles.version === PROFILE_VERSION && isRecord(rawProfiles.profiles)) {
    const parsedEntries = Object.entries(rawProfiles.profiles).map(([name, raw]) => [
      name,
      profileFromUnknown(name, raw),
    ]);
    if (parsedEntries.length > 0) {
      return Object.fromEntries(parsedEntries);
    }
  }
  return bootstrapProfiles(mainConfig);
}

function profileFromUnknown(name: string, raw: unknown): Profile {
  const data = isRecord(raw) ? raw : {};
  const deadYolo = typeof data.default_yolo === "boolean" ? data.default_yolo : undefined;
  const deadThinking = typeof data.default_thinking === "boolean" ? data.default_thinking : undefined;
  const deadEditor = asString(data.default_editor, "");
  const deadTheme = asString(data.theme, "");
  return normalizeProfile({
    name,
    label: asString(data.label, name),
    default_model: asString(data.default_model, DEFAULTS.default_model),
    default_plan_mode: asBoolean(data.default_plan_mode, DEFAULTS.default_plan_mode),
    // 旧 default_yolo -> default_permission_mode 迁移
    default_permission_mode:
      typeof data.default_permission_mode === "string" && data.default_permission_mode
        ? data.default_permission_mode as PermissionMode
        : (deadYolo === true ? "yolo" : (deadYolo === false ? "manual" : "manual")),
    merge_all_available_skills: asBoolean(
      data.merge_all_available_skills,
      DEFAULTS.merge_all_available_skills,
    ),
    // 旧 default_thinking -> thinking_enabled（旧值缺失视为 CLI 默认 true）
    thinking_enabled: data.thinking_enabled !== undefined
      ? asBoolean(data.thinking_enabled, false)
      : (deadThinking === undefined ? undefined : deadThinking),
    thinking_effort: typeof data.thinking_effort === "string" ? data.thinking_effort : undefined,
    // 旧 theme/default_editor -> tui 目标（迁移后由 tuiStore 应用）
    tui_theme: typeof data.tui_theme === "string" ? data.tui_theme : (deadTheme || undefined),
    tui_editor_command: typeof data.tui_editor_command === "string"
      ? data.tui_editor_command
      : (deadEditor || undefined),
  });
}

function normalizeProfile(profile: Profile): Profile {
  return { ...profile };
}

function pickActiveProfile(mainConfig: MainConfig, profiles: Record<string, Profile>): string {
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.default_model !== mainConfig.default_model) {
      continue;
    }
    // 仅对比直接落在 config.toml 顶层的活键；thinking/tui 相关键由各自的合并逻辑负责
    const matches =
      (profile.default_plan_mode || false) === (mainConfig.default_plan_mode || false)
      && (profile.default_permission_mode || "manual") === (mainConfig.default_permission_mode || "manual")
      && (profile.merge_all_available_skills || false) === (mainConfig.merge_all_available_skills || false);
    if (matches) {
      return name;
    }
  }
  return Object.keys(profiles)[0] ?? "";
}

function ensureActiveProfile(activeProfile: string, profiles: Record<string, Profile>): string {
  return profiles[activeProfile] ? activeProfile : Object.keys(profiles)[0] ?? "";
}

function sanitizeProfilesRecord(
  value: unknown,
  fallback: Record<string, Profile> = {},
): Record<string, Profile> {
  if (!isRecord(value)) {
    return structuredClone(fallback) as Record<string, Profile>;
  }
  const entries = Object.entries(value).map(([name, raw]) => [name, profileFromUnknown(name, raw)] as const);
  return Object.fromEntries(entries);
}

function hasOwnRecordProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDefaultKimiCodeEnvironment(environment: KimiCodeEnvironment): boolean {
  return environment.id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID;
}

function getEnvironmentProfiles(
  environment: KimiCodeEnvironment,
  settings: PanelSettings,
  mainConfig: MainConfig,
): Record<string, Profile> | null {
  if (hasOwnRecordProperty(environment, "profiles")) {
    const profiles = sanitizeProfilesRecord(environment.profiles);
    return shouldIgnoreEmptyDefaultEnvironmentProfile(profiles, mainConfig) ? null : profiles;
  }
  if (!isDefaultKimiCodeEnvironment(environment)) {
    return null;
  }
  const panelProfiles = sanitizeProfilesRecord(settings.profiles);
  return Object.keys(panelProfiles).length > 0 ? panelProfiles : null;
}

function getEnvironmentActiveProfile(
  environment: KimiCodeEnvironment,
  settings: PanelSettings,
): string {
  if (typeof environment.activeProfile === "string") {
    return environment.activeProfile;
  }
  return isDefaultKimiCodeEnvironment(environment) ? settings.active_profile : "";
}

function shouldIgnoreEmptyDefaultEnvironmentProfile(
  profiles: Record<string, Profile>,
  mainConfig: MainConfig,
): boolean {
  const keys = Object.keys(profiles);
  if (keys.length !== 1 || keys[0] !== DEFAULT_PROFILE_NAME) {
    return false;
  }
  if (Object.keys(mainConfig.models).length > 0 || Object.keys(mainConfig.providers).length > 0 || mainConfig.default_model) {
    return false;
  }
  const profile = profiles[DEFAULT_PROFILE_NAME];
  return profile.default_model === DEFAULTS.default_model
    && profile.label.toLowerCase() === DEFAULT_PROFILE_NAME;
}

function getEnvironmentMcpServers(
  _environment: KimiCodeEnvironment,
  _settings: PanelSettings,
  fileServers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return cloneMcpServers(fileServers);
}

function cloneMainConfig(config: MainConfig): MainConfig {
  const clone = structuredClone(config) as MainConfig;
  // structuredClone 会保留 extra 普通对象；若为空记录则不设字段，保持空记录透传一致性。
  return clone;
}

function snapshotActiveKimiCodeEnvironment(
  environments: KimiCodeEnvironment[],
  activeEnvironmentId: string,
  snapshot: {
    profiles: Record<string, Profile>;
    activeProfile: string;
  },
): KimiCodeEnvironment[] {
  return environments.map((environment) => {
    const {
      mainConfig: _legacyMainConfig,
      mcpServers: _legacyMcpServers,
      ...withoutLegacySnapshots
    } = environment;
    return environment.id === activeEnvironmentId
      ? {
          ...withoutLegacySnapshots,
          profiles: sanitizeProfilesRecord(snapshot.profiles),
          activeProfile: snapshot.activeProfile,
        }
      : withoutLegacySnapshots;
  });
}

function legacyProfilesPathForConfig(configPath: string): string {
  return joinPath(dirnamePath(configPath), PROFILE_FILENAME);
}

async function loadLegacyProfiles(
  files: FileAccess,
  explicitProfilesPath: string | undefined,
  configPath: string,
  mainConfig: MainConfig,
): Promise<{ profiles: Record<string, Profile>; activeProfile: string } | null> {
  const candidates = [
    explicitProfilesPath,
    legacyProfilesPathForConfig(configPath),
    LEGACY_PROFILES_PATH,
  ].filter((path): path is string => typeof path === "string" && path.trim().length > 0);

  for (const path of new Set(candidates)) {
    let raw: Record<string, unknown>;
    try {
      raw = await loadTomlFile(files, path, "legacy profiles config");
    } catch {
      continue;
    }
    if (!Object.keys(raw).length) {
      continue;
    }
    const profiles = parseProfiles(mainConfig, raw);
    if (!Object.keys(profiles).length) {
      continue;
    }
    return {
      profiles,
      activeProfile: typeof raw.active_profile === "string" ? raw.active_profile : DEFAULT_PROFILE_NAME,
    };
  }
  return null;
}

function parseDocument(document: string | null): Record<string, unknown> {
  if (!document?.trim()) {
    return {};
  }
  return (parse(document) as Record<string, unknown>) ?? {};
}

async function safeReadText(files: FileAccess, path: string): Promise<string | null> {
  try {
    return await files.readText(path);
  } catch {
    return null;
  }
}

async function writeLegacyMigrationMarker(files: FileAccess, result: LegacyKimiCliMigrationResult): Promise<void> {
  await files.ensureDir(dirnamePath(LEGACY_MIGRATION_MARKER_PATH));
  await files.writeText(LEGACY_MIGRATION_MARKER_PATH, JSON.stringify({
    ...result,
    source: LEGACY_CONFIG_PATH,
    target: DEFAULT_CONFIG_PATH,
    migratedAt: new Date().toISOString(),
  }, null, 2));
}

async function writeLegacyManagedDefaultEnvironmentMigrationMarker(
  files: FileAccess,
  result: LegacyManagedDefaultEnvironmentMigrationResult,
): Promise<void> {
  await files.ensureDir(dirnamePath(LEGACY_MANAGED_DEFAULT_ENVIRONMENT_MIGRATION_MARKER_PATH));
  await files.writeText(LEGACY_MANAGED_DEFAULT_ENVIRONMENT_MIGRATION_MARKER_PATH, JSON.stringify({
    ...result,
    source: LEGACY_MANAGED_DEFAULT_KIMI_CODE_HOME,
    target: defaultKimiCodeHomePath(),
    migratedAt: new Date().toISOString(),
  }, null, 2));
}

function mergeMissingRecordValues(
  current: Record<string, unknown>,
  legacy: Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(current) as Record<string, unknown>;
  let changed = false;
  for (const [key, legacyValue] of Object.entries(legacy)) {
    const currentValue = next[key];
    if (currentValue === undefined) {
      next[key] = structuredClone(legacyValue);
      changed = true;
      continue;
    }
    if (!isRecord(currentValue) || !isRecord(legacyValue)) continue;
    const nested = mergeMissingRecordValues(currentValue, legacyValue);
    if (nested.changed) {
      next[key] = nested.value;
      changed = true;
    }
  }
  return { value: next, changed };
}

function mergeInstalledPluginDocuments(
  currentDocument: string | null,
  legacyDocument: string,
  sourceHome: string,
  targetHome: string,
): { value: string; changed: boolean } {
  const remappedLegacyDocument = remapInstalledPluginRoots(legacyDocument, sourceHome, targetHome);
  if (!currentDocument?.trim()) {
    return { value: remappedLegacyDocument, changed: true };
  }

  const current = JSON.parse(currentDocument) as unknown;
  const legacy = JSON.parse(remappedLegacyDocument) as unknown;
  if (!isRecord(current) || !Array.isArray(current.plugins)) {
    throw new Error("native plugins/installed.json must contain a plugins array");
  }
  if (!isRecord(legacy) || !Array.isArray(legacy.plugins)) {
    throw new Error("legacy plugins/installed.json must contain a plugins array");
  }

  const nextPlugins = [...current.plugins];
  const knownIds = new Set(
    current.plugins
      .filter(isRecord)
      .map((plugin) => typeof plugin.id === "string" ? plugin.id.trim().toLocaleLowerCase() : "")
      .filter(Boolean),
  );
  let changed = false;
  for (const plugin of legacy.plugins) {
    if (!isRecord(plugin) || typeof plugin.id !== "string" || !plugin.id.trim()) continue;
    const id = plugin.id.trim().toLocaleLowerCase();
    if (knownIds.has(id)) continue;
    knownIds.add(id);
    nextPlugins.push(structuredClone(plugin));
    changed = true;
  }
  return changed
    ? { value: `${JSON.stringify({ ...current, plugins: nextPlugins }, null, 2)}\n`, changed: true }
    : { value: currentDocument, changed: false };
}

function isLegacyManagedDefaultKimiCodeHome(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const legacySuffix = "/.kimi-code-switch-gui/.env/default";
  return normalized === LEGACY_MANAGED_DEFAULT_KIMI_CODE_HOME || normalized.endsWith(legacySuffix);
}

function isEmptyRecordValue(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isMissingOrBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function mergeLegacyMainConfig(
  current: Record<string, unknown>,
  legacy: Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const next = structuredClone(current) as Record<string, unknown>;
  let changed = false;

  for (const key of ["providers", "models"] as const) {
    const legacyTable = isRecord(legacy[key]) ? legacy[key] : {};
    const currentTable = isRecord(next[key]) ? { ...next[key] } : {};
    for (const [entryKey, entryValue] of Object.entries(legacyTable)) {
      if (currentTable[entryKey] === undefined) {
        currentTable[entryKey] = entryValue;
        changed = true;
      }
    }
    if (Object.keys(currentTable).length > 0) {
      next[key] = currentTable;
    }
  }

  for (const key of [
    "default_model",
    "merge_all_available_skills",
    "default_plan_mode",
    "default_permission_mode",
    "extra_skill_dirs",
    "telemetry",
  ]) {
    if (legacy[key] !== undefined && isMissingOrBlank(next[key])) {
      next[key] = legacy[key];
      changed = true;
    }
  }

  // 旧 default_yolo 布尔迁移为 default_permission_mode（仅在二者都缺失时）。
  if (legacy.default_yolo !== undefined && next.default_permission_mode === undefined) {
    next.default_permission_mode = legacy.default_yolo === true ? "yolo" : "manual";
    changed = true;
  }

  for (const key of ["hooks", "loop_control", "background", "notifications", "services", "mcp", "thinking", "permission", "image", "subagent"]) {
    const legacyValue = legacy[key];
    if (legacyValue === undefined) continue;
    if (isRecord(next[key]) && isRecord(legacyValue)) {
      const nested = mergeMissingRecordValues(next[key], legacyValue);
      if (nested.changed) {
        next[key] = nested.value;
        changed = true;
      }
      continue;
    }
    if (next[key] === undefined || isEmptyRecordValue(next[key]) || (Array.isArray(next[key]) && next[key].length === 0)) {
      next[key] = legacyValue;
      changed = true;
    }
  }

  // Preserve future Kimi Code sections that this GUI does not yet understand.
  // Current native values still win, while nested records receive only missing
  // keys from the retired source. Historical dead keys stay excluded.
  for (const [key, legacyValue] of Object.entries(legacy)) {
    if (ACTIVE_MAIN_CONFIG_KEYS.has(key)) continue;
    if (next[key] === undefined) {
      next[key] = structuredClone(legacyValue);
      changed = true;
      continue;
    }
    if (isRecord(next[key]) && isRecord(legacyValue)) {
      const nested = mergeMissingRecordValues(next[key], legacyValue);
      if (nested.changed) {
        next[key] = nested.value;
        changed = true;
      }
    }
  }

  // legacy 死键（profile_label/default_thinking/default_editor/theme/show_thinking_stream）
  // 不再迁移进 0.38.0 配置；default_yolo 已按上面对应迁移。

  return { value: next, changed };
}

function mergeJsonMcpDocuments(
  currentDocument: string | null,
  legacyDocument: string,
): { value: Record<string, unknown>; changed: boolean } {
  const current = currentDocument?.trim()
    ? JSON.parse(currentDocument) as Record<string, unknown>
    : {};
  const legacy = JSON.parse(legacyDocument) as Record<string, unknown>;
  const currentServers = isRecord(current.mcpServers) ? { ...current.mcpServers } : {};
  const legacyServers = isRecord(legacy.mcpServers) ? legacy.mcpServers : {};
  let changed = false;
  for (const [name, server] of Object.entries(legacyServers)) {
    if (currentServers[name] === undefined) {
      currentServers[name] = server;
      changed = true;
    }
  }
  if (!changed) {
    return { value: current, changed: false };
  }
  return { value: { ...current, mcpServers: currentServers }, changed: true };
}

async function loadTomlFile(
  files: FileAccess,
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let document: string | null;
  try {
    document = await files.readText(path);
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${path}: ${formatErrorMessage(error)}`);
  }

  try {
    return parseDocument(document);
  } catch (error) {
    throw new Error(`Invalid ${label} TOML at ${path}: ${formatErrorMessage(error)}`);
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeMainConfig(input: Record<string, unknown>): MainConfig {
  return {
    default_model: asString(input.default_model, DEFAULTS.default_model),
    // profile_label 为只读遗留字段：0.38.0 忽略，不写回 config.toml，仅作默认 profile 显示名
    profile_label: asString(input.profile_label, ""),
    default_plan_mode: asBoolean(input.default_plan_mode, DEFAULTS.default_plan_mode),
    default_permission_mode: asPermissionMode(
      input.default_permission_mode,
      input.default_yolo,
      DEFAULTS.default_permission_mode,
    ),
    merge_all_available_skills: asBoolean(
      input.merge_all_available_skills,
      DEFAULTS.merge_all_available_skills,
    ),
    explicit_fields: [
      ...(Object.prototype.hasOwnProperty.call(input, "merge_all_available_skills")
        ? ["merge_all_available_skills"]
        : []),
      // E1：builtin_product_skills 走 extra 透传往返；记录「是否在文件里显式出现」，
      // 供 UI 区分「显式 false/true」与「缺省视为 true」，不物化默认值。
      ...(Object.prototype.hasOwnProperty.call(input, "builtin_product_skills")
        ? ["builtin_product_skills"]
        : []),
    ],
    extra_skill_dirs: asStringArray(input.extra_skill_dirs),
    telemetry: typeof input.telemetry === "boolean" ? input.telemetry : undefined,
    hooks: Array.isArray(input.hooks) ? input.hooks : [],
    models: normalizeModels(input.models),
    providers: normalizeProviders(input.providers),
    loop_control: isRecord(input.loop_control) ? input.loop_control : {},
    background: isRecord(input.background) ? input.background : {},
    notifications: isRecord(input.notifications) ? input.notifications : {},
    services: isRecord(input.services) ? input.services : {},
    mcp: isRecord(input.mcp) ? input.mcp : {},
    // 0.38.0 新增/未管理的顶层 section（thinking/permission/image/subagent 等）原样透传，
    // 保存时写回，避免 GUI 保存抹掉 CLI 可识别的字段。
    extra: collectMainConfigExtra(input),
  };
}

function normalizeProviders(value: unknown): MainConfig["providers"] {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([name, provider]) => [name, {
        ...provider,
        type: asString(provider.type, ""),
        base_url: asString(provider.base_url, ""),
        api_key: asString(provider.api_key, ""),
      } as ProviderConfig]),
  );
}

function normalizeModels(value: unknown): MainConfig["models"] {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([name, model]) => [name, {
        ...model,
        provider: asString(model.provider, ""),
        model: asString(model.model, name),
        max_context_size: typeof model.max_context_size === "number" ? model.max_context_size : 0,
        capabilities: Array.isArray(model.capabilities)
          ? model.capabilities.filter((capability): capability is string => typeof capability === "string")
          : [],
      } as ModelConfig]),
  );
}

/**
 * 收集白名单（含死键）之外的所有顶层键进 MainConfig.extra，作为不透明记录透传。
 * 死键单独收进 extra 里的 __dead__ 桶，便于保存时整体剔除。
 */
function collectMainConfigExtra(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  const dead: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (ACTIVE_MAIN_CONFIG_KEYS.has(key)) continue;
    if (DEAD_MAIN_CONFIG_KEYS.includes(key)) {
      dead[key] = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(dead).length > 0) {
    extra.__dead__ = dead;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function asPermissionMode(value: unknown, legacyYolo: unknown, fallback: PermissionMode | ""): PermissionMode | "" {
  if (value === "manual" || value === "auto" || value === "yolo") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return fallback;
  }
  // 旧 default_yolo 布尔迁移：true -> yolo，false/缺省 -> manual（0.38.0 默认 manual）
  if (typeof legacyYolo === "boolean") {
    return legacyYolo ? "yolo" : "manual";
  }
  return fallback;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length > 0 ? items : undefined;
}


function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseAppearanceMode(value: unknown, fallback: PanelSettings["theme"]): PanelSettings["theme"] {
  return value === "light" || value === "dark" || value === "auto" ? value : fallback;
}

function parseLocale(value: unknown, fallback: PanelSettings["locale"]): PanelSettings["locale"] {
  return typeof value === "string" && SUPPORTED_LOCALES.has(value as PanelSettings["locale"])
    ? value as PanelSettings["locale"]
    : fallback;
}

const APPEARANCE_THEMES: ReadonlySet<PanelSettings["appearance_theme"]> = new Set([
  "aurora",
  "ocean",
  "violet",
  "sunset",
  "forest",
  "sakura",
  "mint",
  "cosmos",
  "amber",
]);

function parseAppearanceTheme(
  value: unknown,
  fallback: PanelSettings["appearance_theme"],
): PanelSettings["appearance_theme"] {
  return typeof value === "string" && APPEARANCE_THEMES.has(value as PanelSettings["appearance_theme"])
    ? (value as PanelSettings["appearance_theme"])
    : fallback;
}

function parseUiFontSize(
  value: unknown,
  fallback: PanelSettings["ui_font_size"],
): PanelSettings["ui_font_size"] {
  return value === "mini"
    || value === "compact"
    || value === "small"
    || value === "standard"
    || value === "large"
    || value === "extra-large"
    ? value
    : fallback;
}

function parseDisplayOpenMode(
  value: unknown,
  fallback: PanelSettings["display_open_mode"],
): PanelSettings["display_open_mode"] {
  return value === "random" || value === "remember-last" || value === "active-display"
    ? value
    : fallback;
}

function parseCloseBehavior(
  value: unknown,
  fallback: PanelSettings["close_behavior"],
): PanelSettings["close_behavior"] {
  return value === "quit" || value === "keep-in-tray" ? value : fallback;
}

function parseTerminalApp(
  value: unknown,
  fallback: PanelSettings["terminal_app"],
): PanelSettings["terminal_app"] {
  return value === "system-terminal" || value === "iterm2" ? value : fallback;
}

function parseBackupFrequency(
  value: unknown,
  fallback: PanelSettings["backup_frequency"],
): PanelSettings["backup_frequency"] {
  return value === "hourly" || value === "daily" || value === "weekly" ? value : fallback;
}

function parseBackupDestinationType(
  value: unknown,
  fallback: BackupDestinationType,
): BackupDestinationType {
  return value === "local" || value === "webdav" ? value : fallback;
}

function parseBackupStrategy(
  value: unknown,
  fallback: BackupStrategy,
): BackupStrategy {
  return value === "manual" || value === "scheduled" || value === "on-change" ? value : fallback;
}

function parseBackupRetentionCount(
  value: unknown,
  fallback: PanelSettings["backup_retention_count"],
): PanelSettings["backup_retention_count"] {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(99, Math.round(value)));
}

function sanitizePath(path: string | undefined, fallback: string): string {
  return typeof path === "string" && path.trim() ? path.trim() : fallback;
}

function defaultBackupPath(): string {
  return joinPath(DEFAULT_PANEL_DIRECTORY, BACKUP_DIRECTORY_NAME);
}

export function normalizeStatePaths(state: AppState): AppState {
  const configTarget = ConfigTarget.KimiCode;
  const environments = parseKimiCodeEnvironments(
    state.panelSettings.kimi_code_environments,
    [createDefaultKimiCodeEnvironment()],
  );
  const requestedActiveEnvironmentId = state.panelSettings.active_kimi_code_environment_id;
  const activeEnvironment = environments.find((environment) => environment.id === requestedActiveEnvironmentId)
    ?? environments[0]
    ?? createDefaultKimiCodeEnvironment();
  const configPath = getKimiCodeConfigPath(activeEnvironment.homePath);
  const panelSettingsPath = sanitizePath(state.panelSettingsPath, DEFAULT_PANEL_SETTINGS_PATH);
  const mcpConfigPath = getKimiCodeMcpConfigPath(activeEnvironment.homePath);
  const profiles = sanitizeProfilesRecord(state.profiles);
  const activeProfile = ensureActiveProfile(state.activeProfile, profiles);
  const profilesPath = "";
  const scopedEnvironments = snapshotActiveKimiCodeEnvironment(environments, activeEnvironment.id, {
    profiles,
    activeProfile,
  });
  const panelSettings: PanelSettings = {
    ...state.panelSettings,
    config_target: configTarget,
    config_path: configPath,
    theme: parseAppearanceMode(state.panelSettings.theme, "auto"),
    appearance_theme: parseAppearanceTheme(state.panelSettings.appearance_theme, "aurora"),
    ui_font_size: parseUiFontSize(state.panelSettings.ui_font_size, "standard"),
    display_open_mode: parseDisplayOpenMode(state.panelSettings.display_open_mode, "remember-last"),
    close_behavior: state.panelSettings.tray_icon
      ? parseCloseBehavior(state.panelSettings.close_behavior, "keep-in-tray")
      : "quit",
    terminal_app: parseTerminalApp(state.panelSettings.terminal_app, "system-terminal"),
    backup_strategy: parseBackupStrategy(state.panelSettings.backup_strategy, "manual"),
    backup_frequency: parseBackupFrequency(state.panelSettings.backup_frequency, "daily"),
    backup_retention_count: parseBackupRetentionCount(state.panelSettings.backup_retention_count, 10),
    backup_destination_type: parseBackupDestinationType(state.panelSettings.backup_destination_type, "local"),
    backup_local_path: sanitizePath(state.panelSettings.backup_local_path, defaultBackupPath()),
    backup_webdav_url: asString(state.panelSettings.backup_webdav_url, "").trim(),
    backup_webdav_username: asString(state.panelSettings.backup_webdav_username, ""),
    backup_webdav_password: asString(state.panelSettings.backup_webdav_password, ""),
    backup_webdav_path: asString(state.panelSettings.backup_webdav_path, "").trim(),
    sidebar_collapsed: asBoolean(state.panelSettings.sidebar_collapsed, false),
    shortcuts: normalizeShortcuts(state.panelSettings.shortcuts),
    kimi_code_environments: scopedEnvironments,
    active_kimi_code_environment_id: activeEnvironment.id,
    last_display_id: state.panelSettings.last_display_id,
    model_ui_metadata: snapshotModelUiMetadata(
      state.panelSettings,
      activeEnvironment.id,
      state.mainConfig.models,
    ),
    profiles,
    active_profile: activeProfile,
    profiles_path: profilesPath,
    follow_config_profiles: true,
  };
  return {
    ...state,
    configTarget,
    configPath,
    profilesPath,
    panelSettingsPath,
    mcpConfigPath,
    panelSettings: {
      ...panelSettings,
      config_target: configTarget,
      profiles,
      active_profile: activeProfile,
      profiles_path: profilesPath,
    },
    profiles,
    activeProfile,
  };
}

export function exportConfig(state: AppState): ExportBundle {
  // 完整备份：包含真实密钥，确保可完整还原。
  const source = normalizeStatePaths(state);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: "kimi-code-switch-gui",
    providers: structuredClone(source.mainConfig.providers),
    models: structuredClone(source.mainConfig.models),
    profiles: structuredClone(source.profiles),
    mcpServers: structuredClone(source.mcpConfig.mcpServers),
    panelSettings: structuredClone(source.panelSettings),
  };
}

export function validateImportData(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, errors: ["Data must be a JSON object."] };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    errors.push("Missing or invalid 'version' field (must be a number).");
  }
  const hasProviders = obj.providers && typeof obj.providers === "object";
  const hasModels = obj.models && typeof obj.models === "object";
  const hasProfiles = obj.profiles && typeof obj.profiles === "object";
  const hasMcp = obj.mcpServers && typeof obj.mcpServers === "object";
  if (!hasProviders && !hasModels && !hasProfiles && !hasMcp) {
    errors.push("Data must contain at least one of: providers, models, profiles, mcpServers.");
  }
  return { valid: errors.length === 0, errors };
}

export function bundleContainsRedactedSecrets(data: ExportBundle): boolean {
  return Object.values(data.providers ?? {}).some(
    (provider) => provider.api_key === REDACTION_MASK,
  );
}

export function getImportPreview(state: AppState, data: ExportBundle): ImportPreview {
  const conflicts: ImportConflict[] = [];
  const newItems: ImportConflict[] = [];
  for (const name of Object.keys(data.providers ?? {})) {
    const existing = Boolean(state.mainConfig.providers[name]);
    const item: ImportConflict = { name, type: "provider", existing };
    (existing ? conflicts : newItems).push(item);
  }
  for (const name of Object.keys(data.models ?? {})) {
    const existing = Boolean(state.mainConfig.models[name]);
    const item: ImportConflict = { name, type: "model", existing };
    (existing ? conflicts : newItems).push(item);
  }
  for (const name of Object.keys(data.profiles ?? {})) {
    const existing = Boolean(state.profiles[name]);
    const item: ImportConflict = { name, type: "profile", existing };
    (existing ? conflicts : newItems).push(item);
  }
  for (const name of Object.keys(data.mcpServers ?? {})) {
    const existing = Boolean(state.mcpConfig.mcpServers[name]);
    const item: ImportConflict = { name, type: "mcp_server", existing };
    (existing ? conflicts : newItems).push(item);
  }
  return { conflicts, newItems };
}

export function importConfig(
  state: AppState,
  data: ExportBundle,
  strategy: ImportConflictStrategy,
): AppState {
  const next = cloneState(state);
  // 清空后导入：先清掉受管的四类条目，再整体载入备份，实现完整还原语义。
  if (strategy === "replace") {
    next.mainConfig.providers = {};
    next.mainConfig.models = {};
    next.profiles = {};
    next.mcpConfig.mcpServers = {};
    for (const [name, provider] of Object.entries(data.providers ?? {})) {
      next.mainConfig.providers[name] = structuredClone(provider);
    }
    for (const [name, model] of Object.entries(data.models ?? {})) {
      next.mainConfig.models[name] = structuredClone(model);
    }
    for (const [name, profile] of Object.entries(data.profiles ?? {})) {
      next.profiles[name] = { ...structuredClone(profile), name };
    }
    for (const [name, server] of Object.entries(data.mcpServers ?? {})) {
      next.mcpConfig.mcpServers[name] = structuredClone(server);
    }
    if (data.panelSettings) {
      next.panelSettings = structuredClone(data.panelSettings);
    }
    return next;
  }
  for (const [name, provider] of Object.entries(data.providers ?? {})) {
    const exists = Boolean(next.mainConfig.providers[name]);
    if (exists && strategy === "skip") continue;
    const key = exists && strategy === "rename" ? `${name}-imported` : name;
    next.mainConfig.providers[key] = structuredClone(provider);
  }
  for (const [name, model] of Object.entries(data.models ?? {})) {
    const exists = Boolean(next.mainConfig.models[name]);
    if (exists && strategy === "skip") continue;
    const key = exists && strategy === "rename" ? `${name}-imported` : name;
    next.mainConfig.models[key] = structuredClone(model);
  }
  for (const [name, profile] of Object.entries(data.profiles ?? {})) {
    const exists = Boolean(next.profiles[name]);
    if (exists && strategy === "skip") continue;
    const key = exists && strategy === "rename" ? `${name}-imported` : name;
    next.profiles[key] = { ...structuredClone(profile), name: key };
  }
  for (const [name, server] of Object.entries(data.mcpServers ?? {})) {
    const exists = Boolean(next.mcpConfig.mcpServers[name]);
    if (exists && strategy === "skip") continue;
    const key = exists && strategy === "rename" ? `${name}-imported` : name;
    next.mcpConfig.mcpServers[key] = structuredClone(server);
  }
  // 导入面板设置（如果存在）
  if (data.panelSettings) {
    next.panelSettings = structuredClone(data.panelSettings);
  }
  return next;
}

export const FULL_BACKUP_VERSION = 3;

/**
 * 组装旧版全量备份包。活动环境来自标准文件状态；非活动环境只使用旧 DB
 * 兼容缓存，不再读取已退役的 panel mainConfig/MCP 快照。
 *
 * @param state 当前 AppState（提供 panelSettings 与环境列表）
 */
export function buildFullBackup(
  state: AppState,
  standardEnvironmentConfigs: Record<string, StandardEnvironmentConfig> = {},
): FullBackupBundle {
  const environments = parseKimiCodeEnvironments(
    state.panelSettings.kimi_code_environments,
    [createDefaultKimiCodeEnvironment()],
  );
  const activeId = state.panelSettings.active_kimi_code_environment_id ?? DEFAULT_KIMI_CODE_ENVIRONMENT_ID;

  const bundles: EnvironmentConfigBundle[] = environments.map((environment) => {
    // 当前激活环境的 Provider/Model 以内存 state 为准（可能含未保存编辑）；
    // 其余环境直接使用各自原生 config.toml 的已读取内容。
    const standardConfig = standardEnvironmentConfigs[environment.id];
    const providers = environment.id === activeId
      ? structuredClone(state.mainConfig.providers)
      : structuredClone(standardConfig?.mainConfig.providers ?? {});
    const models = environment.id === activeId
      ? structuredClone(state.mainConfig.models)
      : structuredClone(standardConfig?.mainConfig.models ?? {});
    const mcpServers = environment.id === activeId
      ? cloneMcpServers(state.mcpConfig.mcpServers)
      : cloneMcpServers(standardConfig?.mcpServers ?? {});
    const profiles = environment.id === activeId
      ? sanitizeProfilesRecord(state.profiles)
      : sanitizeProfilesRecord(environment.profiles ?? {});
    const activeProfile = environment.id === activeId
      ? state.activeProfile
      : (environment.activeProfile ?? DEFAULT_PROFILE_NAME);
    return {
      environment: {
        id: environment.id,
        name: environment.name,
        homePath: environment.homePath,
        kind: environment.kind,
        description: environment.description,
        workingDirectory: environment.workingDirectory,
      },
      mainConfig: {
        ...(environment.id === activeId
          ? structuredClone(state.mainConfig)
          : structuredClone(standardConfig?.mainConfig ?? normalizeMainConfig({}))),
        providers: structuredClone(providers),
        models: structuredClone(models),
      },
      tuiDocument: standardConfig?.tuiDocument,
      agentsDocument: standardConfig?.agentsDocument,
      skillsDirectory: standardConfig?.skillsDirectory
        ? structuredClone(standardConfig.skillsDirectory)
        : undefined,
      pluginsDirectory: standardConfig?.pluginsDirectory
        ? structuredClone(standardConfig.pluginsDirectory)
        : undefined,
      providers,
      models,
      mcpServers,
      profiles,
      activeProfile,
    };
  });

  return {
    version: FULL_BACKUP_VERSION,
    kind: "full-backup",
    exportedAt: new Date().toISOString(),
    source: "kimi-code-switch-gui",
    environments: bundles,
    activeEnvironmentId: activeId,
    panelSettings: structuredClone(state.panelSettings),
  };
}

export function isFullBackupBundle(data: unknown): data is FullBackupBundle {
  return (
    isRecord(data)
    && (data as { kind?: unknown }).kind === "full-backup"
    && Array.isArray((data as { environments?: unknown }).environments)
  );
}

export function validateFullBackup(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(data)) {
    return { valid: false, errors: ["Data must be a JSON object."] };
  }
  if ((data as { kind?: unknown }).kind !== "full-backup") {
    errors.push("Not a full backup file (missing kind: 'full-backup').");
  }
  if (typeof (data as { version?: unknown }).version !== "number") {
    errors.push("Missing or invalid 'version' field.");
  }
  if (!Array.isArray((data as { environments?: unknown }).environments)) {
    errors.push("Missing 'environments' array.");
  } else {
    const ids = new Set<string>();
    for (const [index, environment] of (data as { environments: unknown[] }).environments.entries()) {
      if (!isRecord(environment) || !isRecord(environment.environment)) {
        errors.push(`Invalid environment entry at index ${index}.`);
        continue;
      }
      const id = environment.environment.id;
      if (typeof id !== "string" || !normalizeEntryName(id)) {
        errors.push(`Environment at index ${index} has an invalid id.`);
      } else if (ids.has(id)) {
        errors.push(`Duplicate environment id: ${id}.`);
      } else {
        ids.add(id);
      }
      for (const field of ["providers", "models", "mcpServers", "profiles"] as const) {
        if (!isRecord(environment[field])) errors.push(`Environment ${String(id)} has invalid ${field}.`);
      }
    }
    const activeId = (data as { activeEnvironmentId?: unknown }).activeEnvironmentId;
    if (typeof activeId !== "string" || !ids.has(activeId)) {
      errors.push("activeEnvironmentId does not reference a backed-up environment.");
    }
  }
  if (!isRecord((data as { panelSettings?: unknown }).panelSettings)) {
    errors.push("Missing 'panelSettings'.");
  }
  return { valid: errors.length === 0, errors };
}

export interface FullBackupRiskSummary {
  stdioMcpCommands: string[];
  remoteMcpEndpoints: string[];
  providerEndpoints: string[];
  configHooks: string[];
  agentsDocuments: string[];
  executableSkillFiles: string[];
  skillDocumentsAndScripts: string[];
  pluginDirectories: string[];
  pluginExecutableFiles: string[];
  pluginCapabilities: string[];
}

/** Surface executable/network trust boundaries before importing an untrusted backup. */
export function assessFullBackupRisk(data: FullBackupBundle): FullBackupRiskSummary {
  const stdioMcpCommands: string[] = [];
  const remoteMcpEndpoints: string[] = [];
  const providerEndpoints: string[] = [];
  const configHooks: string[] = [];
  const agentsDocuments: string[] = [];
  const executableSkillFiles: string[] = [];
  const skillDocumentsAndScripts: string[] = [];
  const pluginDirectories: string[] = [];
  const pluginExecutableFiles: string[] = [];
  const pluginCapabilities: string[] = [];
  for (const environment of data.environments) {
    const environmentId = environment.environment.id;
    for (const [name, server] of Object.entries(environment.mcpServers ?? {})) {
      const command = typeof server.command === "string" ? server.command.trim() : "";
      const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === "string") : [];
      const url = typeof server.url === "string" ? server.url.trim() : "";
      if (server.transport === "stdio" && command) {
        stdioMcpCommands.push(`${environmentId}/${name}: ${command} ${args.join(" ")}`.trim());
      } else if (url) {
        remoteMcpEndpoints.push(`${environmentId}/${name}: ${redactUrlForTrustPreview(server.url)}`);
      }
    }
    for (const [name, provider] of Object.entries(environment.providers ?? {})) {
      if (typeof provider.base_url === "string" && provider.base_url.trim()) {
        providerEndpoints.push(`${environmentId}/${name}: ${redactUrlForTrustPreview(provider.base_url)}`);
      }
    }
    for (const [index, hook] of (environment.mainConfig?.hooks ?? []).entries()) {
      configHooks.push(`${environmentId}/hook-${index + 1}: ${JSON.stringify(redactTrustValue(hook)).slice(0, 240)}`);
    }
    if (environment.agentsDocument?.trim()) {
      agentsDocuments.push(`${environmentId}/AGENTS.md (${environment.agentsDocument.length} characters)`);
    }
    for (const file of environment.skillsDirectory?.files ?? []) {
      if (file.executable) executableSkillFiles.push(`${environmentId}/skills/${file.relativePath}`);
      const path = file.relativePath.toLocaleLowerCase();
      if (path.endsWith("skill.md") || path.endsWith(".md") || path.includes("/scripts/")) {
        skillDocumentsAndScripts.push(`${environmentId}/skills/${file.relativePath}`);
      }
    }
    if (environment.pluginsDirectory?.exists) {
      pluginDirectories.push(`${environmentId}/plugins (${environment.pluginsDirectory.files.length} files)`);
      for (const file of environment.pluginsDirectory.files) {
        const itemPath = `${environmentId}/plugins/${file.relativePath}`;
        if (file.executable) pluginExecutableFiles.push(itemPath);
        const normalizedPath = file.relativePath.replace(/\\/g, "/").toLocaleLowerCase();
        if (normalizedPath === "installed.json") {
          try {
            const installed = JSON.parse(decodePortableText(file.contentBase64)) as unknown;
            if (isRecord(installed) && Array.isArray(installed.plugins)) {
              for (const plugin of installed.plugins) {
                if (!isRecord(plugin)) continue;
                const id = typeof plugin.id === "string" ? plugin.id : "<unknown>";
                const source = typeof plugin.source === "string"
                  ? redactUrlForTrustPreview(plugin.source)
                  : "unknown source";
                pluginCapabilities.push(`${environmentId}/${id}: installed from ${source}`);
              }
            }
          } catch {
            pluginCapabilities.push(`${itemPath}: invalid installed.json`);
          }
        }
        if (normalizedPath.endsWith("kimi.plugin.json") || normalizedPath.endsWith(".kimi-plugin/plugin.json")) {
          try {
            const manifest = JSON.parse(decodePortableText(file.contentBase64)) as unknown;
            if (!isRecord(manifest)) throw new Error("manifest root is not an object");
            const name = typeof manifest.name === "string" ? manifest.name : file.relativePath;
            const capabilities = [
              Array.isArray(manifest.hooks) && manifest.hooks.length > 0 ? `${manifest.hooks.length} hooks` : "",
              isRecord(manifest.mcpServers) ? `${Object.keys(manifest.mcpServers).length} MCP servers` : "",
              manifest.sessionStart !== undefined ? "sessionStart" : "",
              manifest.systemPrompt !== undefined ? "systemPrompt" : "",
              manifest.commands !== undefined ? "commands" : "",
              manifest.skills !== undefined ? "Skills" : "",
            ].filter(Boolean);
            pluginCapabilities.push(`${environmentId}/${name}: ${capabilities.join(", ") || "manifest"}`);
          } catch {
            pluginCapabilities.push(`${itemPath}: invalid manifest`);
          }
        }
      }
    }
  }
  return {
    stdioMcpCommands,
    remoteMcpEndpoints,
    providerEndpoints,
    configHooks,
    agentsDocuments,
    executableSkillFiles,
    skillDocumentsAndScripts,
    pluginDirectories,
    pluginExecutableFiles,
    pluginCapabilities,
  };
}

function decodePortableText(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function redactTrustValue(value: unknown, key = ""): unknown {
  if (/api[_-]?key|token|secret|password|authorization|cookie/i.test(key)) return REDACTION_MASK;
  if (Array.isArray(value)) return value.map((entry) => redactTrustValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      redactTrustValue(entry, entryKey),
    ]));
  }
  return value;
}

function redactUrlForTrustPreview(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTION_MASK);
    return url.toString();
  } catch {
    return value.replace(/([?&][^=&#]+)=([^&#]*)/g, `$1=${REDACTION_MASK}`);
  }
}

export function fullBackupContainsRedactedSecrets(data: FullBackupBundle): boolean {
  return containsRedactionMask(data.environments);
}

function containsRedactionMask(value: unknown): boolean {
  if (value === REDACTION_MASK) return true;
  if (Array.isArray(value)) return value.some(containsRedactionMask);
  if (isRecord(value)) return Object.values(value).some(containsRedactionMask);
  return false;
}

/**
 * 从全量备份包重建 GUI 私有设置。备份提供的绝对 homePath 不受信任：默认
 * 环境落到官方 root，其它环境落到 GUI 托管 root。MCP 不再存 panel 快照。
 */
export function rebuildPanelSettingsFromBackup(data: FullBackupBundle): PanelSettings {
  const panelSettings = structuredClone(data.panelSettings);
  const environments: KimiCodeEnvironment[] = data.environments.map((env) => ({
    id: env.environment.id,
    name: env.environment.name,
    homePath: env.environment.id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
      ? defaultKimiCodeHomePath()
      : getKimiCodeEnvironmentHomePath(env.environment.id),
    kind: env.environment.id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID ? "default" : "managed",
    description: env.environment.description,
    // Project roots are host-specific and should be selected explicitly after restore.
    workingDirectory: "",
    profiles: sanitizeProfilesRecord(env.profiles ?? {}),
    activeProfile: env.activeProfile,
  }));
  panelSettings.kimi_code_environments = environments;
  panelSettings.active_kimi_code_environment_id = data.activeEnvironmentId;
  // 顶层 MCP 快照已退役；Profile 仍是 GUI 私有状态。
  const active = data.environments.find((e) => e.environment.id === data.activeEnvironmentId)
    ?? data.environments[0];
  if (active) {
    panelSettings.profiles = sanitizeProfilesRecord(active.profiles ?? {});
    panelSettings.active_profile = active.activeProfile;
  }
  return panelSettings;
}

export function toggleFavorite(
  state: AppState,
  type: "provider" | "profile",
  name: string,
): void {
  if (!state.panelSettings.favorites) {
    state.panelSettings.favorites = {};
  }
  const key = type === "provider" ? "providers" : "profiles";
  if (!state.panelSettings.favorites[key]) {
    state.panelSettings.favorites[key] = [];
  }
  const list = state.panelSettings.favorites[key]!;
  const index = list.indexOf(name);
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(name);
  }
}

export interface SearchResult {
  type: "provider" | "model" | "profile" | "mcp";
  name: string;
  subtitle: string;
  tabId: string;
}

export function searchConfig(state: AppState, query: string): SearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const [name, provider] of Object.entries(state.mainConfig.providers)) {
    if (name.toLowerCase().includes(q) || provider.base_url.toLowerCase().includes(q)) {
      results.push({ type: "provider", name, subtitle: provider.base_url, tabId: "providers" });
    }
  }
  for (const [id, model] of Object.entries(state.mainConfig.models)) {
    if (id.toLowerCase().includes(q) || model.provider.toLowerCase().includes(q)) {
      results.push({ type: "model", name: id, subtitle: model.provider, tabId: "models" });
    }
  }
  for (const [name, profile] of Object.entries(state.profiles)) {
    if (name.toLowerCase().includes(q) || profile.default_model.toLowerCase().includes(q)) {
      results.push({ type: "profile", name, subtitle: profile.default_model, tabId: "profiles" });
    }
  }
  for (const name of Object.keys(state.mcpConfig.mcpServers)) {
    if (name.toLowerCase().includes(q)) {
      results.push({ type: "mcp", name, subtitle: "", tabId: "mcp" });
    }
  }
  return results;
}

function parseModelUiMetadata(value: unknown): PanelSettings["model_ui_metadata"] {
  if (!isRecord(value)) return {};
  const result: NonNullable<PanelSettings["model_ui_metadata"]> = {};
  for (const [environmentId, rawEnvironment] of Object.entries(value)) {
    if (!isRecord(rawEnvironment)) continue;
    const models: Record<string, ModelUiMetadata> = {};
    for (const [modelId, rawMetadata] of Object.entries(rawEnvironment)) {
      if (!isRecord(rawMetadata)) continue;
      const metadata: ModelUiMetadata = {
        ...(rawMetadata.auth_mode === "api-key" || rawMetadata.auth_mode === "official-account"
          ? { auth_mode: rawMetadata.auth_mode }
          : {}),
        ...(rawMetadata.official_account_scope === "global"
          ? { official_account_scope: "global" as const }
          : {}),
        ...(isRecord(rawMetadata.pricing) ? { pricing: rawMetadata.pricing as unknown as ModelUiMetadata["pricing"] } : {}),
      };
      if (Object.keys(metadata).length > 0) models[modelId] = metadata;
    }
    if (Object.keys(models).length > 0) result[environmentId] = models;
  }
  return result;
}

function cloneMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        ...server,
        headers: { ...server.headers },
        args: [...server.args],
        env: { ...server.env },
        extra: server.extra ? cloneUnknownRecord(server.extra) : undefined,
      },
    ]),
  );
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (Array.isArray(entry)) {
        return [key, [...entry]];
      }
      if (isRecord(entry)) {
        return [key, cloneUnknownRecord(entry)];
      }
      return [key, entry];
    }),
  );
}

function parseUiState(value: unknown): PanelSettings["uiState"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: NonNullable<PanelSettings["uiState"]> = {};
  if (typeof value.activeTab === "string") {
    result.activeTab = value.activeTab;
  }
  if (typeof value.settingsSubTab === "string") {
    result.settingsSubTab = value.settingsSubTab;
  }
  if (typeof value.kimiCodeSubTab === "string") {
    result.kimiCodeSubTab = value.kimiCodeSubTab;
  }
  if (typeof value.selectedProvider === "string") {
    result.selectedProvider = value.selectedProvider;
  }
  if (typeof value.selectedModel === "string") {
    result.selectedModel = value.selectedModel;
  }
  if (typeof value.selectedProfile === "string") {
    result.selectedProfile = value.selectedProfile;
  }
  if (typeof value.selectedMcpServer === "string") {
    result.selectedMcpServer = value.selectedMcpServer;
  }
  if (typeof value.providerSortBy === "string") {
    result.providerSortBy = value.providerSortBy;
  }
  if (typeof value.profileSortBy === "string") {
    result.profileSortBy = value.profileSortBy;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseFavorites(value: unknown): PanelSettings["favorites"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: NonNullable<PanelSettings["favorites"]> = {};
  if (Array.isArray(value.providers)) {
    result.providers = value.providers.filter((v: unknown) => typeof v === "string");
  }
  if (Array.isArray(value.profiles)) {
    result.profiles = value.profiles.filter((v: unknown) => typeof v === "string");
  }
  return (result.providers?.length || result.profiles?.length) ? result : undefined;
}

function sanitizeEnvironmentId(value: string, fallback: string): string {
  const normalized = normalizeEntryName(value);
  return normalized || fallback;
}

function parseKimiCodeEnvironments(
  value: unknown,
  fallback: PanelSettings["kimi_code_environments"],
): KimiCodeEnvironment[] {
  const entries = Array.isArray(value) ? value : fallback;
  const defaults = [createDefaultKimiCodeEnvironment()];
  if (!Array.isArray(entries)) return defaults;
  const seen = new Set<string>();
  const result: KimiCodeEnvironment[] = [];
  for (const item of entries) {
    if (!isRecord(item)) continue;
    const id = sanitizeEnvironmentId(asString(item.id, ""), "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
      ? DEFAULT_KIMI_CODE_ENVIRONMENT_NAME
      : asString(item.name, id) || id;
    const fallbackHomePath = id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
      ? defaultKimiCodeHomePath()
      : getKimiCodeEnvironmentHomePath(id);
    const requestedHomePath = sanitizePath(asString(item.homePath, ""), fallbackHomePath);
    // Older GUI releases stored the default environment inside the GUI data
    // directory. It is never a valid active default home: the one-time file
    // migration runs before state loading, then this prevents the stale panel
    // record from ever routing Kimi back to the retired location.
    const homePath = id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
      && isLegacyManagedDefaultKimiCodeHome(requestedHomePath)
      ? defaultKimiCodeHomePath()
      : requestedHomePath;
    const inferredKind: KimiCodeEnvironment["kind"] = id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
      ? "default"
      : homePath === getKimiCodeEnvironmentHomePath(id)
        ? "managed"
        : "external";
    const kind = id === DEFAULT_KIMI_CODE_ENVIRONMENT_ID
      ? "default"
      : item.kind === "managed" || item.kind === "external"
        ? item.kind
        : inferredKind;
    result.push({
      id,
      name,
      homePath,
      kind,
      description: asString(item.description, ""),
      workingDirectory: sanitizePath(asString(item.workingDirectory, ""), ""),
      createdAt: asString(item.createdAt, ""),
      updatedAt: asString(item.updatedAt, ""),
      sourceEnvironmentId: asString(item.sourceEnvironmentId, ""),
      ...(hasOwnRecordProperty(item, "profiles") ? { profiles: sanitizeProfilesRecord(item.profiles) } : {}),
      ...(typeof item.activeProfile === "string" ? { activeProfile: item.activeProfile } : {}),
    });
  }
  return result.length > 0 ? result : defaults;
}

function resolveActiveKimiCodeEnvironment(
  settings: Pick<PanelSettings, "kimi_code_environments" | "active_kimi_code_environment_id">,
): KimiCodeEnvironment {
  const environments = parseKimiCodeEnvironments(
    settings.kimi_code_environments,
    [createDefaultKimiCodeEnvironment()],
  );
  return environments.find((environment) => environment.id === settings.active_kimi_code_environment_id)
    ?? environments[0]
    ?? createDefaultKimiCodeEnvironment();
}

export function normalizeKimiCodeEnvironments(
  value: unknown,
  fallback: KimiCodeEnvironment[] = [createDefaultKimiCodeEnvironment()],
): KimiCodeEnvironment[] {
  return parseKimiCodeEnvironments(value, fallback);
}

export function getActiveKimiCodeEnvironment(
  settings: Pick<PanelSettings, "kimi_code_environments" | "active_kimi_code_environment_id">,
): KimiCodeEnvironment {
  return resolveActiveKimiCodeEnvironment(settings);
}

function normalizeTomlIndentation(document: string): string {
  const lines = document.split("\n");
  let inMultiline = false;
  let delim = "";
  return lines
    .map((line) => {
      const startedInside = inMultiline;
      let i = 0;
      while (i < line.length) {
        if (!inMultiline) {
          if (line.startsWith('"""', i)) {
            inMultiline = true;
            delim = '"""';
            i += 3;
            continue;
          }
          if (line.startsWith("'''", i)) {
            inMultiline = true;
            delim = "'''";
            i += 3;
            continue;
          }
          i += 1;
        } else if (line.startsWith(delim, i)) {
          i += delim.length;
          inMultiline = false;
          delim = "";
        } else {
          i += 1;
        }
      }
      // 仅对多行字符串之外的行去缩进，避免吞掉多行字符串值（如 hooks 脚本）的缩进。
      return startedInside
        ? line
        : line.replace(/^[ \t]+(?=(\[|[A-Za-z0-9_.-]+\s*=))/, "");
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dirnamePath(path: string): string {
  if (!path.includes("/")) {
    return ".";
  }
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return normalized.startsWith("/") ? "/" : ".";
  }
  return normalized.slice(0, index);
}

function joinPath(base: string, name: string): string {
  if (!base || base === ".") {
    return name;
  }
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}
