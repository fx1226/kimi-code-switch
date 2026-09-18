import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlan, RecoveryCase } from "@shared/resourceProtocol";
import type { SkillsScanReport } from "@shared/skillsStore";
import type { PluginInventoryReport } from "@shared/types";
import type { BackupSummary, WebApi } from "@shared/webApi";
import { InventoryPanel, RecoveryPanel } from "./ToolsPanels";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function skills(name = "review"): SkillsScanReport {
  return {
    builtinNotice: "Built-in skills are managed by Kimi Code.", discoveryMode: "auto", mergeAllAvailableSkills: true,
    paths: [{ id: "user", group: "user-brand", label: "User skills", path: "/home/kimi/skills", exists: true, selected: true, priority: 1, reason: "Directory found" }],
    summary: { total: 1, effective: 1, overrides: 0, warnings: 0, errors: 0, flow: 0 },
    skills: [{
      id: name, name, sourcePathId: "user", directoryName: name, directoryPath: `/home/kimi/skills/${name}`, skillFilePath: `/home/kimi/skills/${name}/SKILL.md`,
      sourceLabel: "User skills", sourceGroup: "user-brand", priority: 1, enabled: true, effective: true, frontmatter: true,
      metadata: { name, description: "PRIVATE_DESCRIPTION", type: "prompt", license: "", compatibility: "", whenToUse: "", disableModelInvocation: false, arguments: [], metadata: {}, hasSubSkill: false },
      content: "PRIVATE_SKILL_CONTENT", lineCount: 5, hasScripts: true, hasReferences: false, hasAssets: false, valid: true,
      diagnostics: ['api_key = "PRIVATE_DIAGNOSTIC_KEY"'],
    }],
  };
}
const backup: BackupSummary = { id: "backup-1", name: "Before edit", targetId: "a", createdAt: "2026-09-18T00:00:00Z", resources: ["config", "mcp"] };
const plan: ChangePlan = { id: "plan-1", resource: "config", path: "/home/kimi/config.toml", expectedRevision: "before", desiredRevision: "after", changed: true, diagnostics: [], validation: "passed", createdAt: "2026-09-18T00:00:00Z", redactedPreview: { before: "", after: "" } };
function apiMock(overrides: Partial<WebApi> = {}): WebApi {
  return {
    scanSkills: vi.fn().mockResolvedValue(skills()),
    listRecoveryCases: vi.fn().mockResolvedValue([]),
    exportRecoveryJournal: vi.fn().mockResolvedValue({ fileName: "recovery.json", content: "PRIVATE_JOURNAL_CONTENT" }),
    resolveRecovery: vi.fn().mockResolvedValue({ blocked: false, pendingOperationIds: [], diagnostics: [] }),
    listBackups: vi.fn().mockResolvedValue([backup]),
    listHistory: vi.fn().mockResolvedValue([{ id: "history-1", resource: "config", path: "/home/kimi/config.toml", createdAt: backup.createdAt, status: "succeeded" }]),
    createBackup: vi.fn().mockResolvedValue({ ...backup, id: "backup-2", name: "New backup" }),
    diagnose: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
    planRestore: vi.fn().mockResolvedValue(plan),
    planHistoryRestore: vi.fn().mockResolvedValue(plan),
    importBackup: vi.fn().mockResolvedValue({ ...backup, id: "backup-3", name: "Imported backup" }),
    exportBackup: vi.fn().mockResolvedValue({ fileName: "backup.json", content: '{"native":"PRIVATE_BACKUP_CONTENT"}' }),
    applyChange: vi.fn(), ...overrides,
  } as unknown as WebApi;
}

describe("InventoryPanel", () => {
  it("displays actual paths, source and scan state without rendering skill contents or secret diagnostics", async () => {
    const api = apiMock();
    const view = render(<InventoryPanel api={api} targetId="a" locale="en-US" kind="skills" onError={vi.fn()} />);
    await view.findByText("review");
    expect(api.scanSkills).toHaveBeenCalledWith({ targetId: "a" });
    expect(view.getByText("/home/kimi/skills/review/SKILL.md")).toBeDefined();
    expect(view.getByText("Source: user-brand · User skills")).toBeDefined();
    expect(view.getByText("Effective in scan")).toBeDefined();
    expect(view.container.textContent).not.toContain("PRIVATE_");
    fireEvent.click(view.getByRole("button", { name: "View details · review" }));
    expect(view.container.textContent).not.toContain("PRIVATE_");
    expect(view.container.querySelectorAll("dialog")).toHaveLength(1);
    expect(view.getAllByText(/\[REDACTED\]/).length).toBeGreaterThan(0);
  });

  it("shows plugin metadata but excludes original URLs and execution configuration from details", async () => {
    const report: PluginInventoryReport = {
      installedPath: "/home/kimi/plugins/installed.json", skillRoots: [], mcpServers: {}, diagnostics: [],
      plugins: [{ id: "plugin", root: "/home/kimi/plugins/plugin", source: "github", originalSource: "https://PRIVATE_SOURCE@github.com/org/plugin", enabled: true, installedAt: backup.createdAt, state: "ok", displayName: "Plugin", version: "1.2", manifestPath: "/home/kimi/plugins/plugin/kimi.plugin.json", skillRoots: [], mcpServers: { local: { transport: "stdio", enabled: true, command: "PRIVATE_COMMAND", args: [], env: { TOKEN: "PRIVATE_TOKEN" }, url: "", headers: {} } }, hookCount: 2, diagnostics: [] }],
    };
    const api = apiMock({ listPlugins: vi.fn().mockResolvedValue(report) });
    const view = render(<InventoryPanel api={api} targetId="a" locale="en-US" kind="plugins" onError={vi.fn()} />);
    await view.findByText("Plugin");
    fireEvent.click(view.getByRole("button", { name: "View details · Plugin" }));
    expect(view.getByText("MCP server count")).toBeDefined();
    expect(view.getByText("/home/kimi/plugins/plugin/kimi.plugin.json")).toBeDefined();
    expect(view.container.textContent).not.toContain("PRIVATE_");
  });

  it("ignores an earlier target response and closes its detail dialog when the target changes", async () => {
    const first = deferred<SkillsScanReport>();
    const api = apiMock({ scanSkills: vi.fn().mockImplementation(({ targetId }) => targetId === "a" ? first.promise : Promise.resolve(skills("fresh"))) });
    const props = { api, targetId: "a", locale: "en-US" as const, kind: "skills" as const, onError: vi.fn() };
    const view = render(<InventoryPanel {...props} />);
    view.rerender(<InventoryPanel {...props} targetId="b" />);
    await view.findByText("fresh");
    await act(async () => first.resolve(skills("stale")));
    expect(view.queryByText("stale")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "View details · fresh" }));
    expect(view.container.querySelector("dialog")).not.toBeNull();
    view.rerender(<InventoryPanel {...props} targetId="c" />);
    expect(view.container.querySelector("dialog")).toBeNull();
    await view.findByText("fresh");
  });

  it("reports a failed scan and supports retry without presenting an empty successful inventory", async () => {
    const error = new Error("scan failed");
    const api = apiMock({ scanSkills: vi.fn().mockRejectedValueOnce(error).mockResolvedValue(skills()) });
    const onError = vi.fn();
    const view = render(<InventoryPanel api={api} targetId="a" locale="en-US" kind="skills" onError={onError} />);
    await view.findByText("Configuration could not be read");
    expect(view.queryByText("No resources in this directory yet.")).toBeNull();
    expect(onError).toHaveBeenCalledWith(error);
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await view.findByText("review");
  });
});

describe("RecoveryPanel", () => {
  it("runs diagnostics and creates a backup, then hands restoration plans to its parent without applying changes", async () => {
    const api = apiMock();
    const onPlan = vi.fn();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={vi.fn()} onPlan={onPlan} />);
    await view.findByText("Before edit");
    fireEvent.click(view.getByRole("button", { name: "Check files" }));
    await view.findByText("File checks passed.");
    fireEvent.click(view.getByRole("button", { name: "Create backup" }));
    await view.findByText("New backup");
    expect(api.createBackup).toHaveBeenCalledWith({ targetId: "a" });
    fireEvent.click(view.getByRole("button", { name: "Review restoration · Before edit" }));
    await waitFor(() => expect(onPlan).toHaveBeenCalledTimes(1));
    expect(api.planRestore).toHaveBeenCalledWith({ targetId: "a", backupId: "backup-1" });
    expect(onPlan).toHaveBeenLastCalledWith(plan);
    fireEvent.click(view.getByRole("button", { name: `Review restoration · config · ${backup.createdAt}` }));
    await waitFor(() => expect(onPlan).toHaveBeenCalledTimes(2));
    expect(api.planHistoryRestore).toHaveBeenCalledWith({ targetId: "a", id: "history-1" });
    expect(api.applyChange).not.toHaveBeenCalled();
  });

  it("imports file text through the API and distinguishes import from native restoration", async () => {
    const api = apiMock();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={vi.fn()} onPlan={vi.fn()} />);
    await view.findByText("Before edit");
    const file = new File(['{"resources":{}}'], "import.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue('{"resources":{}}') });
    fireEvent.change(view.getByLabelText("Import backup"), { target: { files: [file] } });
    await view.findByText("Imported backup");
    expect(api.importBackup).toHaveBeenCalledWith({ targetId: "a", content: '{"resources":{}}' });
    expect(view.getByText("Backup imported. Native files have not been restored.")).toBeDefined();
    expect(api.planRestore).not.toHaveBeenCalled();
    expect(api.applyChange).not.toHaveBeenCalled();
  });

  it("initiates a browser download without inventing a completed download path or displaying backup contents", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:backup");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn(); });
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
    const api = apiMock();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={vi.fn()} onPlan={vi.fn()} />);
    await view.findByText("Before edit");
    fireEvent.click(view.getByRole("button", { name: "Download backup · Before edit" }));
    await view.findByText("Download initiated. Check the result in your browser.");
    expect(api.exportBackup).toHaveBeenCalledWith({ targetId: "a", id: "backup-1" });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(downloadName).toBe("backup.json");
    expect(view.container.textContent).not.toContain("Downloads/");
    expect(view.container.textContent).not.toContain("PRIVATE_BACKUP_CONTENT");
  });

  it("blocks restoration during recovery while keeping read and backup actions available", async () => {
    const api = apiMock();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={vi.fn()} onPlan={vi.fn()} blocked />);
    await view.findByText("Before edit");
    expect((view.getByRole("button", { name: "Review restoration · Before edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: "Create backup" }) as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByRole("button", { name: "Check files" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("isolates an unrestorable backup diagnostic while keeping healthy and unspecified backups restorable and raw export available", async () => {
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn().mockReturnValue("blob:backup"); static revokeObjectURL = vi.fn(); });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const damaged: BackupSummary = { ...backup, id: "damaged", name: "Damaged archive", resources: [], restorable: false, diagnostic: 'Unknown archive format. api_key = "PRIVATE_DIAGNOSTIC"' };
    const healthy: BackupSummary = { ...backup, id: "healthy", name: "Healthy archive", restorable: true };
    const api = apiMock({ listBackups: vi.fn().mockResolvedValue([damaged, healthy, backup]) });
    const onError = vi.fn();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={onError} onPlan={vi.fn()} />);
    await view.findByText("Damaged archive");
    expect(view.getByText("Cannot restore")).toBeDefined();
    expect(view.getByText(/Unknown archive format/).textContent).toContain("[REDACTED]");
    expect(view.container.textContent).not.toContain("PRIVATE_DIAGNOSTIC");
    expect((view.getByRole("button", { name: "Review restoration · Damaged archive" }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: "Review restoration · Healthy archive" }) as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByRole("button", { name: "Review restoration · Before edit" }) as HTMLButtonElement).disabled).toBe(false);
    const exportButton = view.getByRole("button", { name: "Download backup · Damaged archive" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);
    await view.findByText("Download initiated. Check the result in your browser.");
    expect(api.exportBackup).toHaveBeenCalledWith({ targetId: "a", id: "damaged" });
    expect(api.planRestore).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(view.queryByText("Configuration could not be read")).toBeNull();
  });

  it("ignores a restoration plan returned after switching targets", async () => {
    const pending = deferred<ChangePlan>();
    const api = apiMock({ planRestore: vi.fn().mockReturnValue(pending.promise) });
    const onPlan = vi.fn();
    const props = { api, targetId: "a", locale: "en-US" as const, onError: vi.fn(), onPlan };
    const view = render(<RecoveryPanel {...props} />);
    await view.findByText("Before edit");
    fireEvent.click(view.getByRole("button", { name: "Review restoration · Before edit" }));
    view.rerender(<RecoveryPanel {...props} targetId="b" />);
    await view.findByText("Before edit");
    await act(async () => pending.resolve(plan));
    expect(onPlan).not.toHaveBeenCalled();
    expect(api.applyChange).not.toHaveBeenCalled();
  });

  it("keeps successful history visible when backups fail and reports action errors without dropping the list", async () => {
    const error = new Error("backup read failed");
    const api = apiMock({ listBackups: vi.fn().mockRejectedValue(error), planHistoryRestore: vi.fn().mockRejectedValue(error) });
    const onError = vi.fn();
    const onPlan = vi.fn();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={onError} onPlan={onPlan} />);
    await view.findByText("Configuration could not be read");
    expect(view.getByText("/home/kimi/config.toml")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: `Review restoration · config · ${backup.createdAt}` }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onPlan).not.toHaveBeenCalled();
    expect(view.getByText("/home/kimi/config.toml")).toBeDefined();
  });

  const recoveryCase: RecoveryCase = {
    id: "interrupted-1", kind: "transaction", journalRevision: "journal-sha", requiresExport: false, diagnostics: [],
    resources: [
      { resource: "config", path: "/home/another-target/config.toml", revision: "config-sha", redactedCurrent: 'api_key = "[REDACTED]"\nactive_model = "current"' },
      { resource: "mcp", path: "/home/another-target/mcp.json", revision: "mcp-sha", redactedCurrent: '{"mcpServers":{}}' },
    ],
  };

  it("requires explicit keep-current confirmation and binds all displayed file and journal revisions", async () => {
    const api = apiMock({ listRecoveryCases: vi.fn().mockResolvedValueOnce([recoveryCase]).mockResolvedValue([]) });
    const onRecovered = vi.fn();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={vi.fn()} onPlan={vi.fn()} onRecovered={onRecovered} blocked />);
    await view.findByText("interrupted-1");
    expect(api.resolveRecovery).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Review current files · interrupted-1" }));
    expect(view.getByText("journal-sha")).toBeDefined();
    expect(view.getByText("config-sha")).toBeDefined();
    expect(view.getByText("mcp-sha")).toBeDefined();
    expect(view.getByText(/active_model = "current"/)).toBeDefined();
    expect(view.container.querySelectorAll("dialog")).toHaveLength(1);
    expect(api.resolveRecovery).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Keep current files and archive recovery record" }));
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(api.resolveRecovery).toHaveBeenCalledWith({
      id: "interrupted-1", journalRevision: "journal-sha", decision: "keep-current",
      expectedRevisions: { "/home/another-target/config.toml": "config-sha", "/home/another-target/mcp.json": "mcp-sha" },
    });
    await view.findByText("No recovery records require manual review.");
    expect(api.applyChange).not.toHaveBeenCalled();
  });

  it.each(["legacy", "malformed"] as const)("requires a download and acknowledgement before resolving a %s journal", async (kind) => {
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn().mockReturnValue("blob:journal"); static revokeObjectURL = vi.fn(); });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const item: RecoveryCase = { ...recoveryCase, kind, resources: [], requiresExport: true };
    const api = apiMock({ listRecoveryCases: vi.fn().mockResolvedValueOnce([item]).mockResolvedValue([]) });
    const onRecovered = vi.fn();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={vi.fn()} onPlan={vi.fn()} onRecovered={onRecovered} blocked />);
    fireEvent.click(await view.findByRole("button", { name: "Review current files · interrupted-1" }));
    const confirm = view.getByRole("button", { name: "Keep current files and archive recovery record" }) as HTMLButtonElement;
    const acknowledgement = view.getByRole("checkbox") as HTMLInputElement;
    expect(confirm.disabled).toBe(true);
    expect(acknowledgement.disabled).toBe(true);
    expect(view.getByText(/may contain API keys/)).toBeDefined();
    expect(view.container.textContent).not.toContain("PRIVATE_JOURNAL_CONTENT");
    fireEvent.click(view.getByRole("button", { name: "Download original recovery record" }));
    await view.findByText("Download initiated. Check the result in your browser.");
    expect(click).toHaveBeenCalledOnce();
    expect(api.exportRecoveryJournal).toHaveBeenCalledWith({ id: "interrupted-1", journalRevision: "journal-sha" });
    expect(confirm.disabled).toBe(true);
    expect(acknowledgement.disabled).toBe(false);
    expect(api.resolveRecovery).not.toHaveBeenCalled();
    fireEvent.click(acknowledgement);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(api.resolveRecovery).toHaveBeenCalledWith({ id: "interrupted-1", journalRevision: "journal-sha", decision: "keep-current", expectedRevisions: {}, acknowledgeMalformed: true });
    expect(view.container.textContent).not.toContain("PRIVATE_JOURNAL_CONTENT");
  });

  it("keeps a failed resolution open and requires reloading current revisions before retrying", async () => {
    const error = new Error("revision conflict");
    const api = apiMock({ listRecoveryCases: vi.fn().mockResolvedValue([recoveryCase]), resolveRecovery: vi.fn().mockRejectedValue(error) });
    const onError = vi.fn();
    const onRecovered = vi.fn();
    const view = render(<RecoveryPanel api={api} targetId="a" locale="en-US" onError={onError} onPlan={vi.fn()} onRecovered={onRecovered} />);
    fireEvent.click(await view.findByRole("button", { name: "Review current files · interrupted-1" }));
    fireEvent.click(view.getByRole("button", { name: "Keep current files and archive recovery record" }));
    await view.findByRole("alert");
    expect(onError).toHaveBeenCalledWith(error);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Keep current files and archive recovery record" })).toBeNull();
    expect(view.container.querySelector("dialog")).not.toBeNull();
  });

  it("drops a pending journal export when the target changes and never carries acknowledgement across cases", async () => {
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn().mockReturnValue("blob:journal"); static revokeObjectURL = vi.fn(); });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const pending = deferred<{ fileName: string; content: string }>();
    const item: RecoveryCase = { ...recoveryCase, kind: "legacy", resources: [], requiresExport: true };
    const api = apiMock({ listRecoveryCases: vi.fn().mockResolvedValue([item]), exportRecoveryJournal: vi.fn().mockReturnValue(pending.promise) });
    const props = { api, targetId: "a", locale: "en-US" as const, onError: vi.fn(), onPlan: vi.fn() };
    const view = render(<RecoveryPanel {...props} />);
    fireEvent.click(await view.findByRole("button", { name: "Review current files · interrupted-1" }));
    fireEvent.click(view.getByRole("button", { name: "Download original recovery record" }));
    view.rerender(<RecoveryPanel {...props} targetId="b" />);
    await act(async () => pending.resolve({ fileName: "old.json", content: "PRIVATE_OLD_JOURNAL" }));
    expect(click).not.toHaveBeenCalled();
    expect(view.container.querySelector("dialog")).toBeNull();
    fireEvent.click(await view.findByRole("button", { name: "Review current files · interrupted-1" }));
    expect((view.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(api.resolveRecovery).not.toHaveBeenCalled();
  });
});
