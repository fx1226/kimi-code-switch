import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentsSource = readFileSync(resolve(process.cwd(), "src/renderer/src/components.css"), "utf8");

function getRuleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return componentsSource.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("workspace layout", () => {
  it("lets the Skills and MCP workspaces fill the split-layout editor column", () => {
    expect(getRuleBody(".skills-workspace")).toContain("width: 100%");
    expect(getRuleBody(".mcp-workspace")).toContain("width: 100%");
    expect(componentsSource).not.toMatch(
      /\.split-layout\s*>\s*:nth-child\(2\)\s*>\s*\.form-panel[^{}]*\{[^}]*max-width/s,
    );
    expect(componentsSource).not.toMatch(
      /\.split-layout\s*>\s*:nth-child\(2\)\s*>\s*\.mcp-workspace\s*>\s*\.form-panel[^{}]*\{[^}]*max-width/s,
    );
  });
});
