import { fireEvent, render, waitFor } from "@testing-library/react";
import { Globe } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { ActionFooter, ReadOnlyField, SelectField } from "./formControls";

describe("form controls", () => {
  it("ActionFooter renders without crashing and shows save title hint", () => {
    const onSave = vi.fn();
    const { getByText } = render(<ActionFooter onSave={onSave} saveLabel="Save" deleteLabel="Delete" onDelete={vi.fn()} />);
    const saveButton = getByText("Save").closest("button");
    expect(saveButton).not.toBeNull();
    // 默认 app.save 加速键为 CommandOrControl+S，formatAcceleratorForPlatform 在 macOS 下渲染为 ⌘S
    expect(saveButton?.getAttribute("title")).toContain("S");
  });

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
