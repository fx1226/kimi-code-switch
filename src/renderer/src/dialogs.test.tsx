import { useRef } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog, useFocusTrap } from "./dialogs";

function InlineDialog(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return <><button type="button">Background</button><div ref={ref} role="dialog"><button type="button">Inside</button></div></>;
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
});
