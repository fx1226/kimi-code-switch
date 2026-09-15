import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@shared/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Shared business logic is exercised elsewhere; here we isolate backup.ts orchestration.
vi.mock("@shared/configStore", () => ({
  normalizeStatePaths: (s: AppState) => s,
  buildConfigDocument: () => "config-doc",
  buildProfilesDocument: () => "profiles-doc",
  buildPanelSettingsDocument: () => "panel-doc",
  parsePanelSettingsDocument: () => ({ shortcuts: [] }),
  loadAppState: vi.fn(async () => ({ tag: "loaded" })),
  createLineDiff: () => "diff",
  getKimiCodeTuiConfigPath: (home: string) => `${home}/tui.toml`,
}));
vi.mock("@shared/configSafety", () => ({
  buildConfigDoctorReport: () => ({ ok: true, generatedAt: "", issues: [], errorCount: 0, warningCount: 0, infoCount: 0 }),
  buildManagedDocuments: () => ({ config: "", panel: "", mcp: "" }),
  redactDocumentText: (t: string) => ({ text: t }),
  assessRestoreDocumentsRisk: vi.fn(() => ({
    items: [],
    tiers: { configHooks: [], stdioMcpCommands: [], remoteMcpEndpoints: [], agentsDocuments: [] },
  })),
}));
vi.mock("@shared/mcpStore", () => ({ buildMcpConfigDocument: () => "mcp-doc" }));
vi.mock("@shared/shortcutStore", () => ({ normalizeShortcuts: () => [] }));

// Mock factories must be self-contained (hoisted), so the mock surfaces are created inside
// the factory and the live references are pulled back via vi.mocked() after the imports.
vi.mock("./fileAccess", () => ({
  tauriFileAccess: {
    readText: vi.fn(async () => "current-doc"),
    writeText: vi.fn(async () => undefined),
    writeTextCas: vi.fn(async () => "written-hash"),
    removeTextCas: vi.fn(async () => undefined),
    ensureDir: vi.fn(async () => undefined),
  },
  beginRestoreTransaction: vi.fn(async () => undefined),
  completeRestoreTransaction: vi.fn(async () => undefined),
}));
vi.mock("./fileSnapshots", () => ({
  captureSnapshotForState: vi.fn(async () => ({ capturedAt: "now", files: {} })),
  detectExternalChangeConflict: vi.fn(async () => ({ conflict: null, snapshot: { capturedAt: "now", files: {} } })),
}));
vi.mock("./panelSettingsStore", () => ({
  exportPanelSettings: vi.fn(async () => "original-panel"),
  importPanelSettings: vi.fn(async () => true),
}));
vi.mock("./webdav", () => ({
  buildWebDavUrl: vi.fn((_s: unknown, extra: string[] = []) => `https://dav/${extra.join("/")}`),
  deleteWebDavPath: vi.fn(async () => undefined),
  downloadWebDavFile: vi.fn(async () => "remote-doc"),
  ensureWebDavCollection: vi.fn(async (_s: unknown, extra: string[] = []) => `https://dav/${extra.join("/")}`),
  pruneWebDavBackups: vi.fn(async () => undefined),
  readWebDavManifest: vi.fn(async () => [] as Array<{ name: string; createdAt: string }>),
  testWebDavConnection: vi.fn(async () => ({ ok: true, target: "https://dav" })),
  uploadWebDavFile: vi.fn(async () => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { assessRestoreDocumentsRisk } from "@shared/configSafety";
import { tauriFileAccess } from "./fileAccess";
import { captureSnapshotForState, detectExternalChangeConflict } from "./fileSnapshots";
import { importPanelSettings } from "./panelSettingsStore";
import * as webdavMod from "./webdav";
import {
  createBackupSnapshot,
  deleteBackup,
  listBackups,
  migrateLegacyWebDavBackup,
  restoreBackupSafe,
  restoreBackupDryRun,
  testBackupWebdav,
} from "./backup";

const mockedInvoke = vi.mocked(invoke);
const fa = vi.mocked(tauriFileAccess, { deep: true });
const webdav = vi.mocked(webdavMod);
const mockedDetectConflict = vi.mocked(detectExternalChangeConflict);
const mockedImportPanelSettings = vi.mocked(importPanelSettings);
const mockedAssessRisk = vi.mocked(assessRestoreDocumentsRisk);
void captureSnapshotForState;

function state(destination: "local" | "webdav"): AppState {
  return {
    configPath: "/cfg/config.toml",
    profilesPath: "/cfg/config.profiles.toml",
    panelSettingsPath: "/cfg/config.panel.toml",
    mcpConfigPath: "/cfg/mcp.json",
    panelSettings: {
      backup_destination_type: destination,
      backup_local_path: "/backups",
      backup_retention_count: 2,
      shortcuts: [],
      backup_webdav_url: "https://dav",
      backup_webdav_username: "u",
      backup_webdav_password: "p",
      backup_webdav_path: "/k",
    },
  } as unknown as AppState;
}

beforeEach(() => {
  vi.clearAllMocks();
  // hostname / list_subdirs / remove_dir all flow through invoke
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "hostname") return "My-Laptop" as never;
    if (cmd === "list_subdirs") return [] as never;
    return undefined as never;
  });
  fa.readText.mockResolvedValue("current-doc");
  fa.writeText.mockResolvedValue(undefined);
  fa.ensureDir.mockResolvedValue(undefined);
});

describe("createBackupSnapshot — local branch", () => {
  it("writes backup files + metadata through fileAccess and never touches WebDAV", async () => {
    const result = await createBackupSnapshot(state("local"), "manual");

    expect(result.ok).toBe(true);
    // stamp is YYYYMMDD-HHMMSS-mmm, host sanitized to lowercase
    expect(result.backupName).toMatch(/^backup-\d{8}-\d{6}-\d{3}-my-laptop$/);
    expect(result.backupPath).toContain("/backups/backup-");
    // 6 backup docs + 1 metadata file written; profiles live in config.panel.json.
    expect(fa.writeText).toHaveBeenCalledTimes(7);
    expect(mockedInvoke).toHaveBeenCalledWith("ensure_private_dir", expect.objectContaining({ path: expect.stringContaining("/backups/backup-") }));
    expect(webdav.uploadWebDavFile).not.toHaveBeenCalled();
  });

  it("rotates obsolete local backups beyond the retention count", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "hostname") return "host" as never;
      if (cmd === "list_subdirs") return ["backup-a", "backup-b", "backup-c"] as never; // 3 dirs, retention 2
      return undefined as never;
    });
    await createBackupSnapshot(state("local"), "manual");
    const removed = mockedInvoke.mock.calls.filter((c) => c[0] === "remove_dir");
    expect(removed).toHaveLength(1); // oldest one pruned
  });
});

describe("createBackupSnapshot — webdav branch", () => {
  it("uploads via WebDAV and prunes the manifest, never touching the local FS writer", async () => {
    const result = await createBackupSnapshot(state("webdav"), "manual");

    expect(result.ok).toBe(true);
    expect(webdav.ensureWebDavCollection).toHaveBeenCalled();
    // 6 backup docs + metadata uploaded; profiles live in config.panel.json.
    expect(webdav.uploadWebDavFile).toHaveBeenCalledTimes(7);
    expect(webdav.pruneWebDavBackups).toHaveBeenCalled();
    expect(fa.writeText).not.toHaveBeenCalled();
  });
});

describe("listBackups / deleteBackup branching", () => {
  it("lists local subdirs prefixed with backup-, newest first", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_subdirs") return ["backup-1", "other", "backup-2"] as never;
      return undefined as never;
    });
    const records = await listBackups(state("local"));
    expect(records.map((r) => r.name)).toEqual(["backup-2", "backup-1"]);
  });

  it("lists WebDAV backups from the manifest", async () => {
    webdav.readWebDavManifest.mockResolvedValueOnce([
      { name: "backup-1", createdAt: "2026-01-01" },
      { name: "backup-2", createdAt: "2026-01-02" },
    ]);
    const records = await listBackups(state("webdav"));
    expect(records.map((r) => r.name)).toEqual(["backup-2", "backup-1"]);
    expect(webdav.readWebDavManifest).toHaveBeenCalled();
  });

  it("deletes a local backup directory via remove_dir", async () => {
    await deleteBackup(state("local"), "backup-x");
    expect(mockedInvoke).toHaveBeenCalledWith("remove_dir", { path: "/backups/backup-x" });
  });

  it("deletes a WebDAV backup and rewrites the manifest", async () => {
    webdav.readWebDavManifest.mockResolvedValueOnce([{ name: "backup-x", createdAt: "2026-01-01" }]);
    await deleteBackup(state("webdav"), "backup-x");
    expect(webdav.deleteWebDavPath).toHaveBeenCalled();
    expect(webdav.uploadWebDavFile).toHaveBeenCalled(); // manifest rewrite
  });
});

describe("testBackupWebdav", () => {
  it("delegates to testWebDavConnection", async () => {
    await expect(testBackupWebdav(state("webdav"))).resolves.toEqual({ ok: true, target: "https://dav" });
    expect(webdav.testWebDavConnection).toHaveBeenCalled();
  });
});

describe("migrateLegacyWebDavBackup", () => {
  it("explicitly reads legacy plaintext and rewrites every discovered file encrypted", async () => {
    webdav.downloadWebDavFile.mockResolvedValue("legacy-doc");

    const result = await migrateLegacyWebDavBackup(state("webdav"), "backup-old");

    expect(result).toEqual({ ok: true, migratedFiles: 9 });
    expect(webdav.downloadWebDavFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("backup-old/config.toml"),
      { allowLegacyPlaintext: true, legacyEncryptionPassword: "" },
    );
    expect(webdav.uploadWebDavFile).toHaveBeenCalledTimes(9);
  });

  it("is unavailable for local backup destinations", async () => {
    await expect(migrateLegacyWebDavBackup(state("local"), "backup-old"))
      .rejects.toThrow(/only available for WebDAV/);
  });
});

describe("restoreBackupSafe — rollback point", () => {
  it("includes TUI and AGENTS in the restore dry-run preview", async () => {
    const result = await restoreBackupDryRun(state("local"), "backup-x");
    expect("filePlans" in result).toBe(true);
    if (!("filePlans" in result)) return;
    expect(result.filePlans.map((plan) => plan.id)).toEqual(expect.arrayContaining([
      "config",
      "panel",
      "mcp",
      "tui",
      "agents",
    ]));
  });

  it("creates a pre-restore rollback snapshot, writes restored docs, and returns rollbackBackupName", async () => {
    const result = await restoreBackupSafe(state("local"), "backup-x", { allowOverwrite: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // rollback snapshot is itself a backup -> rollbackBackupName follows the backup naming
    expect(result.rollbackBackupName).toMatch(/^backup-/);
    // config/MCP plus TUI/AGENTS are restored; panel settings use SQLite import.
    const restoredWrites = fa.writeTextCas!.mock.calls.filter(([p]) => String(p).startsWith("/cfg/"));
    expect(restoredWrites).toHaveLength(4);
    expect(mockedImportPanelSettings).toHaveBeenCalledWith(expect.any(String));
  });

  it("returns an external-change conflict result without writing when a conflict is detected", async () => {
    mockedDetectConflict.mockResolvedValueOnce({
      conflict: { changedFiles: [{ id: "config" }] },
      snapshot: { capturedAt: "now", files: {} },
    } as never);

    const result = await restoreBackupSafe(state("local"), "backup-x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("external-change");
    // no restored docs written to managed paths
    const restoredWrites = fa.writeText.mock.calls.filter(([p]) => String(p).startsWith("/cfg/"));
    expect(restoredWrites).toHaveLength(0);
  });

  it("preflight runs when allowOverwrite is not true and blocks writes (no silent overwrite)", async () => {
    const conflictSnapshot = { capturedAt: "conflict", files: {} };
    mockedDetectConflict.mockResolvedValueOnce({
      conflict: { changedFiles: [{ id: "mcp" }] },
      snapshot: conflictSnapshot,
    } as never);

    const result = await restoreBackupSafe(state("local"), "backup-x", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected external-change block");
    expect(result.reason).toBe("external-change");
    expect(mockedDetectConflict).toHaveBeenCalledWith(expect.objectContaining({
      targetPaths: expect.objectContaining({ config: "/cfg/config.toml" }),
    }));
    // preflight 挡下后一份文档都不写盘（写盘前有 crash journal）
    expect(fa.writeTextCas).not.toHaveBeenCalled();
    expect(fa.writeText).not.toHaveBeenCalled();
    // 且没有触发任何“恢复”副作用（不会创建回滚备份）
    expect(mockedInvoke).not.toHaveBeenCalledWith(expect.stringMatching(/ensure_private_dir/), expect.anything());
  });

  it("keeps re-returning external-change across apply attempts while the conflict persists", async () => {
    // 模拟 dry-run 确认后、apply 前外部再次修改：即便以冲突 snapshot 为 expected 重试，
    // 只要冲突仍在，apply 仍返回 external-change，绝不因 allowRisk/重试而静默覆盖。
    const firstSnapshot = { capturedAt: "first", files: {} };
    const secondSnapshot = { capturedAt: "second", files: {} };
    mockedDetectConflict
      .mockResolvedValueOnce({ conflict: { changedFiles: [{ id: "config" }] }, snapshot: firstSnapshot } as never)
      .mockResolvedValueOnce({ conflict: { changedFiles: [{ id: "config" }] }, snapshot: secondSnapshot } as never);

    const first = await restoreBackupSafe(state("local"), "backup-x", {});
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected external-change");
    expect(first.reason).toBe("external-change");
    expect(first.snapshot).toEqual(firstSnapshot);

    // “二次确认”对应的重调：以该次返回的 snapshot 为新 expected，但故意仍不传 allowOverwrite——
    // 意味着用户尚未对该具体版本放行，冲突未消时继续被拦。
    const second = await restoreBackupSafe(state("local"), "backup-x", {
      expectedSnapshot: first.snapshot,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected external-change again");
    expect(second.reason).toBe("external-change");
    expect(fa.writeTextCas).not.toHaveBeenCalled();
    expect(fa.writeText).not.toHaveBeenCalled();

    // 仅当用户对该具体版本显式 allowOverwrite:true 才写盘（此时 preflight 跳过，无需再 mock conflict）。
    const allowed = await restoreBackupSafe(state("local"), "backup-x", {
      expectedSnapshot: first.snapshot,
      allowOverwrite: true,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(fa.writeTextCas).toHaveBeenCalled();
  });

  it("allowRisk retry keeps the external-change preflight armed (no allowOverwrite)", async () => {
    mockedAssessRisk.mockReturnValueOnce({
      items: ["config.toml: auto-execute commands detected"],
      tiers: { configHooks: [], stdioMcpCommands: [], remoteMcpEndpoints: [], agentsDocuments: [] },
    } as never);
    mockedDetectConflict.mockResolvedValueOnce({
      conflict: { changedFiles: [{ id: "config" }] },
      snapshot: { capturedAt: "now", files: {} },
    } as never);

    // allowRisk:true 只放行危险内容，绝不代表放行外部覆盖——preflight 依旧先执行。
    const result = await restoreBackupSafe(state("local"), "backup-x", { allowRisk: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected external-change");
    expect(result.reason).toBe("external-change");
    expect(fa.writeTextCas).not.toHaveBeenCalled();
  });

  it("B4: returns the full, untruncated risk list so the UI renders every item", async () => {
    const manyItems = Array.from({ length: 30 }, (_, index) => `item-${index + 1}: risky config detail ${index}`);
    mockedAssessRisk.mockReturnValueOnce({
      items: manyItems,
      tiers: { configHooks: manyItems, stdioMcpCommands: [], remoteMcpEndpoints: [], agentsDocuments: [] },
    } as never);

    const blocked = await restoreBackupSafe(state("local"), "backup-x", { allowOverwrite: true });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected dangerous-content");
    expect(blocked.reason).toBe("dangerous-content");
    // 数据路径不回传截断清单；完整 30 项全部保留给确认框展示。
    expect(blocked.risk.items).toHaveLength(30);
    expect(blocked.risk.items).toEqual(manyItems);
    expect(fa.writeTextCas).not.toHaveBeenCalled();
  });

  it("B4: blocks dangerous restore content by default and honors explicit allowRisk", async () => {
    // 1) 默认拒绝：危险内容出现时不写盘。
    mockedAssessRisk.mockReturnValueOnce({
      items: ["config.toml: auto-execute commands detected"],
      tiers: { configHooks: ["config.toml: auto-execute commands detected"], stdioMcpCommands: [], remoteMcpEndpoints: [], agentsDocuments: [] },
    } as never);
    const blocked = await restoreBackupSafe(state("local"), "backup-x", { allowOverwrite: true });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected restore to be blocked");
    expect(blocked.reason).toBe("dangerous-content");
    const writesBefore = fa.writeTextCas!.mock.calls.filter(([p]) => String(p).startsWith("/cfg/"));
    expect(writesBefore).toHaveLength(0);

    // 2) 显式 allowRisk 通过后走正常恢复。
    mockedAssessRisk.mockReturnValueOnce({
      items: ["config.toml: auto-execute commands detected"],
      tiers: { configHooks: ["config.toml: auto-execute commands detected"], stdioMcpCommands: [], remoteMcpEndpoints: [], agentsDocuments: [] },
    } as never);
    const allowed = await restoreBackupSafe(state("local"), "backup-x", { allowOverwrite: true, allowRisk: true });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    const restoredWrites = fa.writeTextCas!.mock.calls.filter(([p]) => String(p).startsWith("/cfg/"));
    expect(restoredWrites).toHaveLength(4);
  });
});
