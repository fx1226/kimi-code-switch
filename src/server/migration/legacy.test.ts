import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureAppPaths, getAppPaths } from "../native/paths";
import { applyLegacyMigration, hasPendingLegacyMigration, previewLegacyMigration } from "./legacy";
import { closeUsageDb, isDbOpen, openUsageDb } from "../native/usage";
import { storesCommands } from "../native/stores";
import { createConfigurationService } from "../configuration";
import { readMetadata, savePreferences } from "../metadata";

let dir: string;
let legacy: string;
beforeEach(() => {
  closeUsageDb();
  dir = mkdtempSync(join(tmpdir(), "switch-migration-"));
  vi.stubEnv("HOME", dir);
  vi.stubEnv("KIMI_CODE_HOME", join(dir, "native"));
  configureAppPaths({ dataDir: join(dir, "new") });
  legacy = getAppPaths().legacyDataDir;
  mkdirSync(legacy, { recursive: true });
});
afterEach(() => { closeUsageDb(); configureAppPaths(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function seed(): void {
  mkdirSync(join(legacy, ".env", "default"), { recursive: true });
  writeFileSync(join(legacy, ".env", "default", "config.toml"), "# original native config\n");
  mkdirSync(join(legacy, "history"));
  writeFileSync(join(legacy, "history", "first.gz"), "snapshot");
  mkdirSync(join(legacy, "official-accounts"));
  writeFileSync(join(legacy, "official-accounts", "private.json"), "credential-placeholder");
  const db = new DatabaseSync(join(legacy, "app.db"));
  db.exec("CREATE TABLE panel_settings (id INTEGER, kimi_code_environments TEXT); CREATE TABLE config_history(id INTEGER, snapshot_path TEXT, target_path TEXT)");
  db.exec("CREATE TABLE official_accounts(id TEXT); INSERT INTO official_accounts VALUES ('archived-account'); CREATE TABLE env_config(id TEXT); INSERT INTO env_config VALUES ('retired-mirror')");
  db.prepare("INSERT INTO panel_settings VALUES (?, ?)").run(1, JSON.stringify([{ id: "default", homePath: join(legacy, ".env", "default") }]));
  db.prepare("INSERT INTO config_history VALUES (?, ?, ?)").run(1, join(legacy, "history", "first.gz"), join(legacy, ".env", "default", "config.toml"));
  db.close();
}

describe("explicit private data migration", () => {
  it("previews without creating private state and copies only after confirmation", async () => {
    seed();
    const sourceBefore = readFileSync(join(legacy, "app.db"));
    const preview = previewLegacyMigration();
    expect(preview.status).toBe("available");
    expect(existsSync(getAppPaths().dataDir)).toBe(false);
    expect(preview.entries.find((entry) => entry.path === ".env")?.action).toBe("retain");
    const result = await applyLegacyMigration({ manifestHash: preview.manifestHash });
    expect(result.status).toBe("complete");
    expect(readFileSync(join(legacy, "app.db"))).toEqual(sourceBefore);
    expect(existsSync(join(getAppPaths().dataDir, ".env"))).toBe(false);
    expect(existsSync(join(result.archiveDir, "official-accounts", "private.json"))).toBe(true);
    const db = new DatabaseSync(getAppPaths().databasePath, { readOnly: true });
    const row = db.prepare("SELECT * FROM config_history").get()!;
    expect(row.snapshot_path).toBe(join(getAppPaths().historyDir, "first.gz"));
    expect(row.target_path).toBe(join(legacy, ".env", "default", "config.toml"));
    expect(String(db.prepare("SELECT kimi_code_environments FROM panel_settings").get()!.kimi_code_environments)).toContain(legacy);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('official_accounts', 'env_config')").all()).toEqual([]);
    db.close();
    const archived = new DatabaseSync(join(result.archiveDir, "app.db"), { readOnly: true });
    expect(archived.prepare("SELECT id FROM official_accounts").get()?.id).toBe("archived-account");
    archived.close();
    expect(await applyLegacyMigration({ manifestHash: preview.manifestHash })).toEqual(result);
    expect(previewLegacyMigration().status).toBe("complete");
  });

  it("rejects stale previews and a live legacy process", async () => {
    writeFileSync(join(legacy, "backup-encryption.key"), "before");
    const preview = previewLegacyMigration();
    writeFileSync(join(legacy, "backup-encryption.key"), "after");
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/changed since preview/);
    writeFileSync(join(legacy, "server.lock"), JSON.stringify({ pid: process.pid, token: "legacy", startedAt: "now" }));
    expect(previewLegacyMigration()).toMatchObject({ status: "blocked", blockedReason: expect.stringContaining("is running") });
  });

  it("refuses to overwrite a populated destination database", async () => {
    seed();
    mkdirSync(getAppPaths().dataDir);
    const db = new DatabaseSync(getAppPaths().databasePath);
    db.exec("CREATE TABLE settings (value TEXT); INSERT INTO settings VALUES ('keep')");
    db.close();
    expect(previewLegacyMigration().status).toBe("blocked");
    const original = readFileSync(getAppPaths().databasePath);
    await expect(applyLegacyMigration({ manifestHash: "wrong" })).rejects.toThrow(/contains data/);
    expect(readFileSync(getAppPaths().databasePath)).toEqual(original);
  });

  it("accepts an initialized empty schema and closes its connection before replacing it", async () => {
    seed();
    openUsageDb(getAppPaths().databasePath, "");
    storesCommands.init_panel_settings_store({});
    storesCommands.init_config_history({});
    expect(isDbOpen()).toBe(true);
    const preview = previewLegacyMigration();
    expect(preview.status).toBe("available");
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).resolves.toMatchObject({ status: "complete" });
    expect(isDbOpen()).toBe(false);
    const db = new DatabaseSync(getAppPaths().databasePath, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM panel_settings").get()?.n).toBe(1);
    db.close();
  });

  it("resumes a partial commit and keeps the original directory intact", async () => {
    writeFileSync(join(legacy, "backup-encryption.key"), "key-one");
    writeFileSync(join(legacy, "backup-encryption.key.previous"), "key-two");
    mkdirSync(getAppPaths().dataDir);
    const conflict = join(getAppPaths().dataDir, "backup-encryption.key.previous");
    writeFileSync(conflict, "existing");
    const preview = previewLegacyMigration();
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/different data/);
    expect(readFileSync(conflict, "utf8")).toBe("existing");
    rmSync(conflict);
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).resolves.toMatchObject({ status: "complete" });
    expect(readFileSync(join(legacy, "backup-encryption.key"), "utf8")).toBe("key-one");
    expect(readFileSync(conflict, "utf8")).toBe("key-two");
  });

  it("resumes after reading metadata from a partial database migration without initializing its schema", async () => {
    seed();
    writeFileSync(join(legacy, "backup-encryption.key"), "original-key");
    mkdirSync(getAppPaths().dataDir);
    const conflict = join(getAppPaths().dataDir, "backup-encryption.key");
    writeFileSync(conflict, "existing-key");
    const sourceBefore = readFileSync(join(legacy, "app.db"));
    const preview = previewLegacyMigration();
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/different data/);
    const targetBefore = readFileSync(getAppPaths().databasePath);
    const metadata = await readMetadata();
    expect(metadata.targets).toHaveLength(1);
    expect(readFileSync(getAppPaths().databasePath)).toEqual(targetBefore);
    expect(isDbOpen()).toBe(false);
    rmSync(conflict);
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).resolves.toMatchObject({ status: "complete" });
    expect(readFileSync(join(legacy, "app.db"))).toEqual(sourceBefore);
    expect(readFileSync(join(getAppPaths().dataDir, "archive/legacy-v1/app.db"))).toEqual(sourceBefore);
    expect(readdirSync(getAppPaths().dataDir, { recursive: true }).some((path) => String(path).includes(".migration-"))).toBe(false);
    expect(lstatSync(getAppPaths().databasePath).mode & 0o777).toBe(0o600);
    expect((await readMetadata()).targets[0].homePath).toBe(join(legacy, ".env/default"));
  });

  it("keeps an unfinished database read-only if the legacy source disappears", async () => {
    seed();
    mkdirSync(getAppPaths().historyDir, { recursive: true });
    writeFileSync(join(getAppPaths().historyDir, "first.gz"), "conflict");
    await expect(applyLegacyMigration({ manifestHash: previewLegacyMigration().manifestHash })).rejects.toThrow(/different data/);
    const targetBefore = readFileSync(getAppPaths().databasePath);
    rmSync(legacy, { recursive: true });
    expect(hasPendingLegacyMigration()).toBe(true);
    expect(previewLegacyMigration()).toMatchObject({ status: "blocked", blockedReason: expect.stringContaining("source") });
    await readMetadata();
    await expect(savePreferences({ theme: "dark" })).rejects.toThrow("迁移");
    expect(readFileSync(getAppPaths().databasePath)).toEqual(targetBefore);
    expect(isDbOpen()).toBe(false);
  });

  it("still refuses actual external database changes after a partial migration and metadata read", async () => {
    seed();
    writeFileSync(join(legacy, "backup-encryption.key"), "original-key");
    mkdirSync(getAppPaths().dataDir);
    const conflict = join(getAppPaths().dataDir, "backup-encryption.key");
    writeFileSync(conflict, "existing-key");
    const sourceBefore = readFileSync(join(legacy, "app.db"));
    const preview = previewLegacyMigration();
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/different data/);
    await readMetadata();
    closeUsageDb();
    const database = new DatabaseSync(getAppPaths().databasePath);
    database.exec("CREATE TABLE external_change(value TEXT); INSERT INTO external_change VALUES ('keep')");
    database.close();
    const changed = readFileSync(getAppPaths().databasePath);
    rmSync(conflict);
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/migration verification failed: app.db/);
    expect(readFileSync(getAppPaths().databasePath)).toEqual(changed);
    expect(readFileSync(join(legacy, "app.db"))).toEqual(sourceBefore);
  });

  it("ignores a leftover fixed-name temporary symlink without touching its external target", async () => {
    writeFileSync(join(legacy, "backup-encryption.key"), "original-key");
    mkdirSync(getAppPaths().dataDir);
    const external = join(dir, "external-key");
    writeFileSync(external, "external-original");
    const leftover = join(getAppPaths().dataDir, "backup-encryption.key.migration-tmp");
    symlinkSync(external, leftover);
    const preview = previewLegacyMigration();
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).resolves.toMatchObject({ status: "complete" });
    expect(readFileSync(external, "utf8")).toBe("external-original");
    expect(lstatSync(leftover).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(getAppPaths().dataDir, "backup-encryption.key")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(legacy, "backup-encryption.key"), "utf8")).toBe("original-key");
    expect(readdirSync(getAppPaths().dataDir).filter((name) => name.startsWith(".backup-encryption.key."))).toEqual([]);
  });

  it.each(["stage", "archive"] as const)("rejects a dangling %s symlink before creating an external file", async (location) => {
    seed();
    const preview = previewLegacyMigration();
    const external = join(dir, "external-database");
    const sourceBefore = readFileSync(join(legacy, "app.db"));
    if (location === "stage") {
      mkdirSync(getAppPaths().historyDir, { recursive: true });
      const conflict = join(getAppPaths().historyDir, "first.gz");
      writeFileSync(conflict, "existing-snapshot");
      await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/different data/);
      const journal = JSON.parse(readFileSync(join(getAppPaths().migrationDir, "legacy-v1.json"), "utf8"));
      const stage = join(journal.stageDir, "active/app.db");
      rmSync(stage);
      symlinkSync(external, stage);
      rmSync(conflict);
    } else {
      const archive = join(getAppPaths().dataDir, "archive/legacy-v1");
      mkdirSync(archive, { recursive: true });
      symlinkSync(external, join(archive, "app.db"));
    }
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/symbolic link|escapes/);
    expect(existsSync(external)).toBe(false);
    expect(readFileSync(join(legacy, "app.db"))).toEqual(sourceBefore);
  });

  it.each(["backup-encryption.key", "history"])("rejects dangling destination component %s", async (component) => {
    writeFileSync(join(legacy, "backup-encryption.key"), "original-key");
    mkdirSync(join(legacy, "history"));
    writeFileSync(join(legacy, "history", "first.gz"), "snapshot");
    mkdirSync(getAppPaths().dataDir);
    const external = join(dir, "missing-external");
    symlinkSync(external, join(getAppPaths().dataDir, component));
    await expect(applyLegacyMigration({ manifestHash: previewLegacyMigration().manifestHash })).rejects.toThrow(/symbolic link|escapes/);
    expect(existsSync(external)).toBe(false);
    expect(readFileSync(join(legacy, "backup-encryption.key"), "utf8")).toBe("original-key");
  });

  it("blocks malformed recovery paths and destination symlink escapes", async () => {
    writeFileSync(join(legacy, "backup-encryption.key"), "key-one");
    mkdirSync(getAppPaths().migrationDir, { recursive: true });
    writeFileSync(join(getAppPaths().migrationDir, "legacy-v1.json"), JSON.stringify({ version: 1, entries: [], committed: [], stageDir: dir }));
    expect(previewLegacyMigration()).toMatchObject({ status: "blocked", blockedReason: expect.stringContaining("recovery record is invalid") });
    rmSync(join(getAppPaths().migrationDir, "legacy-v1.json"));
    const outside = join(dir, "outside.key");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, join(getAppPaths().dataDir, "backup-encryption.key"));
    const preview = previewLegacyMigration();
    await expect(applyLegacyMigration({ manifestHash: preview.manifestHash })).rejects.toThrow(/escapes the data directory/);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("keeps pending native recovery journals active after private data migration", async () => {
    const names = ["pending-save-transaction.json", "pending-restore-transaction.json"];
    for (const name of names) writeFileSync(join(legacy, name), `{"unknown-native-revision":"${name}"}\n`);
    const preview = previewLegacyMigration();
    expect(preview.entries.map((entry) => entry.action)).toEqual(["copy", "copy"]);
    await applyLegacyMigration({ manifestHash: preview.manifestHash });
    for (const name of names) expect(readFileSync(join(getAppPaths().dataDir, name))).toEqual(readFileSync(join(legacy, name)));
    const configuration = createConfigurationService({ dataDir: getAppPaths().dataDir });
    await expect(configuration.assertWritable()).rejects.toMatchObject({ code: "recovery-required" });
    expect((await configuration.getRecoveryState()).blocked).toBe(true);
  });
});
