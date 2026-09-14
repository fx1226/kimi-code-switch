import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResourceWorkspace } from "./layoutComponents";

describe("ResourceWorkspace", () => {
  it("keeps selection separate from row actions and supports keyboard navigation", () => {
    const onSelect = vi.fn();
    const onCopy = vi.fn();
    const { getByRole } = render(
      <ResourceWorkspace
        listTitle="Profiles"
        listItems={["work", "personal"]}
        selectedItem="work"
        highlightedItem="work"
        onSelect={onSelect}
        onCopy={onCopy}
        copyLabel="Clone"
        addLabel="New profile"
      >
        <section>Editor</section>
      </ResourceWorkspace>,
    );

    const work = getByRole("button", { name: "work" });
    expect(work.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(work, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("personal");

    fireEvent.click(getByRole("button", { name: "Clone work" }));
    expect(onCopy).toHaveBeenCalledWith("work");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
