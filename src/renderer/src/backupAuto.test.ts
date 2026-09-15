import { describe, expect, it } from "vitest";
import type { AppState } from "@shared/types";
import { createDefaultPanelSettings } from "@shared/configStore";
import { createDefaultShortcuts } from "@shared/shortcutStore";
import {
  backupIntervalMs,
  computeConfigFingerprint,
  parseBackupStampFromName,
  shouldRunScheduled,
} from "./backupAuto";

function createState(): AppState {
  return {
    configPath: "/tmp/config.toml",
    profilesPath: "/tmp/config.profiles.toml",
    panelSettingsPath: "/tmp/config.panel.toml",
    mcpConfigPath: "/tmp/mcp.json",
    mainConfig: {
      default_model: "provider-a/model-a",
      default_plan_mode: false,
      default_permission_mode: "manual",
      merge_all_available_skills: false,
      hooks: [],
      models: {
        "provider-a/model-a": {
          provider: "provider-a",
          model: "model-a",
          max_context_size: 1,
          capabilities: [],
        },
      },
      providers: {
        "provider-a": {
          type: "kimi",
          base_url: "https://a.test",
          api_key: "sk-a",
        },
      },
      loop_control: {},
      background: {},
      notifications: {},
      services: {},
      mcp: {},
    },
    profiles: {
      default: {
        name: "default",
        label: "Default",
        default_model: "provider-a/model-a",
        default_plan_mode: false,
        default_permission_mode: "manual",
        merge_all_available_skills: false,
      },
    },
    activeProfile: "default",
    panelSettings: {
      ...createDefaultPanelSettings(),
      config_path: "/tmp/config.toml",
      backup_local_path: "/tmp/backups",
      theme: "dark",
      backup_strategy: "on-change",
    },
    mcpConfig: {
      mcpServers: {},
    },
  };
}

describe("backupAuto", () => {
  describe("computeConfigFingerprint", () => {
    it("is deterministic for the same state", () => {
      const a = computeConfigFingerprint(createState());
      const b = computeConfigFingerprint(createState());
      expect(a).toBe(b);
    });

    it("changes when core config changes", () => {
      const before = computeConfigFingerprint(createState());
      const mutated = createState();
      mutated.mainConfig.providers["provider-b"] = {
        type: "kimi",
        base_url: "https://b.test",
        api_key: "sk-b",
      };
      const after = computeConfigFingerprint(mutated);
      expect(after).not.toBe(before);
    });

    it("ignores pure UI view state (activeTab / sidebar / theme)", () => {
      const before = computeConfigFingerprint(createState());
      const uiChanged = createState();
      uiChanged.panelSettings.sidebar_collapsed = true;
      uiChanged.panelSettings.theme = "light";
      uiChanged.panelSettings.uiState = { activeTab: "insights" };
      const after = computeConfigFingerprint(uiChanged);
      expect(after).toBe(before);
    });
  });

  describe("backupIntervalMs", () => {
    it("maps frequencies to milliseconds", () => {
      expect(backupIntervalMs("hourly")).toBe(60 * 60 * 1000);
      expect(backupIntervalMs("daily")).toBe(24 * 60 * 60 * 1000);
      expect(backupIntervalMs("weekly")).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  describe("shouldRunScheduled", () => {
    const now = 10_000_000_000;

    it("always runs when never backed up", () => {
      expect(shouldRunScheduled(now, null, "daily")).toBe(true);
    });

    it("runs when the interval has elapsed", () => {
      const lastAt = now - backupIntervalMs("daily");
      expect(shouldRunScheduled(now, lastAt, "daily")).toBe(true);
    });

    it("does not run before the interval elapses", () => {
      const lastAt = now - (backupIntervalMs("daily") - 1);
      expect(shouldRunScheduled(now, lastAt, "daily")).toBe(false);
    });

    it("treats exactly-at-interval as due", () => {
      const lastAt = now - backupIntervalMs("hourly");
      expect(shouldRunScheduled(now, lastAt, "hourly")).toBe(true);
    });
  });

  describe("parseBackupStampFromName", () => {
    it("parses a well-formed backup name", () => {
      const t = parseBackupStampFromName("backup-20260610-143005-123-my-host");
      expect(t).not.toBeNull();
      const d = new Date(t as number);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(5); // June (0-based)
      expect(d.getDate()).toBe(10);
      expect(d.getHours()).toBe(14);
      expect(d.getMinutes()).toBe(30);
      expect(d.getSeconds()).toBe(5);
      expect(d.getMilliseconds()).toBe(123);
    });

    it("returns null for malformed names", () => {
      expect(parseBackupStampFromName("backup-bad-name")).toBeNull();
      expect(parseBackupStampFromName("not-a-backup")).toBeNull();
      expect(parseBackupStampFromName("backup-2026-06-10")).toBeNull();
    });
  });
});
