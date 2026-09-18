import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Preferences } from "@shared/webApi";
import type { Profile } from "@shared/types";
import { addTarget, deletePreset, forgetTarget, getTarget, listPresets, readMetadata, savePreferences, savePreset, updateTarget } from "./metadata";
import { configureAppPaths, getAppPaths } from "./native/paths";
import { authorizeMutation, clearDurableGrants, getDurableGrantsState } from "./native/fs";
import { closeUsageDb, isDbOpen } from "./native/usage";
import { findLegacyProcessBlocker, hasPendingLegacyMigration, previewLegacyMigration } from "./migration/legacy";
import { getPanelSettings, savePanelSettings } from "./services/panelSettingsStore";

vi.mock("./migration/legacy", () => ({ findLegacyProcessBlocker: vi.fn(), hasPendingLegacyMigration: vi.fn(), previewLegacyMigration: vi.fn() }));

let root: string;
let privateDir: string;
let kimiHome: string;

beforeEach(() => {
  closeUsageDb();
  clearDurableGrants();
  root = realpathSync(mkdtempSync(join(tmpdir(), "kimi-metadata-test-")));
  privateDir = join(root, "switch");
  kimiHome = join(root, "native");
  vi.stubEnv("HOME", root);
  vi.stubEnv("KIMI_CODE_HOME", kimiHome);
  configureAppPaths({ dataDir: privateDir });
  vi.mocked(findLegacyProcessBlocker).mockReturnValue(null);
  vi.mocked(hasPendingLegacyMigration).mockReturnValue(false);
  vi.mocked(previewLegacyMigration).mockReturnValue({ status: "absent", sourceDir: "unused", targetDir: privateDir, manifestHash: "", entries: [] });
});

afterEach(() => {
  closeUsageDb();
  clearDurableGrants();
  configureAppPaths({ dataDir: null });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function existingDirectory(name: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("private metadata", () => {
  it("reads a fresh default target from KIMI_CODE_HOME without creating any store or native directory", async () => {
    const result = await readMetadata();
    expect(result.targets).toEqual([{ id: "default", name: "默认目录", kind: "default", homePath: kimiHome }]);
    expect(result.settings.config_path).toBe(join(kimiHome, "config.toml"));
    expect(result.preferences.activeTargetId).toBe("default");
    expect(isDbOpen()).toBe(false);
    expect(existsSync(privateDir)).toBe(false);
    expect(existsSync(kimiHome)).toBe(false);
  });

  it("does not create a database for an empty or unchanged preferences write", async () => {
    const initial = (await readMetadata()).preferences;
    expect(await savePreferences({})).toEqual(initial);
    expect(await savePreferences(initial)).toEqual(initial);
    expect(existsSync(getAppPaths().databasePath)).toBe(false);
  });

  it("returns a safe default view while migration owns the unfinished database", async () => {
    mkdirSync(privateDir);
    writeFileSync(getAppPaths().databasePath, "unfinished-database");
    vi.mocked(hasPendingLegacyMigration).mockReturnValue(true);
    expect((await readMetadata()).targets).toEqual([{ id: "default", name: "默认目录", kind: "default", homePath: kimiHome }]);
    expect(readFileSync(getAppPaths().databasePath, "utf8")).toBe("unfinished-database");
    expect(isDbOpen()).toBe(false);
  });

  it("serializes concurrent preference updates and returns each committed preference view", async () => {
    const [first, second] = await Promise.all([
      savePreferences({ theme: "dark" }),
      savePreferences({ locale: "ja-JP" }),
    ]);
    expect(first.theme).toBe("dark");
    expect(first.locale).not.toBe("ja-JP");
    expect(second).toEqual({ theme: "dark", locale: "ja-JP", activeTargetId: "default" });
    closeUsageDb();
    expect((await readMetadata()).preferences).toEqual(second);
    expect(existsSync(kimiHome)).toBe(false);
  });

  it("retains persisted explicit homes when KIMI_CODE_HOME changes, including the default target", async () => {
    await savePreferences({ theme: "dark" });
    const external = await addTarget({ name: "External", homePath: existingDirectory("external") });
    const newHome = join(root, "new-native-home");
    vi.stubEnv("KIMI_CODE_HOME", newHome);
    const result = await readMetadata();
    expect(result.targets.find((target) => target.id === "default")?.homePath).toBe(kimiHome);
    expect(result.targets.find((target) => target.id === external.id)?.homePath).toBe(external.homePath);
    expect(result.settings.config_path).toBe(join(kimiHome, "config.toml"));
    // Read normalization did not rewrite private persistence either.
    expect((await getPanelSettings())?.config_path).toBe(join(kimiHome, "config.toml"));
    expect(existsSync(newHome)).toBe(false);
  });

  it.each(["~/.kimi-code", "", undefined])("follows KIMI_CODE_HOME for an official or missing default home %s", async (homePath) => {
    await savePreferences({ theme: "dark" });
    const stored = (await getPanelSettings())!;
    stored.kimi_code_environments![0].homePath = homePath as string;
    await savePanelSettings(stored);
    const newHome = join(root, "new-native-home");
    vi.stubEnv("KIMI_CODE_HOME", newHome);
    expect((await readMetadata()).targets[0].homePath).toBe(newHome);
    expect((await readMetadata()).settings.config_path).toBe(join(newHome, "config.toml"));
    expect(existsSync(newHome)).toBe(false);
  });

  it("keeps a migrated legacy default reference through migration, metadata read and subsequent preference writes", async () => {
    const actualMigration = await vi.importActual<typeof import("./migration/legacy")>("./migration/legacy");
    const legacyDir = getAppPaths().legacyDataDir;
    const legacyHome = join(legacyDir, ".env/default");
    mkdirSync(legacyHome, { recursive: true });
    const config = join(legacyHome, "config.toml");
    writeFileSync(config, "# retained official native config\n");
    const database = new DatabaseSync(join(legacyDir, "app.db"));
    database.exec("CREATE TABLE panel_settings (id INTEGER PRIMARY KEY, kimi_code_environments TEXT)");
    database.prepare("INSERT INTO panel_settings VALUES (?, ?)").run(1, JSON.stringify([
      { id: "default", name: "旧版默认目录", homePath: legacyHome, kind: "default" },
    ]));
    database.close();
    const originalDatabase = readFileSync(join(legacyDir, "app.db"));
    const preview = actualMigration.previewLegacyMigration();
    expect(preview.status).toBe("available");
    await expect(actualMigration.applyLegacyMigration({ manifestHash: preview.manifestHash })).resolves.toMatchObject({ status: "complete" });
    expect(existsSync(join(getAppPaths().migrationDir, "legacy-v1.json"))).toBe(true);
    expect((await readMetadata()).targets[0]).toMatchObject({ id: "default", homePath: legacyHome });
    expect((await readMetadata()).settings.config_path).toBe(config);
    await savePreferences({ theme: "dark" });
    closeUsageDb();
    expect((await readMetadata()).targets[0].homePath).toBe(legacyHome);
    expect((await getPanelSettings())!.kimi_code_environments![0].homePath).toBe(legacyHome);
    expect(readFileSync(join(legacyDir, "app.db"))).toEqual(originalDatabase);
    expect(readFileSync(config, "utf8")).toBe("# retained official native config\n");
    expect(existsSync(kimiHome)).toBe(false);
    expect(existsSync(join(privateDir, ".env"))).toBe(false);
  });

  it("normalizes stale selection and persisted preference values only in the effective read view", async () => {
    await savePreferences({ theme: "dark" });
    const stored = (await getPanelSettings())!;
    await savePanelSettings({ ...stored, theme: "broken" as Preferences["theme"], locale: "broken" as Preferences["locale"], active_kimi_code_environment_id: "deleted" });
    const view = await readMetadata();
    expect(view.preferences).toMatchObject({ theme: "auto", activeTargetId: "default" });
    expect(view.preferences.locale).not.toBe("broken");
    expect((await getPanelSettings())?.active_kimi_code_environment_id).toBe("deleted");
  });

  it("rejects invalid preferences and recovers its write queue after a rejected selection", async () => {
    await expect(savePreferences({ theme: "invalid" } as unknown as Partial<Preferences>)).rejects.toThrow("主题");
    await expect(savePreferences({ locale: "invalid" } as unknown as Partial<Preferences>)).rejects.toThrow("语言");
    await expect(savePreferences({ activeTargetId: "missing" })).rejects.toThrow("未知");
    expect(existsSync(privateDir)).toBe(false);
    expect((await savePreferences({ theme: "dark" })).theme).toBe("dark");
  });

  it("registers canonical external targets and scoped project config grants without modifying native files", async () => {
    const home = existingDirectory("external-home");
    const project = existingDirectory("project");
    mkdirSync(join(project, ".git"));
    const cwd = existingDirectory("project/packages/app");
    const alias = join(root, "external-link");
    symlinkSync(home, alias);
    const target = await addTarget({ name: "  Workspace  ", homePath: alias, workingDirectory: cwd });
    expect(target).toMatchObject({ name: "Workspace", homePath: home, kind: "external", workingDirectory: cwd });
    expect(await getTarget(target.id)).toEqual(target);
    const grants = getDurableGrantsState();
    expect(authorizeMutation(grants, join(home, "config.toml"), "SingleFile")).toBe(join(home, "config.toml"));
    expect(authorizeMutation(grants, join(project, ".kimi-code/local.toml"), "SingleFile")).toBe(join(project, ".kimi-code/local.toml"));
    expect(authorizeMutation(grants, join(project, ".mcp.json"), "SingleFile")).toBe(join(project, ".mcp.json"));
    expect(authorizeMutation(grants, join(cwd, ".kimi-code/mcp.json"), "SingleFile")).toBe(join(cwd, ".kimi-code/mcp.json"));
    expect(() => authorizeMutation(grants, join(project, "README.md"), "SingleFile")).toThrow("outside");
    expect(() => authorizeMutation(grants, join(project, ".mcp.json/unrelated"), "SingleFile")).toThrow("outside");
    expect(existsSync(join(project, ".kimi-code"))).toBe(false);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    const grantFile = JSON.parse(readFileSync(getAppPaths().accessGrantsPath, "utf8"));
    expect(grantFile.grants.some((grant: { root: string }) => grant.root === join(project, ".kimi-code"))).toBe(true);
    await expect(addTarget({ name: "Duplicate", homePath: home })).rejects.toThrow("已经添加");
  });

  it("updates the default target project without creating or redirecting its native home", async () => {
    const project = existingDirectory("project");
    mkdirSync(join(project, ".git"));
    const cwd = existingDirectory("project/nested");
    const target = await updateTarget({ targetId: "default", name: "  项目配置  ", workingDirectory: cwd });
    expect(target).toEqual({ id: "default", name: "项目配置", kind: "default", homePath: kimiHome, workingDirectory: cwd });
    closeUsageDb();
    expect(await getTarget("default")).toEqual(target);
    expect(existsSync(kimiHome)).toBe(false);
    expect(existsSync(join(project, ".kimi-code"))).toBe(false);
    expect(existsSync(join(cwd, ".kimi-code"))).toBe(false);
    const grants = JSON.parse(readFileSync(getAppPaths().accessGrantsPath, "utf8")).grants;
    expect(grants.map(({ root: grantRoot, kind }: { root: string; kind: string }) => ({ root: grantRoot, kind }))).toEqual([
      { root: join(project, ".kimi-code"), kind: "DirectoryTree" },
      { root: join(project, ".mcp.json"), kind: "File" },
      { root: join(cwd, ".kimi-code"), kind: "DirectoryTree" },
    ]);
    expect((await updateTarget({ targetId: "default", name: "Renamed" })).workingDirectory).toBe(cwd);
    expect(await updateTarget({ targetId: "default", workingDirectory: null })).toEqual({ id: "default", name: "Renamed", kind: "default", homePath: kimiHome });
    expect((await readMetadata()).settings.config_path).toBe(join(kimiHome, "config.toml"));
  });

  it("deduplicates project root grants and leaves unrelated workspace paths unauthorized", async () => {
    const cwd = existingDirectory("project");
    await updateTarget({ targetId: "default", workingDirectory: cwd });
    const grants = getDurableGrantsState();
    expect(grants.filter((grant) => grant.root === join(cwd, ".kimi-code"))).toHaveLength(1);
    expect(authorizeMutation(grants, join(cwd, ".mcp.json"), "SingleFile")).toBe(join(cwd, ".mcp.json"));
    expect(() => authorizeMutation(grants, join(cwd, "README.md"), "SingleFile")).toThrow("outside");
  });

  it("rejects invalid target updates before creating private state and recovers after failure", async () => {
    await expect(updateTarget({ targetId: "missing", name: "Other" })).rejects.toThrow("不存在");
    await expect(updateTarget({ targetId: "default", name: " " })).rejects.toThrow("名称");
    await expect(updateTarget({ targetId: "default", workingDirectory: join(root, "missing") })).rejects.toThrow("工作目录");
    await expect(updateTarget({ targetId: "default", homePath: join(root, "redirect") } as Parameters<typeof updateTarget>[0])).rejects.toThrow("不能修改");
    expect(existsSync(privateDir)).toBe(false);
    expect((await updateTarget({ targetId: "default" })).homePath).toBe(kimiHome);
    expect(existsSync(privateDir)).toBe(false);
    expect((await updateTarget({ targetId: "default", name: "Renamed" })).homePath).toBe(kimiHome);
  });

  it.each([".kimi-code", ".mcp.json", "nested/.kimi-code"])("rejects an update with redirected project config %s before any grant or metadata write", async (redirected) => {
    const project = existingDirectory("project");
    mkdirSync(join(project, ".git"));
    const cwd = existingDirectory("project/nested");
    symlinkSync(existingDirectory("outside"), join(project, redirected));
    await expect(updateTarget({ targetId: "default", workingDirectory: cwd })).rejects.toThrow("符号链接");
    expect(existsSync(privateDir)).toBe(false);
    expect(getDurableGrantsState()).toEqual([]);
  });

  it("creates explicitly requested managed directories but refuses missing external directories", async () => {
    const managed = join(privateDir, "environments/team");
    const target = await addTarget({ name: "Team", homePath: managed });
    expect(target.kind).toBe("managed");
    expect(existsSync(managed)).toBe(true);
    await expect(addTarget({ name: "Outside", homePath: join(root, "missing") })).rejects.toThrow("外部目录");
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  it("rejects invalid working directories and copy requests before creating managed directories", async () => {
    const managed = join(privateDir, "environments/bad");
    await expect(addTarget({ name: "Bad", homePath: managed, workingDirectory: join(root, "missing-workspace") })).rejects.toThrow("工作目录");
    await expect(addTarget({ name: "Bad", homePath: managed, copyFromTargetId: "default" })).rejects.toThrow("备份");
    await expect(addTarget({ name: " ", homePath: managed })).rejects.toThrow("名称");
    expect(existsSync(privateDir)).toBe(false);
  });

  it("rejects symlink escapes for managed creation and project configuration grants", async () => {
    const outside = existingDirectory("outside");
    mkdirSync(privateDir);
    symlinkSync(outside, join(privateDir, "environments"));
    await expect(addTarget({ name: "Escape", homePath: join(privateDir, "environments/new") })).rejects.toThrow("外部目录");
    expect(existsSync(join(outside, "new"))).toBe(false);
    const workspace = existingDirectory("workspace");
    symlinkSync(outside, join(workspace, ".kimi-code"));
    await expect(addTarget({ name: "Escape", homePath: existingDirectory("another-home"), workingDirectory: workspace })).rejects.toThrow("符号链接");
    expect(existsSync(getAppPaths().databasePath)).toBe(false);
  });

  it("forgets only the reference and moves the active selection to the remaining target", async () => {
    const home = existingDirectory("external-home");
    const sentinel = join(home, "config.toml");
    writeFileSync(sentinel, "# keep native file\n");
    const target = await addTarget({ name: "External", homePath: home });
    await savePreferences({ activeTargetId: target.id });
    await forgetTarget({ targetId: target.id });
    expect((await readMetadata()).preferences.activeTargetId).toBe("default");
    expect(readFileSync(sentinel, "utf8")).toBe("# keep native file\n");
    await expect(forgetTarget({ targetId: "default" })).rejects.toThrow("至少保留");
  });

  it("keeps preset changes scoped to their target", async () => {
    const target = await addTarget({ name: "External", homePath: existingDirectory("external-home") });
    const preset: Profile = { name: "work", label: "Work", default_model: "test-model", default_permission_mode: "manual", default_plan_mode: false, merge_all_available_skills: true };
    await savePreset({ targetId: target.id, preset });
    expect(await listPresets({ targetId: target.id })).toEqual([preset]);
    expect((await listPresets({ targetId: "default" })).some((item) => item.name === "work")).toBe(false);
    await deletePreset({ targetId: target.id, name: "work" });
    expect(await listPresets({ targetId: target.id })).toEqual([]);
  });

  it.each(["available", "blocked"] as const)("blocks metadata writes while legacy migration is %s", async (status) => {
    vi.mocked(previewLegacyMigration).mockReturnValue({ status, sourceDir: "unused", targetDir: privateDir, manifestHash: "", entries: [] });
    await readMetadata();
    await expect(savePreferences({ theme: "dark" })).rejects.toThrow("迁移");
    await expect(addTarget({ name: "Managed", homePath: join(privateDir, "environments/new") })).rejects.toThrow("迁移");
    expect(existsSync(privateDir)).toBe(false);
  });

  it("blocks writes when the legacy process is running, while preserving read access", async () => {
    vi.mocked(findLegacyProcessBlocker).mockReturnValue("legacy process is running");
    expect((await readMetadata()).targets).toHaveLength(1);
    await expect(savePreferences({ theme: "dark" })).rejects.toThrow("legacy process");
    expect(existsSync(privateDir)).toBe(false);
  });
});
