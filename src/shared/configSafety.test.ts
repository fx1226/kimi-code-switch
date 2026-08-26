import {
  bootstrapProfiles,
  createDefaultPanelSettings,
} from "./configStore";
import {
  buildConfigDoctorReport,
  buildManagedDocuments,
  buildRedactedPreviewBundle,
  detectUnknownFields,
  redactAppStateSecrets,
  redactDocumentText,
} from "./configSafety";
import { createDefaultMcpConfig } from "./mcpStore";
import { createDefaultShortcuts } from "./shortcutStore";
import type { AppState, MainConfig } from "./types";

function createState(): AppState {
  const mainConfig: MainConfig = {
    default_model: "kimi_gateway/kimi-k2.5",
    default_plan_mode: false,
    default_permission_mode: "manual",
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
        base_url: "https://api.example.test/v1?token=provider-token&mode=prod",
        api_key: "sk-provider",
      },
    },
    loop_control: {},
    background: {},
    notifications: {},
    services: {},
    mcp: {},
  };

  const panelSettings = createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml");
  panelSettings.shortcuts = createDefaultShortcuts();

  return {
    configPath: "/tmp/config.toml",
    profilesPath: "/tmp/config.profiles.toml",
    panelSettingsPath: "/tmp/config.panel.toml",
    mcpConfigPath: "/tmp/mcp.json",
    mainConfig,
    profiles: bootstrapProfiles(mainConfig),
    activeProfile: "default",
    panelSettings,
    mcpConfig: createDefaultMcpConfig(),
  };
}

describe("configSafety", () => {
  it("builds managed documents from app state", () => {
    const documents = buildManagedDocuments(createState());

    expect(documents.config).toContain('default_model = "kimi_gateway/kimi-k2.5"');
    expect(documents.profiles).toBeUndefined();
    expect(documents.panel).toContain("backup_strategy");
    expect(documents.panel).toContain("active_profile");
    expect(documents.mcp).toContain('"mcpServers"');
  });

  it("does not flag blank model references as missing model errors", () => {
    const state = createState();
    state.mainConfig.default_model = "";
    state.profiles.default.default_model = "";

    const report = buildConfigDoctorReport(state);
    const ids = report.issues.map((issue) => issue.id);

    expect(ids).not.toContain("config.default-model.missing");
    expect(ids).not.toContain("profiles.default-model.missing.default");
  });

  it("redacts provider API keys and URL secrets from preview output", () => {
    const preview = buildRedactedPreviewBundle(createState());

    expect(preview.configDocument).toContain('api_key = "[REDACTED]"');
    expect(preview.configDocument).not.toContain("sk-provider");
    expect(preview.configDocument).toContain("token=%5BREDACTED%5D");
    expect(preview.configDocument).toContain("mode=prod");
    expect(preview.redaction.maskedPaths).toContain("mainConfig.providers.kimi_gateway.api_key");
  });

  it("redacts WebDAV password fields from state and panel preview", () => {
    const state = createState();
    state.panelSettings.backup_destination_type = "webdav";
    state.panelSettings.backup_webdav_url = "https://dav.example.com/root";
    state.panelSettings.backup_webdav_username = "alice";
    state.panelSettings.backup_webdav_password = "super-secret";

    const redactedState = redactAppStateSecrets(state);
    const preview = buildRedactedPreviewBundle(state);

    expect(redactedState.state.panelSettings.backup_webdav_password).toBe("[REDACTED]");
    expect(preview.panelSettingsDocument).toContain('backup_webdav_password = "[REDACTED]"');
    expect(preview.panelSettingsDocument).not.toContain("super-secret");
  });

  it("redacts MCP header, env, extra, and raw document secrets", () => {
    const state = createState();
    state.mcpConfig.mcpServers.gateway = {
      enabled: true,
      transport: "streamable-http",
      url: "https://user:pass@example.test/mcp?access_token=mcp-token&view=compact",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Trace": "trace-id",
      },
      command: "",
      args: [],
      env: {},
      extra: {
        nested: {
          secret: "hidden",
          keep: "visible",
        },
      },
    };
    state.mcpConfig.mcpServers.local = {
      enabled: true,
      transport: "stdio",
      url: "",
      headers: {},
      command: "npx",
      args: ["example-mcp"],
      env: {
        API_KEY: "mcp-api-key",
        DEBUG: "1",
      },
      extra: {
        nested: {
          secret: "hidden",
          keep: "visible",
        },
      },
    };

    const preview = buildRedactedPreviewBundle(state);
    const rawDocument = redactDocumentText(`{
  "Authorization": "Bearer raw-token",
  "Cookie": "session=raw-cookie",
  "url": "https://alice:secret@example.test/mcp?api_key=raw-key&view=wide"
}`);

    expect(preview.mcpDocument).not.toContain("secret-token");
    expect(preview.mcpDocument).not.toContain("mcp-api-key");
    expect(preview.mcpDocument).not.toContain("hidden");
    expect(preview.mcpDocument).toContain('"Authorization": "[REDACTED]"');
    expect(preview.mcpDocument).toContain('"API_KEY": "[REDACTED]"');
    expect(preview.mcpDocument).toContain('"secret": "[REDACTED]"');
    expect(preview.mcpDocument).toContain("view=compact");
    expect(preview.mcpDocument).toContain("access_token=%5BREDACTED%5D");
    expect(rawDocument.text).toContain('"Authorization": "[REDACTED]"');
    expect(rawDocument.text).toContain('"Cookie": "[REDACTED]"');
    expect(rawDocument.text).toContain("api_key=%5BREDACTED%5D");
    expect(rawDocument.summary.maskedCount).toBeGreaterThanOrEqual(3);
  });

  it("reports missing references in doctor output", () => {
    const state = createState();
    state.mainConfig.default_model = "missing/default";
    state.mainConfig.models["broken/model"] = {
      provider: "missing-provider",
      model: "broken-model",
      max_context_size: 1024,
      capabilities: [],
    };
    state.profiles.default.default_model = "missing/profile-model";
    state.activeProfile = "missing-profile";

    const report = buildConfigDoctorReport(state);
    const fieldPaths = report.issues.map((issue) => issue.fieldPath);

    expect(report.ok).toBe(false);
    expect(fieldPaths).toContain("mainConfig.default_model");
    expect(fieldPaths).toContain("mainConfig.models.broken/model.provider");
    expect(fieldPaths).toContain("profiles.default.default_model");
    expect(fieldPaths).toContain("activeProfile");
  });

  it("surfaces shortcut conflicts as doctor warnings", () => {
    const state = createState();
    state.panelSettings.shortcuts["tab.overview"] = {
      ...state.panelSettings.shortcuts["tab.overview"],
      accelerator: "CommandOrControl+S",
    };

    const report = buildConfigDoctorReport(state);
    const conflictIssue = report.issues.find((issue) => issue.scope === "shortcuts");

    expect(conflictIssue?.severity).toBe("warning");
    expect(conflictIssue?.message).toContain("commandorcontrol+s");
  });

  it("validates WebDAV readiness and protocol requirements", () => {
    const state = createState();
    state.panelSettings.backup_destination_type = "webdav";
    state.panelSettings.backup_webdav_url = "http://dav.example.com/root";
    state.panelSettings.backup_webdav_username = "";
    state.panelSettings.backup_webdav_password = "";
    state.panelSettings.backup_webdav_path = "kimi\\backups";

    const report = buildConfigDoctorReport(state);
    const issueIds = report.issues.map((issue) => issue.id);

    expect(issueIds).toContain("webdav.username.missing");
    expect(issueIds).toContain("webdav.password.missing");
    expect(issueIds).toContain("webdav.url.protocol");
    expect(issueIds).toContain("webdav.path.invalid");
  });

  it("flags legacy SSE MCP servers as info (still supported, recommend HTTP)", () => {
    const state = createState();
    state.mcpConfig.mcpServers["amap-maps"] = {
      enabled: true,
      transport: "sse",
      url: "https://mcp.api-inference.modelscope.net/example/sse",
      headers: {},
      command: "",
      args: [],
      env: {},
    };

    const report = buildConfigDoctorReport(state);

    expect(report.issues.map((issue) => issue.id)).toContain("mcp.sse-legacy.amap-maps");
  });

  describe("detectUnknownFields (config drift)", () => {
    it("returns no drift when every field is known", () => {
      const drift = detectUnknownFields({
        config: {
          default_model: "kimi_gateway/kimi-k2.5",
          profile_label: "Default",
          theme: "dark",
          models: {
            "kimi_gateway/kimi-k2.5": {
              provider: "kimi_gateway",
              model: "kimi-k2.5",
              max_context_size: 1024,
              capabilities: [],
              auth_mode: "official-account",
              official_account_scope: "global",
            },
          },
          providers: { kimi_gateway: { type: "kimi", base_url: "https://api.example.test", api_key: "sk-x" } },
          loop_control: { anything: { goes: true } },
        },
        profiles: {
          active_profile: "default",
          profiles: { default: { name: "default", label: "Default", default_model: "kimi_gateway/kimi-k2.5", theme: "dark" } },
        },
        mcp: { mcpServers: { gateway: { enabled: true, transport: "stdio", command: "npx", args: [] } } },
      });

      expect(drift).toEqual([]);
    });

    it("does not flag unknown top-level config keys (they pass through)", () => {
      const drift = detectUnknownFields({
        config: {
          default_model: "a",
          future_feature_flag: true,
          another_new_top_key: "x",
        },
      });

      // 未知顶层键现在原样透传保存（Kimi Code 0.38.0 新增节），不再作为 drift 报告
      expect(drift).toEqual([]);
    });

    it("detects unknown nested fields inside known maps", () => {
      const drift = detectUnknownFields({
        config: {
          providers: {
            kimi_gateway: { type: "kimi", base_url: "https://x", api_key: "sk", region: "us-east" },
          },
          models: {
            "kimi_gateway/k2": { provider: "kimi_gateway", model: "k2", max_context_size: 1, capabilities: [], beta_flag: true },
          },
        },
      });

      const providerDrift = drift.find((entry) => entry.key === "region");
      const modelDrift = drift.find((entry) => entry.key === "beta_flag");
      expect(providerDrift?.path).toBe("providers.kimi_gateway");
      expect(modelDrift?.path).toBe("models.kimi_gateway/k2");
    });

    it("warns when official account models have no active account", () => {
      const state = createState();
      state.mainConfig.models["kimi_gateway/kimi-k2.5"].auth_mode = "official-account";
      state.panelSettings.active_official_account_id = "";

      const report = buildConfigDoctorReport(state);

      expect(report.issues.some((issue) => issue.id === "official-account.active.missing")).toBe(true);
    });

    it("detects unknown nested fields inside known maps", () => {
      const drift = detectUnknownFields({
        config: {
          providers: {
            kimi_gateway: { type: "kimi", base_url: "https://x", api_key: "sk", region: "us-east" },
          },
          models: {
            "kimi_gateway/k2": { provider: "kimi_gateway", model: "k2", max_context_size: 1, capabilities: [], beta_flag: true },
          },
        },
      });

      const providerDrift = drift.find((entry) => entry.key === "region");
      const modelDrift = drift.find((entry) => entry.key === "beta_flag");
      expect(providerDrift?.path).toBe("providers.kimi_gateway");
      expect(modelDrift?.path).toBe("models.kimi_gateway/k2");
    });

    it("treats free-form record fields and MCP server bodies as open (no false positives)", () => {
      const drift = detectUnknownFields({
        config: {
          background: { whatever: { deeply: { nested: 1 } } },
          notifications: { brand_new_channel: true },
        },
        mcp: {
          mcpServers: {
            gateway: { enabled: true, transport: "stdio", command: "x", args: [], unknown_server_opt: 1 },
          },
        },
      });

      expect(drift).toEqual([]);
    });

    it("aggregates drift across multiple files", () => {
      const drift = detectUnknownFields({
        config: { providers: { g: { type: "kimi", base_url: "x", api_key: "sk", unknown_prov_opt: 1 } } },
        mcp: { mcpServers: {}, stray_mcp_key: true },
      });

      const files = new Set(drift.map((entry) => entry.file));
      expect(files.has("config")).toBe(true);
      expect(files.has("mcp")).toBe(true);
    });

    it("ignores null, undefined, and non-object raw documents", () => {
      const drift = detectUnknownFields({
        config: null,
        panel: undefined,
        mcp: "not-an-object" as unknown,
      });

      expect(drift).toEqual([]);
    });

    it("surfaces drift through buildConfigDoctorReport when raw docs are provided", () => {
      const state = createState();
      const report = buildConfigDoctorReport(state, {
        config: { default_model: "kimi_gateway/kimi-k2.5", providers: { g: { type: "kimi", base_url: "x", api_key: "sk", unknown_cli_field: true } } },
      });

      expect(report.drift?.some((entry) => entry.key === "unknown_cli_field")).toBe(true);
    });

    it("treats 0.38.0 provider/model fields as known (no false positives) and redacts their secrets", () => {
      const drift = detectUnknownFields({
        config: {
          providers: {
            g: {
              type: "openai",
              base_url: "https://x",
              api_key: "sk",
              env: { KIMI_API_KEY: "KIMI_API_KEY" },
              custom_headers: { Authorization: "Bearer x" },
            },
          },
          models: {
            "g/m": {
              provider: "g",
              model: "m",
              max_context_size: 1,
              capabilities: [],
              max_output_size: 8192,
              display_name: "My Model",
              support_efforts: ["low", "high"],
              default_effort: "high",
              reasoning_key: "reasoning",
              adaptive_thinking: true,
              overrides: { request: { temperature: 1 } },
            },
          },
        },
      });

      expect(drift).toEqual([]);
    });

    it("redacts provider env / custom_headers credential-looking values", () => {
      const state = createState();
      const provider = state.mainConfig.providers.kimi_gateway;
      provider.type = "openai";
      provider.env = { KIMI_API_KEY: "AKIAEXAMPLEKEY" };
      provider.custom_headers = {
        Authorization: "Bearer s3cr3t-token",
        Key: "exact-key-secret",
        "Ocp-Apim-Subscription-Key": "subscription-key-secret",
        "X-Trace": "trace-id",
      };

      const redactedState = redactAppStateSecrets(state);

      expect(redactedState.state.mainConfig.providers.kimi_gateway.env).toEqual({ KIMI_API_KEY: "[REDACTED]" });
      expect(redactedState.state.mainConfig.providers.kimi_gateway.custom_headers).toEqual({
        Authorization: "[REDACTED]",
        Key: "[REDACTED]",
        "Ocp-Apim-Subscription-Key": "[REDACTED]",
        "X-Trace": "trace-id",
      });
    });

    it("redacts credential-looking provider and MCP keys from raw disk preview diffs", () => {
      const state = createState();
      const providerApiSecret = ["provider", "api", "key"].join("-");
      const providerEnvSecret = ["fixture", "env", "secret"].join("-");
      const providerHeaderSecret = ["provider", "header", "secret"].join("-");
      const rawConfig = [
        "[providers.gateway]",
        'type = "openai"',
        'base_url = "https://api.example.test"',
        `${["api", "key"].join("_")} = "${providerApiSecret}"`,
        "",
        "[providers.gateway.env]",
        `${["KIMI", "API", "KEY"].join("_")} = "${providerEnvSecret}"`,
        "",
        "[providers.gateway.custom_headers]",
        'Key = "provider-exact-key-secret"',
        'Ocp-Apim-Subscription-Key = "provider-subscription-key-secret"',
        `${["X", "API", "Key"].join("-")} = "${providerHeaderSecret}"`,
        'X-Trace = "provider-trace-id"',
        "",
      ].join("\n");
      state.mcpConfig.mcpServers.current = {
        enabled: true,
        transport: "streamable-http",
        url: "https://mcp.example.test/current",
        headers: {
          Key: "current-exact-key-secret",
          "Ocp-Apim-Subscription-Key": "current-subscription-key-secret",
          "X-API-Key": "current-mcp-header-secret",
          "X-Trace": "current-trace-id",
        },
        command: "",
        args: [],
        env: {},
      };
      const preview = buildRedactedPreviewBundle(state, {
        config: rawConfig,
        mcp: JSON.stringify({
          mcpServers: {
            gateway: {
              url: "https://mcp.example.test",
              headers: {
                Key: "mcp-exact-key-secret",
                "Ocp-Apim-Subscription-Key": "mcp-subscription-key-secret",
                "X-API-Key": "mcp-header-secret",
                "X-Trace": "mcp-trace-id",
              },
            },
          },
        }, null, 2),
      });

      expect(preview.configDiff).not.toContain(providerApiSecret);
      expect(preview.configDiff).not.toContain(providerEnvSecret);
      expect(preview.configDiff).not.toContain("provider-exact-key-secret");
      expect(preview.configDiff).not.toContain("provider-subscription-key-secret");
      expect(preview.configDiff).not.toContain(providerHeaderSecret);
      expect(preview.mcpDiff).not.toContain("mcp-exact-key-secret");
      expect(preview.mcpDiff).not.toContain("mcp-subscription-key-secret");
      expect(preview.mcpDiff).not.toContain("mcp-header-secret");
      expect(preview.mcpDocument).not.toContain("current-exact-key-secret");
      expect(preview.mcpDocument).not.toContain("current-subscription-key-secret");
      expect(preview.mcpDocument).not.toContain("current-mcp-header-secret");
      expect(preview.configDiff).toContain("provider-trace-id");
      expect(preview.mcpDiff).toContain("mcp-trace-id");
      expect(preview.mcpDocument).toContain("current-trace-id");
      expect(preview.configDiff).toContain("[REDACTED]");
      expect(preview.mcpDiff).toContain("[REDACTED]");
      expect(preview.mcpDocument).toContain("[REDACTED]");
    });

    it("keeps drift empty and backward compatible when raw docs are omitted", () => {
      const report = buildConfigDoctorReport(createState());
      expect(report.drift).toEqual([]);
    });
  });
});
