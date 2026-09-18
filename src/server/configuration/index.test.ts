import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearDurableGrants, registerDurableGrant } from "../native/fs";
import { withTargetWriteLock } from "../native/targetLock";
import { createConfigurationService, redactResourcePreview, type ConfigurationServiceOptions } from "./index";
import { portableContent } from "./portable";

let base: string;
let home: string;
let dataDir: string;
beforeEach(() => {
  clearDurableGrants();
  base = mkdtempSync(join(tmpdir(), "kimi-configuration-"));
  home = join(base, "native");
  dataDir = join(base, "switch");
  mkdirSync(home);
  registerDurableGrant(base, "DirectoryTree", "dialog");
});
afterEach(() => { clearDurableGrants(); rmSync(base, { recursive: true, force: true }); });

const setup = (options: Partial<ConfigurationServiceOptions> = {}) => createConfigurationService({ dataDir, ...options });
const configPath = () => join(home, "config.toml");
async function planModel(service: ReturnType<typeof setup>, value = "new") {
  const snapshot = await service.read({ home }, "config");
  return service.plan({ home }, { resource: "config", expectedRevision: snapshot.revision, changes: [{ op: "set", path: ["fixture_label"], value }] });
}

describe("native configuration transactions", () => {
  it("refuses an annotated array replacement before creating a transaction or modifying a file", async () => {
    const original = 'extra_skill_dirs = [\n  "/fixture/first", # first source\n  "/fixture/second",\n]\n';
    writeFileSync(configPath(), original);
    const service = setup();
    const snapshot = await service.read({ home }, "config");
    await expect(service.plan({ home }, {
      resource: "config", expectedRevision: snapshot.revision,
      changes: [{ op: "set", path: ["extra_skill_dirs"], value: ["/fixture/new"] }],
    })).rejects.toMatchObject({ code: "UNSUPPORTED_STRUCTURE" });
    expect(readFileSync(configPath(), "utf8")).toBe(original);
    for (const directory of ["configuration-backups", "configuration-journals"]) {
      const path = join(dataDir, directory);
      expect(existsSync(path) ? readdirSync(path) : []).toEqual([]);
    }
  });

  it.each(["", " \t\r\n\n"])("keeps blank MCP bytes and revision unchanged for a no-op: %j", async (original) => {
    const path = join(home, "mcp.json");
    writeFileSync(path, original);
    const before = statSync(path);
    const service = setup();
    const snapshot = await service.read({ home }, "mcp");
    const plan = await service.plan({ home }, {
      resource: "mcp", expectedRevision: snapshot.revision,
      changes: [{ op: "delete", path: ["mcpServers", "missing"] }],
    });
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect((await service.read({ home }, "mcp")).revision).toBe(snapshot.revision);
  });

  it("patches only the requested value and durably backs up and records the operation", async () => {
    const original = '# chosen by CLI\nfixture_label = "old" # retain me\n\n[future]\nopaque = [1, 2, 3]\n';
    writeFileSync(configPath(), original);
    const service = setup();
    const plan = await planModel(service);
    expect(plan.validation).toBe("unavailable");
    expect(plan.diagnostics[0].code).toBe("official-validation-unavailable");
    const operation = await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
    expect(operation.status).toBe("succeeded");
    expect(readFileSync(configPath(), "utf8")).toBe(original.replace('"old"', '"new"'));
    const backup = JSON.parse(readFileSync(join(dataDir, "configuration-backups", `${plan.id}.json`), "utf8"));
    expect(backup.documents[0].content).toBe(original);
    expect(readdirSync(join(dataDir, "configuration-journals"))).toEqual([]);
    expect(setup().getOperation(plan.id)).toEqual(operation);
    expect(await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).toEqual(operation);
    if (process.platform !== "win32") expect(statSync(join(dataDir, "configuration-backups", `${plan.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("leaves native files unchanged when the mandatory backup cannot be written", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "configuration-backups"), "not a directory");
    const service = setup();
    const plan = await planModel(service);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("failed");
    expect(readFileSync(configPath(), "utf8")).toBe('fixture_label = "old"\n');
  });

  it("serializes concurrent writes to the same real file and rejects the stale revision", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    const service = setup();
    const first = await planModel(service, "first");
    const second = await planModel(service, "second");
    const results = await Promise.all([service.commit(first.id, { expectedRevision: first.expectedRevision }), service.commit(second.id, { expectedRevision: second.expectedRevision })]);
    expect(results.map((operation) => operation.status)).toEqual(["succeeded", "conflict"]);
    expect(readFileSync(configPath(), "utf8")).toContain('"first"');
  });

  it("rechecks the exact revision after backup and journal preparation", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    const external = 'fixture_label = "official-app"\n';
    const service = setup({ fault(point) { if (point === "before-write") writeFileSync(configPath(), external); } });
    const plan = await planModel(service);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("conflict");
    expect(readFileSync(configPath(), "utf8")).toBe(external);
  });

  it("rolls back a partial config/TUI batch when a later write fails", async () => {
    const original = 'fixture_label = "old"\n';
    const tui = 'theme = "dark" # keep\n';
    writeFileSync(configPath(), original);
    writeFileSync(join(home, "tui.toml"), tui);
    let writes = 0;
    const service = setup({ fault(point) { if (point === "after-write" && ++writes === 1) throw new Error("injected I/O failure"); } });
    const config = await service.read({ home }, "config");
    const tuiSnapshot = await service.read({ home }, "tui");
    const plan = await service.planBatch({ home }, [
      { resource: "config", expectedRevision: config.revision, changes: [{ op: "set", path: ["fixture_label"], value: "new" }] },
      { resource: "tui", expectedRevision: tuiSnapshot.revision, changes: [{ op: "set", path: ["theme"], value: "light" }] },
    ]);
    expect(plan.resources).toHaveLength(2);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("failed");
    expect(readFileSync(configPath(), "utf8")).toBe(original);
    expect(readFileSync(join(home, "tui.toml"), "utf8")).toBe(tui);
    expect((await service.getRecoveryState()).blocked).toBe(false);
  });

  it("retains unknown revisions and enforces the recovery gate across all resource writes", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    const external = 'fixture_label = "concurrent-external"\n';
    const service = setup({ fault(point) { if (point === "after-write") writeFileSync(configPath(), external); } });
    const plan = await planModel(service);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("recovery-required");
    const restarted = setup();
    expect((await restarted.getRecoveryState()).blocked).toBe(true);
    await expect(restarted.assertWritable()).rejects.toMatchObject({ code: "recovery-required" });
    const agents = await restarted.plan({ home }, { resource: "agents", expectedRevision: "", content: "new instructions" });
    await expect(restarted.commit(agents.id, { expectedRevision: "" })).rejects.toMatchObject({ code: "recovery-required" });
    expect(readFileSync(configPath(), "utf8")).toBe(external);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  });

  it("recovers a durable interrupted operation only after the target matches a known revision", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    const service = setup({ fault(point) { if (point === "after-write") writeFileSync(configPath(), 'fixture_label = "unknown"\n'); } });
    const plan = await planModel(service);
    await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
    // Model a crash after the desired bytes reached disk but before the durable commit record.
    writeFileSync(configPath(), 'fixture_label = "new"\n');
    const restarted = setup();
    expect((await restarted.recover()).blocked).toBe(false);
    expect(restarted.getOperation(plan.id)?.status).toBe("succeeded");
    expect(readdirSync(join(dataDir, "configuration-journals"))).toEqual([]);
  });

  it("waits for the shared target lock and rereads revisions during simultaneous recovery requests", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    const service = setup({ fault(point) { if (point === "after-write") writeFileSync(configPath(), 'fixture_label = "external"\n'); } });
    const plan = await planModel(service);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("recovery-required");
    const restarted = setup();
    let finished = false;
    let recoveries!: Promise<unknown>;
    await withTargetWriteLock(configPath(), async () => {
      recoveries = Promise.all([restarted.recover(), restarted.recover()]).then((states) => {
        expect(states.every((state) => !state.blocked)).toBe(true);
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(finished).toBe(false);
      // The owner changes the revision while recovery is waiting on the shared lock.
      writeFileSync(configPath(), 'fixture_label = "new"\n');
    });
    await recoveries;
    expect(restarted.getOperation(plan.id)?.status).toBe("succeeded");
    expect(readdirSync(join(dataDir, "configuration-journals"))).toEqual([]);
  });

  it("blocks on malformed and legacy journals without mutating native files", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    mkdirSync(join(dataDir, "configuration-journals"), { recursive: true });
    writeFileSync(join(dataDir, "configuration-journals", "bad.json"), "{broken");
    writeFileSync(join(dataDir, "pending-save-transaction.json"), "{}");
    const service = setup();
    const state = await service.getRecoveryState();
    expect(state.diagnostics.map((item) => item.code)).toEqual(["legacy-recovery-required", "invalid-journal"]);
    await expect(service.assertWritable()).rejects.toMatchObject({ code: "recovery-required" });
    expect(readFileSync(configPath(), "utf8")).toBe('fixture_label = "old"\n');
  });

  it("restores original document bytes and supports a reviewed absent-file restoration", async () => {
    writeFileSync(configPath(), 'fixture_label = "new"\n');
    writeFileSync(join(home, "AGENTS.md"), "temporary instruction");
    const original = '# exact backup\r\nfixture_label = "old"\r\n';
    const service = setup();
    const config = await service.read({ home }, "config");
    const agents = await service.read({ home }, "agents");
    const plan = await service.planRestore({ home }, [
      { resource: "config", content: original, expectedRevision: config.revision },
      { resource: "agents", content: null, expectedRevision: agents.revision },
    ]);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(configPath(), "utf8")).toBe(original);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  });

  it("rejects whole-document editing except reviewed restore and AGENTS.md", async () => {
    const service = setup();
    await expect(service.plan({ home }, { resource: "config", expectedRevision: "", content: "" })).rejects.toMatchObject({ code: "invalid-change" });
    const agents = await service.plan({ home }, { resource: "agents", expectedRevision: "", content: "# Guidance\n" });
    expect((await service.commit(agents.id, { expectedRevision: "" })).status).toBe("succeeded");
  });

  it("does not create an absent document for a no-op delete", async () => {
    const service = setup();
    const plan = await service.plan({ home }, { resource: "config", expectedRevision: "", changes: [{ op: "delete", path: ["fixture_label"] }] });
    expect(plan.changed).toBe(false);
    await service.commit(plan.id, { expectedRevision: "" });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(join(dataDir, "configuration-backups"))).toBe(false);
  });

  it("requires a server-resolved project and preserves MCP root extensions", async () => {
    const service = setup();
    await expect(service.read({ home }, "project-local")).rejects.toMatchObject({ code: "missing-project" });
    writeFileSync(join(home, "mcp.json"), '{"future":{"x":true},"mcpServers":{"local":{"command":"node"}}}\n');
    const snapshot = await service.read({ home }, "mcp");
    const plan = await service.plan({ home }, { resource: "mcp", expectedRevision: snapshot.revision, changes: [{ op: "set", path: ["mcpServers", "local", "command"], value: "bun" }] });
    await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
    expect(JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"))).toMatchObject({ future: { x: true }, mcpServers: { local: { command: "bun" } } });
  });

  it("does not widen filesystem grants when a symlink points outside its scope", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "kimi-outside-"));
    try {
      const target = join(outside, "config.toml");
      writeFileSync(target, 'fixture_label = "outside"\n');
      symlinkSync(target, configPath());
      const service = setup();
      await expect(planModel(service)).rejects.toThrow("outside the authorized scope");
      expect(readFileSync(target, "utf8")).toContain('"outside"');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("does not label an absent official validator as verified and can require it", async () => {
    const service = setup({ requireOfficialValidation: true });
    await expect(planModel(service)).rejects.toMatchObject({ code: "official-validation-required" });
    const verified = setup({ officialValidator: async () => ({ status: "passed", diagnostics: [] }) });
    expect((await planModel(verified)).validation).toBe("passed");
  });

  it("keeps secrets out of previews and persisted operation metadata", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n[providers.test]\napi_key = """sensitive\ncontinuation"""\n');
    const service = setup();
    const plan = await planModel(service);
    expect(JSON.stringify(plan.redactedPreview)).not.toMatch(/sensitive|continuation/);
    await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
    expect(readFileSync(join(dataDir, "operations", `${plan.id}.json`), "utf8")).not.toMatch(/sensitive|continuation/);
    expect(redactResourcePreview('{"headers":{"Authorization":"token-value"}}')).not.toContain("token-value");
    for (const source of [
      'base_url = "https://username-only@example.test/api?token=opaque-value&key=another-value&region=local"',
      '{"mcpServers":{"test":{"url":"https://user:pass@example.test/?token=opaque-value"}}}',
      "Connect to https://username-only@example.test/api?token=opaque-value&key=another-value",
    ]) {
      expect(redactResourcePreview(source)).not.toMatch(/username-only|opaque-value|another-value|user:pass/);
    }
  });

  it("restores a missing skills directory and treats an identical tree restore as no-op", async () => {
    const service = setup();
    const before = await service.read({ home }, "skills-directory");
    expect(before.exists).toBe(false);
    const content = portableContent(JSON.stringify({ exists: true, directories: ["review"], files: [{ relativePath: "review/SKILL.md", contentBase64: Buffer.from("# Review\nsecret-not-in-preview").toString("base64"), executable: false }] }));
    const plan = await service.planRestore({ home }, [{ resource: "skills-directory", expectedRevision: before.revision, content }]);
    expect(plan.redactedPreview.after).toContain("review/SKILL.md");
    expect(plan.redactedPreview.after).not.toContain("contentBase64");
    expect(plan.redactedPreview.after).not.toContain("secret-not-in-preview");
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    const after = await service.read({ home }, "skills-directory");
    expect(after.content).toBe(content);
    expect(readFileSync(join(home, "skills/review/SKILL.md"), "utf8")).toBe("# Review\nsecret-not-in-preview");
    const unchanged = await service.planRestore({ home }, [{ resource: "skills-directory", expectedRevision: after.revision, content }]);
    expect(unchanged.changed).toBe(false);
    await service.commit(unchanged.id, { expectedRevision: unchanged.expectedRevision });
    expect(readdirSync(join(dataDir, "configuration-backups"))).toHaveLength(1);
  });

  it("rolls back both a text file and a directory when a mixed restore fails", async () => {
    writeFileSync(configPath(), 'fixture_label = "original"\n');
    mkdirSync(join(home, "skills"));
    writeFileSync(join(home, "skills/original.md"), "original skill");
    let writes = 0;
    const service = setup({ fault(point) { if (point === "after-write" && ++writes === 2) throw new Error("failure after directory swap"); } });
    const config = await service.read({ home }, "config");
    const skills = await service.read({ home }, "skills-directory");
    const plan = await service.planRestore({ home }, [
      { resource: "config", expectedRevision: config.revision, content: 'fixture_label = "restored"\n' },
      { resource: "skills-directory", expectedRevision: skills.revision, content: portableContent(JSON.stringify({ exists: true, directories: [], files: [{ relativePath: "new.md", contentBase64: Buffer.from("new skill").toString("base64"), executable: false }] })) },
    ]);
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("failed");
    expect((await service.read({ home }, "config")).content).toBe(config.content);
    expect((await service.read({ home }, "skills-directory")).content).toBe(skills.content);
    expect(readdirSync(join(home, "skills"))).toEqual(["original.md"]);
    expect((await service.getRecoveryState()).blocked).toBe(false);
  });

  it("rejects direct directory edits and malformed portable snapshots before writing", async () => {
    const service = setup();
    const snapshot = await service.read({ home }, "plugins-directory");
    await expect(service.plan({ home }, { resource: "plugins-directory", expectedRevision: snapshot.revision, changes: [] })).rejects.toMatchObject({ code: "restore-only-resource" });
    await expect(service.planRestore({ home }, [{ resource: "plugins-directory", expectedRevision: snapshot.revision, content: JSON.stringify({ exists: true, directories: [], files: [{ relativePath: "../outside", contentBase64: "YQ==", executable: false }] }) }])).rejects.toThrow("directory snapshot is invalid");
    expect(existsSync(join(home, "plugins"))).toBe(false);
  });

  it("rejects directory revisions changed externally after the restore preview", async () => {
    mkdirSync(join(home, "plugins"));
    writeFileSync(join(home, "plugins/installed.json"), '{"plugins":[]}');
    const service = setup();
    const before = await service.read({ home }, "plugins-directory");
    const plan = await service.planRestore({ home }, [{ resource: "plugins-directory", expectedRevision: before.revision, content: null }]);
    writeFileSync(join(home, "plugins/external.json"), "{}");
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("conflict");
    expect(existsSync(join(home, "plugins/external.json"))).toBe(true);
  });

  it("rejects changed field types even when an official doctor reports success", async () => {
    const service = setup({ officialValidator: async () => ({ status: "passed", diagnostics: [] }) });
    await expect(service.plan({ home }, { resource: "config", expectedRevision: "", changes: [{ op: "set", path: ["default_model"], value: 123 }] })).rejects.toMatchObject({ code: "invalid-native-value" });
    await expect(service.plan({ home }, { resource: "tui", expectedRevision: "", changes: [{ op: "set", path: ["markdown", "mermaid"], value: "unknown" }] })).rejects.toMatchObject({ code: "invalid-native-value" });
    expect(existsSync(configPath())).toBe(false);
  });

  it("prevents provider/model deletion from breaking existing native references", async () => {
    const original = 'default_model = "alias"\n[providers.custom]\ntype = "openai"\n[models.alias]\nprovider = "custom"\nmodel = "upstream"\n[secondary_model]\ndefault_model = "alias"\n';
    writeFileSync(configPath(), original);
    const service = setup();
    const snapshot = await service.read({ home }, "config");
    await expect(service.plan({ home }, { resource: "config", expectedRevision: snapshot.revision, changes: [{ op: "delete", path: ["providers", "custom"] }] })).rejects.toMatchObject({ code: "invalid-native-value" });
    await expect(service.plan({ home }, { resource: "config", expectedRevision: snapshot.revision, changes: [{ op: "delete", path: ["models", "alias"] }] })).rejects.toMatchObject({ code: "invalid-native-value" });
    await expect(service.planRestore({ home }, [{ resource: "config", expectedRevision: snapshot.revision, content: 'default_model = "alias"\n[providers.custom]\ntype = "openai"\n' }])).rejects.toMatchObject({ code: "invalid-native-value" });
    expect(readFileSync(configPath(), "utf8")).toBe(original);
  });

  it("requires the reviewed current revisions before keeping them and archiving an unknown transaction", async () => {
    writeFileSync(configPath(), 'fixture_label = "old"\n');
    const external = 'fixture_label = "external"\n';
    const service = setup({ fault(point) { if (point === "after-write") writeFileSync(configPath(), external); } });
    const plan = await planModel(service);
    await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
    const [entry] = await service.listRecoveryCases();
    expect(entry.kind).toBe("transaction");
    await expect(service.resolveRecovery({ id: entry.id, journalRevision: entry.journalRevision, expectedRevisions: {}, decision: "keep-current" })).rejects.toMatchObject({ code: "conflict" });
    const result = await service.resolveRecovery({ id: entry.id, journalRevision: entry.journalRevision, expectedRevisions: Object.fromEntries(entry.resources.map((resource) => [resource.path, resource.revision])), decision: "keep-current" });
    expect(result.blocked).toBe(false);
    expect(readFileSync(configPath(), "utf8")).toBe(external);
    expect(readdirSync(join(dataDir, "recovery-archive"))).toHaveLength(1);
    expect(service.getOperation(plan.id)?.diagnostics[0].code).toBe("kept-current");
    await expect(service.assertWritable()).resolves.toBeUndefined();
  });

  it("requires exporting and acknowledging malformed journal bytes before explicit keep-current", async () => {
    const original = "{bad original journal bytes";
    mkdirSync(join(dataDir, "configuration-journals"), { recursive: true });
    const path = join(dataDir, "configuration-journals", "broken.json");
    writeFileSync(path, original);
    const service = setup();
    const [entry] = await service.listRecoveryCases();
    const request = { id: entry.id, journalRevision: entry.journalRevision, expectedRevisions: {}, decision: "keep-current" as const, acknowledgeMalformed: true };
    await expect(service.resolveRecovery(request)).rejects.toMatchObject({ code: "recovery-export-required" });
    expect((await service.exportRecoveryJournal(entry)).content).toBe(original);
    expect((await service.resolveRecovery(request)).blocked).toBe(false);
    expect(existsSync(path)).toBe(false);
    const [archived] = readdirSync(join(dataDir, "recovery-archive"));
    expect(readFileSync(join(dataDir, "recovery-archive", archived), "utf8")).toBe(original);
  });

  it("resolves the project-root MCP, cwd MCP and project-local TOML independently", async () => {
    const projectRoot = join(base, "repo");
    const workingDirectory = join(projectRoot, "subdir");
    mkdirSync(workingDirectory, { recursive: true });
    const context = { home, projectRoot, workingDirectory };
    const service = setup();
    const rootMcp = await service.read(context, "mcp-project");
    const localMcp = await service.read(context, "mcp-local");
    const project = await service.read(context, "project-local");
    expect(rootMcp.path).toBe(join(realpathSync(projectRoot), ".mcp.json"));
    expect(localMcp.path).toBe(join(realpathSync(workingDirectory), ".kimi-code/mcp.json"));
    expect(project.path).toBe(join(realpathSync(projectRoot), ".kimi-code/local.toml"));
    const plan = await service.plan(context, { resource: "mcp-local", expectedRevision: localMcp.revision, changes: [{ op: "set", path: ["mcpServers", "local"], value: { command: "node" } }] });
    expect((await service.commit(plan.id, { expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(existsSync(rootMcp.path)).toBe(false);
    expect(existsSync(localMcp.path)).toBe(true);
  });

  it("expires uncommitted plans after fifteen minutes without changing native files", async () => {
    const service = setup();
    const plan = await planModel(service);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15 * 60_000 + 1);
    try { await expect(service.commit(plan.id, { expectedRevision: plan.expectedRevision })).rejects.toMatchObject({ code: "unknown-plan" }); }
    finally { clock.mockRestore(); }
    expect(existsSync(configPath())).toBe(false);
  });
});
