import {
  DEFAULT_PROFILE_NAME,
  applyProfile,
  assessFullBackupRisk,
  bootstrapProfiles,
  buildConfigDocument,
  buildPanelSettingsDocument,
  buildProfilesDocument,
  buildPreviewBundle,
  cloneProfile,
  cloneState,
  compareProfiles,
  copyProfileField,
  createDefaultPanelSettings,
  createLineDiff,
  deleteModel,
  deleteProfile,
  deleteProvider,
  exportConfig,
  bundleContainsRedactedSecrets,
  buildFullBackup,
  fullBackupContainsRedactedSecrets,
  isFullBackupBundle,
  rebuildPanelSettingsFromBackup,
  validateFullBackup,
  defaultKimiCodeHomePath,
  getKimiCodeEnvironmentHomePath,
  getKimiCodeConfigPath,
  getKimiCodeMcpConfigPath,
  getKimiCodeTuiConfigPath,
  migrateLegacyKimiCliConfigToKimiCode,
  migrateLegacyManagedDefaultEnvironmentToNativeHome,
  repairLegacyManagedDefaultHomeSymlink,
  formatMissingModelError,
  getImportPreview,
  importConfig,
  normalizeKimiCodeEnvironments,
  searchConfig,
  toggleFavorite,
  validateImportData,
  loadAppState,
  loadPanelSettings,
  normalizeStatePaths,
  parsePanelSettingsDocument,
  saveAppState,
  upsertModel,
  upsertProfile,
  upsertProvider,
} from "./configStore";
import { buildMcpConfigDocument } from "./mcpStore";
import { parseTuiConfigDocument } from "./tuiStore";
import type { AppState, ConfigTarget, KimiCodeEnvironment, MainConfig, Profile } from "./types";

function createState(): AppState {
  return {
    configTarget: "kimi-code",
    configPath: "/tmp/config.toml",
    profilesPath: "",
    panelSettingsPath: "/tmp/config.panel.toml",
    mcpConfigPath: "/tmp/mcp.json",
    mainConfig: {
      default_model: "kimi_gateway/kimi-k2.5",
      default_plan_mode: false,
      default_permission_mode: "",
      merge_all_available_skills: false,
      hooks: [],
      models: {
        "kimi_gateway/kimi-k2.5": {
          provider: "kimi_gateway",
          model: "kimi-k2.5",
          max_context_size: 262144,
          capabilities: ["thinking"],
        },
      },
      providers: {
        kimi_gateway: {
          type: "kimi",
          base_url: "https://example.test/v1",
          api_key: "sk-test",
        },
      },
      loop_control: {},
      background: {},
      notifications: {},
      services: {},
      mcp: {},
    },
    profiles: bootstrapProfiles({
      default_model: "kimi_gateway/kimi-k2.5",
      default_plan_mode: false,
      default_permission_mode: "",
      merge_all_available_skills: false,
      hooks: [],
      models: {
        "kimi_gateway/kimi-k2.5": {
          provider: "kimi_gateway",
          model: "kimi-k2.5",
          max_context_size: 262144,
          capabilities: ["thinking"],
        },
      },
      providers: {
        kimi_gateway: {
          type: "kimi",
          base_url: "https://example.test/v1",
          api_key: "sk-test",
        },
      },
      loop_control: {},
      background: {},
      notifications: {},
      services: {},
      mcp: {},
    }),
    activeProfile: DEFAULT_PROFILE_NAME,
    panelSettings: createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml"),
    mcpConfig: {
      mcpServers: {
        context7: {
          enabled: true,
          transport: "streamable-http",
          url: "https://mcp.context7.com/mcp",
          headers: {
            CONTEXT7_API_KEY: "ctx-test",
          },
          command: "",
          args: [],
          env: {},
        },
        chrome_devtools: {
          enabled: true,
          transport: "stdio",
          url: "",
          headers: {},
          command: "npx",
          args: ["chrome-devtools-mcp@latest"],
          env: {
            DEBUG: "1",
          },
        },
      },
    },
  };
}

describe("configStore", () => {
  it("bootstraps a default profile from main config", () => {
    const state = createState();
    expect(state.profiles.default.default_model).toBe("kimi_gateway/kimi-k2.5");
  });

  it("preserves explicit environment roots and uses the official default root", () => {
    const environments = normalizeKimiCodeEnvironments([
      { id: "default", name: "Work Default", homePath: "~/.kimi-code" },
      { id: "team", name: "Team", homePath: "/tmp/custom-kimi-code" },
    ]);

    expect(environments[0]).toMatchObject({
      id: "default",
      name: "默认环境",
      homePath: "~/.kimi-code",
    });
    expect(environments[1]).toMatchObject({
      id: "team",
      name: "Team",
      homePath: "/tmp/custom-kimi-code",
    });
  });

  it("uses the renamed home for new targets and preserves every explicit legacy target", () => {
    expect(getKimiCodeEnvironmentHomePath("default")).toBe("~/.kimi-code");
    expect(getKimiCodeEnvironmentHomePath("team")).toBe("~/.kimi-code-switch/.env/team");

    const environments = normalizeKimiCodeEnvironments([
      { id: "default", name: "Default", homePath: "~/.kimi-code-switch-gui/.env/default", kind: "managed" },
      { id: "team", name: "Team", homePath: "~/.kimi-code-switch-gui/.env/team", kind: "managed" },
    ]);

    expect(environments).toEqual([expect.objectContaining({
      id: "default",
      kind: "managed",
      homePath: "~/.kimi-code-switch-gui/.env/default",
    }), expect.objectContaining({ id: "team", kind: "managed", homePath: "~/.kimi-code-switch-gui/.env/team" })]);
  });

  it("bootstraps kimi-cli profile label from main config", () => {
    const profiles = bootstrapProfiles({
      ...createState().mainConfig,
      profile_label: "Work",
    });

    expect(profiles.default.label).toBe("Work");
  });

  it("does not bootstrap a profile when Kimi Code config has no models", () => {
    const profiles = bootstrapProfiles({
      ...createState().mainConfig,
      default_model: "",
      models: {},
      providers: {},
    });

    expect(profiles).toEqual({});
  });

  it("applies profile values into main config", () => {
    const state = createState();
    upsertProvider(state, "alt_gateway", {
      type: "openai",
      base_url: "https://alt.example/v1",
      api_key: "sk-alt",
    });
    upsertModel(state, "alt_gateway/gpt-4.1", {
      provider: "alt_gateway",
      model: "gpt-4.1",
      max_context_size: 128000,
      capabilities: ["thinking"],
    });
    upsertProfile(state, {
      name: "work",
      label: "Work",
      default_model: "alt_gateway/gpt-4.1",
      default_plan_mode: true,
      default_permission_mode: "yolo",
      merge_all_available_skills: true,
      thinking_enabled: false,
      thinking_effort: "high",
      tui_theme: "light",
      tui_editor_command: "vim",
    });

    applyProfile(state, "work");

    expect(state.mainConfig.default_model).toBe("alt_gateway/gpt-4.1");
    expect(state.mainConfig.default_permission_mode).toBe("yolo");
    expect(state.mainConfig.default_plan_mode).toBe(true);
    expect(state.activeProfile).toBe("work");
  });

  it("blocks deleting provider that is still referenced", () => {
    const state = createState();
    expect(() => deleteProvider(state, "kimi_gateway")).toThrow(/still used by model/);
  });

  it("blocks deleting model that is still used by profile", () => {
    const state = createState();
    expect(() => deleteModel(state, "kimi_gateway/kimi-k2.5")).toThrow(/still used by profile/);
  });

  it("blocks deleting active profile", () => {
    const state = createState();
    expect(() => deleteProfile(state, "default")).toThrow(/Cannot delete the active profile/);
  });

  it("clones profiles", () => {
    const state = createState();
    cloneProfile(state, "default", "default-copy", "Default Copy");
    expect(state.profiles["default-copy"].label).toBe("Default Copy");
    expect(state.profiles["default-copy"].default_model).toBe("kimi_gateway/kimi-k2.5");
  });

  it("preserves profile editor and theme from input", () => {
    const state = createState();
    upsertProfile(state, {
      name: "work",
      label: "Work",
      default_model: "kimi_gateway/kimi-k2.5",
      default_plan_mode: false,
      default_permission_mode: "manual",
      merge_all_available_skills: false,
      tui_editor_command: "vim",
      tui_theme: "light",
    });

    expect(state.profiles.work.tui_editor_command).toBe("vim");
    expect(state.profiles.work.tui_theme).toBe("light");
  });

  it("renders config document", () => {
    const document = buildConfigDocument(createState());
    expect(document).toContain('default_model = "kimi_gateway/kimi-k2.5"');
    expect(document).toContain("[providers.kimi_gateway]");
  });

  it("does not materialize the official merge-skills default when the key was absent", async () => {
    const files = createMemoryFs({
      "~/.kimi-code/config.toml": "",
    });
    const state = await loadAppState(files);

    expect(state.mainConfig.merge_all_available_skills).toBe(true);
    expect(buildConfigDocument(state)).not.toContain("merge_all_available_skills");
  });

  it("formats actionable missing model error", () => {
    const message = formatMissingModelError("kimi-k2.5", { "kimi_gateway/kimi-k2.5": {} }, {
      context: "Profile default",
    });
    expect(message).toContain('references a missing default model: "kimi-k2.5"');
    expect(message).toContain("Fill in the [models] key, not the model field value.");
    expect(message).toContain("Available model keys: kimi_gateway/kimi-k2.5");
  });

  it("formats empty model hint when there are no models", () => {
    const message = formatMissingModelError("", {}, { context: "Profile broken" });
    expect(message).toContain("There are no models yet; create one on the Models page first.");
  });

  it("builds preview bundle with diff", () => {
    const preview = buildPreviewBundle(createState(), {
      configDocument: "",
      panelSettingsDocument: "",
    });
    expect(preview.configDocument).toContain("default_model");
    expect(preview.configDiff).toContain("+ default_model");
    expect(preview.mcpDocument).toContain('"mcpServers"');
    expect(preview.mcpDiff).toContain('+   "mcpServers": {');
  });

  it("creates simple line diff", () => {
    expect(createLineDiff("alpha\nbeta\n", "alpha\ngamma\n")).toContain("- beta");
    expect(createLineDiff("alpha\nbeta\n", "alpha\ngamma\n")).toContain("+ gamma");
  });

  it("clones state deeply", () => {
    const state = createState();
    const cloned = cloneState(state);
    cloned.mainConfig.default_model = "changed";
    expect(state.mainConfig.default_model).toBe("kimi_gateway/kimi-k2.5");
  });

  it("loads app state from in-memory files", async () => {
    const files = createMemoryFs({
      "/tmp/config.toml": buildConfigDocument(createState()),
      "/tmp/config.panel.toml": buildPanelSettingsDocument(
        createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml"),
      ),
      "/tmp/config.profiles.toml": buildProfilesDocument(createState()),
      "/tmp/mcp.json": buildMcpConfigDocument(createState().mcpConfig),
    });

    const loaded = await loadAppState(files, {
      configPath: "/tmp/config.toml",
      profilesPath: "/tmp/config.profiles.toml",
      panelSettingsPath: "/tmp/config.panel.toml",
      mcpConfigPath: "/tmp/mcp.json",
    });

    expect(loaded.activeProfile).toBe("default");
    expect(loaded.mainConfig.providers.kimi_gateway.type).toBe("kimi");
    expect(loaded.mcpConfig.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
    expect(loaded.mcpConfig.mcpServers.chrome_devtools.command).toBe("npx");
  });

  it("loads the complete effective TUI configuration from the active environment", async () => {
    const files = createMemoryFs({
      "~/.kimi-code/config.toml": 'default_model = ""\n',
      "~/.kimi-code/tui.toml": `
theme = "dark"
render_latex = true
cache_expiry_hint = true
[editor]
command = "nvim"
[notifications]
enabled = true
notification_condition = "always"
[upgrade]
auto_install = true
[status_line]
items = ["model", "cwd"]
`,
    });

    const state = await loadAppState(files);

    expect(state.tuiConfig).toEqual({
      theme: "dark",
      renderLatex: true,
      cacheExpiryHint: true,
      editorCommand: "nvim",
      notificationsEnabled: true,
      notificationCondition: "always",
      upgradeAutoInstall: true,
      statusLine: { items: ["model", "cwd"] },
    });
  });

  it("loads panel settings with defaults", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml":
        'locale = "en-US"\ntheme = "dark"\nui_font_size = "large"\nconfig_path = "/tmp/custom.toml"\ntray_icon = true\ndisplay_open_mode = "active-display"\nlast_display_id = 2\nskills_project_root = "/workspace/demo"\nskills_extra_dirs = ["/tmp/skills-a", "/tmp/skills-b"]\n',
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    expect(loaded.locale).toBe("en-US");
    expect(loaded.theme).toBe("dark");
    expect(loaded.ui_font_size).toBe("large");
    expect(loaded.config_path).toBe("/tmp/custom.toml");
    expect(loaded.display_open_mode).toBe("active-display");
    expect(loaded.close_behavior).toBe("keep-in-tray");
    expect(loaded.terminal_app).toBe("system-terminal");
    expect(loaded.backup_local_path).toBe("~/.kimi-code-switch/backups");
    expect(loaded.backup_frequency).toBe("daily");
    expect(loaded.backup_retention_count).toBe(10);
    expect(loaded.backup_strategy).toBe("manual");
    expect(loaded.backup_destination_type).toBe("local");
    expect(loaded.shortcuts["window.toggle"].accelerator).toBe("Command+Shift+H");
    expect(loaded.shortcuts["app.save"].scope).toBe("window");
    expect(loaded.last_display_id).toBe(2);
  });

  it("loads supported non-English panel locales", async () => {
    for (const locale of ["zh-TW", "ja-JP", "de-DE", "es-ES"] as const) {
      const files = createMemoryFs({
        "/tmp/config.panel.toml": `locale = "${locale}"\n`,
      });
      const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
      expect(loaded.locale).toBe(locale);
    }
  });

  it("clamps invalid backup settings to safe defaults", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml":
        'config_path = "/tmp/custom.toml"\nui_font_size = "huge"\nbackup_frequency = "monthly"\nbackup_retention_count = 0\nbackup_enabled = true\n',
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    expect(loaded.ui_font_size).toBe("standard");
    expect(loaded.backup_local_path).toBe("~/.kimi-code-switch/backups");
    expect(loaded.backup_frequency).toBe("daily");
    expect(loaded.backup_retention_count).toBe(1);
    expect(loaded.backup_strategy).toBe("scheduled");
  });

  it("falls back to system terminal for invalid terminal app values", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml": 'terminal_app = "warp"\n',
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    expect(loaded.terminal_app).toBe("system-terminal");
  });

  it("loads explicit webdav backup settings", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml":
        'backup_destination_type = "webdav"\nbackup_strategy = "on-change"\nbackup_webdav_url = "https://dav.example.com/root"\nbackup_webdav_username = "alice"\nbackup_webdav_password = "secret"\nbackup_webdav_path = "kimi/backups"\n',
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    expect(loaded.backup_destination_type).toBe("webdav");
    expect(loaded.backup_strategy).toBe("on-change");
    expect(loaded.backup_webdav_url).toBe("https://dav.example.com/root");
    expect(loaded.backup_webdav_username).toBe("alice");
    expect(loaded.backup_webdav_password).toBe("secret");
    expect(loaded.backup_webdav_path).toBe("kimi/backups");
  });

  it("drops legacy panel MCP data instead of treating it as GUI settings", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml": `version = 1
config_path = "/tmp/config.toml"

[mcp_servers.context7]
enabled = false
transport = "streamable-http"
url = "https://mcp.context7.com/mcp"

  [mcp_servers.context7.headers]
  CONTEXT7_API_KEY = "ctx-test"

  [mcp_servers.context7.extra]
  oauth_audience = "ctx"
`,
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    const document = buildPanelSettingsDocument(loaded);
    expect(JSON.stringify(loaded)).not.toContain("mcp_servers");
    expect(document).not.toContain("mcp_servers");
    expect(document).not.toContain("CONTEXT7_API_KEY");
    expect(document).toContain('[shortcuts."window.toggle"]');
  });

  it("parses shortcut tables from panel settings documents", () => {
    const panelSettings = createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml");
    panelSettings.shortcuts["window.toggle"].accelerator = "Command+Shift+H";
    panelSettings.shortcuts["window.toggle"].enabled = true;
    const parsed = parsePanelSettingsDocument(buildPanelSettingsDocument(panelSettings), panelSettings);
    expect(parsed.shortcuts["window.toggle"].accelerator).toBe("Command+Shift+H");
    expect(parsed.shortcuts["window.toggle"].enabled).toBe(true);
  });

  it("round-trips sidebar collapsed preference in panel settings", () => {
    const panelSettings = createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml");
    panelSettings.sidebar_collapsed = true;
    const document = buildPanelSettingsDocument(panelSettings);
    const parsed = parsePanelSettingsDocument(document);
    expect(document).toContain("sidebar_collapsed = true");
    expect(parsed.sidebar_collapsed).toBe(true);
  });

  it("round-trips chatgpt bridge bindings in panel settings", () => {
    const panelSettings = createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml");
    panelSettings.chatgpt_bridge_bindings = {
      default: {
        environmentId: "default",
        providerName: "chatgpt-bridge",
        modelAliases: ["chatgpt/gpt-5.5"],
        bridgePort: 8317,
        bridgeSecret: "local-secret",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const document = buildPanelSettingsDocument(panelSettings);
    const parsed = parsePanelSettingsDocument(document);
    expect(parsed.chatgpt_bridge_bindings?.default.providerName).toBe("chatgpt-bridge");
    expect(parsed.chatgpt_bridge_bindings?.default.bridgeSecret).toBe("local-secret");
    expect(parsed.chatgpt_bridge_bindings?.default.modelAliases).toEqual(["chatgpt/gpt-5.5"]);
  });

  it("forces quit behavior when tray icon is disabled", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml": 'tray_icon = false\nclose_behavior = "keep-in-tray"\n',
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    expect(loaded.tray_icon).toBe(false);
    expect(loaded.close_behavior).toBe("quit");
  });

  it("falls back to remember-last display mode for invalid panel setting", async () => {
    const files = createMemoryFs({
      "/tmp/config.panel.toml": 'display_open_mode = "nearest"\n',
    });
    const loaded = await loadPanelSettings(files, "/tmp/config.panel.toml");
    expect(loaded.display_open_mode).toBe("remember-last");
  });

  it("saves app state into Kimi files and SQLite panel state", async () => {
    const state = createState();
    const files = createMemoryFs({});
    await saveAppState(files, state);
    expect(files.store["~/.kimi-code/config.toml"]).toContain("default_model");
    expect(files.store["/tmp/config.profiles.toml"]).toBeUndefined();
    expect(files.store["/tmp/config.panel.toml"]).toContain("follow_config_profiles");
    expect(files.store["/tmp/config.panel.toml"]).toContain("active_profile");
    expect(files.store["~/.kimi-code/mcp.json"]).toContain('"mcpServers"');
  });

  it("keeps GUI model pricing out of Kimi config.toml", async () => {
    const state = createState();
    state.mainConfig.models["kimi_gateway/kimi-k2.5"].pricing = {
      input_per_mtok: 1,
      output_per_mtok: 2,
      cache_read_per_mtok: 0.25,
    };
    const files = createMemoryFs({});

    await saveAppState(files, state);

    const document = files.store["~/.kimi-code/config.toml"];
    expect(document).not.toContain("pricing");
    expect(state.mainConfig.models["kimi_gateway/kimi-k2.5"].pricing?.input_per_mtok).toBe(1);
  });

  it("persists official account model mode and active account setting", async () => {
    const state = createState();
    state.mainConfig.models["kimi_gateway/kimi-k2.5"].auth_mode = "official-account";
    state.mainConfig.models["kimi_gateway/kimi-k2.5"].official_account_scope = "global";
    state.panelSettings.active_official_account_id = "acct-test";
    const files = createMemoryFs({});

    await saveAppState(files, state);

    expect(files.store["~/.kimi-code/config.toml"]).not.toContain("auth_mode");
    expect(files.store["~/.kimi-code/config.toml"]).not.toContain("official_account_scope");
    expect(files.store["/tmp/config.panel.toml"]).toContain('active_official_account_id = "acct-test"');
  });

  it("does not persist redacted provider api keys into config.toml", async () => {
    const state = createState();
    const files = createMemoryFs({
      "~/.kimi-code/config.toml": buildConfigDocument(state),
    });
    state.mainConfig.providers.kimi_gateway.api_key = "[REDACTED]";

    await saveAppState(files, state);

    expect(files.store["~/.kimi-code/config.toml"]).toContain('api_key = "sk-test"');
    expect(files.store["~/.kimi-code/config.toml"]).not.toContain("[REDACTED]");
  });

  it("ignores legacy profiles path collisions on save", async () => {
    const state = createState();
    state.profilesPath = state.configPath;
    await expect(saveAppState(createMemoryFs({}), state)).resolves.toBeUndefined();
  });

  it("falls back to bootstrap profile when profiles file is missing", async () => {
    const files = createMemoryFs({
      "/tmp/config.toml": buildConfigDocument(createState()),
      "/tmp/config.panel.toml": buildPanelSettingsDocument(
        createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml"),
      ),
    });
    const loaded = await loadAppState(files, {
      configPath: "/tmp/config.toml",
      panelSettingsPath: "/tmp/config.panel.toml",
    });
    expect(loaded.profiles.default).toBeDefined();
  });

  it("reads legacy panel settings without recreating a GUI panel TOML", async () => {
    const files = createMemoryFs({
      "~/.kimi/config.toml": 'default_model = "kimi/k2"\n',
      "~/.kimi/config.profiles.toml": 'version = 1\nactive_profile = "default"\n',
      "~/.kimi/config.panel.toml": 'locale = "en-US"\ntheme = "dark"\n',
    });
    const loaded = await loadAppState(files);
    expect(loaded.panelSettingsPath).toBe("~/.kimi-code-switch/app.db#panel_settings");
    expect(loaded.panelSettings.locale).toBe("en-US");
    expect(loaded.panelSettings.theme).toBe("dark");
    expect(files.ensured).not.toContain("~/.kimi-code-switch-gui");
    expect(files.writes).not.toContain("~/.kimi-code-switch-gui/config.panel.toml");
    expect(files.store["~/.kimi-code-switch-gui/config.panel.toml"]).toBeUndefined();
  });

  it("throws when panel settings file read fails for reasons other than missing content", async () => {
    const files = createMemoryFs({});
    files.readText = async () => { throw new Error("EACCES"); };
    await expect(loadPanelSettings(files, "/tmp/config.panel.toml")).rejects.toThrow(/Failed to read panel settings/);
  });

  it("throws when config TOML is invalid instead of treating it as empty", async () => {
    const files = createMemoryFs({
      "/tmp/config.toml": "default_model = ",
      "/tmp/config.panel.toml": buildPanelSettingsDocument(createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml")),
      "/tmp/config.profiles.toml": buildProfilesDocument(createState()),
      "/tmp/mcp.json": buildMcpConfigDocument(createState().mcpConfig),
    });
    await expect(loadAppState(files, {
      configPath: "/tmp/config.toml",
      profilesPath: "/tmp/config.profiles.toml",
      panelSettingsPath: "/tmp/config.panel.toml",
      mcpConfigPath: "/tmp/mcp.json",
    })).rejects.toThrow(/Invalid main config TOML/);
  });

  it("throws when MCP config is invalid instead of silently dropping servers", async () => {
    const files = createMemoryFs({
      "/tmp/config.toml": buildConfigDocument(createState()),
      "/tmp/config.panel.toml": buildPanelSettingsDocument(createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml")),
      "/tmp/config.profiles.toml": buildProfilesDocument(createState()),
      "/tmp/mcp.json": "{invalid-json}",
    });
    await expect(loadAppState(files, {
      configPath: "/tmp/config.toml",
      profilesPath: "/tmp/config.profiles.toml",
      panelSettingsPath: "/tmp/config.panel.toml",
      mcpConfigPath: "/tmp/mcp.json",
    })).rejects.toThrow(/Invalid MCP config/);
  });

  it("falls back to first profile when active profile is invalid", async () => {
    const state = createState();
    const files = createMemoryFs({
      "/tmp/config.toml": buildConfigDocument(state),
      "/tmp/config.panel.toml": buildPanelSettingsDocument(createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml")),
      "/tmp/config.profiles.toml":
        'version = 1\nactive_profile = "missing"\n\n[profiles.default]\nlabel = "Default"\ndefault_model = "kimi_gateway/kimi-k2.5"\ndefault_thinking = true\ndefault_yolo = false\ndefault_plan_mode = false\ndefault_editor = ""\ntheme = "dark"\nshow_thinking_stream = false\nmerge_all_available_skills = false\n',
    });
    const loaded = await loadAppState(files, {
      configPath: "/tmp/config.toml",
      profilesPath: "/tmp/config.profiles.toml",
      panelSettingsPath: "/tmp/config.panel.toml",
    });
    expect(loaded.activeProfile).toBe("default");
  });

  it("normalizes empty paths before save", () => {
    const state = createState();
    state.profilesPath = "";
    state.panelSettingsPath = "";
    const normalized = normalizeStatePaths(state);
    expect(normalized.profilesPath).toBe("");
    expect(normalized.panelSettingsPath).toBe("~/.kimi-code-switch/app.db#panel_settings");
    expect(normalized.mcpConfigPath).toBe("~/.kimi-code/mcp.json");
  });

  it("saves profiles into panel settings when explicit path is blank", async () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.profilesPath = "";
    const files = createMemoryFs({});
    await saveAppState(files, state);
    expect(files.store["/tmp/config.profiles.toml"]).toBeUndefined();
    expect(files.store["/tmp/config.panel.toml"]).toContain("active_profile");
  });

  it("rejects unknown model provider on upsert", () => {
    const state = createState();
    expect(() =>
      upsertModel(state, "missing/gpt", { provider: "missing", model: "gpt", max_context_size: 1, capabilities: [] }),
    ).toThrow(/Provider not found/);
  });

  it("rejects duplicate and missing profile clone requests", () => {
    const state = createState();
    expect(() => cloneProfile(state, "missing", "target", "Target")).toThrow(/Profile not found/);
    expect(() => cloneProfile(state, "default", "default", "Default")).toThrow(/already exists/);
  });

  describe("compareProfiles", () => {
    it("reports identical profiles as all same", () => {
      const state = createState();
      const profile = state.profiles.default;
      const diff = compareProfiles(profile, profile);
      expect(diff.differences.every((d) => d.isSame)).toBe(true);
    });

    it("reports all differences when profiles differ completely", () => {
      const state = createState();
      const a = state.profiles.default;
      const b: typeof a = {
        ...a,
        name: "other",
        label: "Other",
        default_model: "kimi_gateway/kimi-k2.5",
        default_permission_mode: "yolo",
        default_plan_mode: true,
        thinking_enabled: false,
        tui_theme: "light",
        tui_editor_command: "vim",
        merge_all_available_skills: true,
      };
      const diff = compareProfiles(a, b);
      expect(diff.differences.filter((d) => !d.isSame).length).toBeGreaterThan(0);
    });

    it("reports partial differences correctly", () => {
      const state = createState();
      const a = state.profiles.default;
      const b: Profile = { ...a, label: "Changed", default_permission_mode: "yolo", tui_theme: "light" };
      const diff = compareProfiles(a, b);
      const changed = diff.differences.filter((d) => !d.isSame);
      expect(changed.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("copyProfileField", () => {
    it("copies a field from source to target profile", () => {
      const state = createState();
      upsertProfile(state, {
        name: "source",
        label: "Source",
        default_model: "kimi_gateway/kimi-k2.5",
        default_plan_mode: false,
        default_permission_mode: "manual",
        merge_all_available_skills: false,
        tui_theme: "light",
      });
      copyProfileField(state, "default", "source", "tui_theme");
      // 默认 profile 未设 tui_theme，复制后 source 仍为 undefined
      expect(state.profiles.source.tui_theme).toBe(undefined);
    });

    it("throws when source profile is missing", () => {
      const state = createState();
      expect(() => copyProfileField(state, "missing", "default", "tui_theme")).toThrow(/Profile not found: missing/);
    });

    it("throws when target profile is missing", () => {
      const state = createState();
      expect(() => copyProfileField(state, "default", "missing", "tui_theme")).toThrow(/Profile not found: missing/);
    });
  });

});

function createMemoryFs(initial: Record<string, string>) {
  const store = { ...initial };
  const ensured: string[] = [];
  const writes: string[] = [];
  return {
    store,
    ensured,
    writes,
    async readText(path: string): Promise<string | null> {
      return store[path] ?? null;
    },
    async writeText(path: string, content: string): Promise<void> {
      writes.push(path);
      store[path] = content;
    },
    async ensureDir(path: string): Promise<void> {
      ensured.push(path);
    },
  };
}

describe("native provider and model persistence", () => {
  it("brackets a logical multi-file save with a durable transaction journal", async () => {
    const state = createState();
    const base = createMemoryFs({});
    const records: unknown[] = [];
    let completed = 0;
    const files = {
      ...base,
      async beginSaveTransaction(record: unknown) { records.push(record); },
      async completeSaveTransaction() { completed += 1; },
    };

    await saveAppState(files, state);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "save-app-state", version: 1 });
    expect(completed).toBe(1);
  });

  it("routes config and MCP writes through CAS when revisions are supplied", async () => {
    const state = createState();
    const base = createMemoryFs({});
    const casWrites: Array<{ path: string; expectedSha256: string }> = [];
    const files = {
      ...base,
      async writeTextCas(path: string, content: string, expectedSha256: string) {
        casWrites.push({ path, expectedSha256 });
        await base.writeText(path, content);
        return `new-${expectedSha256}`;
      },
    };

    await saveAppState(files, state, {
      expectedSha256: { config: "config-base", mcp: "mcp-base" },
    });

    expect(casWrites).toEqual([
      { path: normalizeStatePaths(state).configPath, expectedSha256: "config-base" },
      { path: normalizeStatePaths(state).mcpConfigPath, expectedSha256: "mcp-base" },
    ]);
  });

  it("rolls config back with CAS when the subsequent MCP write conflicts", async () => {
    const state = createState();
    const normalized = normalizeStatePaths(state);
    const base = createMemoryFs({
      [normalized.configPath]: "original-config",
      [normalized.mcpConfigPath]: "original-mcp",
    });
    const casWrites: Array<{ path: string; content: string; expectedSha256: string }> = [];
    const files = {
      ...base,
      async writeTextCas(path: string, content: string, expectedSha256: string) {
        casWrites.push({ path, content, expectedSha256 });
        if (path === normalized.mcpConfigPath) throw new Error("write conflict");
        await base.writeText(path, content);
        return expectedSha256 === "config-base" ? "written-config" : "rolled-back-config";
      },
    };

    await expect(saveAppState(files, state, {
      expectedSha256: { config: "config-base", mcp: "mcp-base" },
    })).rejects.toThrow(/write conflict/);

    expect(casWrites).toEqual(expect.arrayContaining([
      { path: normalized.configPath, content: "original-config", expectedSha256: "written-config" },
    ]));
    expect(base.store[normalized.configPath]).toBe("original-config");
  });

  it("removes a newly created MCP file with CAS when a later panel write fails", async () => {
    const state = createState();
    const normalized = normalizeStatePaths(state);
    const base = createMemoryFs({
      [normalized.configPath]: "original-config",
    });
    const files = {
      ...base,
      async writeTextCas(path: string, content: string, expectedSha256: string) {
        await base.writeText(path, content);
        return path === normalized.configPath ? "written-config" : "written-mcp";
      },
      async removeTextCas(path: string, expectedSha256: string) {
        expect(expectedSha256).toBe("written-mcp");
        delete base.store[path];
      },
      async writePanelSettings() {
        throw new Error("panel write failed");
      },
    };

    await expect(saveAppState(files, state, {
      expectedSha256: { config: "config-base", mcp: "" },
    })).rejects.toThrow(/panel write failed/);

    expect(base.store[normalized.configPath]).toBe("original-config");
    expect(base.store[normalized.mcpConfigPath]).toBeUndefined();
  });

  it("rolls panel, MCP, and config back when the final TUI write fails", async () => {
    const state = createState();
    state.tuiConfig = { theme: "dark" };
    const normalized = normalizeStatePaths(state);
    const tuiPath = normalized.configPath.replace(/\/config\.toml$/, "/tui.toml");
    const base = createMemoryFs({
      [normalized.configPath]: "original-config",
      [normalized.mcpConfigPath]: "original-mcp",
    });
    const oldPanel = createDefaultPanelSettings("/old/config.toml", "/old/panel.toml");
    let panel = oldPanel;
    const files = {
      ...base,
      async writeText(path: string, content: string) {
        if (path === tuiPath) throw new Error("tui write failed");
        await base.writeText(path, content);
      },
      async writeTextCas(path: string, content: string, expectedSha256: string) {
        await base.writeText(path, content);
        return path === normalized.configPath ? "written-config" : "written-mcp";
      },
      async readPanelSettings() {
        return panel;
      },
      async writePanelSettings(_path: string, settings: typeof oldPanel) {
        panel = settings;
      },
    };

    await expect(saveAppState(files, state, {
      expectedSha256: { config: "config-base", mcp: "mcp-base" },
    })).rejects.toThrow(/tui write failed/);

    expect(base.store[normalized.configPath]).toBe("original-config");
    expect(base.store[normalized.mcpConfigPath]).toBe("original-mcp");
    expect(panel).toEqual(oldPanel);
  });

  it("writes provider and model definitions only to the native config.toml", async () => {
    const state = createState();
    state.mainConfig.providers.alt_gateway = {
      type: "openai",
      base_url: "https://alt.example.test/v1",
      api_key: "sk-alt",
    };
    state.mainConfig.models["alt_gateway/gpt-4.1"] = {
      provider: "alt_gateway",
      model: "gpt-4.1",
      max_context_size: 128000,
      capabilities: ["thinking"],
    };
    const writeEnvConfig = vi.fn();
    const files = {
      ...createMemoryFs({}),
      writeEnvConfig,
    };

    await saveAppState(files as never, state);

    const normalized = normalizeStatePaths(state);
    const configDoc = files.store[normalized.configPath];
    expect(configDoc).toContain("alt_gateway");
    expect(configDoc).toContain("sk-alt");
    expect(configDoc).toContain("gpt-4.1");
    expect(writeEnvConfig).not.toHaveBeenCalled();
  });

  it("does not read provider or model definitions from a legacy env-config cache", async () => {
    const readEnvConfig = vi.fn().mockResolvedValue({
      providers: {
        cache_only: { type: "openai", base_url: "https://cache.example.test", api_key: "cache-secret" },
      },
      models: {
        "cache_only/model": {
          provider: "cache_only",
          model: "model",
          max_context_size: 4096,
          capabilities: [],
        },
      },
    });
    const files = {
      ...createMemoryFs({
      "~/.kimi-code/config.toml": `
default_model = "cli/model"
[providers.cli]
type = "openai"
base_url = "https://cli.example.test"
api_key = "cli-key"
[models."cli/model"]
provider = "cli"
model = "model"
max_context_size = 8192
`,
      }),
      readEnvConfig,
    };

    const state = await loadAppState(files as never);

    expect(state.mainConfig.providers.cli.base_url).toBe("https://cli.example.test");
    expect(state.mainConfig.models["cli/model"].model).toBe("model");
    expect(state.mainConfig.providers.cache_only).toBeUndefined();
    expect(state.mainConfig.models["cache_only/model"]).toBeUndefined();
    expect(readEnvConfig).not.toHaveBeenCalled();
  });

  it("writes MCP only to native mcp.json, never to GUI panel settings", async () => {
    const state = createState();
    let savedPanelJson = "";
    const files = {
      ...createMemoryFs({}),
      async readPanelSettings() {
        return null;
      },
      async writePanelSettings(_path: string, settings: unknown) {
        savedPanelJson = JSON.stringify(settings);
      },
    };

    await saveAppState(files as never, state);

    expect(files.store[normalizeStatePaths(state).mcpConfigPath]).toContain("CONTEXT7_API_KEY");
    expect(savedPanelJson).not.toContain("mcp_servers");
    expect(savedPanelJson).not.toContain("CONTEXT7_API_KEY");
  });
});


describe("exportConfig", () => {
  it("includes real API keys so the backup can be fully restored", () => {
    const state = createState();
    const bundle = exportConfig(state);
    expect(bundle.version).toBe(1);
    expect(bundle.source).toBe("kimi-code-switch-gui");
    expect(bundle.exportedAt).toBeTruthy();
    expect(bundle.providers.kimi_gateway.api_key).toBe("sk-test");
    expect(bundle.providers.kimi_gateway.type).toBe("kimi");
  });

  it("includes models, profiles, and mcpServers", () => {
    const state = createState();
    const bundle = exportConfig(state);
    expect(bundle.models["kimi_gateway/kimi-k2.5"]).toBeTruthy();
    expect(bundle.profiles.default).toBeTruthy();
    expect(bundle.mcpServers.context7).toBeTruthy();
  });
});

describe("validateImportData", () => {
  it("rejects non-object data", () => {
    const result = validateImportData("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects data without version", () => {
    const result = validateImportData({ providers: {} });
    expect(result.valid).toBe(false);
  });

  it("rejects data without any data fields", () => {
    const result = validateImportData({ version: 1 });
    expect(result.valid).toBe(false);
  });

  it("accepts valid data with providers", () => {
    const result = validateImportData({ version: 1, providers: {} });
    expect(result.valid).toBe(true);
  });
});

describe("getImportPreview", () => {
  it("classifies existing items as conflicts", () => {
    const state = createState();
    const data = exportConfig(state);
    const preview = getImportPreview(state, data);
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(preview.conflicts.some((c) => c.name === "kimi_gateway" && c.type === "provider")).toBe(true);
  });

  it("classifies new items correctly", () => {
    const state = createState();
    const data = { version: 1, exportedAt: "", source: "t", providers: { new_prov: { type: "openai", base_url: "https://x", api_key: "k" } }, models: {}, profiles: {}, mcpServers: {} };
    const preview = getImportPreview(state, data);
    expect(preview.newItems.length).toBe(1);
    expect(preview.conflicts.length).toBe(0);
  });
});

describe("importConfig", () => {
  it("skip strategy does not overwrite existing", () => {
    const state = createState();
    const data = exportConfig(state);
    const next = importConfig(state, data, "skip");
    expect(next.mainConfig.providers.kimi_gateway.type).toBe("kimi");
  });

  it("overwrite strategy replaces existing", () => {
    const state = createState();
    const data = { version: 1, exportedAt: "", source: "t", providers: { kimi_gateway: { type: "anthropic", base_url: "https://r", api_key: "k" } }, models: {}, profiles: {}, mcpServers: {} };
    const next = importConfig(state, data, "overwrite");
    expect(next.mainConfig.providers.kimi_gateway.type).toBe("anthropic");
  });

  it("rename strategy appends -imported", () => {
    const state = createState();
    const data = exportConfig(state);
    const next = importConfig(state, data, "rename");
    expect(next.mainConfig.providers["kimi_gateway-imported"]).toBeTruthy();
    expect(next.mainConfig.providers.kimi_gateway).toBeTruthy();
  });

  it("adds new items regardless of strategy", () => {
    const state = createState();
    const data = { version: 1, exportedAt: "", source: "t", providers: { brand_new: { type: "openai", base_url: "https://n", api_key: "k" } }, models: {}, profiles: {}, mcpServers: {} };
    const next = importConfig(state, data, "skip");
    expect(next.mainConfig.providers.brand_new).toBeTruthy();
  });

  it("does not mutate original state", () => {
    const state = createState();
    const origCount = Object.keys(state.mainConfig.providers).length;
    const data = { version: 1, exportedAt: "", source: "t", providers: { extra: { type: "openai", base_url: "https://e", api_key: "k" } }, models: {}, profiles: {}, mcpServers: {} };
    importConfig(state, data, "skip");
    expect(Object.keys(state.mainConfig.providers).length).toBe(origCount);
  });

  it("replace strategy clears existing items then loads backup in full", () => {
    const state = createState();
    const data = {
      version: 1,
      exportedAt: "",
      source: "t",
      providers: { only_prov: { type: "openai", base_url: "https://o", api_key: "k" } },
      models: {},
      profiles: {},
      mcpServers: {},
    };
    const next = importConfig(state, data, "replace");
    expect(Object.keys(next.mainConfig.providers)).toEqual(["only_prov"]);
    expect(next.mainConfig.providers.kimi_gateway).toBeUndefined();
    expect(Object.keys(next.mainConfig.models)).toEqual([]);
    expect(Object.keys(next.profiles)).toEqual([]);
    expect(Object.keys(next.mcpConfig.mcpServers)).toEqual([]);
  });

  it("replace strategy is a full round-trip with exportConfig", () => {
    const state = createState();
    const bundle = exportConfig(state);
    const next = importConfig(state, bundle, "replace");
    expect(next.mainConfig.providers.kimi_gateway.api_key).toBe("sk-test");
    expect(next.mainConfig.models["kimi_gateway/kimi-k2.5"]).toBeTruthy();
    expect(next.profiles.default).toBeTruthy();
    expect(next.mcpConfig.mcpServers.context7).toBeTruthy();
  });

  it("replace strategy does not mutate original state", () => {
    const state = createState();
    const origCount = Object.keys(state.mainConfig.providers).length;
    const data = { version: 1, exportedAt: "", source: "t", providers: {}, models: {}, profiles: {}, mcpServers: {} };
    importConfig(state, data, "replace");
    expect(Object.keys(state.mainConfig.providers).length).toBe(origCount);
  });
});

describe("bundleContainsRedactedSecrets", () => {
  it("returns false for a backup with real secrets", () => {
    const state = createState();
    const bundle = exportConfig(state);
    expect(bundleContainsRedactedSecrets(bundle)).toBe(false);
  });

  it("detects a redacted provider api_key", () => {
    const state = createState();
    const bundle = exportConfig(state);
    bundle.providers.kimi_gateway.api_key = "[REDACTED]";
    expect(bundleContainsRedactedSecrets(bundle)).toBe(true);
  });
});

describe("toggleFavorite", () => {
  it("adds name to favorites", () => {
    const state = createState();
    toggleFavorite(state, "provider", "kimi_gateway");
    expect(state.panelSettings.favorites?.providers).toContain("kimi_gateway");
  });

  it("removes existing favorite", () => {
    const state = createState();
    toggleFavorite(state, "provider", "kimi_gateway");
    toggleFavorite(state, "provider", "kimi_gateway");
    expect(state.panelSettings.favorites?.providers).not.toContain("kimi_gateway");
  });

  it("initializes favorites if undefined", () => {
    const state = createState();
    state.panelSettings.favorites = undefined;
    toggleFavorite(state, "profile", "default");
    expect(state.panelSettings.favorites).toMatchObject({ profiles: ["default"] });
  });

  it("handles provider and profile independently", () => {
    const state = createState();
    toggleFavorite(state, "provider", "kimi_gateway");
    toggleFavorite(state, "profile", "default");
    expect(state.panelSettings.favorites?.providers).toContain("kimi_gateway");
    expect(state.panelSettings.favorites?.profiles).toContain("default");
  });
});

describe("searchConfig", () => {
  it("finds providers by name", () => {
    const state = createState();
    const results = searchConfig(state, "kimi");
    expect(results.some((r) => r.type === "provider" && r.name === "kimi_gateway")).toBe(true);
  });

  it("finds models by ID", () => {
    const state = createState();
    const results = searchConfig(state, "k2.5");
    expect(results.some((r) => r.type === "model" && r.name === "kimi_gateway/kimi-k2.5")).toBe(true);
  });

  it("finds profiles by name", () => {
    const state = createState();
    const results = searchConfig(state, "default");
    expect(results.some((r) => r.type === "profile")).toBe(true);
  });

  it("finds MCP servers by name", () => {
    const state = createState();
    const results = searchConfig(state, "context7");
    expect(results.some((r) => r.type === "mcp" && r.name === "context7")).toBe(true);
  });

  it("returns empty for empty query", () => {
    const state = createState();
    expect(searchConfig(state, "")).toEqual([]);
    expect(searchConfig(state, "   ")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const state = createState();
    const upper = searchConfig(state, "KIMI");
    const lower = searchConfig(state, "kimi");
    expect(upper.length).toBe(lower.length);
  });

  it("returns empty for no match", () => {
    const state = createState();
    expect(searchConfig(state, "zzz_nonexistent")).toEqual([]);
  });
});

describe("kimi-code only configuration", () => {
  it("ignores historical kimi-cli target requests and loads kimi-code paths", async () => {
    const files = createMemoryFs({
      "~/.kimi-code/config.toml": `
profile_label = "Work"
default_model = "test-model"
default_thinking = true
[providers.test]
type = "openai"
base_url = "https://api.test.com"
api_key = "sk-test"
[models.test-model]
provider = "test"
model = "gpt-4"
max_context_size = 8192
`,
    });
    const state = await loadAppState(files);
    expect(state.configTarget).toBe("kimi-code");
    expect(state.configPath).toBe("~/.kimi-code/config.toml");
    expect(state.profilesPath).toBe("");
    expect(state.mcpConfigPath).toBe("~/.kimi-code/mcp.json");
    expect(state.activeProfile).toBe("default");
    expect(state.profiles.default.label).toBe("Work");
    expect(state.profiles.default.default_model).toBe("test-model");
    expect(state.mainConfig.providers.test).toBeDefined();
  });

  it("saves Kimi Code profiles into panel settings", async () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.configPath = "~/.kimi-code/config.toml";
    state.profilesPath = "";
    state.profiles.default.label = "Personal";
    const files = createMemoryFs({});

    await saveAppState(files, state);

    expect(files.store["~/.kimi-code/config.toml"]).toBeDefined();
    expect(files.store["~/.kimi-code/config.profiles.toml"]).toBeUndefined();
    expect(files.store["/tmp/config.panel.toml"]).toContain('label = "Personal"');
  });

  it("ignores persisted historical panel config target", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": 'config_target = "kimi-cli"\n',
      "~/.kimi-code/config.toml": `
default_model = "test-model"
[providers.test]
type = "openai"
base_url = "https://api.test.com"
api_key = "sk-test"
[models.test-model]
provider = "test"
model = "gpt-4"
max_context_size = 8192
`,
    });

    const state = await loadAppState(files);

    expect(state.configTarget).toBe("kimi-code");
    expect(state.configPath).toBe("~/.kimi-code/config.toml");
    expect(state.profilesPath).toBe("");
    expect(state.panelSettings.config_target).toBe("kimi-code");
  });

  it("migrates legacy kimi-code profiles file into panel state", async () => {
    const files = createMemoryFs({
      "~/.kimi-code/config.toml": `
[providers.test]
type = "openai"
base_url = "https://api.test.com"
api_key = "sk-test"
[models.test-model]
provider = "test"
model = "gpt-4"
max_context_size = 8192
`,
      "~/.kimi-code/config.profiles.toml": `
version = 1
active_profile = "work"
[profiles.work]
default_model = "test-model"
default_thinking = false
`,
    });
    const state = await loadAppState(files, { configTarget: "kimi-code" });
    expect(state.configTarget).toBe("kimi-code");
    expect(state.configPath).toBe("~/.kimi-code/config.toml");
    expect(state.profilesPath).toBe("");
    expect(state.mcpConfigPath).toBe("~/.kimi-code/mcp.json");
    expect(state.activeProfile).toBe("work");
    // 旧 default_thinking 迁移为 thinking_enabled
    expect(state.profiles.work.thinking_enabled).toBe(false);
    expect(state.panelSettings.profiles.work.thinking_enabled).toBe(false);
  });

  it("keeps Kimi Code defaults even when historical target is present", () => {
    const state = createState();
    // 模拟历史遗留数据中的 kimi-cli 目标值（当前类型系统只允许 kimi-code）。
    state.configTarget = "kimi-cli" as unknown as ConfigTarget;
    state.configPath = "~/.kimi-code/config.toml";
    state.profilesPath = "~/.kimi-code/config.profiles.toml";
    state.mcpConfigPath = "~/.kimi-code/mcp.json";

    const normalized = normalizeStatePaths(state);

    expect(normalized.configPath).toBe("~/.kimi-code/config.toml");
    expect(normalized.profilesPath).toBe("");
    expect(normalized.mcpConfigPath).toBe("~/.kimi-code/mcp.json");
    expect(normalized.panelSettings.config_path).toBe("~/.kimi-code/config.toml");
    expect(normalized.panelSettings.profiles_path).toBe("");
  });

  it("moves legacy kimi-code defaults into the kimi-code directory", () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.configPath = "~/.kimi/config.toml";
    state.profilesPath = "~/.kimi/config.profiles.toml";
    state.mcpConfigPath = "~/.kimi/mcp.json";

    const normalized = normalizeStatePaths(state);

    expect(normalized.configPath).toBe("~/.kimi-code/config.toml");
    expect(normalized.profilesPath).toBe("");
    expect(normalized.mcpConfigPath).toBe("~/.kimi-code/mcp.json");
  });

  it("keeps custom paths when config target changes", () => {
    const state = createState();
    // 模拟历史遗留数据中的 kimi-cli 目标值（当前类型系统只允许 kimi-code）。
    state.configTarget = "kimi-cli" as unknown as ConfigTarget;
    state.configPath = "/custom/kimi-code/config.toml";
    state.profilesPath = "/custom/kimi-code/config.profiles.toml";
    state.mcpConfigPath = "/custom/kimi-code/mcp.json";
    state.panelSettings.kimi_code_environments = [{
      id: "custom",
      name: "Custom",
      homePath: "/custom/kimi-code",
    }];
    state.panelSettings.active_kimi_code_environment_id = "custom";

    const normalized = normalizeStatePaths(state);

    expect(normalized.configPath).toBe("/custom/kimi-code/config.toml");
    expect(normalized.profilesPath).toBe("");
    expect(normalized.mcpConfigPath).toBe("/custom/kimi-code/mcp.json");
  });

  it("loads config and MCP from the active Kimi Code environment", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
config_target = "kimi-code"
active_kimi_code_environment_id = "work"
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
[[kimi_code_environments]]
id = "work"
name = "Work"
homePath = "~/.kimi-code-work"
`,
      "~/.kimi-code-work/config.toml": `
profile_label = "Work Env"
default_model = "test-model"
[providers.test]
type = "openai"
base_url = "https://api.test.com"
api_key = "sk-test"
[models.test-model]
provider = "test"
model = "gpt-4"
max_context_size = 8192
`,
      "~/.kimi-code-work/mcp.json": buildMcpConfigDocument({
        mcpServers: {
          filesystem: {
            enabled: true,
            transport: "stdio",
            url: "",
            headers: {},
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            env: {},
          },
        },
      }),
    });

    const state = await loadAppState(files);

    expect(state.panelSettings.active_kimi_code_environment_id).toBe("work");
    expect(state.configPath).toBe("~/.kimi-code-work/config.toml");
    expect(state.mcpConfigPath).toBe("~/.kimi-code-work/mcp.json");
    expect(state.profiles.default.label).toBe("Work Env");
    expect(state.mcpConfig.mcpServers.filesystem).toBeDefined();
  });

  it("does not leak legacy global profiles or MCP servers into a new Kimi Code environment", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
config_target = "kimi-code"
active_profile = "old"
active_kimi_code_environment_id = "env-2"
[profiles.old]
label = "Old Env"
default_model = "old-provider/old-model"
default_thinking = true
[mcp_servers.old-server]
transport = "stdio"
command = "old-command"
args = []
env = {}
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
[[kimi_code_environments]]
id = "env-2"
name = "New Env"
homePath = "~/.kimi-code-2"
`,
      "~/.kimi-code-2/config.toml": `
profile_label = "New Env"
default_model = "new-provider/new-model"
[providers.new-provider]
type = "openai"
base_url = "https://api.new.test"
api_key = "sk-new"
[models."new-provider/new-model"]
provider = "new-provider"
model = "new-model"
max_context_size = 8192
`,
    });

    const state = await loadAppState(files);

    expect(Object.keys(state.profiles)).toEqual(["default"]);
    expect(state.profiles.default.label).toBe("New Env");
    expect(state.profiles.default.default_model).toBe("new-provider/new-model");
    expect(state.mcpConfig.mcpServers["old-server"]).toBeUndefined();
  });

  it("loads an empty model configuration for a new Kimi Code environment with empty config", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
config_target = "kimi-code"
active_profile = "old"
active_kimi_code_environment_id = "env-2"
[profiles.old]
label = "Old Env"
default_model = "old-provider/old-model"
default_thinking = true
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
[[kimi_code_environments]]
id = "env-2"
name = "New Env"
homePath = "~/.kimi-code-2"
`,
      "~/.kimi-code-switch-gui/.env/env-2/config.toml": `
profile_label = ""
default_model = ""
models = { }
providers = { }
`,
    });

    const state = await loadAppState(files);

    expect(state.mainConfig.models).toEqual({});
    expect(state.mainConfig.providers).toEqual({});
    expect(state.profiles).toEqual({});
    expect(state.activeProfile).toBe("");
  });

  it("does not resurrect a copied environment snapshot when the official config file is empty", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
config_target = "kimi-code"
active_kimi_code_environment_id = "env-2"
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
[[kimi_code_environments]]
id = "env-2"
name = "Copied Env"
homePath = "~/.kimi-code-2"
[kimi_code_environments.mainConfig]
profile_label = "Copied Profile"
default_model = "copy-provider/copy-model"
default_thinking = true
default_yolo = false
default_plan_mode = false
default_editor = ""
theme = "dark"
show_thinking_stream = false
merge_all_available_skills = false
hooks = []
[kimi_code_environments.mainConfig.providers.copy-provider]
type = "openai"
base_url = "https://api.copy.test"
api_key = "sk-copy"
[kimi_code_environments.mainConfig.models."copy-provider/copy-model"]
provider = "copy-provider"
model = "copy-model"
max_context_size = 8192
capabilities = ["completion"]
`,
      "~/.kimi-code-switch-gui/.env/env-2/config.toml": `
profile_label = ""
default_model = ""
models = { }
providers = { }
`,
    });

    const state = await loadAppState(files);

    expect(state.mainConfig.providers).toEqual({});
    expect(state.mainConfig.models).toEqual({});
    expect(state.profiles).toEqual({});
  });

  it("drops stale empty default profile snapshots from empty Kimi Code environments", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
config_target = "kimi-code"
active_kimi_code_environment_id = "env-2"
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
[[kimi_code_environments]]
id = "env-2"
name = "New Env"
homePath = "~/.kimi-code-2"
activeProfile = "default"
profiles = { default = { label = "Default", default_model = "", default_thinking = true, default_yolo = false, default_plan_mode = false, default_editor = "", theme = "dark", show_thinking_stream = false, merge_all_available_skills = false } }
`,
      "~/.kimi-code-switch-gui/.env/env-2/config.toml": `
profile_label = ""
default_model = ""
models = { }
providers = { }
`,
    });

    const state = await loadAppState(files);

    expect(state.profiles).toEqual({});
    expect(state.activeProfile).toBe("");
  });

  it("keeps legacy GUI profiles but does not resurrect panel-only MCP servers", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
config_target = "kimi-code"
active_profile = "old"
active_kimi_code_environment_id = "default"
[profiles.old]
label = "Old Env"
default_model = "old-provider/old-model"
default_thinking = true
[mcp_servers.old-server]
transport = "stdio"
command = "old-command"
args = []
env = {}
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
`,
      "~/.kimi-code/config.toml": `
[providers.old-provider]
type = "openai"
base_url = "https://api.old.test"
api_key = "sk-old"
[models."old-provider/old-model"]
provider = "old-provider"
model = "old-model"
max_context_size = 8192
`,
    });

    const state = await loadAppState(files);

    expect(state.activeProfile).toBe("old");
    expect(state.profiles.old.label).toBe("Old Env");
    expect(state.mcpConfig.mcpServers["old-server"]).toBeUndefined();
  });

  it("uses the native enabled value from mcp.json instead of the panel snapshot", async () => {
    const files = createMemoryFs({
      "~/.kimi-code-switch-gui/config.panel.toml": `
active_kimi_code_environment_id = "default"
[mcp_servers.shared]
enabled = true
transport = "stdio"
command = "old-command"
args = []
env = {}
[[kimi_code_environments]]
id = "default"
name = "Default"
homePath = "~/.kimi-code"
`,
      "~/.kimi-code/mcp.json": JSON.stringify({
        mcpServers: {
          shared: { command: "new-command", enabled: false },
        },
      }),
    });

    const state = await loadAppState(files);

    expect(state.mcpConfig.mcpServers.shared.command).toBe("new-command");
    expect(state.mcpConfig.mcpServers.shared.enabled).toBe(false);
  });

  it("stores only GUI Profile state in the environment registry", () => {
    const state = createState();
    state.panelSettings.kimi_code_environments = [
      {
        id: "default",
        name: "Default",
        homePath: "~/.kimi-code",
      },
      {
        id: "work",
        name: "Work",
        homePath: "~/.kimi-code-work",
      },
    ];
    state.panelSettings.active_kimi_code_environment_id = "work";

    const normalized = normalizeStatePaths(state);
    const workEnvironment = normalized.panelSettings.kimi_code_environments?.find((environment) => environment.id === "work");

    expect(workEnvironment?.profiles?.default.default_model).toBe("kimi_gateway/kimi-k2.5");
    expect(workEnvironment?.mainConfig).toBeUndefined();
    expect(workEnvironment?.activeProfile).toBe("default");
    expect(workEnvironment?.mcpServers).toBeUndefined();
    expect(normalized.panelSettings.profiles.default.default_model).toBe("kimi_gateway/kimi-k2.5");
  });

  it("does not create a kimi-code profiles file when saving", async () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.configPath = "~/.kimi-code/config.toml";
    state.profilesPath = "~/.kimi-code/config.profiles.toml";
    const files = createMemoryFs({});
    await saveAppState(files, state);
    expect(files.store["~/.kimi-code/config.toml"]).toBeDefined();
    expect(files.store["~/.kimi-code/config.profiles.toml"]).toBeUndefined();
    expect(files.store["/tmp/config.panel.toml"]).toContain("active_profile");
  });

  it("migrates legacy dead profile keys into tui/thinking fields via loadAppState", async () => {
    const files = createMemoryFs({
      "~/.kimi-code/config.toml": `
default_model = "test-model"
[providers.test]
type = "openai"
base_url = "https://api.test.com"
api_key = "sk-test"
[models.test-model]
provider = "test"
model = "gpt-4"
max_context_size = 8192
[thinking]
enabled = true
`,
      "~/.kimi-code/config.profiles.toml": `
version = 1
active_profile = "work"
[profiles.work]
label = "Work"
default_model = "test-model"
default_thinking = true
default_yolo = false
default_plan_mode = false
default_editor = "vim"
theme = "dark"
show_thinking_stream = false
merge_all_available_skills = false
`,
    });

    const state = await loadAppState(files, { configTarget: "kimi-code" });
    const profile = state.profiles.work;
    // 旧死键访问需类型透明（新版 schema 已删除这些字段），断言其被迁移后为 undefined
    const legacyProfile = profile as Profile & Record<string, unknown>;

    // 旧死键迁移为新字段
    expect(legacyProfile.theme).toBeUndefined();
    expect(profile.tui_theme).toBe("dark");
    expect(legacyProfile.default_editor).toBeUndefined();
    expect(profile.tui_editor_command).toBe("vim");
    expect(legacyProfile.default_yolo).toBeUndefined();
    expect(profile.default_permission_mode).toBe("manual");
    expect(legacyProfile.show_thinking_stream).toBeUndefined();
    expect(legacyProfile.default_thinking).toBeUndefined();
    // default_thinking -> thinking_enabled（旧键布尔进 profile 的 thinking_enabled）
    expect(profile.thinking_enabled).toBe(true);

    // 顶层 [thinking] 经透传进 mainConfig.extra，不写回 profile 字段
    expect((state.mainConfig.extra as Record<string, unknown>).thinking).toEqual({ enabled: true });
    // show_thinking_stream 这类死键不进 mainConfig 顶层、也不进 extra
    const legacyMainConfig = state.mainConfig as MainConfig & Record<string, unknown>;
    expect(legacyMainConfig.show_thinking_stream).toBeUndefined();
    expect(legacyMainConfig.theme).toBeUndefined();
    expect(legacyMainConfig.default_editor).toBeUndefined();
  });

  it("writes tui.toml next to the active environment config when a profile is explicitly applied", async () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.configPath = "~/.kimi-code/config.toml";
    state.profilesPath = "";
    state.profiles.default = {
      ...state.profiles.default,
      tui_theme: "dark",
      tui_editor_command: "nvim",
    };
    state.activeProfile = "default";
    applyProfile(state, "default");
    const files = createMemoryFs({});

    await saveAppState(files, state);

    const tuiPath = getKimiCodeTuiConfigPath("~/.kimi-code");
    const document = files.store[tuiPath];
    expect(document).toBeDefined();
    expect(document).toContain('theme = "dark"');
    expect(document).toContain("[editor]");
    expect(document).toContain('command = "nvim"');
    // tui.toml 可解析回同值
    expect(parseTuiConfigDocument(document)).toEqual({
      theme: "dark",
      editorCommand: "nvim",
    });
  });

  it("skips writing tui.toml when the active profile sets no tui fields (no overwrite of unrelated sections)", async () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.configPath = "~/.kimi-code/config.toml";
    state.profilesPath = "";
    const files = createMemoryFs({
      "~/.kimi-code/tui.toml": `[notifications]\nenabled = false\n[upgrade]\nauto_install = true\n`,
    });

    await saveAppState(files, state);

    const tuiPath = getKimiCodeTuiConfigPath("~/.kimi-code");
    // 未传播 tui 字段时不写，保留用户原文档
    expect(files.store[tuiPath]).toBeDefined();
    expect(files.store[tuiPath]).toContain("[notifications]");
    expect(files.store[tuiPath]).toContain("[upgrade]");
  });

  it("merges GUI tui fields into an existing tui.toml, preserving unrelated sections", async () => {
    const state = createState();
    state.configTarget = "kimi-code";
    state.configPath = "~/.kimi-code/config.toml";
    state.profilesPath = "";
    state.profiles.default = {
      ...state.profiles.default,
      tui_theme: "dark",
    };
    state.activeProfile = "default";
    applyProfile(state, "default");
    const existingTui = `disable_paste_burst = true\n\n[notifications]\nenabled = false\nnotification_condition = "always"\n\n[upgrade]\nauto_install = true\n`;
    const files = createMemoryFs({
      "~/.kimi-code/tui.toml": existingTui,
    });

    await saveAppState(files, state);

    const tuiPath = getKimiCodeTuiConfigPath("~/.kimi-code");
    const document = files.store[tuiPath];
    expect(document).toContain('theme = "dark"');
    // 无关 section 原样保留
    expect(document).toContain("disable_paste_burst = true");
    expect(document).toContain("enabled = false");
    expect(document).toContain('notification_condition = "always"');
    expect(document).toContain("auto_install = true");
  });

  it("persists advanced TUI fields from AppState while preserving unknown keys", async () => {
    const state = createState();
    state.configPath = "~/.kimi-code/config.toml";
    state.profiles.default = {
      ...state.profiles.default,
      tui_theme: undefined,
      tui_editor_command: undefined,
    };
    state.tuiConfig = {
      renderLatex: false,
      cacheExpiryHint: false,
      notificationsEnabled: true,
      notificationCondition: "always",
      upgradeAutoInstall: false,
      disable_paste_burst: true,
      statusLine: { items: ["model", "cwd"], command: "status.sh" },
    };
    const tuiPath = getKimiCodeTuiConfigPath("~/.kimi-code");
    const files = createMemoryFs({ [tuiPath]: 'unknown_top = "keep"\n' });

    await saveAppState(files, state);

    expect(files.store[tuiPath]).toContain('unknown_top = "keep"');
    expect(parseTuiConfigDocument(files.store[tuiPath])).toMatchObject(state.tuiConfig);
  });

  it("preserves TUI values when the active Profile does not manage them", async () => {
    const state = createState();
    state.configPath = "~/.kimi-code/config.toml";
    state.profiles.default = {
      ...state.profiles.default,
      tui_theme: undefined,
      tui_editor_command: undefined,
    };
    const tuiPath = getKimiCodeTuiConfigPath("~/.kimi-code");
    const files = createMemoryFs({
      [tuiPath]: 'theme = "dark"\n\n[editor]\ncommand = "vim"\n\n[notifications]\nenabled = false\n',
    });

    await saveAppState(files, state);

    expect(files.store[tuiPath]).toContain('theme = "dark"');
    expect(files.store[tuiPath]).toContain('command = "vim"');
    expect(files.store[tuiPath]).toContain("[notifications]");
    expect(files.store[tuiPath]).toContain("enabled = false");
  });

  it("does not overwrite an invalid existing tui.toml", async () => {
    const state = createState();
    state.configPath = "~/.kimi-code/config.toml";
    state.profiles.default = {
      ...state.profiles.default,
      tui_theme: "light",
    };
    const tuiPath = getKimiCodeTuiConfigPath("~/.kimi-code");
    const invalidDocument = 'theme = \n[notifications]\nenabled = false\n';
    const files = createMemoryFs({ [tuiPath]: invalidDocument });

    await saveAppState(files, state);

    expect(files.store[tuiPath]).toBe(invalidDocument);
    expect(files.writes).not.toContain(tuiPath);
  });

  it("persists configTarget in panelSettings", () => {
    const settings = createDefaultPanelSettings("/tmp/config.toml", "/tmp/panel.toml");

    const doc = buildPanelSettingsDocument(settings);
    expect(doc).toContain('config_target = "kimi-code"');
  });
});

describe("migrateLegacyKimiCliConfigToKimiCode", () => {
  const defaultHome = defaultKimiCodeHomePath();
  const defaultConfigPath = getKimiCodeConfigPath(defaultHome);
  const defaultMcpPath = getKimiCodeMcpConfigPath(defaultHome);
  const LEGACY_CONFIG = "~/.kimi/config.toml";
  const MARKER = "~/.kimi-code-switch/legacy-kimi-cli-config.migrated.json";

  it("migrates legacy config into the official default ~/.kimi-code directory", async () => {
    const files = createMemoryFs({
      [LEGACY_CONFIG]: 'default_model = "kimi/k2"\n[providers.kimi]\ntype = "kimi"\n',
    });

    const result = await migrateLegacyKimiCliConfigToKimiCode(files);

    expect(result.migrated).toBe(true);
    expect(result.configMerged).toBe(true);
    // ~/.kimi-code 现在就是官方默认环境的真实目录，不再由面板改造成软链。
    expect(files.store[defaultConfigPath]).toBeTruthy();
    expect(files.store[defaultConfigPath]).toContain("kimi/k2");
  });

  it("is idempotent: a second run does nothing once the marker exists", async () => {
    const files = createMemoryFs({
      [LEGACY_CONFIG]: 'default_model = "kimi/k2"\n',
    });
    await migrateLegacyKimiCliConfigToKimiCode(files);
    expect(files.store[MARKER]).toBeTruthy();

    const second = await migrateLegacyKimiCliConfigToKimiCode(files);
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe("already-migrated");
  });

  it("records a marker and skips when there is no legacy config", async () => {
    const files = createMemoryFs({});
    const result = await migrateLegacyKimiCliConfigToKimiCode(files);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("legacy-config-missing");
    expect(files.store[MARKER]).toBeTruthy();
  });

  it("merges legacy MCP servers into the default environment mcp.json", async () => {
    const files = createMemoryFs({
      [LEGACY_CONFIG]: 'default_model = "kimi/k2"\n',
      "~/.kimi/mcp.json": JSON.stringify({ mcpServers: { ctx: { url: "https://ctx.test/mcp" } } }),
    });

    const result = await migrateLegacyKimiCliConfigToKimiCode(files);

    expect(result.mcpMerged).toBe(true);
    expect(files.store[defaultMcpPath]).toBeTruthy();
    expect(files.store[defaultMcpPath]).toContain("ctx.test/mcp");
  });

  it("migrates a legacy MCP-only installation into the official default home", async () => {
    const files = createMemoryFs({
      "~/.kimi/mcp.json": JSON.stringify({ mcpServers: { ctx: { url: "https://ctx.test/mcp" } } }),
    });

    const result = await migrateLegacyKimiCliConfigToKimiCode(files);

    expect(result).toMatchObject({ migrated: true, configMerged: false, mcpMerged: true });
    expect(files.store[defaultMcpPath]).toContain("ctx.test/mcp");
  });

  it("falls back to legacy config.mcp.json when mcp.json is only an empty placeholder", async () => {
    const files = createMemoryFs({
      "~/.kimi/mcp.json": "  \n",
      "~/.kimi/config.mcp.json": JSON.stringify({
        mcpServers: { fallback: { url: "https://fallback.test/mcp" } },
      }),
    });

    const result = await migrateLegacyKimiCliConfigToKimiCode(files);

    expect(result.mcpMerged).toBe(true);
    expect(files.store[defaultMcpPath]).toContain("fallback.test/mcp");
  });
});

describe("migrateLegacyManagedDefaultEnvironmentToNativeHome", () => {
  const legacyHome = "~/.kimi-code-switch-gui/.env/default";
  const nativeHome = defaultKimiCodeHomePath();

  it("moves retired default-environment configuration into the native home without overwriting native values", async () => {
    const mergedDirectories: Array<[string, string]> = [];
    const files = {
      ...createMemoryFs({
        [`${legacyHome}/config.toml`]: `
default_model = "legacy/model"
[providers.legacy]
type = "openai"
base_url = "https://legacy.example.test"
api_key = "legacy-secret"
[models."legacy/model"]
provider = "legacy"
model = "legacy-model"
max_context_size = 8192
[thinking]
effort = "high"
[unmanaged_extension]
keep = "legacy-value"
`,
        [`${legacyHome}/mcp.json`]: JSON.stringify({
          mcpServers: { legacy: { transport: "streamable-http", url: "https://legacy.example.test/mcp" } },
        }),
        [`${legacyHome}/tui.toml`]: 'theme = "dark"\n',
        [`${legacyHome}/AGENTS.md`]: "legacy instructions\n",
        [`${legacyHome}/plugins/installed.json`]: JSON.stringify({
          plugins: [{ id: "legacy-plugin", root: `${legacyHome}/plugins/managed/legacy-plugin` }],
        }),
        [`${nativeHome}/config.toml`]: `
default_model = "native/model"
[providers.native]
type = "openai"
base_url = "https://native.example.test"
api_key = "native-secret"
[thinking]
enabled = true
`,
        [`${nativeHome}/mcp.json`]: JSON.stringify({
          mcpServers: { native: { transport: "streamable-http", url: "https://native.example.test/mcp" } },
        }),
      }),
      async mergeDirectoryMissing(from: string, to: string) {
        mergedDirectories.push([from, to]);
        return { sourceExists: true, copiedEntries: 1, skippedConflicts: 0 };
      },
    };

    const result = await migrateLegacyManagedDefaultEnvironmentToNativeHome(files);

    expect(result).toMatchObject({
      migrated: true,
      configMerged: true,
      mcpMerged: true,
      tuiMerged: true,
      agentsCopied: true,
      skillsCopied: true,
      pluginsMerged: true,
    });
    expect(files.store[`${nativeHome}/config.toml`]).toContain('default_model = "native/model"');
    expect(files.store[`${nativeHome}/config.toml`]).toContain("[providers.legacy]");
    expect(files.store[`${nativeHome}/config.toml`]).toContain("enabled = true");
    expect(files.store[`${nativeHome}/config.toml`]).toContain('effort = "high"');
    expect(files.store[`${nativeHome}/config.toml`]).toContain("[unmanaged_extension]");
    expect(files.store[`${nativeHome}/mcp.json`]).toContain("native.example.test/mcp");
    expect(files.store[`${nativeHome}/mcp.json`]).toContain("legacy.example.test/mcp");
    expect(files.store[`${nativeHome}/tui.toml`]).toContain('theme = "dark"');
    expect(files.store[`${nativeHome}/AGENTS.md`]).toBe("legacy instructions\n");
    expect(files.store[`${nativeHome}/plugins/installed.json`]).toContain(`${nativeHome}/plugins/managed/legacy-plugin`);
    expect(mergedDirectories).toEqual([
      [`${legacyHome}/skills`, `${nativeHome}/skills`],
      [`${legacyHome}/plugins`, `${nativeHome}/plugins`],
    ]);
  });

  it("reports legacy-environment-missing when the legacy home has no recoverable content", async () => {
    const files = createMemoryFs({});
    const result = await migrateLegacyManagedDefaultEnvironmentToNativeHome(files);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("legacy-environment-missing");
  });
});

describe("repairLegacyManagedDefaultHomeSymlink", () => {
  const legacyHome = "~/.kimi-code-switch-gui/.env/default";
  const nativeHome = defaultKimiCodeHomePath();

  it("remaps plugin roots after materializing the native home", async () => {
    const files = {
      ...createMemoryFs({
        ["/Users/test/.kimi-code/plugins/installed.json"]: JSON.stringify({
          plugins: [
            { id: "kimi-cu", root: `${legacyHome}/plugins/managed/kimi-cu` },
            { id: "kimi-datasource", root: `/Users/test/.kimi-code-switch-gui/.env/default/plugins/managed/kimi-datasource` },
            { id: "foreign", root: `/other/place/plugins/managed/foreign` },
          ],
        }),
      }),
      async repairNativeHomeSymlink() {
        return {
          repaired: true,
          reason: "symlink-materialized",
          skillsMaterialized: [
            { name: "ask-matt", copied: true, reason: "" },
            { name: "ghost", copied: false, reason: "broken-target" },
          ],
        };
      },
    };

    const result = await repairLegacyManagedDefaultHomeSymlink(files, "/Users/test/.kimi-code");

    expect(result).toMatchObject({
      repaired: true,
      reason: "symlink-materialized",
      skillsMaterialized: 1,
      pluginsRemapped: true,
    });
    expect(result.skillIssues).toEqual(["ghost: broken-target"]);
    const remapped = JSON.parse(files.store["/Users/test/.kimi-code/plugins/installed.json"]);
    expect(remapped.plugins[0].root).toBe("/Users/test/.kimi-code/plugins/managed/kimi-cu");
    expect(remapped.plugins[1].root).toBe("/Users/test/.kimi-code/plugins/managed/kimi-datasource");
    // 其他 home 的插件根不得被误改写（严格前缀匹配，不用 inferred-suffix 兜底）。
    expect(remapped.plugins[2].root).toBe("/other/place/plugins/managed/foreign");
  });

  it("passes through not-repaired without touching plugin roots", async () => {
    const files = {
      ...createMemoryFs({}),
      async repairNativeHomeSymlink() {
        return { repaired: false, reason: "not-a-symlink", skillsMaterialized: [] };
      },
    };
    const result = await repairLegacyManagedDefaultHomeSymlink(files);
    expect(result).toMatchObject({ repaired: false, reason: "not-a-symlink", pluginsRemapped: false });
  });

  it("is a no-op when the FileAccess does not support symlink repair", async () => {
    const files = createMemoryFs({});
    const result = await repairLegacyManagedDefaultHomeSymlink(files);
    expect(result).toMatchObject({ repaired: false, reason: "unsupported", pluginsRemapped: false });
  });
});

describe("full backup", () => {
  it("buildFullBackup captures active env from state with real secrets", () => {
    const state = createState();
    const bundle = buildFullBackup(state, {});
    expect(bundle.kind).toBe("full-backup");
    expect(bundle.environments.length).toBeGreaterThan(0);
    const active = bundle.environments.find((e) => e.environment.id === bundle.activeEnvironmentId);
    expect(active?.providers.kimi_gateway.api_key).toBe("sk-test");
  });

  it("buildFullBackup uses each environment's native files without an env-config cache", () => {
    const state = createState();
    state.panelSettings.kimi_code_environments = [
      ...(state.panelSettings.kimi_code_environments ?? []),
      { id: "work", name: "Work", homePath: getKimiCodeEnvironmentHomePath("work") },
    ];
    const bundle = buildFullBackup(state, {
      work: {
        mainConfig: {
          ...createState().mainConfig,
          providers: { work_prov: { type: "openai", base_url: "https://work.example.test", api_key: "work-secret" } },
          models: {},
        },
        mcpServers: {
          work_mcp: {
            enabled: true,
            transport: "stdio",
            url: "",
            headers: {},
            command: "work-mcp",
            args: [],
            env: {},
          },
        },
      },
    });

    const work = bundle.environments.find((environment) => environment.environment.id === "work");
    expect(work?.providers.work_prov.api_key).toBe("work-secret");
    expect(work?.mcpServers.work_mcp.command).toBe("work-mcp");
  });

  it("buildFullBackup does not resurrect deprecated panel config snapshots", () => {
    const state = createState();
    // work 环境只有面板快照（mainConfig），DB 中无记录（模拟旧版复制环境的遗留数据）
    state.panelSettings.kimi_code_environments = [
      ...(state.panelSettings.kimi_code_environments ?? []),
      {
        id: "work",
        name: "Work",
        homePath: getKimiCodeEnvironmentHomePath("work"),
        mainConfig: {
          ...createState().mainConfig,
          providers: { snap_prov: { type: "kimi", base_url: "https://s", api_key: "sk", enabled: true } },
          models: { "snap_prov/m": { provider: "snap_prov", model: "m", max_context_size: 1, capabilities: [], enabled: true } },
        },
        // enabled 字段是旧版面板快照的遗留数据，当前契约已不含该字段。
      } as unknown as KimiCodeEnvironment,
    ];
    const bundle = buildFullBackup(state, {}); // DB 为空
    const work = bundle.environments.find((e) => e.environment.id === "work");
    expect(work?.providers).toEqual({});
    expect(work?.models).toEqual({});
  });

  it("validateFullBackup accepts a built bundle and rejects junk", () => {
    const state = createState();
    const bundle = buildFullBackup(state, {});
    expect(validateFullBackup(bundle).valid).toBe(true);
    expect(validateFullBackup({ version: 1 }).valid).toBe(false);
    expect(validateFullBackup("nope").valid).toBe(false);
    const duplicate = structuredClone(bundle);
    duplicate.environments.push(structuredClone(duplicate.environments[0]));
    expect(validateFullBackup(duplicate).valid).toBe(false);
  });

  it("assessFullBackupRisk surfaces executable MCP and network endpoints", () => {
    const state = createState();
    const bundle = buildFullBackup(state, {});
    bundle.environments[0].mainConfig!.hooks = [{ event: "beforeTool", command: "check.sh" }];
    bundle.environments[0].agentsDocument = "# Imported instructions";
    bundle.environments[0].skillsDirectory = {
      exists: true,
      directories: ["deploy"],
      files: [
        { relativePath: "deploy/run.sh", contentBase64: "", executable: true },
        { relativePath: "deploy/SKILL.md", contentBase64: "", executable: false },
      ],
    };
    bundle.environments[0].pluginsDirectory = {
      exists: true,
      directories: ["managed/demo"],
      files: [
        {
          relativePath: "installed.json",
          contentBase64: btoa(JSON.stringify({ plugins: [{ id: "demo", source: "https://github.com/example/demo" }] })),
          executable: false,
        },
        {
          relativePath: "managed/demo/kimi.plugin.json",
          contentBase64: btoa(JSON.stringify({ name: "demo", hooks: [{}], mcpServers: { tool: {} } })),
          executable: false,
        },
        { relativePath: "managed/demo/run.sh", contentBase64: "", executable: true },
      ],
    };
    const risk = assessFullBackupRisk(bundle);
    expect(risk.stdioMcpCommands.some((item) => item.includes("chrome_devtools"))).toBe(true);
    expect(risk.remoteMcpEndpoints.some((item) => item.includes("context7"))).toBe(true);
    expect(risk.providerEndpoints.some((item) => item.includes("kimi_gateway"))).toBe(true);
    expect(risk.configHooks).toHaveLength(1);
    expect(risk.agentsDocuments).toHaveLength(1);
    expect(risk.executableSkillFiles).toEqual(["default/skills/deploy/run.sh"]);
    expect(risk.skillDocumentsAndScripts).toEqual(["default/skills/deploy/SKILL.md"]);
    expect(risk.pluginDirectories).toEqual(["default/plugins (3 files)"]);
    expect(risk.pluginExecutableFiles).toEqual(["default/plugins/managed/demo/run.sh"]);
    expect(risk.pluginCapabilities).toEqual(expect.arrayContaining([
      expect.stringContaining("installed from https://github.com/example/demo"),
      expect.stringContaining("1 hooks, 1 MCP servers"),
    ]));
  });

  it("isFullBackupBundle discriminates", () => {
    const state = createState();
    expect(isFullBackupBundle(buildFullBackup(state, {}))).toBe(true);
    expect(isFullBackupBundle(exportConfig(state))).toBe(false);
  });

  it("rebuildPanelSettingsFromBackup restores environment list + active id", () => {
    const state = createState();
    const bundle = buildFullBackup(state, {});
    const panel = rebuildPanelSettingsFromBackup(bundle);
    expect(panel.active_kimi_code_environment_id).toBe(bundle.activeEnvironmentId);
    expect(panel.kimi_code_environments?.length).toBe(bundle.environments.length);
  });

  it("fullBackupContainsRedactedSecrets detects masked keys", () => {
    const state = createState();
    const bundle = buildFullBackup(state, {});
    expect(fullBackupContainsRedactedSecrets(bundle)).toBe(false);
    bundle.environments[0].providers.kimi_gateway.api_key = "[REDACTED]";
    expect(fullBackupContainsRedactedSecrets(bundle)).toBe(true);
    bundle.environments[0].providers.kimi_gateway.api_key = "real";
    bundle.environments[0].mcpServers.context7.headers.Authorization = "[REDACTED]";
    expect(fullBackupContainsRedactedSecrets(bundle)).toBe(true);
  });
});

describe("buildConfigDocument native source of truth", () => {
  it("writes every provider and model definition directly without GUI-only enabled state", () => {
    const state = createState();
    const doc = buildConfigDocument(state);
    expect(doc).toContain("[providers.kimi_gateway]");
    expect(doc).toContain('[models."kimi_gateway/kimi-k2.5"]');
    expect(doc).not.toMatch(/^enabled\s*=/m);
  });

  it("draft document matches what saveAppState writes to disk (no spurious diff)", async () => {
    const state = createState();
    const files = createMemoryFs({});
    await saveAppState(files as never, state);
    const normalized = normalizeStatePaths(state);
    const onDisk = files.store[normalized.configPath];
    const draft = buildConfigDocument(normalized);
    expect(draft).toBe(onDisk);
  });
});
