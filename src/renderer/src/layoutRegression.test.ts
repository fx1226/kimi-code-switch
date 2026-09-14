import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rendererRoot = resolve(process.cwd(), "src/renderer/src");
const layoutSource = readFileSync(resolve(rendererRoot, "layout.css"), "utf8");
const foundationSource = readFileSync(resolve(rendererRoot, "foundation.css"), "utf8");
const componentsSource = readFileSync(resolve(rendererRoot, "components.css"), "utf8");
const appSource = readFileSync(resolve(rendererRoot, "App.tsx"), "utf8");

function ruleBodies(source: string, selector: string): string[] {
  const selectorPattern = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(source.matchAll(new RegExp(`(?:^|,)\\s*${selectorPattern}\\s*\\{([^{}]*)\\}`, "gm")), (match) => match[1]);
}

function mediaBody(source: string, breakpoint: number): string {
  const marker = `@media (max-width: ${breakpoint}px)`;
  const start = source.indexOf(marker);
  if (start < 0) return "";

  const openingBrace = source.indexOf("{", start + marker.length);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  return "";
}

function expectBalancedBraces(source: string): void {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  for (const character of withoutComments) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
}

describe("desktop layout regressions", () => {
  it("keeps the masthead toggle and topbar groups in their shared layout flow", () => {
    const mastheadStart = appSource.indexOf('<div className="brand drag-region"');
    const mastheadEnd = appSource.indexOf('<nav className="nav"', mastheadStart);
    const toggle = appSource.indexOf('className="sidebar-collapse-button no-drag"', mastheadStart);
    const topbarStart = appSource.indexOf('<header className="topbar">');
    const topbarEnd = appSource.indexOf('<div className="content-scroll"', topbarStart);
    const heading = appSource.indexOf('<div className="page-heading">', topbarStart);
    const toolbar = appSource.indexOf('<div className="toolbar">', topbarStart);

    expect(mastheadStart).toBeGreaterThanOrEqual(0);
    expect(toggle).toBeGreaterThan(mastheadStart);
    expect(toggle).toBeLessThan(mastheadEnd);
    expect(heading).toBeGreaterThan(topbarStart);
    expect(toolbar).toBeGreaterThan(heading);
    expect(toolbar).toBeLessThan(topbarEnd);
  });

  it("keeps collapsed-sidebar geometry in the layout authority", () => {
    expect(layoutSource).toContain("--shell-sidebar-collapsed-width");
    expect(layoutSource).toContain("--shell-sidebar-inline-padding");
    expect(layoutSource).toMatch(
      /\.shell\.sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*var\(--shell-sidebar-collapsed-width\)\s+minmax\(0, 1fr\)/s,
    );
    expect(ruleBodies(layoutSource, ".shell.sidebar-collapsed").join("\n")).toMatch(
      /--shell-sidebar-inline-padding\s*:/,
    );
    expect(ruleBodies(layoutSource, ".sidebar").join("\n")).toMatch(
      /padding(?:-inline)?\s*:[^;]*var\(--shell-sidebar-inline-padding\)/,
    );

    for (const source of [foundationSource, componentsSource]) {
      const collapsedSidebarRules = ruleBodies(source, ".shell.sidebar-collapsed .sidebar").join("\n");
      expect(collapsedSidebarRules).not.toMatch(/\b(?:width|padding|margin|grid-template-columns)\s*:/);
    }
  });

  it("keeps the collapsed sidebar toggle in the masthead flow", () => {
    const collapsedToggleRules = [layoutSource, foundationSource, componentsSource]
      .flatMap((source) => ruleBodies(source, ".shell.sidebar-collapsed .sidebar-collapse-button"))
      .join("\n");

    expect(collapsedToggleRules).not.toMatch(/\bposition\s*:\s*absolute\b/);
    expect(collapsedToggleRules).not.toMatch(/\b(?:top|right|bottom|left)\s*:/);
  });

  it("keeps every application stylesheet structurally balanced", () => {
    for (const source of [layoutSource, foundationSource, componentsSource]) {
      expectBalancedBraces(source);
    }
  });

  it("progressively condenses the topbar at 1240px, 1140px, and 1100px", () => {
    const at1240 = mediaBody(foundationSource, 1240);
    const at1140 = mediaBody(foundationSource, 1140);
    const at1100 = mediaBody(foundationSource, 1100);

    expect(at1240).toMatch(/\.topbar-search-button span,[\s\S]*\.topbar-search-button kbd,[\s\S]*\.toolbar-icon-copy small\s*\{\s*display:\s*none/s);
    expect(at1240).toMatch(/\.toolbar-icon-button,[\s\S]*\.toolbar-environment-button,[\s\S]*\.toolbar-preferences-button\s*\{\s*min-width:\s*var\(--control-h-md\)/s);
    expect(at1140).toMatch(/\.page-heading p\s*\{\s*display:\s*none/);
    expect(at1140).toMatch(/\.active-profile-label\s*\{\s*display:\s*none/);
    expect(at1100).toMatch(/\.toolbar-icon-copy\s*\{\s*display:\s*none/);
    expect(at1100).toMatch(/\.toolbar\s*\{[^}]*gap\s*:/s);
    expect(at1100).toMatch(/\.toolbar-icon-button,[\s\S]*width:\s*var\(--topbar-control-height\)/s);
    expect(ruleBodies(foundationSource, ".page-heading").join("\n")).toContain("min-width: 0");
  });

});
