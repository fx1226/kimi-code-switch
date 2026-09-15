import { describe, expect, it } from "vitest";

import {
  buildBridgeModelConfig,
  buildBridgeProviderConfig,
  bridgeModelKey,
  diffCatalog,
  planUnbind,
  redactBindingSecret,
} from "./chatgptBridge";
import { bootstrapProfiles, createDefaultPanelSettings } from "./configStore";
import type { AppState, MainConfig } from "./types";

function makeMainConfig(): MainConfig {
  return {
    default_model: "chatgpt/gpt-mock-pro",
    default_plan_mode: false,
    default_permission_mode: "manual",
    merge_all_available_skills: false,
    hooks: [],
    models: {
      "chatgpt/gpt-mock-pro": {
        provider: "chatgpt-bridge",
        model: "gpt-mock-pro",
        max_context_size: 128000,
        capabilities: ["tool_use", "thinking"],
      },
    },
    providers: {
      "chatgpt-bridge": {
        type: "openai_responses",
        base_url: "http://127.0.0.1:8317/v1",
        api_key: "secret",
      },
    },
    loop_control: {},
    background: {},
    notifications: {},
    services: {},
    mcp: {},
  };
}

function createState(): AppState {
  const mainConfig = makeMainConfig();
  return {
    configTarget: "kimi-code",
    configPath: "/tmp/config.toml",
    profilesPath: "",
    panelSettingsPath: "/tmp/config.panel.toml",
    mcpConfigPath: "/tmp/mcp.json",
    mainConfig,
    profiles: bootstrapProfiles(mainConfig),
    activeProfile: "default",
    panelSettings: createDefaultPanelSettings("/tmp/config.toml", "/tmp/config.panel.toml"),
    mcpConfig: { mcpServers: {} },
  };
}

describe("chatgptBridge", () => {
  it("builds a provider pointing at the loopback bridge", () => {
    const provider = buildBridgeProviderConfig({ bridgePort: 8317, bridgeSecret: "s" });
    expect(provider.type).toBe("openai_responses");
    expect(provider.base_url).toBe("http://127.0.0.1:8317/v1");
    expect(provider.api_key).toBe("s");
    expect(provider.model_source).toBe("oauth-catalog");
  });

  it("builds a model with confirmed capabilities only", () => {
    const model = buildBridgeModelConfig("chatgpt-bridge", "gpt-mock-pro", {
      context_window: 128000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
    });
    expect(model.model).toBe("gpt-mock-pro");
    expect(model.provider).toBe("chatgpt-bridge");
    expect(model.max_context_size).toBe(128000);
    expect(model.capabilities).toContain("tool_use");
    expect(model.capabilities).toContain("thinking");
    expect(model.capabilities).toContain("image_in");
    expect(model.support_efforts).toEqual(["low", "medium"]);
    expect(model.default_effort).toBe("medium");
  });

  it("computes catalog diff with add / stale (un)referenced", () => {
    const state = createState();
    const diff = diffCatalog(
      state,
      { providerName: "chatgpt-bridge", modelAliases: ["chatgpt/gpt-mock-pro", "chatgpt/gone"] },
      {
        models: [
          { slug: "gpt-mock-pro", context_window: 128000 },
          { slug: "gpt-new", context_window: 64000 },
        ],
      },
    );
    expect(diff.add.map((entry) => entry.alias)).toEqual(["chatgpt/gpt-new"]);
    // gpt-mock-pro 仍在目录中；gone 不在目录且未被引用 → 可安全移除。
    expect(diff.staleUnreferenced).toEqual(["chatgpt/gone"]);
    expect(diff.staleReferenced).toEqual([]);

    // 被 profile 引用的过期模型必须保留并标记。
    const referencedState = createState();
    referencedState.profiles.default.default_model = "chatgpt/gone";
    referencedState.mainConfig.default_model = "chatgpt/gone";
    const diff2 = diffCatalog(
      referencedState,
      { providerName: "chatgpt-bridge", modelAliases: ["chatgpt/gone"] },
      { models: [] },
    );
    expect(diff2.staleUnreferenced).toEqual([]);
    expect(diff2.staleReferenced).toEqual(["chatgpt/gone"]);
  });

  it("plans unbind preserving referenced models and provider", () => {
    const state = createState();
    const plan = planUnbind(state, {
      providerName: "chatgpt-bridge",
      modelAliases: ["chatgpt/gpt-mock-pro"],
      profileName: "default",
    });
    expect(plan.modelsToRemove).toEqual([]);
    expect(plan.modelsRetained).toHaveLength(1);
    expect(plan.providerRemovable).toBe(false);
    expect(plan.profileRemovable).toBe(false); // active profile retained
  });

  it("plans full removal when nothing references the entries", () => {
    const state = createState();
    state.profiles.default.default_model = "other/other";
    state.mainConfig.default_model = "other/other";
    const plan = planUnbind(state, {
      providerName: "chatgpt-bridge",
      modelAliases: ["chatgpt/gpt-mock-pro"],
      profileName: "default",
    });
    expect(plan.modelsToRemove).toEqual(["chatgpt/gpt-mock-pro"]);
    expect(plan.providerRemovable).toBe(true);
  });

  it("redacts the local secret for export", () => {
    expect(redactBindingSecret({ bridgeSecret: "topsecret" } as never).bridgeSecret).toBe("[redacted]");
  });

  it("builds namespaced model keys", () => {
    expect(bridgeModelKey("gpt-mock-pro")).toBe("chatgpt/gpt-mock-pro");
  });
});
