import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Toast, ToastContainer } from "./Toast";

describe("Toast", () => {
  it("announces errors assertively and keeps them visible until dismissed", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { getByRole } = render(<Toast message="Connection failed" type="error" closeLabel="Close" copyLabel="Copy" onClose={onClose} />);

    expect(getByRole("alert").textContent).toContain("Connection failed");
    vi.advanceTimersByTime(30_000);
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses localized action labels and exposes a polite live region", () => {
    const { getByRole, getByLabelText } = render(
      <ToastContainer locale="en-US" toasts={[{ id: "1", message: "Saved", type: "success" }]} onRemove={() => {}} />,
    );

    expect(getByRole("status")).toBeDefined();
    expect(getByLabelText("Close")).toBeDefined();
    fireEvent.click(getByLabelText("Close"));
  });
});
