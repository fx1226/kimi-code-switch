import { describe, expect, it } from "vitest";

import { parsePanelSettingsDocument } from "./configStore";

describe("UI route persistence", () => {
  it("keeps the renderer-only route context when panel settings are parsed", () => {
    const settings = parsePanelSettingsDocument(JSON.stringify({
      uiState: {
        activeTab: "settings",
        settingsSubTab: "backup",
        kimiCodeSubTab: "plugins",
        selectedProvider: "openai",
        selectedModel: "openai/gpt-5",
        selectedProfile: "work",
        selectedMcpServer: "filesystem",
      },
    }));

    expect(settings.uiState).toEqual({
      activeTab: "settings",
      settingsSubTab: "backup",
      kimiCodeSubTab: "plugins",
      selectedProvider: "openai",
      selectedModel: "openai/gpt-5",
      selectedProfile: "work",
      selectedMcpServer: "filesystem",
    });
  });
});
