import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../src/renderer/src");
const read = (file) => readFile(resolve(root, file), "utf8");
const [styles, tokens, insights, skills] = await Promise.all([
  read("styles.css"),
  read("tokens.css"),
  read("insights.css"),
  read("skillsWorkspace.tsx"),
]);

const requiredStyles = [
  '@import "./primitives.css" layer(primitives);',
  '@import "./patterns.css" layer(patterns);',
  '@import "./insights.css" layer(features);',
  '@import "./layout.css" layer(shell);',
];
const requiredTokens = [
  "--state-selected-bg",
  "--state-active-bg",
  "--state-dirty",
  "--overlay-scrim",
  "--field-bg",
  "--list-row-min-height",
];

const failures = [
  ...requiredStyles.filter((value) => !styles.includes(value)).map((value) => `Missing style layer import: ${value}`),
  ...requiredTokens.filter((value) => !tokens.includes(value)).map((value) => `Missing semantic token: ${value}`),
  ...(skills.includes("ResizeObserver") ? ["Skills workspace must use natural scrolling instead of measured pagination."] : []),
  ...(insights.match(/insights-button-(?:primary|secondary|danger)/) ? ["Insights must use shared action-button variants."] : []),
  ...(insights.match(/#(?:3b82f6|10b981|d97706|8b5cf6)/i) ? ["Insights metric colors must use semantic tokens."] : []),
];

if (failures.length > 0) {
  throw new Error(`CSS architecture checks failed:\n${failures.map((message) => `- ${message}`).join("\n")}`);
}

process.stdout.write("CSS architecture checks passed.\n");
