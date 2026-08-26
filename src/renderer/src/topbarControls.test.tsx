import { fireEvent, render } from "@testing-library/react";
import { MonitorCog, MoonStar } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { TopbarControls } from "./topbarControls";

function renderControls() {
  return render(<TopbarControls locale="en-US" theme="auto" localeOptions={[{ value: "en-US", shortLabel: "EN", longLabel: "English" }, { value: "zh-CN", shortLabel: "中", longLabel: "中文" }]} themeOptions={[{ value: "auto", icon: MonitorCog, shortLabel: "A", label: { "en-US": "Auto" } }, { value: "dark", icon: MoonStar, shortLabel: "D", label: { "en-US": "Dark" } }]} environmentId="default" environmentOptions={[{ value: "default", label: "Default" }]} onLocaleChange={vi.fn()} onThemeChange={vi.fn()} onEnvironmentChange={vi.fn()} />);
}

describe("TopbarControls", () => {
  it("keeps preference menu items out of the tab order while closed", () => {
    const { getByRole, queryByRole } = renderControls();
    expect(queryByRole("menu", { name: "Preferences" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Preferences" }));
    expect(getByRole("menu", { name: "Preferences" })).toBeDefined();
  });

  it("closes the preferences menu with Escape", () => {
    const { getByRole, queryByRole } = renderControls();
    fireEvent.click(getByRole("button", { name: "Preferences" }));
    fireEvent.keyDown(getByRole("menu", { name: "Preferences" }), { key: "Escape" });
    expect(queryByRole("menu", { name: "Preferences" })).toBeNull();
  });
});
