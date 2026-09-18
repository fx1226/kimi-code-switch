// system.ts 的聚焦测试：覆盖 11 个系统集成命令的确定性分支。
// 运行方式：npx vitest run src/server/native/system.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildKimiProviderCommand,
  findKimiCodeLoginCommand,
  fileStat,
  getGoogleAdcAccessToken,
  runKimiProviderCommand,
  ipIsBlocked,
  isOauthModelsPaymentRequired,
  normalizeMcpStdioArgs,
  parseDeviceLoginLine,
  readFileSlice,
  resolveWorkspaceDirectory,
  runExec,
  runMcpStdioSession,
  summarizeOauthLoginFailure,
  systemCommands,
  validateCommand,
  validateHttpUrl,
  writeExecutable,
} from "./system";

const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const handler = systemCommands[name];
  if (!handler) throw new Error(`unsupported command ${name} in test`);
  return handler(args);
};

const TEST_TEMPDIRS: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimi-system-test-"));
  TEST_TEMPDIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TEST_TEMPDIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.SYSTEM_TEST_VAR;
});

describe("exec_command", () => {
  it("returns code/stdout/stderr for a successful command", async () => {
    const result = (await invoke("exec_command", {
      program: "sh",
      args: ["-c", "echo hi"],
      timeoutMs: null,
    })) as { code: number; stdout: string; stderr: string };
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
  });

  it("rejects non-allowlisted programs before spawning", async () => {
    await expect(
      invoke("exec_command", { program: "curl", args: [], timeoutMs: null }),
    ).rejects.toThrow("not in the allowed list");
  });

  it("kills and errors when the command times out", async () => {
    await expect(
      invoke("exec_command", { program: "sh", args: ["-c", "sleep 5"], timeoutMs: 300 }),
    ).rejects.toThrow("command timed out after 300ms");
  });
});

describe("read_environment_variable", () => {
  it("reads an existing variable", async () => {
    process.env.SYSTEM_TEST_VAR = "hello";
    const value = (await invoke("read_environment_variable", {
      name: "SYSTEM_TEST_VAR",
    })) as string | null;
    expect(value).toBe("hello");
  });

  it("returns null for an unset variable", async () => {
    const value = (await invoke("read_environment_variable", {
      name: "SYSTEM_TEST_VAR_NOT_SET",
    })) as string | null;
    expect(value).toBeNull();
  });

  it("rejects invalid names", async () => {
    await expect(invoke("read_environment_variable", { name: "" })).rejects.toThrow(
      "environment variable name is invalid",
    );
    await expect(
      invoke("read_environment_variable", { name: "BAD-NAME" }),
    ).rejects.toThrow("environment variable name is invalid");
  });
});

describe("file_stat", () => {
  it("returns size/mtime_ms/ino for an existing file", async () => {
    const dir = makeTempDir();
    const file = join(dir, "a.log");
    writeFileSync(file, "abc");
    const stat = (await fileStat({ path: file })) as {
      size: number;
      mtime_ms: number;
      ino: number;
    };
    expect(stat).not.toBeNull();
    expect(stat.size).toBe(3);
    expect(stat.mtime_ms).toBeGreaterThan(0);
    expect(stat.ino).toBeGreaterThan(0);
  });

  it("returns null for a missing file", async () => {
    const stat = await fileStat({ path: join(makeTempDir(), "missing.log") });
    expect(stat).toBeNull();
  });
});

describe("read_file_slice", () => {
  it("reads the requested offset/length", async () => {
    const dir = makeTempDir();
    const file = join(dir, "slice.txt");
    writeFileSync(file, "hello world");
    expect(readFileSlice({ path: file, offset: 0, length: 5 })).toBe("hello");
    expect(readFileSlice({ path: file, offset: 6, length: 5 })).toBe("world");
    expect(readFileSlice({ path: file, offset: 0, length: 0 })).toBe("");
  });
});

describe("write_executable", () => {
  it("writes content and sets 0755 within temp", () => {
    const dir = makeTempDir();
    const script = join(dir, "run.sh");
    writeExecutable({ path: script, content: "#!/bin/sh\necho ok\n" });
    const mode = statSync(script).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("rejects paths outside the allowed temp directories", () => {
    expect(() =>
      writeExecutable({ path: "/nonexistent-system-test/evil.sh", content: "x" }),
    ).toThrow("write_executable only allowed in temp directories");
  });
});

describe("resolve_workspace_directory", () => {
  it("resolves a relative ../ directory against the project root", () => {
    const root = makeTempDir();
    const project = join(root, "project");
    const shared = join(root, "shared");
    mkdirSync(project);
    mkdirSync(shared);
    expect(resolveWorkspaceDirectory({ projectRoot: project, inputPath: "../shared" })).toBe(
      shared,
    );
    expect(resolveWorkspaceDirectory({ projectRoot: project, inputPath: "." })).toBe(project);
  });

  it("rejects blank / missing / non-directory inputs", () => {
    const project = makeTempDir();
    expect(() =>
      resolveWorkspaceDirectory({ projectRoot: project, inputPath: "   " }),
    ).toThrow("workspace.additional_dir must exist and be a directory");
    expect(() =>
      resolveWorkspaceDirectory({ projectRoot: project, inputPath: "../missing" }),
    ).toThrow("workspace.additional_dir must exist and be a directory");
    const file = join(project, "f.txt");
    writeFileSync(file, "x");
    expect(() =>
      resolveWorkspaceDirectory({ projectRoot: project, inputPath: "f.txt" }),
    ).toThrow("workspace.additional_dir must exist and be a directory");
  });
});

describe("http_request validation (SSRF, offline)", () => {
  it("blocks loopback/private/link-local hosts", async () => {
    await expect(invoke("http_request", { method: "GET", url: "http://127.0.0.1/x" })).rejects.toThrow(
      "refers to a loopback/private/link-local address",
    );
    await expect(invoke("http_request", { method: "GET", url: "http://localhost/x" })).rejects.toThrow(
      "refers to a loopback/private/link-local address",
    );
    await expect(invoke("http_request", { method: "GET", url: "http://169.254.169.254/" })).rejects.toThrow(
      "refers to a loopback/private/link-local address",
    );
  });

  it("rejects non-http schemes and invalid methods", async () => {
    await expect(invoke("http_request", { method: "GET", url: "file://evilhost/etc/passwd" })).rejects.toThrow(
      "not allowed",
    );
    await expect(invoke("http_request", { method: "GET", url: "ftp://example.com/x" })).rejects.toThrow(
      "not allowed",
    );
    await expect(invoke("http_request", { method: "BAD METHOD", url: "https://example.com/" })).rejects.toThrow(
      "invalid method",
    );
  });

  it("allows whitelisted public domains", () => {
    expect(() => validateHttpUrl("https://api.github.com/repos")).not.toThrow();
    expect(() => validateHttpUrl("https://github.com/x")).not.toThrow();
  });

  it("ipIsBlocked covers common private ranges", () => {
    expect(ipIsBlocked("127.0.0.1")).toBe(true);
    expect(ipIsBlocked("10.0.0.1")).toBe(true);
    expect(ipIsBlocked("172.16.0.1")).toBe(true);
    expect(ipIsBlocked("192.168.1.1")).toBe(true);
    expect(ipIsBlocked("::1")).toBe(true);
    expect(ipIsBlocked("::ffff:127.0.0.1")).toBe(true);
  });
});

describe("get_google_adc_access_token", () => {
  it("rejects invalid env values before spawning", async () => {
    await expect(
      getGoogleAdcAccessToken({
        env: { GOOGLE_CLOUD_PROJECT: "a\0b" },
      }),
    ).rejects.toThrow("invalid Google ADC environment value for GOOGLE_CLOUD_PROJECT");
  });


});

describe("run_kimi_provider_command (deterministic validation branches)", () => {
  it("rejects unsupported actions", async () => {
    await expect(
      runKimiProviderCommand({
        homePath: "~/.kimi-code",
        request: { action: "bogus" },
      }),
    ).rejects.toThrow("unsupported provider action: bogus");
  });

  it("rejects catalog-add without provider id / api key", async () => {
    await expect(
      runKimiProviderCommand({
        homePath: "~/.kimi-code",
        request: { action: "catalog-add" },
      }),
    ).rejects.toThrow("provider id is required");
  });

  it("rejects insecure registry URLs", async () => {
    await expect(
      runKimiProviderCommand({
        homePath: "~/.kimi-code",
        request: { action: "registry-add", url: "http://registry.example/api.json", apiKey: "s" },
      }),
    ).rejects.toThrow("must use HTTPS");
  });

  it("builds provider command argv without leaking secrets", () => {
    const { args, registryApiKey } = buildKimiProviderCommand({
      action: "catalog-add",
      provider_id: "anthropic",
      api_key: "secret-key",
      default_model: "claude-opus",
    });
    expect(args).toEqual(["provider", "catalog", "add", "anthropic", "--default-model", "claude-opus"]);
    expect(registryApiKey).toBe("secret-key");
    expect(args.some((arg) => arg.includes("secret-key"))).toBe(false);
  });
});

describe("OAuth login event parsing (mirrors Rust unit tests)", () => {
  it("extracts device-code from opening browser line", () => {
    const e = parseDeviceLoginLine("kimi-code", "Opening browser for Kimi device login: https://auth.example/device?code=abc");
    expect(e.kind).toBe("device-code");
    expect(e.url).toBe("https://auth.example/device?code=abc");
  });

  it("extracts verification url and user code", () => {
    const e = parseDeviceLoginLine("kimi-code", "Verification URL: https://www.kimi.com/code/authorize_device?user_code=RSSI-UYYI");
    expect(e.kind).toBe("device-code");
    expect(e.user_code).toBe("RSSI-UYYI");
  });

  it("extracts standalone user code", () => {
    expect(parseDeviceLoginLine("kimi-code", "User Code: RSSI-UYYI").user_code).toBe("RSSI-UYYI");
    expect(
      parseDeviceLoginLine("kimi-code", "If the browser did not open, paste the URL above and enter code: ABCD-1234").user_code,
    ).toBe("ABCD-1234");
  });

  it("extracts expiry seconds", () => {
    const e = parseDeviceLoginLine("kimi-code", "Code expires in 600s.");
    expect(e.kind).toBe("expires-in");
    expect(e.expires_in).toBe(600);
  });

  it("marks success variants", () => {
    expect(parseDeviceLoginLine("kimi-code", "Logged in to Moonshot.").message).toBe("Logged in to Moonshot");
    expect(parseDeviceLoginLine("kimi-code", "Logged in successfully.").message).toBe("Logged in successfully.");
    expect(parseDeviceLoginLine("kimi-code", "Logged in.").message).toBe("Logged in.");
    expect(
      parseDeviceLoginLine("kimi-code", "Already logged in. Model configuration refreshed.").message,
    ).toBe("Already logged in. Model configuration refreshed.");
  });

  it("does not confuse login failed with success", () => {
    const e = parseDeviceLoginLine("kimi-code", "Login failed: bad");
    expect(e.kind).toBe("error");
    expect(e.message).toBe("bad");
  });

  it("marks cancelled as error and keeps unrecognized output", () => {
    expect(parseDeviceLoginLine("kimi-code", "Login cancelled.").kind).toBe("error");
    const out = parseDeviceLoginLine("kimi-code", "Waiting for authorization...");
    expect(out.kind).toBe("output");
    expect(out.line).toBe("Waiting for authorization...");
  });

  it("marks models payment required as account-required", () => {
    const e = parseDeviceLoginLine(
      "kimi-code",
      "Failed to get models: 402, message='Payment Required', url='https://api.kimi.com/coding/v1/models'",
    );
    expect(e.kind).toBe("account-required");
    expect(e.message).toContain("402 Payment Required");
    expect(isOauthModelsPaymentRequired("failed to get models 402 payment required")).toBe(true);
  });
});

describe("OAuth failure summary", () => {
  it("prefers stderr", () => {
    const s = summarizeOauthLoginFailure({
      code: 1,
      stdout: "Verification URL: https://x\n",
      stderr: "\nLogin failed: authorization expired\n",
    });
    expect(s).toBe("Login failed: authorization expired");
  });

  it("identifies models payment required", () => {
    const s = summarizeOauthLoginFailure({
      code: 1,
      stdout: "Verification URL: https://x\nFailed to get models: 402, message='Payment Required',\nurl='https://api.kimi.com/coding/v1/models'",
      stderr: "",
    });
    expect(s).toContain("402 Payment Required");
  });

  it("falls back to stdout and exit code", () => {
    expect(
      summarizeOauthLoginFailure({ code: 1, stdout: "\nKimi OAuth login failed\n", stderr: "\n" }),
    ).toBe("Kimi OAuth login failed");
    expect(summarizeOauthLoginFailure({ code: 42, stdout: "", stderr: "" })).toBe(
      "Kimi OAuth login failed with exit code 42.",
    );
  });
});

describe("runExec (spawn failure branch)", () => {
  it("rejects when the program cannot be spawned", async () => {
    await expect(runExec("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(
      "spawn error",
    );
  });
});

describe("normalize_mcp_stdio_args", () => {
  it("adds npx -y for filesystem server and expands ~ args", () => {
    expect(
      normalizeMcpStdioArgs("npx", ["@modelcontextprotocol/server-filesystem", "/tmp"]),
    ).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(
      normalizeMcpStdioArgs("node", [`~/server.js`]),
    ).toEqual([join(homedir(), "server.js")]);
  });
});

describe("run_mcp_stdio_session", () => {
  it("uses the selected target home and working directory in the actual child process", async () => {
    const cwd = makeTempDir();
    const kimiHome = join(cwd, "isolated-kimi-home");
    const response = await runMcpStdioSession({
      program: "node", cwd,
      args: ["-e", "const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{cwd:process.cwd(),home:process.env.KIMI_CODE_HOME}}))})"],
      env: { KIMI_CODE_HOME: kimiHome }, requests: [{ id: 1, method: "initialize", params: {} }], timeoutMs: 3000,
    });
    expect(response.responses[0]).toMatchObject({ result: { cwd: realpathSync(cwd), home: kimiHome } });
  });

  it("returns matching responses for a valid MCP stdio server", async () => {
    const result = (await runMcpStdioSession({
      program: "node",
      args: [
        "-e",
        "const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const m=JSON.parse(l);if(m.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true}}));}catch{}})",
      ],
      env: {},
      requests: [{ id: 1, method: "initialize", params: {} }],
      timeoutMs: 3000,
    })) as { responses: unknown[]; stderr: string };
    expect(result.responses.length).toBe(1);
    expect(result.responses[0]).toMatchObject({ id: 1 });
  });

  it("errors when the server exits without responding", async () => {
    await expect(
      runMcpStdioSession({
        program: "node",
        args: ["-e", "process.exit(1)"],
        env: {},
        requests: [{ id: 1, method: "initialize" }],
        timeoutMs: 2000,
      }),
    ).rejects.toThrow("MCP stdio server returned no JSON-RPC response");
  });

  it("errors on timeout", async () => {
    await expect(
      runMcpStdioSession({
        program: "sh",
        args: ["-c", "sleep 5"],
        env: {},
        requests: [{ id: 1, method: "initialize" }],
        timeoutMs: 500,
      }),
    ).rejects.toThrow("MCP stdio session timed out after 1000ms");
  });

  it("rejects an empty request list", async () => {
    await expect(
      runMcpStdioSession({ program: "node", args: [], env: {}, requests: [] }),
    ).rejects.toThrow("MCP stdio request list cannot be empty");
  });

  it("rejects non-allowlisted programs", async () => {
    await expect(
      runMcpStdioSession({
        program: "curl",
        args: [],
        env: {},
        requests: [{ id: 1, method: "initialize" }],
      }),
    ).rejects.toThrow("not in the allowed list");
  });
});

describe("findKimiCodeLoginCommand", () => {
  it("always targets the kimi login subcommand", () => {
    const command = findKimiCodeLoginCommand();
    expect(command.args).toEqual(["login"]);
  });
});

describe("validateCommand allowlist", () => {
  it("accepts interpreter/shell names used by the renderer", () => {
    expect(() => validateCommand("sh")).not.toThrow();
    expect(() => validateCommand("/bin/sh")).not.toThrow();
    expect(() => validateCommand("node")).not.toThrow();
    expect(() => validateCommand("npx")).not.toThrow();
  });
});
