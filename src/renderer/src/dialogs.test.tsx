import { useRef, useState } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog, DialogShell, useFocusTrap } from "./dialogs";

function InlineDialog(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return <><button type="button">Background</button><div ref={ref} role="dialog"><button type="button">Inside</button></div></>;
}

function DialogShellHarness(): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>Open dialog</button>
      {isOpen ? (
        <DialogShell
          backdropClassName="test-backdrop"
          dialogClassName="test-dialog"
          ariaLabelledBy="test-dialog-title"
          onClose={() => setIsOpen(false)}
        >
          <h2 id="test-dialog-title">Dialog title</h2>
          <button type="button" data-dialog-initial-focus>Keep editing</button>
          <button type="button">Close later</button>
        </DialogShell>
      ) : null}
    </>
  );
}

function NestedDialogHarness(): JSX.Element | null {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(false);
  return outerOpen ? (
    <DialogShell backdropClassName="test-backdrop" dialogClassName="test-dialog" ariaLabel="Outer dialog" onClose={() => setOuterOpen(false)}>
      <button type="button" onClick={() => setInnerOpen(true)}>Open nested dialog</button>
      {innerOpen ? (
        <DialogShell backdropClassName="test-backdrop" dialogClassName="test-dialog" ariaLabel="Inner dialog" onClose={() => setInnerOpen(false)}>
          <button type="button" data-dialog-initial-focus>Dismiss nested dialog</button>
        </DialogShell>
      ) : null}
    </DialogShell>
  ) : null;
}

describe("dialog accessibility", () => {
  it("inerts only siblings outside an inline dialog", async () => {
    const { getByRole, getByText } = render(<InlineDialog />);
    await waitFor(() => expect(document.activeElement).toBe(getByRole("button", { name: "Inside" })));
    expect(getByRole("dialog").hasAttribute("inert")).toBe(false);
    expect(getByText("Background").hasAttribute("inert")).toBe(true);
  });

  it("treats Escape as cancel rather than discard in an unsaved dialog", () => {
    const onCancel = vi.fn();
    const onDiscard = vi.fn();
    render(<ConfirmDialog title="Unsaved" description="Keep editing?" confirmLabel="Save" cancelLabel="Cancel" discardLabel="Discard" tone="primary" kind="unsaved" onConfirm={() => {}} onCancel={onCancel} onDiscard={onDiscard} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("closes a dialog shell with Escape and restores focus to its trigger", async () => {
    const { getByRole, queryByRole } = render(<DialogShellHarness />);
    const trigger = getByRole("button", { name: "Open dialog" });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = getByRole("dialog", { name: "Dialog title" });
    await waitFor(() => expect(document.activeElement).toBe(getByRole("button", { name: "Keep editing" })));

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes only the topmost dialog when dialogs are nested", async () => {
    const { getByRole, queryByRole } = render(<NestedDialogHarness />);
    fireEvent.click(getByRole("button", { name: "Open nested dialog" }));
    expect(getByRole("dialog", { name: "Inner dialog" })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(queryByRole("dialog", { name: "Inner dialog" })).toBeNull());
    expect(getByRole("dialog", { name: "Outer dialog" })).toBeDefined();
  });
});
