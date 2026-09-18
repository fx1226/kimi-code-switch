import { chmod, mkdtemp, readFile, rm, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseOfficialCliVersion, validateOfficialDocuments, verifyOfficialExecutable } from "./officialValidation";

describe("official CLI validation boundary", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fakeCli(mode: "pass" | "reject" | "skip" | "mutate" | "future" | "warning" | "self-update") {
    const directory = await mkdtemp(join(tmpdir(), "official-validation-test-"));
    directories.push(directory);
    const executable = join(directory, "kimi");
    const record = join(directory, "record.json");
    await writeFile(executable, `#!${process.execPath}
import fs from "node:fs";
const mode = ${JSON.stringify(mode)};
if (process.argv[2] === "--version") {
  fs.appendFileSync(${JSON.stringify(record + ".versions")}, "v");
  console.log(mode === "future" ? "2.0.1" : "2.0.0");
} else {
  const [, , command, kind, path] = process.argv;
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({command, kind, path, cwd:process.cwd(), env:process.env, mode:fs.statSync(path).mode & 0o777}));
  if (mode === "mutate") fs.writeFileSync(path, "changed");
  if (mode === "self-update") fs.appendFileSync(process.argv[1], "\\n// changed executable");
  if (mode === "reject") { console.error("invalid token: candidate-super-secret"); process.exitCode = 1; }
  else if (mode === "skip") console.log("SKIP " + kind + ".toml");
  else { console.log("OK " + kind + ".toml " + path); if (mode === "warning") console.log("  warning: candidate-super-secret"); }
}
`, { mode: 0o700 });
    await chmod(executable, 0o700);
    return { executable, record };
  }

  it("parses a version line without dropping prerelease or build suffixes", () => {
    expect(parseOfficialCliVersion("Kimi Code 2.0.0\n")).toBe("2.0.0");
    expect(parseOfficialCliVersion("2.0.0-beta.1")).toBe("2.0.0-beta.1");
    expect(parseOfficialCliVersion("2.0.0+custom")).toBe("2.0.0+custom");
    expect(parseOfficialCliVersion("warning\n2.0.0")).toBeNull();
  });

  it("does not report missing, relative, or unverified executables as passed", async () => {
    const documents = [{ kind: "config" as const, content: "" }];
    expect((await validateOfficialDocuments({ executable: null, documents })).status).toBe("unavailable");
    expect((await validateOfficialDocuments({ executable: "kimi", documents })).status).toBe("unavailable");
    const { executable } = await fakeCli("future");
    expect(await validateOfficialDocuments({ executable, documents })).toMatchObject({ status: "unavailable", version: "2.0.1" });
  });

  it("reuses version evidence only while executable identity stays unchanged", async () => {
    const { executable, record } = await fakeCli("pass");
    expect((await verifyOfficialExecutable(executable)).status).toBe("passed");
    expect((await verifyOfficialExecutable(executable)).status).toBe("passed");
    expect((await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: "" }] })).status).toBe("passed");
    expect(await readFile(record + ".versions", "utf8")).toBe("v");
    const content = await readFile(executable, "utf8");
    await writeFile(executable, content.replace('const mode = "pass";', 'const mode = "future";'));
    expect(await verifyOfficialExecutable(executable)).toMatchObject({ status: "unavailable", version: "2.0.1" });
    expect(await readFile(record + ".versions", "utf8")).toBe("vv");
  });

  it("invalidates evidence when the launch symlink switches to another binary", async () => {
    const current = await fakeCli("pass");
    const future = await fakeCli("future");
    const launch = current.executable + "-launch";
    await symlink(current.executable, launch);
    expect((await verifyOfficialExecutable(launch)).status).toBe("passed");
    await unlink(launch); await symlink(future.executable, launch);
    expect(await verifyOfficialExecutable(launch)).toMatchObject({ status: "unavailable", version: "2.0.1" });
  });

  it("rejects a binary update during doctor even when doctor reports OK", async () => {
    const { executable } = await fakeCli("self-update");
    const result = await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: "" }] });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics.at(-1)?.code).toBe("OFFICIAL_EXECUTABLE_CHANGED");
  });

  it("uses private candidates and isolated homes without inherited credentials or model overrides", async () => {
    vi.stubEnv("KIMI_MODEL_API_KEY", "inherited-secret");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    vi.stubEnv("KIMI_CODE_HOME", "/real-user-kimi-home");
    const { executable, record } = await fakeCli("pass");
    const result = await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: 'default_model = "fixture"\n' }] });
    expect(result).toMatchObject({ status: "passed", version: "2.0.0" });
    const run = JSON.parse(await readFile(record, "utf8"));
    expect(run.command).toBe("doctor");
    expect(run.kind).toBe("config");
    expect(run.env.HOME).toBe(run.cwd);
    expect(run.env.KIMI_CODE_HOME).toBe(join(run.cwd, "kimi-home"));
    expect(run.env.KIMI_MODEL_API_KEY).toBeUndefined();
    expect(run.env.NODE_OPTIONS).toBeUndefined();
    expect(run.mode).toBe(0o600);
    await expect(readFile(run.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["reject", "mutate"] as const)("rejects %s without exposing CLI output", async (mode) => {
    const { executable } = await fakeCli(mode);
    const result = await validateOfficialDocuments({ executable, documents: [{ kind: "tui", content: "theme = \"auto\"" }] });
    expect(result.status).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("candidate-super-secret");
  });

  it("requires explicit OK rather than exit zero plus SKIP", async () => {
    const { executable } = await fakeCli("skip");
    expect((await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: "" }] })).status).toBe("unavailable");
  });

  it("retains the warning boundary without exposing sensitive warning content", async () => {
    const { executable } = await fakeCli("warning");
    const result = await validateOfficialDocuments({ executable, documents: [{ kind: "config", content: "" }] });
    expect(result.status).toBe("passed");
    expect(result.diagnostics[0].severity).toBe("warning");
    expect(JSON.stringify(result)).not.toContain("candidate-super-secret");
  });
});
