import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokenSource = readFileSync(resolve(process.cwd(), "src/renderer/src/tokens.css"), "utf8");
const foundationSource = readFileSync(resolve(process.cwd(), "src/renderer/src/foundation.css"), "utf8");

function luminance(hex: string): number {
  const values = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const [r = 0, g = 0, b = 0] = values.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("design tokens", () => {
  it("never defines semantic text below 12px", () => {
    const sizes = Array.from(tokenSource.matchAll(/--text-[\w-]+:\s*(\d+)px/g), (match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  });

  it("defines one shared geometry for every topbar control", () => {
    expect(tokenSource).toContain("--topbar-control-height: 52px");
    expect(tokenSource).toContain("--topbar-control-radius: var(--radius-xl)");
  });

  it("keeps form actions in flow and advanced section titles on one line", () => {
    const footerRule = foundationSource.match(/\.form-panel > \.button-row\s*{([^}]+)}/)?.[1] ?? "";
    expect(footerRule).toContain("position: static");
    expect(footerRule).not.toContain("position: sticky");
    expect(foundationSource).toContain(".advanced-collapse > summary");
    expect(foundationSource).toContain("white-space: nowrap");
  });

  it("keeps primary button text at WCAG AA contrast across light themes", () => {
    const lightThemePairs = [
      ["#176edc", "#ffffff"], ["#2563eb", "#ffffff"], ["#7c3aed", "#ffffff"],
      ["#ea580c", "#101828"], ["#16a34a", "#101828"], ["#ec4899", "#101828"],
      ["#059669", "#101828"], ["#4f46e5", "#ffffff"], ["#d97706", "#101828"],
    ];
    for (const [background, foreground] of lightThemePairs) {
      expect(contrast(background, foreground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
