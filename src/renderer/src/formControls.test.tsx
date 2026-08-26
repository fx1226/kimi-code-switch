import { fireEvent, render, waitFor } from "@testing-library/react";
import { Globe } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { ReadOnlyField, SelectField } from "./formControls";

describe("form controls", () => {
  it("uses a native labeled select for simple enums", () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<SelectField label="Mode" value="manual" options={[{ value: "manual", label: "Manual" }, { value: "auto", label: "Auto" }]} onChange={onChange} />);
    fireEvent.change(getByLabelText("Mode"), { target: { value: "auto" } });
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("does not expose rich options while the popup is closed", () => {
    const { getByRole, queryByRole } = render(<SelectField label="Provider" value="kimi" options={[{ value: "kimi", label: "Kimi", icon: Globe }, { value: "openai", label: "OpenAI", icon: Globe }]} onChange={() => {}} />);
    expect(queryByRole("listbox", { name: "Provider" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Provider Kimi" }));
    expect(getByRole("listbox", { name: "Provider" })).toBeDefined();
  });

  it("opens rich options with ArrowDown and moves focus with End", async () => {
    const { getByRole, getAllByRole } = render(<SelectField label="Provider" value="kimi" options={[{ value: "kimi", label: "Kimi", icon: Globe }, { value: "openai", label: "OpenAI", icon: Globe }]} onChange={() => {}} />);
    const trigger = getByRole("button", { name: "Provider Kimi" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(getAllByRole("option")[0]));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(getAllByRole("option")[1]);
  });

  it("keeps read-only values focusable and copyable", () => {
    const { getByDisplayValue } = render(<ReadOnlyField label="Path" value="/tmp/config" />);
    expect((getByDisplayValue("/tmp/config") as HTMLInputElement).disabled).toBe(false);
  });
});
