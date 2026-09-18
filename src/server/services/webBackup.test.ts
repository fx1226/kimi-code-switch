import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { Target } from "../../shared/webApi";
import { createConfigurationService } from "../configuration";
import { clearDurableGrants, registerDurableGrant, resolveFinalTarget } from "../native/fs";
import { configureAppPaths } from "../native/paths";
import { closeUsageDb, getDb, openUsageDb } from "../native/usage";
import { createWebBackupService } from "./webBackup";

let base: string;
let dataDir: string;
let target: Target;
const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
function configDocument(model = "old", comment = "# original comment", newline = "\r\n"): string {
  return [comment, `default_model = "${model}"`, "[providers.test]", 'type = "openai"', 'api_key = "original-secret"',
    ...["old", "new", "updated", "legacy", "concurrent"].flatMap((name) => [`[models.${name}]`, 'provider = "test"', `model = "${name}"`]), ""].join(newline);
}
function write(path: string, content: string): void { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
function setup() {
  const configuration = createConfigurationService({ dataDir });
  return { configuration, backups: createWebBackupService(configuration) };
}
beforeEach(() => {
  clearDurableGrants();
  closeUsageDb();
  base = mkdtempSync(join(tmpdir(), "kimi-web-backup-"));
  dataDir = join(base, "app");
  configureAppPaths({ dataDir });
  registerDurableGrant(base, "DirectoryTree", "dialog");
  target = { id: "default", name: "Default", homePath: join(base, "native"), kind: "default" };
  mkdirSync(target.homePath);
  write(join(target.homePath, "config.toml"), configDocument());
  write(join(target.homePath, "mcp.json"), '{"mcpServers":{}}\n');
  write(join(target.homePath, "skills", "tool", "SKILL.md"), "# Tool\nUse the bundled script.\n");
  write(join(target.homePath, "skills", "tool", "run.sh"), "#!/bin/sh\nprintf ready\n");
  chmodSync(join(target.homePath, "skills", "tool", "run.sh"), 0o700);
  write(join(target.homePath, "plugins", "tool", "plugin.json"), '{"name":"tool"}');
});
afterEach(() => { closeUsageDb(); clearDurableGrants(); configureAppPaths(); rmSync(base, { recursive: true, force: true }); });

describe("web native backups", () => {
  it("lists healthy, damaged and unknown backup files independently and exports read-only entries unchanged", async () => {
    const { backups } = setup();
    const good = await backups.createBackup(target);
    const damagedName = `${randomUUID()}.json`;
    const damaged = '{"secret":"private-backup-content",\n';
    write(join(dataDir, "backups", damagedName), damaged);
    const unknown = '  {"format":"old-tool","payload":"legacy-content"}\r\n';
    write(join(dataDir, "backups", "old-tool-export.json"), unknown);
    const listed = await backups.listBackups(target);
    expect(listed).toHaveLength(3);
    expect(listed.find((item) => item.id === good.id)).toMatchObject({ restorable: true });
    for (const [name, original] of [[damagedName, damaged], ["old-tool-export.json", unknown]]) {
      const item = listed.find((entry) => entry.name === name)!;
      expect(item.id).toMatch(/^readonly-[a-f0-9]{64}$/);
      expect(item).toMatchObject({ restorable: false, diagnostic: expect.any(String) });
      expect((await backups.listBackups(target)).find((entry) => entry.name === name)?.id).toBe(item.id);
      expect((await backups.exportBackup(target, item.id)).content).toBe(original);
      await expect(backups.planRestore(target, item.id)).rejects.toThrow("Automatic restore is unavailable");
      expect(readFileSync(join(dataDir, "backups", name), "utf8")).toBe(original);
    }
    expect(JSON.stringify(listed)).not.toContain("private-backup-content");
    await expect(backups.exportBackup(target, "../outside.json")).rejects.toThrow("Invalid backup ID");
    await expect(backups.exportBackup(target, `readonly-${"0".repeat(64)}`)).rejects.toThrow("not found");
  });

  it("keeps legacy directory backups visible and exports every original file byte without restoring them", async () => {
    const { backups } = setup();
    const legacy = join(dataDir, "backups", "backup-legacy-directory");
    write(join(legacy, "config.toml"), '# legacy bytes\r\nkey = "value"\r\n');
    const binary = Buffer.from([0, 255, 128, 42]);
    writeFileSync(join(legacy, "opaque.bin"), binary);
    const [item] = await backups.listBackups(target);
    expect(item).toMatchObject({ restorable: false, name: "backup-legacy-directory" });
    const exported = await backups.exportBackup(target, item.id);
    const bundle = JSON.parse(exported.content).bundle;
    expect(exported.fileName).toBe("backup-legacy-directory.portable.json");
    const opaque = bundle.files.find((file: { relativePath: string }) => file.relativePath === "opaque.bin");
    expect(Buffer.from(opaque.contentBase64, "base64")).toEqual(binary);
    await expect(backups.planRestore(target, item.id)).rejects.toThrow("automatic restore is unavailable");
  });

  it("does not follow symlink entries and preserves unknown binary files through a byte-safe export envelope", async () => {
    const { backups } = setup();
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x42]);
    writeFileSync(join(dataDir, "backups", "old-binary.backup"), bytes);
    write(join(base, "outside-secret.json"), "must-not-be-read");
    symlinkSync(join(base, "outside-secret.json"), join(dataDir, "backups", "linked.json"));
    const listed = await backups.listBackups(target);
    const binary = listed.find((item) => item.name === "old-binary.backup")!;
    const link = listed.find((item) => item.name === "linked.json")!;
    expect(binary.restorable).toBe(false);
    const exported = JSON.parse((await backups.exportBackup(target, binary.id)).content);
    expect(Buffer.from(exported.content, exported.encoding)).toEqual(bytes);
    expect(link.restorable).toBe(false);
    await expect(backups.exportBackup(target, link.id)).rejects.toThrow("will not be followed");
    expect(JSON.stringify(listed)).not.toContain("must-not-be-read");
  });

  it("restores an early v1 backup without deleting project MCP files that were never captured", async () => {
    const { backups, configuration } = setup();
    const projectTarget = { ...target, workingDirectory: join(base, "early-project") };
    mkdirSync(projectTarget.workingDirectory);
    const created = await backups.createBackup(projectTarget);
    const archivePath = join(dataDir, "backups", `${created.id}.json`);
    const early = JSON.parse(readFileSync(archivePath, "utf8"));
    early.resources = early.resources.filter((item: { resource: string }) => item.resource !== "mcp-project" && item.resource !== "mcp-local");
    early.excluded = early.excluded.filter((item: { resource: string }) => item.resource !== "mcp-project" && item.resource !== "mcp-local");
    const originalArchive = JSON.stringify(early, null, 2);
    writeFileSync(archivePath, originalArchive);
    const projectMcp = '{"mcpServers":{"keep-project":{"command":"echo"}}}';
    const localMcp = '{"mcpServers":{"keep-local":{"command":"echo"}}}';
    write(join(projectTarget.workingDirectory, ".mcp.json"), projectMcp);
    write(join(projectTarget.workingDirectory, ".kimi-code", "mcp.json"), localMcp);
    write(join(target.homePath, "config.toml"), configDocument("new"));
    expect((await backups.listBackups(projectTarget))[0]).toMatchObject({ id: created.id, restorable: true, diagnostic: expect.stringContaining("will be preserved") });
    expect((await backups.exportBackup(projectTarget, created.id)).content).toBe(originalArchive);
    const plan = await backups.planRestore(projectTarget, created.id);
    expect(plan.resources?.some((item) => item.resource === "mcp-project" || item.resource === "mcp-local")).toBe(false);
    expect(plan.diagnostics.some((item) => item.code === "earlier-backup-scopes-preserved")).toBe(true);
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(projectTarget.workingDirectory, ".mcp.json"), "utf8")).toBe(projectMcp);
    expect(readFileSync(join(projectTarget.workingDirectory, ".kimi-code", "mcp.json"), "utf8")).toBe(localMcp);
    expect(readFileSync(archivePath, "utf8")).toBe(originalArchive);
  });

  it("stores exact native text and portable trees privately without runtime credentials or summary secrets", async () => {
    write(join(target.homePath, "credentials", "auth.json"), "home-secret");
    write(join(target.homePath, "sessions", "session.json"), "session-secret");
    write(join(target.homePath, "plugins", "tool", "credentials.json"), "plugin-secret");
    write(join(target.homePath, "plugins", "tool", "logs", "debug.log"), "log-secret");
    const { backups } = setup();
    const before = readFileSync(join(target.homePath, "config.toml"), "utf8");
    const created = await backups.createBackup(target);
    const exported = await backups.exportBackup(target, created.id);
    const archive = JSON.parse(exported.content);
    expect(created.resources).toEqual(["home:config", "home:mcp", "home:tui", "home:agents", "home:skills-directory", "home:plugins-directory"]);
    expect(archive.resources.find((item: { resource: string }) => item.resource === "config").content).toBe(before);
    expect(archive.excluded).toContainEqual(expect.objectContaining({ resource: "project-local", scope: "project" }));
    expect(archive.excluded).toContainEqual(expect.objectContaining({ resource: "mcp-project", scope: "project" }));
    expect(archive.excluded).toContainEqual(expect.objectContaining({ resource: "mcp-local", scope: "local" }));
    expect(exported.content).not.toContain("home-secret");
    expect(exported.content).not.toContain(Buffer.from("plugin-secret").toString("base64"));
    expect(exported.content).not.toContain(Buffer.from("log-secret").toString("base64"));
    expect(JSON.stringify(created)).not.toContain("original-secret");
    expect(await backups.listBackups(target)).toEqual([created]);
    expect(readFileSync(join(target.homePath, "config.toml"), "utf8")).toBe(before);
    if (process.platform !== "win32") expect(statSync(join(dataDir, "backups", `${created.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("restores text, absent files and both directories in one reviewed kernel transaction", async () => {
    const { backups, configuration } = setup();
    const original = readFileSync(join(target.homePath, "config.toml"), "utf8");
    const backup = await backups.createBackup(target);
    write(join(target.homePath, "config.toml"), configDocument("new"));
    write(join(target.homePath, "tui.toml"), 'theme = "dark"\n');
    write(join(target.homePath, "skills", "tool", "SKILL.md"), "changed");
    write(join(target.homePath, "plugins", "new", "plugin.json"), "{}");
    write(join(target.homePath, "plugins", "tool", "credentials.json"), "keep-current-secret");
    const plan = await backups.planRestore(target, backup.id);
    expect(plan.resources).toHaveLength(6);
    expect(JSON.stringify(plan.redactedPreview)).not.toContain("original-secret");
    expect(JSON.stringify(plan.redactedPreview)).not.toContain(Buffer.from("keep-current-secret").toString("base64"));
    expect(readFileSync(join(target.homePath, "config.toml"), "utf8")).toContain('"new"');
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(target.homePath, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(target.homePath, "tui.toml"))).toBe(false);
    expect(readFileSync(join(target.homePath, "skills", "tool", "SKILL.md"), "utf8")).toContain("# Tool");
    expect(existsSync(join(target.homePath, "plugins", "new"))).toBe(false);
    expect(readFileSync(join(target.homePath, "plugins", "tool", "credentials.json"), "utf8")).toBe("keep-current-secret");
    if (process.platform !== "win32") expect(statSync(join(target.homePath, "skills", "tool", "run.sh")).mode & 0o100).toBe(0o100);
  });

  it("imports under the selected target and never uses the original native home as a restore destination", async () => {
    const { backups, configuration } = setup();
    const source = await backups.createBackup(target);
    const exported = await backups.exportBackup(target, source.id);
    const other: Target = { id: "external", name: "External", homePath: join(base, "other"), kind: "external" };
    mkdirSync(other.homePath);
    const imported = await backups.importBackup(other, exported.content);
    expect(imported.id).not.toBe(source.id);
    expect(imported.targetId).toBe(other.id);
    await expect(backups.exportBackup(other, source.id)).rejects.toThrow("does not belong");
    expect(await backups.listBackups(other)).toEqual([imported]);
    const plan = await backups.planRestore(other, imported.id);
    expect(plan.resources?.every((resource) => resource.path.startsWith(`${resolveFinalTarget(other.homePath)}/`))).toBe(true);
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(other.homePath, "skills", "tool", "SKILL.md"), "utf8")).toContain("# Tool");
  });

  it("remaps only source-home plugin roots while preserving source, origin and external plugin metadata", async () => {
    const { backups, configuration } = setup();
    const managedRoot = join(target.homePath, "plugins", "managed", "copied");
    write(join(managedRoot, "kimi.plugin.json"), '{"name":"copied"}');
    const installed = { version: 1, plugins: [
      { id: "copied", root: resolveFinalTarget(managedRoot), source: "github", originalSource: "https://github.com/example/plugin", github: { owner: "example", repo: "plugin", ref: { kind: "tag", value: "v1" } }, enabled: true },
      { id: "external", root: "/external-plugins/not-in-backup", source: "local-path", originalSource: "/original-plugin-source", enabled: false },
    ] };
    write(join(target.homePath, "plugins", "installed.json"), JSON.stringify(installed));
    const created = await backups.createBackup(target);
    const archive = JSON.parse((await backups.exportBackup(target, created.id)).content);
    expect(archive.sourceHome).toBe(resolveFinalTarget(target.homePath));
    const other: Target = { ...target, id: "destination", homePath: join(base, "destination") };
    mkdirSync(other.homePath);
    const imported = await backups.importBackup(other, JSON.stringify(archive));
    const plan = await backups.planRestore(other, imported.id);
    expect(plan.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["plugin-roots-remapped", "external-plugin-roots-preserved"]));
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    const restored = JSON.parse(readFileSync(join(other.homePath, "plugins", "installed.json"), "utf8"));
    expect(restored.plugins[0]).toEqual({ ...installed.plugins[0], root: resolveFinalTarget(join(other.homePath, "plugins", "managed", "copied")) });
    expect(restored.plugins[1]).toEqual(installed.plugins[1]);
    expect(JSON.parse(readFileSync(join(target.homePath, "plugins", "installed.json"), "utf8"))).toEqual(installed);
  });

  it("includes project-local only with selected cwd and requires a selected destination project for restore", async () => {
    const { backups, configuration } = setup();
    const projectTarget = { ...target, workingDirectory: join(base, "project") };
    write(join(projectTarget.workingDirectory, ".kimi-code", "local.toml"), 'additional_dirs = ["/workspace"]\n');
    const created = await backups.createBackup(projectTarget);
    expect(created.resources).toContain("project:project-local");
    expect(created.resources).toContain("project:mcp-project");
    expect(created.resources).toContain("local:mcp-local");
    await expect(backups.planRestore(target, created.id)).rejects.toThrow("working directory");
    const plan = await backups.planRestore(projectTarget, created.id);
    expect(plan.resources).toHaveLength(9);
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
  });

  it("resolves a nested working directory to the same nearest Git project root as the application", async () => {
    const { backups, configuration } = setup();
    const projectRoot = join(base, "git-project");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const cwd = join(projectRoot, "src", "nested");
    mkdirSync(cwd, { recursive: true });
    write(join(projectRoot, ".kimi-code", "local.toml"), 'additional_dirs = ["root"]\n');
    write(join(cwd, ".kimi-code", "local.toml"), 'additional_dirs = ["wrong-nested"]\n');
    const projectMcp = '{"mcpServers":{"project":{"command":"echo","args":["root"]}}}';
    const localMcp = '{"mcpServers":{"local":{"command":"echo","args":["cwd"]}}}';
    write(join(projectRoot, ".mcp.json"), projectMcp);
    write(join(cwd, ".kimi-code", "mcp.json"), localMcp);
    write(join(cwd, ".mcp.json"), '{"mcpServers":{}}');
    write(join(projectRoot, ".kimi-code", "mcp.json"), '{"mcpServers":{}}');
    const projectTarget = { ...target, workingDirectory: cwd };
    const created = await backups.createBackup(projectTarget);
    const archive = JSON.parse((await backups.exportBackup(projectTarget, created.id)).content);
    expect(archive.resources.find((item: { resource: string }) => item.resource === "project-local").content).toContain('"root"');
    expect(archive.resources.find((item: { resource: string }) => item.resource === "mcp-project")).toMatchObject({ scope: "project", content: projectMcp });
    expect(archive.resources.find((item: { resource: string }) => item.resource === "mcp-local")).toMatchObject({ scope: "local", content: localMcp });
    write(join(projectRoot, ".mcp.json"), '{"mcpServers":{}}');
    write(join(cwd, ".kimi-code", "mcp.json"), '{"mcpServers":{}}');
    const plan = await backups.planRestore(projectTarget, created.id);
    expect(plan.resources?.find((resource) => resource.resource === "project-local")?.path).toBe(resolveFinalTarget(join(projectRoot, ".kimi-code", "local.toml")));
    expect(plan.resources?.find((resource) => resource.resource === "mcp-project")?.path).toBe(resolveFinalTarget(join(projectRoot, ".mcp.json")));
    expect(plan.resources?.find((resource) => resource.resource === "mcp-local")?.path).toBe(resolveFinalTarget(join(cwd, ".kimi-code", "mcp.json")));
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(projectRoot, ".mcp.json"), "utf8")).toBe(projectMcp);
    expect(readFileSync(join(cwd, ".kimi-code", "mcp.json"), "utf8")).toBe(localMcp);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
    expect(readFileSync(join(projectRoot, ".kimi-code", "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
  });

  it("rejects import checksums, extra paths, traversal, duplicate resources and noncanonical base64 before persistence", async () => {
    const { backups } = setup();
    const created = await backups.createBackup(target);
    const exported = await backups.exportBackup(target, created.id);
    const tamper = () => JSON.parse(exported.content);
    const wrongHash = tamper(); wrongHash.resources[0].content = "changed";
    await expect(backups.importBackup(target, JSON.stringify(wrongHash))).rejects.toThrow("checksum");
    const extraPath = tamper(); extraPath.resources[0].path = "/outside/config.toml";
    await expect(backups.importBackup(target, JSON.stringify(extraPath))).rejects.toThrow("unsupported fields");
    const duplicate = tamper(); duplicate.resources[1] = duplicate.resources[0];
    await expect(backups.importBackup(target, JSON.stringify(duplicate))).rejects.toThrow("schema");
    for (const path of ["../escape", "/absolute", "C:/absolute", "tool\\escape"]) {
      const traversal = tamper();
      const entry = traversal.resources.find((item: { resource: string }) => item.resource === "skills-directory");
      entry.content = JSON.stringify({ exists: true, directories: [], files: [{ relativePath: path, contentBase64: "eA==", executable: false }] });
      entry.sha256 = digest(entry.content);
      await expect(backups.importBackup(target, JSON.stringify(traversal))).rejects.toThrow("portable path");
    }
    const badBase64 = tamper();
    const entry = badBase64.resources.find((item: { resource: string }) => item.resource === "skills-directory");
    entry.content = JSON.stringify({ exists: true, directories: [], files: [{ relativePath: "SKILL.md", contentBase64: "%%%", executable: false }] });
    entry.sha256 = digest(entry.content);
    await expect(backups.importBackup(target, JSON.stringify(badBase64))).rejects.toThrow("portable file schema");
    expect(readdirSync(join(dataDir, "backups"))).toEqual([`${created.id}.json`]);
  });

  it("aborts a backup when an official process changes a resource during capture", async () => {
    const { configuration } = setup();
    const read = configuration.read.bind(configuration);
    let count = 0;
    vi.spyOn(configuration, "read").mockImplementation(async (...args) => {
      if (++count === 7) write(join(target.homePath, "config.toml"), configDocument("concurrent"));
      return read(...args);
    });
    const backups = createWebBackupService(configuration);
    await expect(backups.createBackup(target)).rejects.toThrow("changed during backup");
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });

  it("filters operation history by actual target paths and restores original bytes through the kernel", async () => {
    const { configuration, backups } = setup();
    const current = await configuration.read({ home: target.homePath }, "config");
    const plan = await configuration.plan({ home: target.homePath }, { resource: "config", expectedRevision: current.revision, changes: [{ op: "set", path: ["default_model"], value: "updated" }] });
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    const history = await backups.listHistory(target);
    expect(history.map((item) => item.id)).toEqual([plan.id]);
    expect(JSON.stringify(history)).not.toContain("original-secret");
    const other: Target = { ...target, id: "another", homePath: join(base, "another") };
    mkdirSync(other.homePath);
    expect(await backups.listHistory(other)).toEqual([]);
    await expect(backups.planHistoryRestore(other, plan.id)).rejects.toThrow("does not belong");
    const restore = await backups.planHistoryRestore(target, plan.id);
    expect((await configuration.commit(restore.id, { expectedRevision: restore.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(target.homePath, "config.toml"), "utf8")).toBe(current.content);
  });

  it("preserves migrated SQLite snapshots and restores only a matching native target through the kernel", async () => {
    openUsageDb(join(dataDir, "app.db"), "CREATE TABLE config_history (id INTEGER PRIMARY KEY, snapshot_at TEXT, file_id TEXT, sha256 TEXT, snapshot_path TEXT, target_path TEXT)");
    const old = configDocument("legacy", "# older comment", "\n");
    const snapshotPath = join(dataDir, "history", "1.toml.gz");
    mkdirSync(join(dataDir, "history"));
    writeFileSync(snapshotPath, gzipSync(old));
    getDb().prepare("INSERT INTO config_history VALUES (?, ?, ?, ?, ?, ?)").run(7, "2026-09-01T00:00:00.000Z", "config", digest(old), snapshotPath, join(target.homePath, "config.toml"));
    const { configuration, backups } = setup();
    expect((await backups.listHistory(target))[0]).toMatchObject({ id: "legacy-7", resource: "config", status: "legacy-snapshot" });
    const plan = await backups.planHistoryRestore(target, "legacy-7");
    expect((await configuration.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(target.homePath, "config.toml"), "utf8")).toBe(old);
  });

  it("restores mixed directory history without replacing current credentials from older snapshots", async () => {
    const { configuration, backups } = setup();
    const created = await backups.createBackup(target);
    write(join(target.homePath, "skills", "tool", "SKILL.md"), "before restore");
    write(join(target.homePath, "plugins", "tool", "credentials.json"), "credential-before");
    const restore = await backups.planRestore(target, created.id);
    expect((await configuration.commit(restore.id, { expectedRevision: restore.expectedRevision })).status).toBe("succeeded");
    write(join(target.homePath, "plugins", "tool", "credentials.json"), "credential-current");
    const undo = await backups.planHistoryRestore(target, restore.id);
    expect((await configuration.commit(undo.id, { expectedRevision: undo.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(target.homePath, "skills", "tool", "SKILL.md"), "utf8")).toBe("before restore");
    expect(readFileSync(join(target.homePath, "plugins", "tool", "credentials.json"), "utf8")).toBe("credential-current");
  });
});
