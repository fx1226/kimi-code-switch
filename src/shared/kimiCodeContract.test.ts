import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import * as TOML from "@iarna/toml";

import { buildConfigDocument, loadAppState } from "./configStore";
import { buildMcpConfigDocument, parseMcpConfigStrict } from "./mcpStore";
import { scanSkills } from "./skillsStore";
import { mergeTuiConfigDocument, normalizeTuiConfig, parseTuiConfigDocumentWithDiagnostics } from "./tuiStore";

const CONTRACT_DIR = resolve(process.cwd(), "tests/fixtures/kimi-code/0.38.0");

interface ContractSource {
  id: string;
  canonical_url: string;
  immutable_url: string;
}

interface ContractManifest {
  product: {
    package: string;
    version: string;
    release_tag: string;
    release_commit: string;
    release_date: string;
  };
  contract: {
    data_home_env: string;
    default_data_home: string;
    user_files: string[];
    defaults: Record<string, boolean | number | string>;
  };
  sources: ContractSource[];
  fixtures: Record<string, { sources: string[] }>;
}

function readFixture(relativePath: string): string {
  return readFileSync(resolve(CONTRACT_DIR, relativePath), "utf8");
}

function readManifest(): ContractManifest {
  return JSON.parse(readFixture("contract-manifest.json")) as ContractManifest;
}

describe("Kimi Code 0.38.0 upstream contract", () => {
  it("pins every source to the released commit instead of the moving main branch", () => {
    const manifest = readManifest();
    const releaseCommit = "0999454bdcb5ddd98f39bffee434dcf0a810f394";

    expect(manifest.product).toEqual({
      package: "@moonshot-ai/kimi-code",
      version: "0.38.0",
      release_tag: "@moonshot-ai/kimi-code@0.38.0",
      release_commit: releaseCommit,
      release_date: "2026-08-20",
    });
    expect(manifest.sources.length).toBeGreaterThanOrEqual(7);
    expect(new Set(manifest.sources.map((source) => source.id)).size).toBe(manifest.sources.length);
    for (const source of manifest.sources) {
      expect(source.canonical_url).toMatch(/^https:\/\/(github\.com|raw\.githubusercontent\.com)\/MoonshotAI\/kimi-code/);
      expect(source.immutable_url).toMatch(
        new RegExp(
          `^https:\\/\\/(github\\.com\\/MoonshotAI\\/kimi-code\\/(?:commit|blob)|raw\\.githubusercontent\\.com\\/MoonshotAI\\/kimi-code)\\/${releaseCommit}(?:\\/|$)`,
        ),
      );
      expect(source.immutable_url).not.toContain("/main/");
    }

    const sourceIds = new Set(manifest.sources.map((source) => source.id));
    for (const fixture of Object.values(manifest.fixtures)) {
      expect(fixture.sources.length).toBeGreaterThan(0);
      expect(fixture.sources.every((sourceId) => sourceIds.has(sourceId))).toBe(true);
    }
  });

  it("captures the released data-home contract and key config defaults", () => {
    const manifest = readManifest();
    const config = TOML.parse(readFixture("config.toml"));

    expect(manifest.contract.data_home_env).toBe("KIMI_CODE_HOME");
    expect(manifest.contract.default_data_home).toBe("~/.kimi-code");
    expect(manifest.contract.user_files).toEqual([
      "config.toml",
      "tui.toml",
      "AGENTS.md",
      "mcp.json",
      "skills/",
      "plugins/",
      "session_index.jsonl",
      "credentials/",
      "sessions/",
      "bin/",
      "logs/",
      "updates/",
      "user-history/",
    ]);
    expect(manifest.contract.defaults).toMatchObject({
      default_permission_mode: "manual",
      default_plan_mode: false,
      merge_all_available_skills: true,
      builtin_product_skills: true,
      telemetry: true,
      thinking_enabled: true,
      thinking_keep: "all",
      token_counting_strategy: "measured+estimated",
      subagent_timeout_ms_interactive: 7_200_000,
      subagent_timeout_ms_print: 0,
      mcp_startup_timeout_ms: 30_000,
      mcp_tool_timeout_ms: 60_000,
    });

    expect(config).toMatchObject({
      default_model: "kimi-code/k3",
      default_permission_mode: "manual",
      default_plan_mode: false,
      merge_all_available_skills: true,
      builtin_product_skills: true,
      telemetry: true,
      thinking: { enabled: true, effort: "high", keep: "all" },
      token_counting: { strategy: "measured+estimated" },
      subagent: { timeout_ms: 7_200_000 },
      mcp: { startup_timeout_ms: 30_000, tool_timeout_ms: 60_000 },
    });
    expect(Object.keys(config).sort()).toEqual([
      "builtin_product_skills",
      "default_model",
      "default_permission_mode",
      "default_plan_mode",
      "mcp",
      "merge_all_available_skills",
      "models",
      "providers",
      "secondary_model",
      "subagent",
      "telemetry",
      "thinking",
      "token_counting",
    ]);
    expect(config).not.toHaveProperty("swarm");

    const providers = config.providers as Record<string, Record<string, unknown>>;
    const models = config.models as Record<string, Record<string, unknown>>;
    expect(providers["managed:kimi-code"]).toMatchObject({
      type: "kimi",
      model_source: "oauth-catalog",
      base_url: "https://api.kimi.com/coding/v1",
      default_model: "kimi-code/k3",
    });
    expect(models["kimi-code/k3"]).toMatchObject({
      provider: "managed:kimi-code",
      model: "k3",
      max_context_size: 1_048_576,
      support_efforts: ["low", "high", "max"],
      default_effort: "max",
    });
  });

  it("captures all three released MCP transports and runtime controls", () => {
    const mcp = JSON.parse(readFixture("mcp.json")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(mcp.mcpServers.filesystem).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      cwd: "/tmp",
      enabled: true,
      startupTimeoutMs: 30_000,
      toolTimeoutMs: 60_000,
    });
    expect(Object.keys(mcp.mcpServers.filesystem).sort()).toEqual([
      "args",
      "command",
      "cwd",
      "enabled",
      "env",
      "startupTimeoutMs",
      "toolTimeoutMs",
    ]);
    expect(mcp.mcpServers.linear).toMatchObject({
      url: "https://mcp.linear.app/mcp",
      bearerTokenEnvVar: "LINEAR_TOKEN",
      enabledTools: ["get_issue", "list_issues"],
      disabledTools: ["delete_issue"],
    });
    expect(mcp.mcpServers["legacy-events"]).toMatchObject({
      transport: "sse",
      url: "https://mcp.example.com/sse",
      enabled: false,
    });
    expect(Object.keys(mcp.mcpServers["legacy-events"]).sort()).toEqual([
      "enabled",
      "transport",
      "url",
    ]);
  });

  it("captures released TUI defaults and both supported Skill forms", () => {
    const tui = TOML.parse(readFixture("tui.toml"));
    const directorySkill = readFixture("skills/review-pr/SKILL.md");
    const flatSkill = readFixture("skills/release-notes.md");

    expect(tui).toMatchObject({
      theme: "auto",
      render_latex: true,
      disable_paste_burst: false,
      cache_expiry_hint: true,
      editor: { command: "" },
      notifications: { enabled: true, notification_condition: "unfocused" },
      upgrade: { auto_install: true },
    });
    expect(Object.keys(tui).sort()).toEqual([
      "cache_expiry_hint",
      "disable_paste_burst",
      "editor",
      "notifications",
      "render_latex",
      "theme",
      "upgrade",
    ]);
    expect(tui).not.toHaveProperty("status_line");
    expect(directorySkill).toContain("name: review-pr");
    expect(directorySkill).toContain("description:");
    expect(directorySkill).toContain("type: prompt");
    expect(directorySkill).toContain("$pr_ref");
    expect(flatSkill).toContain("type: flow");
    expect(flatSkill).toContain("$ARGUMENTS");
  });

  it("round-trips the upstream fixtures through production adapters without losing unmanaged fields", async () => {
    const configDocument = readFixture("config.toml");
    const mcpDocument = readFixture("mcp.json");
    const state = await loadAppState({
      async readText(path: string) {
        if (path.endsWith("config.toml")) return configDocument;
        if (path.endsWith("mcp.json")) return mcpDocument;
        return null;
      },
      async writeText() {},
      async ensureDir() {},
    });

    const renderedConfig = TOML.parse(buildConfigDocument(state));
    expect(renderedConfig).toMatchObject({
      builtin_product_skills: true,
      token_counting: { strategy: "measured+estimated" },
      subagent: { timeout_ms: 7_200_000 },
      providers: {
        "managed:kimi-code": {
          model_source: "oauth-catalog",
          default_model: "kimi-code/k3",
        },
      },
    });

    const renderedMcp = JSON.parse(buildMcpConfigDocument(parseMcpConfigStrict(mcpDocument))) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(renderedMcp.mcpServers.filesystem).toMatchObject({ cwd: "/tmp", startupTimeoutMs: 30_000 });
    expect(renderedMcp.mcpServers.linear).toMatchObject({ bearerTokenEnvVar: "LINEAR_TOKEN" });
    expect(renderedMcp.mcpServers["legacy-events"]).toMatchObject({ transport: "sse", enabled: false });

    const mergedTui = mergeTuiConfigDocument(readFixture("tui.toml"), {
      theme: "dark",
      editorCommand: "code --wait",
    });
    expect(TOML.parse(mergedTui)).toMatchObject({
      theme: "dark",
      render_latex: true,
      cache_expiry_hint: true,
    });
    expect(TOML.parse(mergedTui)).not.toHaveProperty("status_line");

    const skillRoot = resolve(CONTRACT_DIR, "skills");
    const skills = await scanSkills({
      async readText(path: string) {
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      },
      async listDir(path: string) {
        if (!existsSync(path)) return [];
        return readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      },
      async pathExists(path: string) {
        return existsSync(path);
      },
    }, {
      mergeAllAvailableSkills: true,
      envHome: resolve(CONTRACT_DIR),
      userHome: resolve(CONTRACT_DIR, "isolated-home"),
      readJson: async () => null,
    });
    expect(skills.skills.map((skill) => skill.name).sort()).toEqual(["release-notes", "review-pr"]);
  });

  it("captures the Plugin installed.json and manifest contract fixtures", () => {
    const installed = JSON.parse(readFixture("plugins/installed.json")) as {
      version: number;
      plugins: Array<Record<string, unknown>>;
    };
    // 官方 InstalledFile schema：version=1，plugins 数组，每条含 id/root/source/enabled/installedAt。
    expect(installed.version).toBe(1);
    expect(Array.isArray(installed.plugins)).toBe(true);
    const record = installed.plugins[0];
    expect(record.id).toBe("kimi-datasource");
    expect(record.root).toContain("kimi-datasource");
    expect(record.source).toMatch(/^npm:@moonshot-ai\/kimi-datasource@/);
    expect(typeof record.enabled).toBe("boolean");
    expect(typeof record.installedAt).toBe("string");

    const manifest = JSON.parse(readFixture("plugins/managed/kimi-datasource/kimi.plugin.json")) as {
      name: string;
      version: string;
      mcpServers: Record<string, Record<string, unknown>>;
      interface?: Record<string, unknown>;
    };
    expect(manifest.name).toBe("kimi-datasource");
    expect(manifest.version).toBe("3.4.0");
    expect(manifest.mcpServers.data).toMatchObject({
      command: "node",
      args: ["./bin/kimi-datasource.mjs"],
      cwd: "./",
    });
    expect(manifest.interface?.developerName).toBe("Moonshot AI");
  });

  it("captures the provider registry catalog contract fixture", () => {
    const catalog = JSON.parse(readFixture("provider-registry/catalog.json")) as Record<
      string,
      { name: string; type: string; models: Record<string, { id: string; capability?: Record<string, unknown> }> }
    >;
    expect(Object.keys(catalog)).toEqual(["acme"]);
    const acme = catalog.acme;
    expect(acme.name).toBe("Acme Inference");
    expect(acme.type).toBe("openai");
    expect(acme.models["acme-70b"]).toMatchObject({
      id: "acme-70b",
      capability: { tool_use: true, thinking: true },
    });
    // 与 GUI listKimiProviderCatalog 的消费形态一致：id -> {name, type, models}。
    expect(Object.keys(acme.models).length).toBe(2);
  });

  it("E2: derives the effective TUI config from the official tui.toml fixture", () => {
    const tuiDocument = readFixture("tui.toml");
    const { config, effective, errors } = parseTuiConfigDocumentWithDiagnostics(tuiDocument);
    expect(errors).toEqual([]);

    // 文件显式值（Explicit）。
    expect(config.theme).toBe("auto");
    expect(config.editorCommand).toBeUndefined(); // 空串 command 视为未显式设置

    // 有效配置（Effective）应用官方默认：空 editor command → null；
    // status_line 未声明 → 默认空布局；notifications/upgrade 显式值保留。
    expect(effective).toMatchObject({
      theme: "auto",
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      editorCommand: null,
      notificationsEnabled: true,
      notificationCondition: "unfocused",
      upgradeAutoInstall: true,
      statusLineItems: [],
      statusLineCommand: null,
    });

    // normalize（单一 schema）对同一文档给出等价有效配置。
    expect(normalizeTuiConfig(config)).toEqual(effective);
  });
});
