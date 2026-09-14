import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rendererRoot = resolve(process.cwd(), "src/renderer/src");
const componentsSource = readFileSync(resolve(rendererRoot, "components.css"), "utf8");
const tabPanelsSource = readFileSync(resolve(rendererRoot, "tabs/TabPanels.tsx"), "utf8");

describe("Kimi Code settings layout", () => {
  it("lets each sub-page detail span every available wide-screen column", () => {
    expect(tabPanelsSource).toContain('className="settings-tab-panel kimi-code-settings-panel"');
    expect(componentsSource).toMatch(
      /\.kimi-code-settings-panel\s*>\s*\.settings-group,[\s\S]*\.kimi-code-settings-panel\s*>\s*\.oauth-login-panel\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/s,
    );
  });
});
