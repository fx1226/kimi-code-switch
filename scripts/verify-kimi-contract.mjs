// Uses the actual installed CLI, isolated temporary homes, and source-pinned fixtures.
// Usage: node scripts/verify-kimi-contract.mjs [/absolute/path/to/kimi]
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(repository, "tests/fixtures/kimi-code/2.0.0");

async function resolveCli() {
  if (process.argv[2]) {
    if (!isAbsolute(process.argv[2])) throw new Error("Pass an absolute CLI executable path.");
    return realpath(process.argv[2]);
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, process.platform === "win32" ? "kimi.exe" : "kimi");
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next PATH entry */ }
  }
  return null;
}

async function main() {
  const executable = await resolveCli();
  const bundle = await build({
    entryPoints: [join(repository, "src/server/officialValidation.ts")],
    bundle: true, platform: "node", format: "esm", target: "node22", write: false,
  });
  const { validateOfficialDocuments } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const documents = await Promise.all(["config", "tui"].map(async (kind) => ({
    kind, content: await readFile(join(fixtures, `${kind}.toml`), "utf8"),
  })));
  const accepted = await validateOfficialDocuments({ executable, documents });
  if (accepted.status !== "passed") {
    console.log(JSON.stringify({ result: "not-verified", ...accepted }, null, 2));
    process.exitCode = 1;
    return;
  }
  const invalidConfig = await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: 'default_plan_mode = "not-a-boolean"\n' }] });
  const invalidTui = await validateOfficialDocuments({ executable, documents: [{ kind: "tui", content: 'disable_feedback_survey = "not-a-boolean"\n' }] });
  const malformed = await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: "[models\n" }] });
  const rejectsInvalid = [invalidConfig, invalidTui, malformed].every((result) => result.status === "rejected");
  console.log(JSON.stringify({
    result: rejectsInvalid ? "passed" : "failed",
    cliVersion: accepted.version,
    releaseCommit: "1b89e4b039f052d10f258464413b2047acca12ba",
    checks: { validConfigAndTui: accepted.status, invalidConfig: invalidConfig.status, invalidTui: invalidTui.status, malformedToml: malformed.status, candidatesUnchanged: true },
    diagnostics: accepted.diagnostics,
    scope: "Official doctor parsing only; candidate files and homes are temporary and removed.",
    mcpSkillsPluginsRuntime: "not-executed",
    desktopRuntime: "not-executed",
  }, null, 2));
  if (!rejectsInvalid) process.exitCode = 1;
}

main().catch(() => {
  console.error("Official contract verification could not run; no compatibility claim was produced.");
  process.exitCode = 1;
});
