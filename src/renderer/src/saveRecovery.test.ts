import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { SAVE_RECOVERY_PREVIEW_LIMIT, redactedPreview, summarizeSaveRecoveryJournal } from "./saveRecovery";
import { REDACTION_MASK } from "@shared/configSafety";

const REVEALING_CONFIG = [
  '[providers.openai]',
  'type = "openai"',
  'api_key = "sk-very-secret-value"',
  "base_url = \"https://api.example.com/v1?token=query-secret\"",
  "Authorization = \"Bearer abcdef\"",
].join("\n");

describe("summarizeSaveRecoveryJournal", () => {
  it("lists only changed files and reports unchanged count / createdAt", () => {
    const summary = summarizeSaveRecoveryJournal({
      version: 1,
      kind: "save-app-state",
      createdAt: "2026-09-15T10:00:00.000Z",
      textFiles: [
        { path: "/cfg/config.toml", originalContent: "old", desiredContent: "new" },
        { path: "/cfg/mcp.json", originalContent: "old-mcp", desiredContent: "old-mcp" },
      ],
    });

    expect(summary.record).not.toBeNull();
    expect(summary.createdAt).toBe("2026-09-15T10:00:00.000Z");
    expect(summary.unchangedCount).toBe(1);
    expect(summary.changedFiles).toHaveLength(1);
    expect(summary.changedFiles[0].path).toBe("/cfg/config.toml");
  });

  it("marks files created by the save (null original) without an original preview", () => {
    const summary = summarizeSaveRecoveryJournal({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [
        { path: "/cfg/tui.toml", originalContent: null, desiredContent: "theme = \"dark\"" },
      ],
    });

    expect(summary.changedFiles[0].hasOriginal).toBe(false);
    expect(summary.changedFiles[0].originalPreview).toBe("");
    expect(summary.changedFiles[0].desiredPreview).toContain("theme");
  });

  it("redacts API keys, Authorization and token query params from previews", () => {
    const summary = summarizeSaveRecoveryJournal({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [
        {
          path: "/cfg/config.toml",
          originalContent: "",
          desiredContent: REVEALING_CONFIG,
        },
      ],
    });

    const preview = summary.changedFiles[0].desiredPreview;
    expect(preview).not.toContain("sk-very-secret-value");
    expect(preview).not.toContain("Bearer abcdef");
    expect(preview).not.toContain("query-secret");
    expect(preview).toContain(REDACTION_MASK);
    expect(preview).toContain("api.example.com");
  });

  it("truncates long previews at the configured limit", () => {
    const longDocument = "x".repeat(SAVE_RECOVERY_PREVIEW_LIMIT * 3);
    const preview = redactedPreview(longDocument);
    expect(preview.length).toBe(SAVE_RECOVERY_PREVIEW_LIMIT + 1); // + "…"
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns an empty summary for malformed or non-record journals", () => {
    expect(summarizeSaveRecoveryJournal(null)).toMatchObject({
      record: null,
      changedFiles: [],
      unchangedCount: 0,
      createdAt: "",
    });
    expect(summarizeSaveRecoveryJournal({ version: 99, kind: "unknown" })).toMatchObject({
      record: null,
      changedFiles: [],
    });
  });

  it("keeps redacted paths free of embedded URL query secrets", () => {
    const summary = summarizeSaveRecoveryJournal({
      version: 1,
      kind: "save-app-state",
      createdAt: "now",
      textFiles: [{
        path: "https://example.com/config?api_key=hs",
        originalContent: "a",
        desiredContent: "b",
      }],
    });
    expect(summary.changedFiles[0].redactedPath).not.toContain("api_key=hs");
  });
});
