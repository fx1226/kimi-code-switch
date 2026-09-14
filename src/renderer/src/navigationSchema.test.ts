import { describe, expect, it } from "vitest";

import { NAVIGATION_ITEMS, isTabId } from "./appOptions";

describe("navigation schema", () => {
  it("defines every routable page once with a sidebar section", () => {
    const expectedIds = ["overview", "profiles", "providers", "models", "mcp", "skills", "insights", "settings", "about"];
    expect(NAVIGATION_ITEMS.map((item) => item.id).sort()).toEqual([...expectedIds].sort());
    expect(new Set(NAVIGATION_ITEMS.map((item) => item.id)).size).toBe(expectedIds.length);
    expect(NAVIGATION_ITEMS.every((item) => item.section === "primary" || item.section === "configuration" || item.section === "footer")).toBe(true);
    expect(expectedIds.every(isTabId)).toBe(true);
    expect(isTabId("missing-page")).toBe(false);
  });
});
