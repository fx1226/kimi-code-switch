import type { AppState } from "@shared/types";
import type { SkillEntry, SkillsScanReport } from "@shared/skillsStore";

import { emptyPreview } from "./appOptions";
import { createFallbackState } from "./tabComponents";

const skills = Array.from({ length: 14 }, (_, index): SkillEntry => ({
  id: `fixture-skill-${index + 1}`,
  name: ["Review pull request", "Release notes", "Architecture", "Testing"][index % 4] + ` ${index + 1}`,
  sourcePathId: "fixture-user-skills",
  directoryName: `fixture-skill-${index + 1}`,
  directoryPath: `/fixture/skills/${index + 1}`,
  skillFilePath: `/fixture/skills/${index + 1}/SKILL.md`,
  sourceLabel: "User skills",
  sourceGroup: "user-common",
  priority: index,
  enabled: true,
  effective: true,
  frontmatter: true,
  metadata: {
    name: `Fixture skill ${index + 1}`,
    description: "A stable, local-only fixture used to review the responsive skills workspace.",
    license: "",
    compatibility: "",
    type: "prompt",
    whenToUse: "",
    disableModelInvocation: false,
    arguments: [],
    metadata: {},
    hasSubSkill: false,
  },
  content: "# Fixture skill\n\nThis content is only used in development screenshots.",
  lineCount: 3,
  hasScripts: false,
  hasReferences: false,
  hasAssets: false,
  valid: true,
  diagnostics: [],
}));

const skillsReport: SkillsScanReport = {
  builtinNotice: "",
  discoveryMode: "auto",
  mergeAllAvailableSkills: true,
  paths: [{
    id: "fixture-user-skills",
    path: "/fixture/skills",
    label: "User skills",
    group: "user-common",
    priority: 1,
    exists: true,
    selected: true,
    reason: "",
  }],
  skills,
  summary: { total: skills.length, effective: skills.length, overrides: 0, warnings: 0, errors: 0, flow: 0 },
};

function createFixtureState(): AppState {
  const state = createFallbackState();
  state.mainConfig.providers = {
    openai: { type: "openai", base_url: "https://api.openai.com/v1", api_key: "" },
    local: { type: "openai", base_url: "http://localhost:11434/v1", api_key: "" },
  };
  state.mainConfig.models = {
    "openai/gpt-5": { provider: "openai", model: "gpt-5", max_context_size: 128000, capabilities: ["thinking"] },
    "local/qwen": { provider: "local", model: "qwen", max_context_size: 32768, capabilities: [] },
  };
  state.profiles = {
    work: { name: "work", label: "Work", default_model: "openai/gpt-5", default_plan_mode: false, default_permission_mode: "manual", merge_all_available_skills: true, thinking_enabled: true },
    fast: { name: "fast", label: "Fast local", default_model: "local/qwen", default_plan_mode: false, default_permission_mode: "auto", merge_all_available_skills: true, thinking_enabled: false },
  };
  state.activeProfile = "work";
  state.mainConfig.default_model = "openai/gpt-5";
  state.mcpConfig.mcpServers = {
    filesystem: { enabled: true, transport: "stdio", url: "", headers: {}, command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: {} },
    docs: { enabled: true, transport: "streamable-http", url: "https://example.test/mcp", headers: {}, command: "", args: [], env: {} },
  };
  state.kimiTargetDetection = {
    target: "kimi-code",
    status: "detected",
    installed: true,
    version: "0.38.0",
    latestVersion: "0.38.0",
    hasUpdate: false,
    executablePath: "/usr/local/bin/kimi",
    resolvedPath: "/usr/local/bin/kimi",
    candidates: ["/usr/local/bin/kimi"],
    reason: "fixture",
    installSource: "homebrew",
  };
  return state;
}

let fixtureState = createFixtureState();

export function installUiFixture(): void {
  window.kimiSwitch = {
    loadState: async () => structuredClone(fixtureState),
    previewState: async () => emptyPreview,
    scanSkills: async () => structuredClone(skillsReport),
    getCliVersion: async () => ({ installed: true, version: "0.38.0", hasUpdate: false, installSource: "homebrew" }),
    runDoctor: async () => ({ ok: true, generatedAt: "", issues: [], errorCount: 0, warningCount: 0, infoCount: 0 }),
    usageGetStatus: async () => ({
      ok: true,
      settings: {
        insights_status: "enabled",
        insights_proxy_port: "auto",
        insights_retention_days: 90,
        insights_disk_warn_threshold_mb: 100,
        insights_store_prompt_preview: false,
        insights_onboarding_shown_at: "fixture",
        insights_last_known_port: null,
        insights_display_currency: "USD",
        insights_currency_rates: {},
      },
    }),
    usageQueryOverview: async () => ({ ok: true, slice: { totalCalls: 248, totalTokens: 1_420_000, cacheHitRate: 0.46, reasoningTokens: 128_000, avgLatencyMs: 840, latencySamples: 240, errorRate: 0.012 } }),
    usageQueryTokenTotals: async () => ({ ok: true, totals: { promptTokens: 840_000, completionTokens: 410_000, cacheCreationTokens: 76_000, cacheReadTokens: 618_000 } }),
    usageQueryTrendTokens: async () => ({ ok: true, series: Array.from({ length: 7 }, (_, index) => ({ bucket: Date.UTC(2026, 7, index + 1), prompt: 90_000 + index * 8_000, completion: 48_000 + index * 4_000, cacheCreation: 9_000 + index * 700, cacheRead: 72_000 + index * 5_000 })) }),
    usageQueryCostSeries: async () => ({
      ok: true,
      points: Array.from({ length: 7 }, (_, index) => ({ bucket: Date.UTC(2026, 7, index + 1), cost: 4.2 + index * 0.45 })),
      series: Array.from({ length: 7 }, (_, index) => ({ bucket: Date.UTC(2026, 7, index + 1), prompt: 90_000 + index * 8_000, completion: 48_000 + index * 4_000, cacheCreation: 9_000 + index * 700, cacheRead: 72_000 + index * 5_000 })),
    }),
    usageQueryCost: async () => ({ ok: true, total: 32.8, byDay: {}, byModel: { "openai/gpt-5": 31.4 } }),
    usageQueryBreakdown: async () => ({ ok: true, rows: [{ name: "openai/gpt-5", calls: 186, tokens: 1_112_000, avgLatency: 920 }, { name: "local/qwen", calls: 62, tokens: 308_000, avgLatency: 620 }] }),
    usageQuerySessions: async () => ({ ok: true, rows: [] }),
    usageSetConfig: async (settings: AppState["panelSettings"]) => {
      fixtureState = { ...fixtureState, panelSettings: { ...fixtureState.panelSettings, ...settings } };
      return { ok: true, settings: fixtureState.panelSettings };
    },
  } as unknown as Window["kimiSwitch"];
}
