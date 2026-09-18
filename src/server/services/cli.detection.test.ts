import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../native", () => ({ invokeCommand: vi.fn() }));

import { invokeCommand } from "../native";
import { verifyOfficialExecutable } from "../officialValidation";
import { detectActiveKimiTarget, evaluateCliCompatibility } from "./cli";

let base: string;
const mockedInvoke = vi.mocked(invokeCommand);
function executable(path: string, version = "2.0.0"): string {
  mkdirSync(dirname(path), { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const trace = join(base, "invocations");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$HOME|$KIMI_CODE_HOME|$PWD|$*" >> ${quote(trace)}\nprintf '%s\\n' ${quote(version)}\n`, { mode: 0o700 });
  return path;
}
function invocations(): string[] {
  const path = join(base, "invocations");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "switch-detection-")));
  mkdirSync(join(base, "user-home"));
  mkdirSync(join(base, "user-kimi-home"));
  writeFileSync(join(base, "user-kimi-home/config.toml"), "# must remain unchanged\n");
  vi.stubEnv("HOME", join(base, "user-home"));
  vi.stubEnv("KIMI_CODE_HOME", join(base, "user-kimi-home"));
  vi.stubEnv("PATH", join(base, "absent-bin"));
  mockedInvoke.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("cold POSIX CLI detection", () => {
  it("uses the first PATH executable, retains its symlink path, and shares isolated version evidence", async () => {
    const first = join(base, "first/bin/kimi");
    const resolved = executable(join(base, "real-install/version-tool"));
    mkdirSync(dirname(first), { recursive: true });
    symlinkSync(resolved, first);
    executable(join(base, "later/bin/kimi"), "9.9.9");
    vi.stubEnv("PATH", [dirname(first), join(base, "later/bin")].join(":"));

    const result = await detectActiveKimiTarget();
    const evidence = await verifyOfficialExecutable(result.resolvedPath);

    expect(result).toMatchObject({ installed: true, version: "2.0.0", executablePath: first, resolvedPath: resolved, candidates: [first] });
    expect(evidence.status).toBe("passed");
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(invocations()).toHaveLength(1);
    const [home, kimiHome, cwd, args] = invocations()[0].split("|");
    expect(home).not.toBe(join(base, "user-home"));
    expect(kimiHome).not.toBe(join(base, "user-kimi-home"));
    expect(cwd).toBe(home);
    expect(args).toBe("--version");
    expect(readFileSync(join(base, "user-kimi-home/config.toml"), "utf8")).toBe("# must remain unchanged\n");
  });

  it("skips directories, non-executable files and broken symlinks before selecting a real executable", async () => {
    const directories = ["directory", "not-executable", "broken-link", "valid"].map((name) => join(base, name));
    directories.forEach((path) => mkdirSync(path));
    mkdirSync(join(directories[0], "kimi"));
    writeFileSync(join(directories[1], "kimi"), "not executable");
    chmodSync(join(directories[1], "kimi"), 0o600);
    symlinkSync(join(base, "missing"), join(directories[2], "kimi"));
    const selected = executable(join(directories[3], "kimi"));
    vi.stubEnv("PATH", directories.join(":"));

    expect(await detectActiveKimiTarget()).toMatchObject({ installed: true, executablePath: selected });
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(invocations()).toHaveLength(1);
  });

  it("uses shell fallback only to locate an absolute executable when PATH has no candidate", async () => {
    const selected = executable(join(base, "login-shell/bin/kimi"));
    mockedInvoke.mockResolvedValue({ code: 0, stdout: `${selected}\n`, stderr: "" });

    expect(await detectActiveKimiTarget()).toMatchObject({ installed: true, executablePath: selected, version: "2.0.0" });

    expect(mockedInvoke).toHaveBeenCalledExactlyOnceWith("exec_command", {
      program: "sh", args: ["-lc", "command -v kimi 2>/dev/null"], timeoutMs: 2000,
    });
    expect(invocations()).toHaveLength(1);
  });

  it.each(["kimi", "function kimi () { echo 2.0.0; }", "/missing/kimi", "/first/kimi\n/second/kimi"])("rejects non-executable shell output: %s", async (stdout) => {
    mockedInvoke.mockResolvedValue({ code: 0, stdout, stderr: "private shell output" });

    expect(await detectActiveKimiTarget()).toMatchObject({ installed: false, version: "", executablePath: "" });
    expect(invocations()).toEqual([]);
  });

  it("keeps an unrecognized first candidate instead of substituting a later known installation", async () => {
    const selected = executable(join(base, "first/kimi"), "Authorization: Bearer sensitive-unrecognized-output");
    executable(join(base, ".kimi-code/bin/kimi"));
    vi.stubEnv("PATH", [dirname(selected), join(base, ".kimi-code/bin")].join(":"));

    const result = await detectActiveKimiTarget();

    expect(result).toMatchObject({ installed: false, version: "", executablePath: selected, reason: "kimi-code-version-unrecognized" });
    expect(JSON.stringify(result)).not.toContain("sensitive-unrecognized-output");
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(invocations()).toHaveLength(1);
  });

  it("does not classify a historical uv kimi-cli installation as Kimi Code", async () => {
    const legacy = executable(join(base, "uv/tools/kimi-cli/bin/kimi"));
    vi.stubEnv("PATH", dirname(legacy));

    expect(await detectActiveKimiTarget()).toMatchObject({ installed: false, version: "", executablePath: legacy, reason: "legacy-kimi-cli-detected" });
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(invocations()).toEqual([]);
  });

  it("does not identify a legacy version format from its Homebrew-shaped path alone", async () => {
    const selected = executable(join(base, "opt/homebrew/bin/kimi"), "kimi, version 1.47.0");
    vi.stubEnv("PATH", dirname(selected));

    expect(await detectActiveKimiTarget()).toMatchObject({ installed: false, version: "", executablePath: selected, reason: "kimi-code-version-unrecognized" });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("retains prerelease evidence so cold detection cannot unlock the stable contract", async () => {
    const selected = executable(join(base, "bin/kimi"), "2.0.0-beta.1+fixture");
    vi.stubEnv("PATH", dirname(selected));

    const result = await detectActiveKimiTarget();

    expect(result).toMatchObject({ installed: true, version: "2.0.0-beta.1+fixture" });
    expect(evaluateCliCompatibility(result)).toBe("unverified-version");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
