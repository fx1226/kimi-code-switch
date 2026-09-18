import {
  EFFECTIVE_TUI_DEFAULTS,
  TUI_CONFIG_FILENAME,
  TuiConfigFromProfile,
  buildTuiConfigDocument,
  hasTuiConfigValues,
  mergeTuiConfigDocument,
  normalizeTuiConfig,
  parseTuiConfigDocument,
  parseTuiConfigDocumentWithDiagnostics,
} from "./tuiStore";
import type { Profile } from "./types";

describe("tuiStore", () => {
  describe("buildTuiConfigDocument", () => {
    it("outputs an empty document for an empty config", () => {
      expect(buildTuiConfigDocument({})).toBe("");
    });

    it("renders only present fields, omitting unset ones", () => {
      const document = buildTuiConfigDocument({
        theme: "dark",
        editorCommand: "vim",
      });
      expect(document).toContain('theme = "dark"');
      expect(document).toContain("[editor]");
      expect(document).toContain('command = "vim"');
      expect(document).not.toContain("notifications");
      expect(document).not.toContain("upgrade");
      expect(document).not.toContain("disable_paste_burst");
    });

    it("emits sub-tables for editor/notifications/upgrade at top level (no leading indentation)", () => {
      const document = buildTuiConfigDocument({
        theme: "auto",
        disable_paste_burst: true,
        editorCommand: "code --wait",
        notificationsEnabled: true,
        notificationCondition: "unfocused",
        upgradeAutoInstall: false,
      });
      expect(document).toContain("[editor]");
      expect(document).toContain("[notifications]");
      expect(document).toContain("[upgrade]");
      expect(document).not.toContain("  [editor]");
      expect(document).not.toContain("  [notifications]");
    });
  });

  describe("parseTuiConfigDocument", () => {
    it("round-trips a full document back to the same values", () => {
      const source = {
        theme: "dark",
        disable_paste_burst: true,
        renderLatex: false,
        cacheExpiryHint: true,
        disableFeedbackSurvey: true,
        markdownMermaid: "off" as const,
        editorCommand: "vim",
        notificationsEnabled: true,
        notificationCondition: "unfocused" as const,
        upgradeAutoInstall: true,
        statusLine: { items: ["mode", "model"], command: "/tmp/status.sh" },
      };
      const parsed = parseTuiConfigDocument(buildTuiConfigDocument(source));
      expect(parsed).toEqual(source);
    });

    it("reports malformed TOML and filters unknown status-line items", () => {
      expect(parseTuiConfigDocumentWithDiagnostics("theme = ").errors.length).toBeGreaterThan(0);
      const result = parseTuiConfigDocumentWithDiagnostics(`
[status_line]
items = ["model", "unknown", "cwd"]
`);
      expect(result.config.statusLine?.items).toEqual(["model", "cwd"]);
      expect(result.warnings).toContain("Unknown status_line item skipped: unknown");
    });

    it("returns an empty object for null, empty, or invalid documents", () => {
      expect(parseTuiConfigDocument(null)).toEqual({});
      expect(parseTuiConfigDocument("")).toEqual({});
      expect(parseTuiConfigDocument("  \n ")).toEqual({});
      expect(parseTuiConfigDocument("theme = ")).toEqual({});
    });

    it("falls back on unknown Mermaid values without overwriting their source", () => {
      const document = 'disable_feedback_survey = true\n[markdown]\nmermaid = "future-mode"\ncustom = "keep"\n';
      const parsed = parseTuiConfigDocumentWithDiagnostics(document);
      expect(parsed.config.disableFeedbackSurvey).toBe(true);
      expect(parsed.config.markdownMermaid).toBeUndefined();
      expect(parsed.effective.markdownMermaid).toBe("final");
      expect(parsed.warnings).toContain("Unknown markdown.mermaid value ignored: future-mode");
      expect(mergeTuiConfigDocument(document, {})).toBe(document);
      const changed = mergeTuiConfigDocument(document, { markdownMermaid: "off", disableFeedbackSurvey: false });
      expect(changed).toContain('custom = "keep"');
      expect(parseTuiConfigDocument(changed)).toMatchObject({ markdownMermaid: "off", disableFeedbackSurvey: false });
    });

    it("leaves missing fields undefined", () => {
      const parsed = parseTuiConfigDocument('notification_condition = "always"');
      expect(parsed.theme).toBeUndefined();
      expect(parsed.editorCommand).toBeUndefined();
    });

    it("ignores unknown keys and invalid notification conditions", () => {
      const parsed = parseTuiConfigDocument(
        'theme = "dark"\n[custom]\nx = 1\n[notifications]\nnotification_condition = "sometimes"\n',
      );
      expect(parsed.theme).toBe("dark");
      expect(parsed.notificationCondition).toBeUndefined();
    });
  });

  describe("TuiConfigFromProfile", () => {
    const profile: Profile = {
      name: "work",
      label: "Work",
      default_model: "m",
      default_plan_mode: false,
      default_permission_mode: "manual",
      merge_all_available_skills: false,
    };

    it("maps tui_theme and tui_editor_command onto theme/editorCommand", () => {
      const tui = TuiConfigFromProfile({
        ...profile,
        tui_theme: "light",
        tui_editor_command: "nvim",
      });
      expect(tui).toEqual({ theme: "light", editorCommand: "nvim" });
    });

    it("maps only tui_theme when editor command is unset", () => {
      const tui = TuiConfigFromProfile({ ...profile, tui_theme: "dark" });
      expect(tui.theme).toBe("dark");
      expect(tui.editorCommand).toBeUndefined();
    });

    it("returns an empty object when neither field is set", () => {
      expect(TuiConfigFromProfile(profile)).toEqual({});
      expect(TuiConfigFromProfile(undefined)).toEqual({});
    });

    it("treats blank strings as unset", () => {
      const tui = TuiConfigFromProfile({
        ...profile,
        tui_theme: "",
        tui_editor_command: "  ",
      });
      expect(tui).toEqual({});
    });
  });

  describe("hasTuiConfigValues / mergeTuiConfigDocument", () => {
    it("reports present GUI-managed fields", () => {
      expect(hasTuiConfigValues({ theme: "dark" })).toBe(true);
      expect(hasTuiConfigValues({ editorCommand: "vim" })).toBe(true);
      expect(hasTuiConfigValues({ notificationsEnabled: true })).toBe(true);
      expect(hasTuiConfigValues({})).toBe(false);
    });

    it("removes stale GUI-managed fields when the active profile has no TUI values", () => {
      const existing = [
        'theme = "dark"',
        "",
        "[editor]",
        'command = "vim"',
        "line_number = true",
        "",
        "[notifications]",
        "enabled = false",
      ].join("\n");
      const merged = mergeTuiConfigDocument(existing, {});

      expect(merged).not.toContain("theme =");
      expect(merged).not.toContain('command = "vim"');
      expect(merged).toContain("line_number = true");
      expect(merged).toContain("[notifications]");
      expect(merged).toContain("enabled = false");
    });

    it("preserves an unchanged document and updates advanced fields when explicitly managed", () => {
      const existing = '[notifications]\nenabled = false\n';
      expect(mergeTuiConfigDocument(existing, {})).toBe(existing);
      expect(mergeTuiConfigDocument(existing, { notificationsEnabled: true })).toContain("enabled = true");
    });

    it("merges every official advanced TUI field while keeping unknown keys", () => {
      const existing = 'unknown_top = "keep"\n[notifications]\ncustom = "keep"\n';
      const merged = mergeTuiConfigDocument(existing, {
        disable_paste_burst: true,
        renderLatex: false,
        cacheExpiryHint: false,
        notificationsEnabled: true,
        notificationCondition: "always",
        upgradeAutoInstall: false,
        statusLine: { items: ["model", "cwd"], command: "status.sh" },
      });
      expect(merged).toContain('unknown_top = "keep"');
      expect(parseTuiConfigDocument(merged)).toMatchObject({
        disable_paste_burst: true,
        renderLatex: false,
        cacheExpiryHint: false,
        notificationsEnabled: true,
        notificationCondition: "always",
        upgradeAutoInstall: false,
        statusLine: { items: ["model", "cwd"], command: "status.sh" },
      });
    });

    it("merges GUI fields into an existing document, preserving unrelated sections", () => {
      const existing = [
        'disable_paste_burst = true',
        '',
        '[notifications]',
        'enabled = false',
        'notification_condition = "always"',
        '',
        '[upgrade]',
        'auto_install = true',
      ].join("\n");
      const merged = mergeTuiConfigDocument(existing, { theme: "dark", editorCommand: "vim" });
      // 保留的字段
      expect(merged).toContain("disable_paste_burst = true");
      expect(merged).toContain("[notifications]");
      expect(merged).toContain("enabled = false");
      expect(merged).toContain("notification_condition");
      expect(merged).toContain("auto_install = true");
      // GUI 写入的字段
      expect(merged).toContain('theme = "dark"');
      expect(merged).toContain("[editor]");
      expect(merged).toContain('command = "vim"');
      // 合并结果可解析回同值
      const parsed = parseTuiConfigDocument(merged);
      expect(parsed.theme).toBe("dark");
      expect(parsed.editorCommand).toBe("vim");
      expect(parsed.notificationsEnabled).toBe(false);
      expect(parsed.upgradeAutoInstall).toBe(true);
    });

    it("leaves an invalid existing document untouched instead of overwriting it", () => {
      const merged = mergeTuiConfigDocument("theme = ", { theme: "light" });
      expect(merged).toBe("theme = ");
    });
  });

  it("exposes the tui.toml filename constant", () => {
    expect(TUI_CONFIG_FILENAME).toBe("tui.toml");
  });

  describe("E2: normalizeTuiConfig (Explicit → Effective)", () => {
    it("applies official defaults to an empty explicit config", () => {
      const effective = normalizeTuiConfig({});
      expect(effective).toEqual({
        theme: "auto",
        disablePasteBurst: false,
        renderLatex: true,
        cacheExpiryHint: true,
        disableFeedbackSurvey: false,
        markdownMermaid: "final",
        editorCommand: null,
        notificationsEnabled: true,
        notificationCondition: "unfocused",
        upgradeAutoInstall: true,
        statusLineItems: [],
        statusLineCommand: null,
      });
    });

    it("keeps explicit values and trims editor/status commands", () => {
      const effective = normalizeTuiConfig({
        theme: "dark",
        editorCommand: "  code --wait  ",
        notificationsEnabled: false,
        notificationCondition: "always",
        upgradeAutoInstall: false,
        statusLine: { items: ["mode", "bogus", "cwd"], command: "  pwd  " },
        disable_paste_burst: true,
      });
      expect(effective.theme).toBe("dark");
      expect(effective.editorCommand).toBe("code --wait");
      expect(effective.notificationsEnabled).toBe(false);
      expect(effective.notificationCondition).toBe("always");
      expect(effective.upgradeAutoInstall).toBe(false);
      // 未知 status_line item 被过滤；command 被 trim
      expect(effective.statusLineItems).toEqual(["mode", "cwd"]);
      expect(effective.statusLineCommand).toBe("pwd");
      expect(effective.disablePasteBurst).toBe(true);
    });

    it("treats blank editor/status commands as null (official default)", () => {
      const effective = normalizeTuiConfig({ editorCommand: "   ", statusLine: { command: "" } });
      expect(effective.editorCommand).toBeNull();
      expect(effective.statusLineCommand).toBeNull();
    });

    it("round-trips through defaults constant", () => {
      expect(EFFECTIVE_TUI_DEFAULTS).toEqual(normalizeTuiConfig({}));
    });
  });
});
