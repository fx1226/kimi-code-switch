import { useState } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFallbackState } from "./tabComponents";
import { CommandPalette } from "./commandPalette";

function PaletteHarness(): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const state = createFallbackState();
  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>Open search</button>
      {isOpen ? (
        <CommandPalette
          state={state}
          locale="en-US"
          onSelect={() => {}}
          onClose={() => setIsOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("CommandPalette", () => {
  it("returns focus to its trigger when its modal closes", async () => {
    const { getByRole, queryByRole } = render(<PaletteHarness />);
    const trigger = getByRole("button", { name: "Open search" });

    trigger.focus();
    fireEvent.click(trigger);
    const input = getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
