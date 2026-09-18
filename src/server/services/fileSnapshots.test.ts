import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({ invokeCommand: vi.fn() }));
vi.mock("./fileAccess", () => ({
  serverFileAccess: { readText: vi.fn() },
}));
vi.mock("./panelSettingsStore", () => ({ getPanelSettings: vi.fn() }));

import { invokeCommand as invoke } from "../native";
import { buildPanelSettingsSnapshot, createDefaultPanelSettings } from "@shared/configStore";
import type { FileFingerprint, ManagedFileId } from "@shared/types";
import { serverFileAccess } from "./fileAccess";
import { getPanelSettings } from "./panelSettingsStore";
import {
  captureSnapshotForPaths,
  detectChangeReason,
  detectExternalChangeConflict,
  fingerprintFile,
  readManagedDocuments,
} from "./fileSnapshots";

const mockedInvoke = vi.mocked(invoke);
const mockedReadText = vi.mocked(serverFileAccess.readText);
const mockedGetPanelSettings = vi.mocked(getPanelSettings);

const paths: Record<ManagedFileId, string> = {
  config: "/env/config.toml",
  panel: "/panel/settings",
  mcp: "/env/mcp.json",
};

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedReadText.mockReset();
  mockedGetPanelSettings.mockReset();
});

describe("fileSnapshots", () => {
  it("fingerprints missing and existing native files plus SQLite panel settings", async () => {
    mockedInvoke.mockResolvedValueOnce(null as never).mockResolvedValueOnce({
      size: 12,
      mtime_ms: 42,
      ino: 7,
    } as never);
    mockedReadText.mockResolvedValueOnce("config-body");
    mockedGetPanelSettings.mockResolvedValue(createDefaultPanelSettings("/env/config.toml", "/panel/settings"));

    const missing = await fingerprintFile("mcp", paths.mcp);
    const existing = await fingerprintFile("config", paths.config);
    const panel = await fingerprintFile("panel", paths.panel);

    expect(missing).toMatchObject({ exists: false, sha256: "" });
    expect(existing).toMatchObject({ exists: true, size: 12, mtimeMs: 42 });
    expect(existing.sha256).toHaveLength(64);
    expect(panel).toMatchObject({ exists: true, mtimeMs: 0 });
    expect(panel.sha256).toHaveLength(64);
  });

  it("captures and reads all managed documents", async () => {
    mockedInvoke.mockResolvedValue({ size: 3, mtime_ms: 1, ino: 1 } as never);
    mockedReadText.mockImplementation(async (path: string) => path.endsWith("mcp.json") ? "mcp" : "cfg");
    mockedGetPanelSettings.mockResolvedValue(createDefaultPanelSettings("/env/config.toml", "/panel/settings"));

    const snapshot = await captureSnapshotForPaths(paths);
    const documents = await readManagedDocuments(paths);

    expect(Object.keys(snapshot.files)).toEqual(["config", "panel", "mcp"]);
    expect(documents.config).toBe("cfg");
    expect(documents.mcp).toBe("mcp");
    expect(documents.panel).toContain("config_target");
  });

  it("measures non-ASCII panel snapshots in UTF-8 bytes", async () => {
    const settings = createDefaultPanelSettings("/环境/config.toml", "/panel/settings");
    mockedGetPanelSettings.mockResolvedValue(settings);

    const fingerprint = await fingerprintFile("panel", paths.panel);
    const document = buildPanelSettingsSnapshot(settings);

    expect(fingerprint.size).toBe(Buffer.byteLength(document, "utf8"));
    expect(fingerprint.size).toBeGreaterThan(document.length);
  });

  it("classifies revisions and reports only disk/draft conflicts with redacted secrets", async () => {
    const base = (id: ManagedFileId, exists: boolean, sha256: string): FileFingerprint => ({
      id,
      path: paths[id],
      exists,
      size: 1,
      mtimeMs: 1,
      sha256,
    });
    expect(detectChangeReason(base("config", false, ""), base("config", true, "a"))).toBe("created");
    expect(detectChangeReason(base("config", true, "a"), base("config", false, ""))).toBe("deleted");
    expect(detectChangeReason(base("config", true, "a"), base("config", true, "b"))).toBe("modified");
    expect(detectChangeReason(base("config", true, "a"), base("config", true, "a"))).toBeNull();

    mockedInvoke.mockImplementation(async (_command: string, args?: unknown) => {
      const path = (args as { path: string }).path;
      return { size: 20, mtime_ms: 2, ino: 2, path } as never;
    });
    mockedReadText.mockImplementation(async (path: string) => path.endsWith("config.toml")
      ? 'api_key = "disk-secret"'
      : "same");
    mockedGetPanelSettings.mockResolvedValue(null);
    const expected = {
      capturedAt: "before",
      files: {
        config: base("config", true, "old"),
        panel: base("panel", false, ""),
        mcp: base("mcp", true, "old"),
      },
    };

    const result = await detectExternalChangeConflict({
      expectedSnapshot: expected,
      targetPaths: paths,
      draftDocuments: {
        config: 'api_key = "draft-secret"',
        panel: "",
        mcp: "same",
      },
    });

    expect(result.conflict?.changedFiles).toHaveLength(1);
    expect(result.conflict?.changedFiles[0].diskDocument).not.toContain("disk-secret");
    expect(result.conflict?.changedFiles[0].draftDocument).not.toContain("draft-secret");
  });
});
