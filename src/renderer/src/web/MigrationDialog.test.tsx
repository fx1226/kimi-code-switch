import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyMigrationPreview, WebApi } from "@shared/webApi";
import { MigrationDialog } from "./MigrationDialog";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const preview: LegacyMigrationPreview = {
  status: "available", sourceDir: "/tmp/old-private", targetDir: "/tmp/new-private", manifestHash: "reviewed-hash",
  entries: [
    { path: "app.db", action: "copy", sizeBytes: 2048, sha256: "db-sha" },
    { path: "retired.json", action: "archive", sizeBytes: 12, sha256: "archive-sha" },
    { path: ".env/default", action: "retain", sizeBytes: 0, sha256: null },
  ],
};
function mockApi(overrides: Partial<WebApi> = {}): WebApi {
  return {
    previewMigration: vi.fn().mockResolvedValue(preview),
    applyMigration: vi.fn().mockResolvedValue({ status: "complete", migratedFiles: 2, retainedPaths: ["/tmp/old-private/.env/default"] }),
    ...overrides,
  } as unknown as WebApi;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("MigrationDialog", () => {
  it("previews the paths, actions, byte counts and revision without applying anything", async () => {
    const api = mockApi();
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={vi.fn()} onMigrated={vi.fn()} />);
    await view.findByText("app.db");
    expect(api.previewMigration).toHaveBeenCalledOnce();
    expect(api.applyMigration).not.toHaveBeenCalled();
    for (const value of ["/tmp/old-private", "/tmp/new-private", "reviewed-hash", "Copy", "Archive", "Retain in original location", "2,048 B"]) expect(view.getByText(value)).toBeDefined();
    expect(view.getByRole("heading", { name: "Migration entries: 3" })).toBeDefined();
    expect(view.getByText("Copy 1 · Archive 1 · Retain in original location 1 · 2,060 B")).toBeDefined();
    expect((view.getByRole("button", { name: "Confirm private data migration" }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByText(/native configuration is not moved or modified/)).toBeDefined();
  });

  it.each(["blocked", "absent", "complete"] as const)("disables confirmation when migration status is %s", async (status) => {
    const api = mockApi({ previewMigration: vi.fn().mockResolvedValue({ ...preview, status, blockedReason: status === "blocked" ? 'Old process running. api_key = "PRIVATE_KEY"' : undefined }) });
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={vi.fn()} onMigrated={vi.fn()} />);
    await view.findByText("app.db");
    if (status === "complete") expect(view.queryByRole("button", { name: "Confirm private data migration" })).toBeNull();
    else expect((view.getByRole("button", { name: "Confirm private data migration" }) as HTMLButtonElement).disabled).toBe(true);
    if (status === "blocked") expect(view.getByText(/Old process running/).textContent).toContain("[REDACTED]");
    expect(view.container.textContent).not.toContain("PRIVATE_KEY");
    expect(api.applyMigration).not.toHaveBeenCalled();
  });

  it("does not enable confirmation for an empty manifest hash or malformed entries", async () => {
    const api = mockApi({ previewMigration: vi.fn().mockResolvedValueOnce({ ...preview, manifestHash: "" }).mockResolvedValueOnce({ ...preview, entries: [{ path: "app.db", action: "delete", sizeBytes: 1 }] }) });
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={vi.fn()} onMigrated={vi.fn()} />);
    await view.findByRole("alert");
    expect((view.getByRole("button", { name: "Confirm private data migration" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Reload migration preview" }));
    await waitFor(() => expect(api.previewMigration).toHaveBeenCalledTimes(2));
    await view.findByRole("alert");
    expect((view.getByRole("button", { name: "Confirm private data migration" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.applyMigration).not.toHaveBeenCalled();
  });

  it("submits the reviewed hash, waits for the completion callback, and blocks close while applying", async () => {
    const api = mockApi();
    const completion = deferred<void>();
    const onMigrated = vi.fn().mockReturnValue(completion.promise);
    const onClose = vi.fn();
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={onClose} onMigrated={onMigrated} />);
    await view.findByText("app.db");
    fireEvent.click(view.getByRole("button", { name: "Confirm private data migration" }));
    await waitFor(() => expect(onMigrated).toHaveBeenCalledOnce());
    expect(api.applyMigration).toHaveBeenCalledWith({ manifestHash: "reviewed-hash" });
    expect(onClose).not.toHaveBeenCalled();
    expect(view.getAllByRole("button", { name: "Close" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent(view.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => completion.resolve());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retains the preview after an apply failure and requires a fresh preview before retrying with its new hash", async () => {
    const api = mockApi({
      previewMigration: vi.fn().mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, manifestHash: "fresh-hash" }),
      applyMigration: vi.fn().mockRejectedValueOnce(new Error("PRIVATE_ERROR")).mockResolvedValueOnce({ status: "complete", migratedFiles: 2, retainedPaths: [] }),
    });
    const onClose = vi.fn();
    const onMigrated = vi.fn().mockResolvedValue(undefined);
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={onClose} onMigrated={onMigrated} />);
    await view.findByText("app.db");
    fireEvent.click(view.getByRole("button", { name: "Confirm private data migration" }));
    await view.findByRole("alert");
    expect(view.getByText("app.db")).toBeDefined();
    expect(view.getByText("reviewed-hash")).toBeDefined();
    expect(view.container.textContent).not.toContain("PRIVATE_ERROR");
    expect((view.getByRole("button", { name: "Confirm private data migration" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onMigrated).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Reload migration preview" }));
    await view.findByText("fresh-hash");
    fireEvent.click(view.getByRole("button", { name: "Confirm private data migration" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.applyMigration).toHaveBeenLastCalledWith({ manifestHash: "fresh-hash" });
  });

  it("does not call the completion callback or close for a non-complete apply result", async () => {
    const api = mockApi({ applyMigration: vi.fn().mockResolvedValue({ status: "pending", migratedFiles: 0, retainedPaths: [] }) });
    const onClose = vi.fn();
    const onMigrated = vi.fn();
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={onClose} onMigrated={onMigrated} />);
    await view.findByText("app.db");
    fireEvent.click(view.getByRole("button", { name: "Confirm private data migration" }));
    await view.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(onMigrated).not.toHaveBeenCalled();
    expect(view.getByText("app.db")).toBeDefined();
  });

  it("can refresh a completed migration after the completion callback fails without applying again", async () => {
    const api = mockApi();
    const onMigrated = vi.fn().mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={onClose} onMigrated={onMigrated} />);
    await view.findByText("app.db");
    fireEvent.click(view.getByRole("button", { name: "Confirm private data migration" }));
    await view.findByRole("alert");
    expect(view.getByText("Migration complete")).toBeDefined();
    expect(view.getByText("app.db")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Reload files" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.applyMigration).toHaveBeenCalledOnce();
    expect(onMigrated).toHaveBeenCalledTimes(2);
  });

  it("allows rereading a failed initial preview and ignores results after unmount", async () => {
    const pending = deferred<LegacyMigrationPreview>();
    const api = mockApi({ previewMigration: vi.fn().mockRejectedValueOnce(new Error("PRIVATE_PREVIEW")).mockReturnValueOnce(pending.promise) });
    const onClose = vi.fn();
    const onMigrated = vi.fn();
    const view = render(<MigrationDialog api={api} locale="en-US" onClose={onClose} onMigrated={onMigrated} />);
    await view.findByRole("alert");
    expect(view.container.textContent).not.toContain("PRIVATE_PREVIEW");
    fireEvent.click(view.getByRole("button", { name: "Reload migration preview" }));
    view.unmount();
    await act(async () => pending.resolve(preview));
    expect(api.applyMigration).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onMigrated).not.toHaveBeenCalled();
  });
});
