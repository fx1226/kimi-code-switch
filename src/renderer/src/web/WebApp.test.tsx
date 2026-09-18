import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { WebApi, BootstrapResult, Preferences } from "@shared/webApi";
import type { ChangePlan, NativeResource, Operation, ResourceSnapshot } from "@shared/resourceProtocol";
import { WebApp } from "./WebApp";
import { WebApiError } from "../http/webApi";

const plan: ChangePlan = { id: "plan-one", resource: "config", path: "/tmp/kimi/config.toml", expectedRevision: "config-r1", desiredRevision: "config-r2", changed: true, diagnostics: [], validation: "passed", createdAt: "2026-01-01", redactedPreview: { before: "before", after: "after" } };
const operation: Operation = { id: "op-one", planId: plan.id, resource: "config", path: plan.path, status: "succeeded", createdAt: "2026-01-01", updatedAt: "2026-01-01", beforeRevision: plan.expectedRevision, afterRevision: plan.desiredRevision, diagnostics: [] };
function fixture() {
  const bootstrap: BootstrapResult = { product: "Kimi Code Switch", version: "3.0.0", targets: [{ id: "default", name: "Default", homePath: "/tmp/kimi", kind: "default" }, { id: "other", name: "Other", homePath: "/tmp/other", kind: "external" }], preferences: { locale: "en-US", theme: "light", activeTargetId: "default" }, compatibility: { detectedVersion: "2.0.0", expectedVersion: "2.0.0", nativeWritesAllowed: true, status: "compatible", runtimeVerified: false }, recovery: { blocked: false }, migrationAvailable: false };
  const data = { providers: { alpha: { type: "kimi", base_url: "https://alpha.example", api_key: "secret-a" }, beta: { type: "kimi", base_url: "https://beta.example", api_key: "secret-b" } }, models: {}, default_model: "" };
  const readResource = vi.fn(async ({ resource, targetId }: { resource: NativeResource; targetId: string }): Promise<ResourceSnapshot> => ({ resource, path: `/tmp/${targetId}/${resource}`, format: resource === "mcp" ? "json" : resource === "agents" ? "text" : "toml", exists: true, revision: `${resource}-r1`, content: "# native file", diagnostics: [], data: resource === "config" ? structuredClone(data) : {} }));
  const api = {
    bootstrap: vi.fn(async () => structuredClone(bootstrap)), readResource,
    planChange: vi.fn(async () => plan), applyChange: vi.fn(async () => operation), getOperation: vi.fn(async () => operation),
    savePreferences: vi.fn(async (input: Partial<Preferences>) => { Object.assign(bootstrap.preferences, input); return { ...bootstrap.preferences }; }),
    listPresets: vi.fn(async () => []), savePreset: vi.fn(), deletePreset: vi.fn(), planPreset: vi.fn(async () => plan),
    addTarget: vi.fn(), updateTarget: vi.fn(), listRecoveryCases: vi.fn(async () => []), openKimi: vi.fn(), login: vi.fn(),
    previewMigration: vi.fn(async () => ({
      status: "available", sourceDir: "/tmp/legacy-private", targetDir: "/tmp/current-private", manifestHash: "a".repeat(64),
      entries: [{ path: "panel.sqlite", action: "copy", sizeBytes: 1024, sha256: "b".repeat(64) }],
    })),
    applyMigration: vi.fn(async () => ({ status: "complete", migratedFiles: 1, retainedPaths: [] })),
  } as unknown as WebApi;
  return { api, bootstrap, data };
}
function projectFixture() {
  const result = fixture();
  const target = result.bootstrap.targets[0]!;
  target.workingDirectory = "/tmp/project-a";
  const defaultRead = vi.mocked(result.api.readResource).getMockImplementation()!;
  vi.mocked(result.api.readResource).mockImplementation(async (input) => {
    const { resource } = input;
    if (!["mcp", "mcp-project", "mcp-local", "project-local"].includes(resource)) return defaultRead(input);
    const directory = resource === "mcp" ? target.homePath : target.workingDirectory!;
    const file = resource === "mcp" ? "mcp.json" : resource === "mcp-project" ? ".mcp.json"
      : resource === "mcp-local" ? ".kimi-code/mcp.json" : ".kimi-code/local.toml";
    const source = resource === "mcp" ? "user" : directory.split("/").at(-1)!;
    return {
      resource, path: `${directory}/${file}`, format: resource === "project-local" ? "toml" : "json",
      exists: true, revision: `${resource}:${source}:r1`, content: "# isolated fixture", diagnostics: [],
      data: resource === "project-local" ? { workspace: { additional_dir: [`../${source}-shared`] } }
        : { mcpServers: { shared: { type: "stdio", command: `${source}-command`, args: [], future: "preserved" } } },
    };
  });
  vi.mocked(result.api.updateTarget).mockImplementation(async ({ workingDirectory }) => {
    if (workingDirectory === null) delete target.workingDirectory;
    else if (workingDirectory !== undefined) target.workingDirectory = workingDirectory;
    return { ...target };
  });
  vi.mocked(result.api.planChange).mockImplementation(async (input) => {
    const snapshot = await result.api.readResource(input);
    return { ...plan, resource: input.resource, path: snapshot.path, expectedRevision: input.expectedRevision };
  });
  return result;
}
beforeEach(() => {
  cleanup(); window.history.replaceState(null, "", "/");
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), clear: vi.fn() });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openProviders(api: WebApi): Promise<void> {
  render(<WebApp api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Models & connections" }));
  await screen.findByLabelText(/Base URL/);
}
async function reviewAndApply(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
  const dialog = await screen.findByRole("dialog");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Apply to native files" })); });
}
async function setWorkingDirectory(path: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Set working directory" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Working directory (optional)"), { target: { value: path } });
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Save directory settings" })); });
}

describe("WebApp native-file workflows", () => {
  it("creates an MCP server with the official transport field", async () => {
    const { api } = fixture();
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Extensions" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "new-server" } });
    fireEvent.change(screen.getByLabelText("Command (command)"), { target: { value: "fixture-command" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenCalledWith({
      targetId: "default", resource: "mcp", expectedRevision: "mcp-r1",
      changes: [{
        op: "set", path: ["mcpServers", "new-server"],
        value: { transport: "stdio", command: "fixture-command", args: [] },
      }],
    });
  });
  it("keeps the unsaved TUI draft and departure warning after applying global configuration", async () => {
    const { api, data } = fixture();
    const defaultRead = vi.mocked(api.readResource).getMockImplementation()!;
    vi.mocked(api.applyChange).mockImplementation(async () => {
      data.default_model = "saved-model";
      return operation;
    });
    vi.mocked(api.readResource).mockImplementation(async (input) => {
      const snapshot = await defaultRead(input);
      return input.resource === "tui" ? { ...snapshot, data: { theme: "dark" } } : snapshot;
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.change(screen.getByLabelText(/Default model/), { target: { value: "saved-model" } });
    fireEvent.click(screen.getByRole("tab", { name: "Terminal interface" }));
    fireEvent.change(screen.getByLabelText(/Terminal theme/), { target: { value: "light" } });
    fireEvent.click(screen.getByRole("tab", { name: "Global configuration" }));
    await reviewAndApply();
    await screen.findByText("Native files saved and read back.");

    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Models & connections" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal interface" }));
    expect(screen.getByLabelText(/Terminal theme/)).toHaveValue("light");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  });
  it.each(["direct", "dropped"])("does not resubmit a saved field after a %s apply response, external change and reload", async (response) => {
    const { api, data } = fixture();
    let revision = "config-r1";
    const defaultRead = vi.mocked(api.readResource).getMockImplementation()!;
    vi.mocked(api.readResource).mockImplementation(async (input) => {
      const snapshot = await defaultRead(input);
      return input.resource === "config" ? { ...snapshot, revision } : snapshot;
    });
    vi.mocked(api.applyChange).mockImplementation(async () => {
      data.default_model = "saved-model";
      revision = "config-r2";
      if (response === "dropped") throw new WebApiError("CONNECTION_LOST", "Apply response dropped");
      return operation;
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.change(screen.getByLabelText(/Default model/), { target: { value: "saved-model" } });
    await reviewAndApply();
    await screen.findByText("Native files saved and read back.");
    expect(api.applyChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();

    data.default_model = "externally-updated-model";
    revision = "config-r3";
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    expect(screen.getByLabelText(/Default model/)).toHaveValue("externally-updated-model");
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Telemetry/), { target: { value: "false" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenLastCalledWith({
      targetId: "default", resource: "config", expectedRevision: "config-r3",
      changes: [{ op: "set", path: ["telemetry"], value: false }],
    });
  });
  it.each(["failed", "conflict"] as const)("preserves configuration drafts when applying ends with %s", async (status) => {
    const { api } = fixture();
    vi.mocked(api.applyChange).mockResolvedValue({ ...operation, status });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.change(screen.getByLabelText(/Default model/), { target: { value: "unsaved-model" } });
    fireEvent.click(screen.getByRole("tab", { name: "Terminal interface" }));
    fireEvent.change(screen.getByLabelText(/Terminal theme/), { target: { value: "light" } });
    fireEvent.click(screen.getByRole("tab", { name: "Global configuration" }));
    await reviewAndApply();
    expect(screen.queryByText("Native files saved and read back.")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText(/Default model/)).toHaveValue("unsaved-model");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Models & connections" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal interface" }));
    expect(screen.getByLabelText(/Terminal theme/)).toHaveValue("light");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  });
  it("shows the migration gate without automatically previewing or applying legacy data", async () => {
    const { api, bootstrap } = fixture();
    bootstrap.migrationAvailable = true;
    await openProviders(api);
    expect(screen.getByText("Legacy private data needs migration")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review migration" })).toBeEnabled();
    expect(screen.getByLabelText(/Base URL/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(api.previewMigration).not.toHaveBeenCalled();
    expect(api.applyMigration).not.toHaveBeenCalled();
    expect(api.planChange).not.toHaveBeenCalled();
  });
  it("blocks native writes, target changes, preferences, and valid preset actions while migration is pending", async () => {
    const { api, bootstrap, data } = projectFixture();
    data.default_model = "fixture-model";
    vi.mocked(api.listPresets).mockResolvedValue([{
      name: "work", label: "Work preset", default_model: "fixture-model", default_plan_mode: false,
      default_permission_mode: "", merge_all_available_skills: true,
    }]);
    await openProviders(api);
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Switching presets" })); });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "new-preset" } });
    expect(screen.getByRole("button", { name: "Save current default model as preset" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

    bootstrap.migrationAvailable = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    expect(screen.getByText("Legacy private data needs migration")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Current directory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add configuration directory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set working directory" })).toBeDisabled();
    for (const name of ["Save current default model as preset", "Delete", "Review preset changes"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }

    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(screen.getByLabelText(/Base URL/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));
    expect(screen.getByLabelText("Command (command)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByLabelText(/Default model/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    expect(screen.getByRole("combobox", { name: "Language" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Appearance" })).toBeDisabled();

    for (const method of [api.planChange, api.applyChange, api.savePreferences, api.savePreset, api.deletePreset, api.planPreset, api.addTarget, api.updateTarget, api.applyMigration]) {
      expect(method).not.toHaveBeenCalled();
    }
  });
  it("previews migration on request and unlocks editing only after explicit migration and a fresh bootstrap", async () => {
    const { api, bootstrap } = fixture();
    bootstrap.migrationAvailable = true;
    vi.mocked(api.applyMigration).mockImplementationOnce(async () => {
      bootstrap.migrationAvailable = false;
      return { status: "complete", migratedFiles: 1, retainedPaths: [] };
    });
    await openProviders(api);
    expect(screen.getByLabelText(/Base URL/)).toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review migration" })); });
    const dialog = screen.getByRole("dialog", { name: "Migrate private data" });
    expect(api.previewMigration).toHaveBeenCalledTimes(1);
    expect(api.applyMigration).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Base URL/)).toBeDisabled();

    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Confirm private data migration" })); });
    expect(api.applyMigration).toHaveBeenCalledExactlyOnceWith({ manifestHash: "a".repeat(64) });
    expect(vi.mocked(api.bootstrap).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("dialog", { name: "Migrate private data" })).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy private data needs migration")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review migration" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/)).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Current directory" })).toBeEnabled();
    expect(api.planChange).not.toHaveBeenCalled();
    expect(api.applyChange).not.toHaveBeenCalled();
  });
  it("applies only A while preserving the independent B draft", async () => {
    const { api } = fixture(); await openProviders(api);
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "https://alpha-new.example" } });
    fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "https://beta-new.example" } });
    fireEvent.click(screen.getByRole("button", { name: /^alpha/ }));
    await reviewAndApply();
    await waitFor(() => expect(api.applyChange).toHaveBeenCalledTimes(1));
    expect(api.planChange).toHaveBeenCalledWith({ targetId: "default", resource: "config", expectedRevision: "config-r1", changes: [{ op: "set", path: ["providers", "alpha", "base_url"], value: "https://alpha-new.example" }] });
    await screen.findByText("Native files saved and read back.");
    fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
    expect(screen.getByLabelText(/Base URL/)).toHaveValue("https://beta-new.example");
  });
  it("queries a dropped apply response by plan ID without submitting it again", async () => {
    const { api } = fixture();
    vi.mocked(api.applyChange).mockRejectedValueOnce(new WebApiError("CONNECTION_LOST", "Connection dropped"));
    await openProviders(api);
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "https://alpha-new.example" } });
    await reviewAndApply();
    await waitFor(() => expect(api.getOperation).toHaveBeenCalledWith({ id: "plan-one" }));
    await screen.findByText("Native files saved and read back.");
    expect(api.applyChange).toHaveBeenCalledTimes(1);
  });
  it.each(["queued", "committing"] as const)("blocks another apply when polling an accepted %s operation loses connection", async (status) => {
    const { api } = fixture();
    vi.mocked(api.applyChange).mockResolvedValueOnce({ ...operation, status });
    vi.mocked(api.getOperation)
      .mockRejectedValueOnce(new WebApiError("CONNECTION_LOST", "Polling connection dropped"))
      .mockResolvedValueOnce(operation);
    await openProviders(api);
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "https://alpha-new.example" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    const dialog = screen.getByRole("dialog");

    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Apply to native files" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(api.getOperation).toHaveBeenNthCalledWith(1, { id: "op-one" });
      expect(within(dialog).getByText("The outcome is not confirmed. Check this operation before continuing to avoid duplicate writes.")).toBeInTheDocument();
      const apply = within(dialog).getByRole("button", { name: "Apply to native files" });
      const check = within(dialog).getByRole("button", { name: "Check this operation" });
      expect(apply).toBeDisabled();
      expect(check).toBeEnabled();
      fireEvent.click(apply);
      expect(api.applyChange).toHaveBeenCalledTimes(1);

      await act(async () => { fireEvent.click(check); });
      expect(api.getOperation).toHaveBeenNthCalledWith(2, { id: "plan-one" });
      expect(screen.getByText("Native files saved and read back.")).toBeInTheDocument();
      expect(api.applyChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps target drafts isolated and restores a draft when switching back", async () => {
    const { api } = fixture(); await openProviders(api);
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "https://local-draft.example" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Current directory" }), { target: { value: "other" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Current directory" })).toHaveValue("other"));
    expect(screen.getByLabelText(/Base URL/)).toHaveValue("https://alpha.example");
    fireEvent.change(screen.getByRole("combobox", { name: "Current directory" }), { target: { value: "default" } });
    await waitFor(() => expect(screen.getByLabelText(/Base URL/)).toHaveValue("https://local-draft.example"));
    expect(api.planChange).not.toHaveBeenCalled(); expect(api.applyChange).not.toHaveBeenCalled();
  });
  it("keeps same-named MCP drafts independent across user and local scopes and plans the selected file", async () => {
    const { api } = projectFixture();
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Extensions" }));
    fireEvent.change(screen.getByLabelText("Command (command)"), { target: { value: "user-draft-command" } });

    fireEvent.change(screen.getByRole("combobox", { name: "MCP file scope" }), { target: { value: "mcp-local" } });
    expect(screen.getByLabelText("Command (command)")).toHaveValue("project-a-command");
    fireEvent.change(screen.getByLabelText("Command (command)"), { target: { value: "local-draft-command" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenNthCalledWith(1, {
      targetId: "default", resource: "mcp-local", expectedRevision: "mcp-local:project-a:r1",
      changes: [{ op: "set", path: ["mcpServers", "shared", "command"], value: "local-draft-command" }],
    });
    expect(within(screen.getByRole("dialog")).getByText("/tmp/project-a/.kimi-code/mcp.json")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    fireEvent.change(screen.getByRole("combobox", { name: "MCP file scope" }), { target: { value: "mcp" } });
    expect(screen.getByLabelText("Command (command)")).toHaveValue("user-draft-command");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenNthCalledWith(2, {
      targetId: "default", resource: "mcp", expectedRevision: "mcp:user:r1",
      changes: [{ op: "set", path: ["mcpServers", "shared", "command"], value: "user-draft-command" }],
    });
    expect(within(screen.getByRole("dialog")).getByText("/tmp/kimi/mcp.json")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("combobox", { name: "MCP file scope" }), { target: { value: "mcp-local" } });
    expect(screen.getByLabelText("Command (command)")).toHaveValue("local-draft-command");
    expect(api.applyChange).not.toHaveBeenCalled();
  });
  it("keeps a local MCP draft at its original path when the target working directory changes", async () => {
    const { api } = projectFixture();
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Extensions" }));
    fireEvent.change(screen.getByRole("combobox", { name: "MCP file scope" }), { target: { value: "mcp-local" } });
    fireEvent.change(screen.getByLabelText("Command (command)"), { target: { value: "project-a-unsaved" } });

    await setWorkingDirectory("/tmp/project-b");
    expect(api.updateTarget).toHaveBeenCalledWith({ targetId: "default", workingDirectory: "/tmp/project-b" });
    expect(screen.getByRole("combobox", { name: "MCP file scope" })).toHaveValue("mcp");
    fireEvent.change(screen.getByRole("combobox", { name: "MCP file scope" }), { target: { value: "mcp-local" } });
    expect(screen.getByLabelText("Command (command)")).toHaveValue("project-b-command");
    expect(screen.getByText("/tmp/project-b/.kimi-code/mcp.json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Command (command)"), { target: { value: "project-b-unsaved" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenCalledWith({
      targetId: "default", resource: "mcp-local", expectedRevision: "mcp-local:project-b:r1",
      changes: [{ op: "set", path: ["mcpServers", "shared", "command"], value: "project-b-unsaved" }],
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    await setWorkingDirectory("/tmp/project-a");
    fireEvent.change(screen.getByRole("combobox", { name: "MCP file scope" }), { target: { value: "mcp-local" } });
    expect(screen.getByLabelText("Command (command)")).toHaveValue("project-a-unsaved");
    expect(screen.getByText("/tmp/project-a/.kimi-code/mcp.json")).toBeInTheDocument();
    expect(api.applyChange).not.toHaveBeenCalled();
  });
  it("requires confirmation before replacing a project configuration draft and starts fresh at the new path", async () => {
    const { api } = projectFixture();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: "Project configuration" }));
    fireEvent.change(screen.getByLabelText(/Additional working directories/), { target: { value: "../project-a-unsaved" } });

    await setWorkingDirectory("/tmp/project-b");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.updateTarget).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Additional working directories/)).toHaveValue("../project-a-unsaved");
    const dialog = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Save directory settings" })); });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.updateTarget).toHaveBeenCalledWith({ targetId: "default", workingDirectory: "/tmp/project-b" });
    fireEvent.click(screen.getByRole("tab", { name: "Project configuration" }));
    expect(screen.getByLabelText(/Additional working directories/)).toHaveValue("../project-b-shared");
    expect(screen.getByText("/tmp/project-b/.kimi-code/local.toml")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Additional working directories/), { target: { value: "../project-b-edited" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenCalledWith({
      targetId: "default", resource: "project-local", expectedRevision: "project-local:project-b:r1",
      changes: [{ op: "set", path: ["workspace", "additional_dir"], value: ["../project-b-edited"] }],
    });
    expect(within(screen.getByRole("dialog")).getByText("/tmp/project-b/.kimi-code/local.toml")).toBeInTheDocument();
    expect(api.applyChange).not.toHaveBeenCalled();
  });
  it("keeps a project draft when browser history navigation is declined and leaves only after confirmation", async () => {
    const { api } = projectFixture();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: "Project configuration" }));
    fireEvent.change(screen.getByLabelText(/Additional working directories/), { target: { value: "../history-draft" } });

    window.history.replaceState(null, "", "/?page=overview");
    fireEvent.popState(window);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Additional working directories/)).toHaveValue("../history-draft");
    expect(new URLSearchParams(location.search).get("page")).toBe("configuration");

    window.history.replaceState(null, "", "/?page=overview");
    fireEvent.popState(window);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: "Project configuration" }));
    expect(screen.getByLabelText(/Additional working directories/)).toHaveValue("../project-a-shared");
    expect(api.planChange).not.toHaveBeenCalled();
    expect(api.applyChange).not.toHaveBeenCalled();
  });
  it("distinguishes empty configuration from a damaged file and does not read unselected project files", async () => {
    const { api } = fixture();
    vi.mocked(api.readResource).mockImplementation(async ({ resource }) => ({ resource, path: `/tmp/kimi/${resource}`, format: "toml", revision: "", exists: false, data: {}, content: null, diagnostics: [] }));
    render(<WebApp api={api} />);
    await screen.findByText("This directory has no configuration yet. Add a provider or model, then review changes before creating native files.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Models & connections" }));
    expect(screen.getAllByRole("button", { name: "Add" })[0]).toBeEnabled();
    expect(vi.mocked(api.readResource).mock.calls.some(([input]) => input.resource === "project-local")).toBe(false);
  });
  it("renders a damaged file read-only without inventing providers", async () => {
    const { api } = fixture();
    vi.mocked(api.readResource).mockResolvedValue({ resource: "config", path: "/tmp/kimi/config.toml", format: "toml", exists: true, revision: "broken", content: "[broken", diagnostics: [{ code: "parse-error", severity: "error", message: "Malformed TOML" }] });
    render(<WebApp api={api} />);
    expect((await screen.findAllByText("Invalid file")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Editable")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Models & connections" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByText("Select a resource to view its details.")).toBeInTheDocument();
    expect(api.planChange).not.toHaveBeenCalled();
    expect(vi.mocked(api.readResource).mock.calls.some(([input]) => input.resource === "project-local")).toBe(false);
  });
  it("shows a connection recovery screen instead of editable fallback configuration", async () => {
    const { api } = fixture(); vi.mocked(api.bootstrap).mockRejectedValue(new WebApiError("CONNECTION_LOST", "Offline"));
    render(<WebApp api={api} />);
    await screen.findByRole("heading", { name: "Local service disconnected" });
    expect(screen.queryByRole("button", { name: "Models & connections" })).not.toBeInTheDocument();
    expect(api.readResource).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
  it("passes an explicit working directory when adding a target", async () => {
    const { api } = fixture(); render(<WebApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add configuration directory" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Directory name"), { target: { value: "Project" } });
    fireEvent.change(within(dialog).getByLabelText("KIMI_CODE_HOME directory"), { target: { value: "/tmp/custom" } });
    fireEvent.change(within(dialog).getByLabelText("Working directory (optional)"), { target: { value: "/tmp/repo" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Add" })); });
    await waitFor(() => expect(api.addTarget).toHaveBeenCalledWith({ name: "Project", homePath: "/tmp/custom", workingDirectory: "/tmp/repo" }));
  });
});
