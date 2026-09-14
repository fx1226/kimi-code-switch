import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TabList } from "./tabList";

describe("TabList", () => {
  it("uses tab semantics and changes tabs with arrow keys", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <TabList
        label="Kimi Code sections"
        activeId="instance"
        onChange={onChange}
        items={[
          { id: "instance", label: "Instance" },
          { id: "accounts", label: "Accounts" },
        ]}
      />,
    );

    const firstTab = getByRole("tab", { name: "Instance" });
    expect(firstTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(firstTab, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("accounts");
  });
});
