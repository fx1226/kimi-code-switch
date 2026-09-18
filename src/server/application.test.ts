import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "@shared/types";
import type { WebApi } from "@shared/webApi";
import type { ChangePlan } from "@shared/resourceProtocol";

vi.mock("./services/cli", async (importOriginal) => ({
  ...await importOriginal<typeof import("./services/cli")>(),
  detectActiveKimiTarget: vi.fn(),
}));
vi.mock("./officialValidation", () => ({ validateOfficialDocuments: vi.fn(), verifyOfficialExecutable: vi.fn() }));
vi.mock("./migration/legacy", () => ({
  hasPendingLegacyMigration: vi.fn(() => false),
  findLegacyProcessBlocker: vi.fn(),
  previewLegacyMigration: vi.fn(),
  applyLegacyMigration: vi.fn(),
}));

import { createApplicationApi } from "./application";
import { detectActiveKimiTarget } from "./services/cli";
import { validateOfficialDocuments, verifyOfficialExecutable } from "./officialValidation";
import { findLegacyProcessBlocker, previewLegacyMigration } from "./migration/legacy";
import { configureAppPaths, getAppPaths } from "./native/paths";
import { clearDurableGrants } from "./native/fs";
import { closeUsageDb } from "./native/usage";
import { kimiSwitchServices } from "./services/kimiSwitch";

let base: string;
let nativeHome: string;
let dataDir: string;
let api: WebApi;
const configPath = () => join(nativeHome, "config.toml");
function configDocument(document: string): string {
  return `${document}\n[providers.fixture]\ntype = "openai"\nbase_url = "https://fixture.example/v1"\n` +
    ["selected", "first-updated", "second-updated"].map((name) => `[models."${name}"]\nprovider = "fixture"\nmodel = "fixture-model"\n`).join("\n");
}

beforeEach(() => {
  closeUsageDb();
  clearDurableGrants();
  vi.clearAllMocks();
  vi.mocked(verifyOfficialExecutable).mockImplementation(async () => ({ status: "passed", version: (await detectActiveKimiTarget()).version, diagnostics: [] }));
  base = realpathSync(mkdtempSync(join(tmpdir(), "kimi-application-")));
  const osHome = join(base, "home");
  nativeHome = join(osHome, ".kimi-code");
  dataDir = join(base, "private");
  mkdirSync(nativeHome, { recursive: true });
  vi.stubEnv("HOME", osHome);
  vi.stubEnv("USERPROFILE", osHome);
  vi.stubEnv("KIMI_CODE_HOME", nativeHome);
  configureAppPaths({ dataDir });
  vi.mocked(detectActiveKimiTarget).mockResolvedValue({
    target: "kimi-code", installed: true, status: "detected", version: "2.0.0",
    executablePath: join(base, "bin/kimi"), resolvedPath: join(base, "bin/kimi"),
    candidates: [join(base, "bin/kimi")], reason: "test-fixture", installSource: "official-script",
  });
  vi.mocked(validateOfficialDocuments).mockResolvedValue({ status: "passed", version: "2.0.0", diagnostics: [] });
  vi.mocked(findLegacyProcessBlocker).mockReturnValue(null);
  vi.mocked(previewLegacyMigration).mockReturnValue({
    status: "absent", sourceDir: join(osHome, ".kimi-code-switch-gui"), targetDir: dataDir,
    manifestHash: "", entries: [],
  });
  api = createApplicationApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeUsageDb();
  clearDurableGrants();
  configureAppPaths();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

async function planDefaultModel(value: string, targetId = "default") {
  const snapshot = await api.readResource({ targetId, resource: "config" });
  return api.planChange({
    targetId, resource: "config", expectedRevision: snapshot.revision,
    changes: [{ op: "set", path: ["default_model"], value }],
  });
}

function pauseValidation(validation: typeof verifyOfficialExecutable | typeof validateOfficialDocuments) {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(validation).mockImplementationOnce(async () => {
    entered();
    await pending;
    return { status: "passed", version: "2.0.0", diagnostics: [] };
  });
  return { started, release };
}

function createProject(name: string) {
  const project = join(base, name);
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".mcp.json"), '{"mcpServers":{}}\n');
  return project;
}

const planMethods = ["planChange", "planPreset", "planRestore", "planHistoryRestore"] as const;
async function preparePlan(method: typeof planMethods[number]): Promise<() => Promise<ChangePlan>> {
  writeFileSync(configPath(), configDocument('default_model = "first-updated"\n'));
  if (method === "planChange") return () => planDefaultModel("selected");
  if (method === "planPreset") {
    await api.savePreset({ targetId: "default", preset: {
      name: "context-fixture", label: "Context fixture", default_model: "selected",
      default_plan_mode: false, default_permission_mode: "", merge_all_available_skills: false,
      nativeEdits: [{ op: "set", path: ["default_model"], value: "selected" }],
    } });
    return () => api.planPreset({ targetId: "default", name: "context-fixture" });
  }
  if (method === "planRestore") {
    const backup = await api.createBackup({ targetId: "default" });
    writeFileSync(configPath(), configDocument('default_model = "selected"\n'));
    return () => api.planRestore({ targetId: "default", backupId: backup.id });
  }
  const plan = await planDefaultModel("selected");
  expect((await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
  return () => api.planHistoryRestore({ targetId: "default", id: plan.id });
}

describe("application API over isolated native files", () => {
  for (const stage of ["version", "candidate"] as const) {
    it.each(planMethods)(`rejects %s when the target context changes during ${stage} validation`, async (method) => {
      const firstProject = createProject("first-project");
      const secondProject = createProject("second-project");
      await api.updateTarget({ targetId: "default", workingDirectory: firstProject });
      const createPlan = await preparePlan(method);
      const before = readFileSync(configPath(), "utf8");
      const pause = pauseValidation(stage === "version" ? verifyOfficialExecutable : validateOfficialDocuments);
      const pending = createPlan();
      await pause.started;
      await api.updateTarget({ targetId: "default", workingDirectory: secondProject });
      pause.release();

      await expect(pending).rejects.toMatchObject({ code: "unknown-plan" });
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(readFileSync(join(firstProject, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
      expect(readFileSync(join(secondProject, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    });
  }

  it.each(["planRestore", "planHistoryRestore"] as const)("applies %s when its captured context remains current", async (method) => {
    const createPlan = await preparePlan(method);
    const plan = await createPlan();
    const operation = await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision });

    expect(operation.status).toBe("succeeded");
    expect(readFileSync(configPath(), "utf8")).toBe(configDocument('default_model = "first-updated"\n'));
    expect(await api.getOperation({ id: plan.id })).toEqual(operation);
  });

  it.each(["plan", "apply"] as const)("does not write either project if the context changes during %s verification", async (stage) => {
    const firstProject = createProject("first-project");
    const secondProject = createProject("second-project");
    await api.updateTarget({ targetId: "default", workingDirectory: firstProject });
    const snapshot = await api.readResource({ targetId: "default", resource: "mcp-project" });
    const input = {
      targetId: "default", resource: "mcp-project" as const, expectedRevision: snapshot.revision,
      changes: [{ op: "set" as const, path: ["mcpServers", "new"], value: { command: "fixture" } }],
    };
    const plan = stage === "apply" ? await api.planChange(input) : undefined;
    const pause = pauseValidation(verifyOfficialExecutable);
    const pending = plan
      ? api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision })
      : api.planChange(input);
    await pause.started;
    await api.updateTarget({ targetId: "default", workingDirectory: secondProject });
    pause.release();

    await expect(pending).rejects.toMatchObject({ code: "unknown-plan" });
    if (plan) expect(await api.getOperation({ id: plan.id })).toBeNull();
    expect(readFileSync(join(firstProject, ".mcp.json"), "utf8")).toBe(snapshot.content);
    expect(readFileSync(join(secondProject, ".mcp.json"), "utf8")).toBe(snapshot.content);
  });

  it("tests exactly the selected MCP scope and resolves project-root cwd independently of the working directory", async () => {
    const root = join(base, "project");
    const cwd = join(root, "nested");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(cwd, ".kimi-code"), { recursive: true });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { relative: { command: "fixture", cwd: "tools" }, implicit: { command: "fixture" } } }));
    writeFileSync(join(cwd, ".kimi-code/mcp.json"), JSON.stringify({ mcpServers: { local: { command: "fixture", cwd: "tools" } } }));
    await api.updateTarget({ targetId: "default", workingDirectory: cwd });
    const testServer = vi.spyOn(kimiSwitchServices, "testMcpServer").mockResolvedValue({ ok: true } as never);
    await api.testMcp({ targetId: "default", resource: "mcp-project", name: "relative" });
    expect(Object.keys(testServer.mock.calls[0][0].mcpConfig.mcpServers)).toEqual(["relative", "implicit"]);
    expect(testServer.mock.calls[0][0].mcpConfig.mcpServers).toMatchObject({
      relative: { command: "fixture", extra: { cwd: join(root, "tools") } }, implicit: { command: "fixture", extra: { cwd: root } },
    });
    await api.testMcp({ targetId: "default", resource: "mcp-local", name: "local" });
    expect(Object.keys(testServer.mock.calls[1][0].mcpConfig.mcpServers)).toEqual(["local"]);
    expect(testServer.mock.calls[1][0].mcpConfig.mcpServers).toMatchObject({ local: { command: "fixture", extra: { cwd: "tools" } } });
    expect(testServer.mock.calls[1][0].panelSettings.kimi_code_environments?.[0].workingDirectory).toBe(cwd);
  });

  it("bootstraps and reads native bytes without creating a database or filling absent fields", async () => {
    const original = configDocument('# selected by the official client\ndefault_model = "original" # keep this\n\n[future]\nunknown = [1, 2]\n');
    writeFileSync(configPath(), original);

    const result = await api.bootstrap();
    const snapshot = await api.readResource({ targetId: "default", resource: "config" });

    expect(result.targets).toEqual([{ id: "default", name: "默认目录", homePath: nativeHome, kind: "default" }]);
    expect(result.compatibility).toMatchObject({ status: "contract-matched", runtimeVerified: false });
    expect(snapshot.content).toBe(original);
    expect(readFileSync(configPath(), "utf8")).toBe(original);
    expect(existsSync(getAppPaths().databasePath)).toBe(false);
    expect(readdirSync(nativeHome)).toEqual(["config.toml"]);
    expect(validateOfficialDocuments).not.toHaveBeenCalled();
  });

  it("plans without mutation, applies the selected field, and exposes a durable idempotent operation", async () => {
    const original = configDocument('# chosen by CLI\ndefault_model = "original" # comment\n\n[future]\nopaque = "retain"\n');
    writeFileSync(configPath(), original);

    const plan = await planDefaultModel("selected");
    expect(readFileSync(configPath(), "utf8")).toBe(original);
    expect(await api.getOperation({ id: plan.id })).toBeNull();
    expect(validateOfficialDocuments).toHaveBeenCalledWith({
      executable: join(base, "bin/kimi"),
      documents: [{ kind: "config", content: original.replace('"original"', '"selected"') }],
    });

    const operation = await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision });
    expect(operation.status).toBe("succeeded");
    expect(readFileSync(configPath(), "utf8")).toBe(original.replace('"original"', '"selected"'));
    expect(await api.getOperation({ id: plan.id })).toEqual(operation);
    expect(await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision })).toEqual(operation);
    expect(await createApplicationApi().getOperation({ id: plan.id })).toEqual(operation);
    expect(readdirSync(join(dataDir, "configuration-backups"))).toHaveLength(1);
  });

  it("rejects a stale revision if the official client edits after preview", async () => {
    writeFileSync(configPath(), configDocument('default_model = "original"\n'));
    const plan = await planDefaultModel("selected");
    const external = '# saved elsewhere\ndefault_model = "external"\n';
    writeFileSync(configPath(), external);

    const operation = await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision });

    expect(operation.status).toBe("conflict");
    expect(readFileSync(configPath(), "utf8")).toBe(external);
    expect(await api.getOperation({ id: plan.id })).toEqual(operation);
  });

  it("binds plans and persisted results to their target while active selection changes independently", async () => {
    const first = configDocument('default_model = "first"\n');
    const second = configDocument('default_model = "second"\n');
    writeFileSync(configPath(), first);
    const secondHome = join(base, "second-kimi-home");
    mkdirSync(secondHome);
    writeFileSync(join(secondHome, "config.toml"), second);
    const target = await api.addTarget({ name: "Second", homePath: secondHome });
    await api.savePreferences({ activeTargetId: target.id });
    const plan = await planDefaultModel("first-updated");

    await expect(api.applyChange({ targetId: target.id, planId: plan.id, expectedRevision: plan.expectedRevision }))
      .rejects.toMatchObject({ code: "unknown-plan" });
    const firstOperation = await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision });
    expect(firstOperation.status).toBe("succeeded");
    expect(readFileSync(configPath(), "utf8")).toBe(first.replace('"first"', '"first-updated"'));
    expect(readFileSync(join(secondHome, "config.toml"), "utf8")).toBe(second);
    await expect(api.applyChange({ targetId: target.id, planId: plan.id, expectedRevision: plan.expectedRevision }))
      .rejects.toMatchObject({ code: "wrong-target" });

    const secondPlan = await planDefaultModel("second-updated", target.id);
    expect((await api.applyChange({ targetId: target.id, planId: secondPlan.id, expectedRevision: secondPlan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(join(secondHome, "config.toml"), "utf8")).toBe(second.replace('"second"', '"second-updated"'));
    expect((await api.bootstrap()).preferences.activeTargetId).toBe(target.id);
  });

  it("applies explicit preset nativeEdits without supplementing legacy profile defaults", async () => {
    const original = configDocument('# no permission defaults here\ndefault_model = "original"\n\n[future]\nunchanged = true\n');
    writeFileSync(configPath(), original);
    const preset: Profile = {
      name: "model-only", label: "Model only", default_model: "legacy-unused",
      default_plan_mode: true, default_permission_mode: "yolo", merge_all_available_skills: true,
      thinking_enabled: false, thinking_effort: "high",
      nativeEdits: [{ op: "set", path: ["default_model"], value: "selected" }],
    };
    await api.savePreset({ targetId: "default", preset });
    expect((await api.listPresets({ targetId: "default" }))[0].nativeEdits).toEqual(preset.nativeEdits);
    expect(readFileSync(configPath(), "utf8")).toBe(original);

    const plan = await api.planPreset({ targetId: "default", name: preset.name });
    expect((await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision })).status).toBe("succeeded");

    expect(readFileSync(configPath(), "utf8")).toBe(original.replace('"original"', '"selected"'));
    expect(existsSync(join(nativeHome, "tui.toml"))).toBe(false);
  });

  it("preserves MCP root and server extensions and original formatting when changing one field", async () => {
    const original = '{\n  "futureRoot": { "preserve": true },\n  "mcpServers": {\n    "local": { "command": "node", "args": ["server.mjs"], "futureServer": { "n": 2 } }\n  }\n}\n';
    const path = join(nativeHome, "mcp.json");
    writeFileSync(path, original);
    const snapshot = await api.readResource({ targetId: "default", resource: "mcp" });
    const plan = await api.planChange({
      targetId: "default", resource: "mcp", expectedRevision: snapshot.revision,
      changes: [{ op: "set", path: ["mcpServers", "local", "command"], value: "bun" }],
    });

    expect((await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision })).status).toBe("succeeded");
    expect(readFileSync(path, "utf8")).toBe(original.replace('"node"', '"bun"'));
    expect(validateOfficialDocuments).not.toHaveBeenCalled();
  });

  it("commits an explicit MCP transport while preserving an implicit stdio command and unknown type fields", async () => {
    const path = join(nativeHome, "mcp.json");
    const original = {
      futureRoot: { preserve: true },
      mcpServers: { local: { command: "node", args: ["server.mjs"], type: "vendor-extension", futureServer: { n: 2 } } },
    };
    writeFileSync(path, JSON.stringify(original, null, 2));
    const snapshot = await api.readResource({ targetId: "default", resource: "mcp" });
    const plan = await api.planChange({
      targetId: "default", resource: "mcp", expectedRevision: snapshot.revision,
      changes: [
        { op: "set", path: ["mcpServers", "local", "transport"], value: "http" },
        { op: "set", path: ["mcpServers", "local", "url"], value: "https://fixture.example/mcp" },
      ],
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);

    const operation = await api.applyChange({ targetId: "default", planId: plan.id, expectedRevision: plan.expectedRevision });

    expect(operation.status).toBe("succeeded");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...original,
      mcpServers: { local: { ...original.mcpServers.local, transport: "http", url: "https://fixture.example/mcp" } },
    });
    expect((await api.readResource({ targetId: "default", resource: "mcp" })).revision).toBe(operation.afterRevision);
    expect(validateOfficialDocuments).not.toHaveBeenCalled();
  });

  it("bootstraps malformed native configuration and diagnoses it without replacing it with defaults", async () => {
    const brokenToml = '[providers.broken\napi_key = "never-log-this"\n';
    const brokenMcp = '{"mcpServers": ';
    writeFileSync(configPath(), brokenToml);
    writeFileSync(join(nativeHome, "mcp.json"), brokenMcp);

    expect((await api.bootstrap()).targets).toHaveLength(1);
    const snapshot = await api.readResource({ targetId: "default", resource: "config" });
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-document", severity: "error" }));
    const result = await api.diagnose({ targetId: "default" });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.resource)).toEqual(["config", "mcp"]);
    expect(JSON.stringify(result)).not.toContain("never-log-this");
    await expect(planDefaultModel("selected")).rejects.toMatchObject({ code: "invalid-document" });
    expect(readFileSync(configPath(), "utf8")).toBe(brokenToml);
    expect(readFileSync(join(nativeHome, "mcp.json"), "utf8")).toBe(brokenMcp);
    expect(existsSync(getAppPaths().databasePath)).toBe(false);
    expect(validateOfficialDocuments).not.toHaveBeenCalled();
  });

  it("keeps unverified CLI versions readable and blocks native plans", async () => {
    vi.mocked(detectActiveKimiTarget).mockResolvedValue({
      target: "kimi-code", installed: true, status: "detected", version: "2.1.0",
      executablePath: join(base, "bin/kimi"), resolvedPath: join(base, "bin/kimi"),
      candidates: [], reason: "test-fixture", installSource: "official-script",
    });
    writeFileSync(configPath(), configDocument('default_model = "original"\n'));

    expect((await api.bootstrap()).compatibility).toMatchObject({ nativeWritesAllowed: false, status: "unverified-version" });
    expect((await api.readResource({ targetId: "default", resource: "config" })).exists).toBe(true);
    await expect(planDefaultModel("selected")).rejects.toMatchObject({ code: "unverified-version" });
    expect(readFileSync(configPath(), "utf8")).toBe(configDocument('default_model = "original"\n'));
    expect(validateOfficialDocuments).not.toHaveBeenCalled();
  });

  it("does not create a plan or touch native bytes when official validation rejects a candidate", async () => {
    writeFileSync(configPath(), configDocument('default_model = "original"\n'));
    vi.mocked(validateOfficialDocuments).mockResolvedValue({
      status: "rejected", version: "2.0.0",
      diagnostics: [{ code: "OFFICIAL_DOCTOR_REJECTED", severity: "error", message: "Fixture rejected the candidate." }],
    });

    await expect(planDefaultModel("selected")).rejects.toMatchObject({ code: "official-validation-failed" });

    expect(readFileSync(configPath(), "utf8")).toBe(configDocument('default_model = "original"\n'));
    expect(existsSync(join(dataDir, "configuration-backups"))).toBe(false);
    expect(existsSync(join(dataDir, "operations"))).toBe(false);
  });
});
