import { useState } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFallbackState } from "./tabComponents";
import { QuickProfileSwitcher } from "./quickProfileSwitcher";

function createState() {
  const state = createFallbackState();
  state.profiles = {
    work: { name: "work", label: "Work", default_model: "openai/gpt-5", default_plan_mode: false, default_permission_mode: "manual", merge_all_available_skills: true },
    fast: { name: "fast", label: "Fast", default_model: "local/qwen", default_plan_mode: false, default_permission_mode: "auto", merge_all_available_skills: true },
  };
  state.activeProfile = "work";
  return state;
}

function Harness(props: { onActivate: (name: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open profiles</button>
      {open ? <QuickProfileSwitcher state={createState()} locale="en-US" onActivate={(name) => { props.onActivate(name); setOpen(false); }} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe("QuickProfileSwitcher", () => {
  it("starts on the active profile, supports arrows and activates the selected profile", async () => {
    const onActivate = vi.fn();
    const { getByRole, getAllByRole } = render(<Harness onActivate={onActivate} />);
    fireEvent.click(getByRole("button", { name: "Open profiles" }));

    const options = getAllByRole("option");
    await waitFor(() => expect(options[0]?.getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    await waitFor(() => expect(options[1]?.getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(options[0]!, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith("fast");
  });

  it("returns focus to the trigger on Escape", async () => {
    const { getByRole, queryByRole } = render(<Harness onActivate={vi.fn()} />);
    const trigger = getByRole("button", { name: "Open profiles" });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
