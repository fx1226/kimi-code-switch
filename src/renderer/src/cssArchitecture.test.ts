import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src/renderer/src");
const styles = readFileSync(resolve(root, "styles.css"), "utf8");
const tokens = readFileSync(resolve(root, "tokens.css"), "utf8");
const insights = readFileSync(resolve(root, "insights.css"), "utf8");

describe("CSS architecture", () => {
  it("keeps the cascade explicit from tokens through shell geometry", () => {
    expect(styles).toContain("@layer tokens, legacy-components, primitives, patterns, features, overrides, shell;");
    expect(styles).toContain('@import "./primitives.css" layer(primitives);');
    expect(styles).toContain('@import "./patterns.css" layer(patterns);');
    expect(styles).toContain('@import "./insights.css" layer(features);');
    expect(styles).toContain('@import "./layout.css" layer(shell);');
  });

  it("defines semantic interaction, overlay, field, and density tokens", () => {
    for (const token of [
      "--state-selected-bg",
      "--state-active-bg",
      "--state-dirty",
      "--overlay-scrim",
      "--field-bg",
      "--list-row-min-height",
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it("keeps metric colors semantic instead of embedding fixed hex values in Insights", () => {
    expect(insights).not.toMatch(/#(?:3b82f6|10b981|d97706|8b5cf6)/i);
  });
});
