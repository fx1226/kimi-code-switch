import { describe, expect, it } from "vitest";

import { normalizeUiRouteState } from "./uiRouteState";

describe("normalizeUiRouteState", () => {
  it("restores known pages, sub-pages, and resource selections", () => {
    expect(normalizeUiRouteState({
      activeTab: "settings",
      settingsSubTab: "backup",
      kimiCodeSubTab: "plugins",
      selectedProvider: "openai",
      selectedModel: "openai/gpt-5",
      selectedProfile: "work",
      selectedMcpServer: "filesystem",
    })).toEqual({
      activeTab: "settings",
      settingsSubTab: "backup",
      kimiCodeSubTab: "plugins",
      selectedProvider: "openai",
      selectedModel: "openai/gpt-5",
      selectedProfile: "work",
      selectedMcpServer: "filesystem",
    });
  });

  it("falls back safely when persisted values are malformed", () => {
    expect(normalizeUiRouteState({
      activeTab: "unknown",
      settingsSubTab: "danger-zone",
      kimiCodeSubTab: 3,
      selectedProvider: 4,
    })).toMatchObject({
      activeTab: "overview",
      settingsSubTab: "kimi-code",
      kimiCodeSubTab: "instance",
      selectedProvider: "",
    });
  });
});
