import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@shared/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { callKimiMcpServerTool, classifyKimiTargetFromSignals, evaluateCliCompatibility, getCliVersion, getKimiProviderCatalogModels, getTargetCliVersion, importKimiProviderCatalog, importKimiProviderRegistry, listKimiMcpServerTools, listKimiProviderCatalog, MIN_CLI_VERSION, runKimiConnectivityTest, runKimiMcpServerTest, runProvidersHealthCheck, startKimiOAuthLogin, upgradeKimiCli, upgradeTargetCli } from "./cli";

const mockedInvoke = vi.mocked(invoke);

function exec(code: number, stdout = "", stderr = ""): { code: number; stdout: string; stderr: string } {
  return { code, stdout, stderr };
}
function http(status: number, body = "", headers: Record<string, string> = {}): { status: number; ok: boolean; body: string; headers: Record<string, string> } {
  return { status, ok: status >= 200 && status < 300, body, headers };
}

function connectivityState(providerType = "openai_legacy"): AppState {
  return {
    activeProfile: "work",
    mainConfig: {
      models: { "p/m": { provider: "p", model: "m-1" } },
      providers: { p: { type: providerType, base_url: "https://api.example.com/v1", api_key: "sk-1" } },
    },
  } as unknown as AppState;
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyKimiTargetFromSignals", () => {
  it("detects Kimi Code from Homebrew paths (Apple Silicon)", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/opt/homebrew/bin/kimi",
      resolvedPath: "/opt/homebrew/Cellar/kimi-code/0.14.2/bin/kimi",
      versionOutput: "0.14.2",
    })).toMatchObject({ target: "kimi-code", status: "detected", reason: "homebrew-path-detected" });
  });

  it("detects Kimi Code official script installs from the default bin path", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/Users/me/.kimi-code/bin/kimi",
      resolvedPath: "/Users/me/.kimi-code/bin/kimi",
      versionOutput: "kimi, version 1.2.0",
    })).toMatchObject({ target: "kimi-code", status: "detected", installSource: "official-script" });
  });

  it("detects Kimi Code npm package installs from node_modules paths", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/Users/me/.npm-global/bin/kimi",
      resolvedPath: "/Users/me/.npm-global/lib/node_modules/@moonshot-ai/kimi-code/bin/kimi",
      versionOutput: "0.14.2",
    })).toMatchObject({ target: "kimi-code", status: "detected", installSource: "npm" });
  });

  it("detects Kimi Code from Homebrew paths (Intel Mac)", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/usr/local/bin/kimi",
      resolvedPath: "/usr/local/Homebrew/bin/kimi",
      versionOutput: "0.14.2",
    })).toMatchObject({ target: "kimi-code", status: "detected", reason: "homebrew-path-detected" });
  });

  it("detects Kimi Code from Linuxbrew paths", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/home/linuxbrew/.linuxbrew/bin/kimi",
      resolvedPath: "/home/linuxbrew/.linuxbrew/Cellar/kimi-code/0.14.2/bin/kimi",
      versionOutput: "0.14.2",
    })).toMatchObject({ target: "kimi-code", status: "detected", reason: "homebrew-path-detected" });
  });

  it("detects Kimi Code from executable paths", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/opt/homebrew/bin/kimi",
      resolvedPath: "/opt/homebrew/Cellar/kimi-code/1.2.0/bin/kimi",
      versionOutput: "kimi, version 1.2.0",
    })).toMatchObject({ target: "kimi-code", status: "detected" });
  });

  it("does not accept historical uv kimi-cli paths as Kimi Code", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/Users/me/.local/bin/kimi",
      resolvedPath: "/Users/me/.local/share/uv/tools/kimi-cli/bin/kimi",
      versionOutput: "kimi, version 1.47.0",
    })).toMatchObject({ target: "kimi-code", status: "not-installed" });
  });

  it("does not accept the plain historical kimi-cli version format without Kimi Code signals", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/usr/local/bin/kimi",
      versionOutput: "kimi, version 1.47.0",
    })).toMatchObject({ target: "kimi-code", status: "not-installed" });
  });

  it("marks unknown signals as not installed", () => {
    expect(classifyKimiTargetFromSignals({
      executablePath: "/opt/custom/bin/kimi",
      versionOutput: "custom output",
    })).toMatchObject({ target: "kimi-code", status: "not-installed" });
  });
});

describe("getCliVersion", () => {
  it("extracts the semver from Homebrew kimi-code output", async () => {
    mockedInvoke.mockResolvedValue(exec(0, "kimi-code 1.4.2\n") as unknown as never);
    const result = await getCliVersion();
    expect(result).toMatchObject({ version: "1.4.2", installed: true, target: "kimi-code", packageName: "Kimi Code", installSource: "homebrew" });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "brew",
      args: ["list", "--versions", "kimi-code"],
      timeoutMs: 3000,
    });
    expect(mockedInvoke.mock.calls.some((call) => call[0] === "http_request")).toBe(false);
  });

  it("reports not installed when the command fails", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(127, "", "command not found") as unknown as never)
      .mockResolvedValueOnce(exec(1, "", "") as unknown as never)
      .mockResolvedValueOnce(exec(127, "", "command not found") as unknown as never);
    await expect(getCliVersion()).resolves.toMatchObject({
      version: "",
      installed: false,
      target: "kimi-code",
      installCommand: "brew install kimi-code",
      installSource: "unknown",
    });
  });

  it("reads the CDN manifest for the latest version and flags an available update", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.0.0") as unknown as never) // brew list
      .mockResolvedValueOnce(null) // 无本地更新缓存
      .mockResolvedValueOnce('"global"') // region
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "2.0.0" })) as unknown as never); // CDN manifest
    const result = await getCliVersion({ checkLatest: true });
    expect(result.latestVersion).toBe("2.0.0");
    expect(result.hasUpdate).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("read_text", { path: "~/.kimi-code/updates/latest.json" });
    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      url: "https://code.kimi.ai/kimi-code/latest.json",
    }));
  });

  it("does not flag an update when already current", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 2.0.0") as unknown as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('"global"')
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "2.0.0" })) as unknown as never);
    const result = await getCliVersion({ checkLatest: true });
    expect(result.hasUpdate).toBe(false);
  });

  it("tolerates a failing latest-version request and returns the local result", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.0.0") as unknown as never)
      .mockResolvedValueOnce(http(500) as unknown as never);
    const result = await getCliVersion({ checkLatest: true });
    expect(result).toMatchObject({ version: "1.0.0", installed: true });
    expect(result.latestVersion).toBeUndefined();
  });

  it("bounds manual latest-version checks with a renderer timeout", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.0.0") as unknown as never)
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(http(200, JSON.stringify({ versions: { stable: "2.0.0" } })) as never), 50);
      }));
    const result = await getCliVersion({ checkLatest: true, latestTimeoutMs: 1 });
    expect(result).toMatchObject({ version: "1.0.0", installed: true });
    expect(result.latestVersion).toBeUndefined();
  });

  it("reads the CDN manifest for kimi-code latest version on non-Windows platforms", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.2.0") as unknown as never)
      .mockResolvedValueOnce(null) // 无缓存
      .mockResolvedValueOnce('"mainland-cn"') // region
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "1.3.0" })) as unknown as never);
    const result = await getTargetCliVersion("kimi-code", { checkLatest: true });
    expect(result).toMatchObject({
      target: "kimi-code",
      packageName: "Kimi Code",
      version: "1.2.0",
      latestVersion: "1.3.0",
      hasUpdate: true,
      installCommand: "brew install kimi-code",
      updateCommand: "brew upgrade kimi-code",
      installSource: "homebrew",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "brew",
      args: ["list", "--versions", "kimi-code"],
      timeoutMs: 3000,
    });
    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      url: "https://code.kimi.com/kimi-code/latest.json",
    }));
  });

  it("prefers the local ~/.kimi-code/updates/latest.json cache for the latest version", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z"));
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.0.0") as unknown as never)
      .mockResolvedValueOnce(JSON.stringify({
        source: "cdn",
        checkedAt: "2026-01-01T00:00:00Z",
        latest: "2.5.0",
        manifest: { version: "2.5.0" },
      }))
      .mockRejectedValueOnce(new Error("should not hit the network"));
    const result = await getCliVersion({ checkLatest: true });
    expect(result.latestVersion).toBe("2.5.0");
    expect(result.hasUpdate).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalledWith("http_request", expect.objectContaining({
      url: expect.stringContaining("latest.json"),
    }));
  });

  it.each(["mainland-cn", "cn", "zh-cn"])(
    "uses the mainland CDN for the %s region marker",
    async (region) => {
      mockedInvoke
        .mockResolvedValueOnce(exec(0, "kimi-code 1.2.0") as unknown as never)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(region)
        .mockResolvedValueOnce(http(200, JSON.stringify({ version: "1.3.0" })) as unknown as never);

      await getCliVersion({ checkLatest: true });

      expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
        url: "https://code.kimi.com/kimi-code/latest.json",
      }));
    },
  );

  it("falls back to the official mainland region for a missing marker", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.2.0") as unknown as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "1.3.0" })) as unknown as never);

    await getCliVersion({ checkLatest: true });

    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      url: "https://code.kimi.com/kimi-code/latest.json",
    }));
  });

  it("refreshes the latest version from CDN when the local cache is stale", async () => {
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    mockedInvoke
      .mockResolvedValueOnce(exec(0, "kimi-code 1.0.0") as unknown as never)
      .mockResolvedValueOnce(JSON.stringify({
        source: "cdn",
        checkedAt: "2026-01-01T00:00:00Z",
        latest: "2.0.0",
      }))
      .mockResolvedValueOnce('"global"')
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "2.5.0" })) as unknown as never);

    const result = await getCliVersion({ checkLatest: true });

    expect(result.latestVersion).toBe("2.5.0");
    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      url: "https://code.kimi.ai/kimi-code/latest.json",
    }));
  });

  it("does not treat the plain kimi command as a kimi-code install on non-Windows platforms", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(1, "", "Error: No such keg: /opt/homebrew/Cellar/kimi-code") as unknown as never)
      .mockResolvedValueOnce(exec(1, "", "") as unknown as never)
      .mockResolvedValueOnce(exec(0, "/usr/local/bin/kimi\n---KIMI_RESOLVED---\n/usr/local/bin/kimi\n---KIMI_CANDIDATES---\n/usr/local/bin/kimi\n---KIMI_VERSION---\nkimi, version 1.47.0\n") as unknown as never)
      .mockResolvedValueOnce(null) // 无缓存
      .mockResolvedValueOnce('"global"') // region
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "1.3.0" })) as unknown as never);
    const result = await getTargetCliVersion("kimi-code", { checkLatest: true });
    expect(result).toMatchObject({
      target: "kimi-code",
      installed: false,
      version: "",
      latestVersion: "1.3.0",
      hasUpdate: false,
      installCommand: "brew install kimi-code",
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("exec_command", expect.objectContaining({
      program: "kimi",
    }));
  });

  it("detects kimi-code installed by the official script on non-Windows platforms", async () => {
    mockedInvoke
      .mockResolvedValueOnce(exec(1, "", "Error: No such keg: /opt/homebrew/Cellar/kimi-code") as unknown as never)
      .mockResolvedValueOnce(exec(0, "kimi, version 1.2.0") as unknown as never);
    const result = await getTargetCliVersion("kimi-code");
    expect(result).toMatchObject({
      target: "kimi-code",
      installed: true,
      version: "1.2.0",
      installCommand: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      updateCommand: "kimi upgrade",
      installSource: "official-script",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "sh",
      args: ["-lc", 'p="${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi"; [ -x "$p" ] && "$p" --version'],
      timeoutMs: 3000,
    });
  });

  it("checks the CDN manifest for kimi-code latest version on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
    mockedInvoke
      .mockResolvedValueOnce(exec(1, "", "") as unknown as never)
      .mockResolvedValueOnce(exec(0, JSON.stringify({
        dependencies: {
          "@moonshot-ai/kimi-code": { version: "1.2.0" },
        },
      })) as unknown as never)
      .mockResolvedValueOnce(null) // 无缓存
      .mockResolvedValueOnce('"global"') // region
      .mockResolvedValueOnce(http(200, JSON.stringify({ version: "1.3.0" })) as unknown as never);
    const result = await getTargetCliVersion("kimi-code", { checkLatest: true });
    expect(result).toMatchObject({
      target: "kimi-code",
      latestVersion: "1.3.0",
      hasUpdate: true,
      installCommand: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
      updateCommand: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
      installSource: "npm",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      url: "https://code.kimi.ai/kimi-code/latest.json",
    }));
  });

  it("detects the official Windows install directory before checking PATH", async () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
    mockedInvoke.mockResolvedValueOnce(exec(0, "kimi, version 1.2.0") as unknown as never);
    const result = await getTargetCliVersion("kimi-code");
    expect(result).toMatchObject({
      target: "kimi-code",
      installed: true,
      version: "1.2.0",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$d = if ($env:KIMI_INSTALL_DIR) { $env:KIMI_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.kimi-code' }; $p = Join-Path (Join-Path $d 'bin') 'kimi.exe'; if (Test-Path -LiteralPath $p -PathType Leaf) { & $p --version } else { exit 1 }",
      ],
      timeoutMs: 3000,
    });
  });

  it("does not treat an ambiguous kimi --version as kimi-code on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
    mockedInvoke
      .mockResolvedValueOnce(exec(1, "", "") as unknown as never)
      .mockResolvedValueOnce(exec(1, "{}", "") as unknown as never)
      .mockResolvedValueOnce(exec(0, "kimi, version 1.47.0") as unknown as never);
    const result = await getTargetCliVersion("kimi-code");
    expect(result).toMatchObject({
      target: "kimi-code",
      installed: false,
      version: "",
    });
  });

  it("accepts a kimi --version result only when it identifies Kimi Code on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
    mockedInvoke
      .mockResolvedValueOnce(exec(1, "", "") as unknown as never)
      .mockResolvedValueOnce(exec(1, "{}", "") as unknown as never)
      .mockResolvedValueOnce(exec(0, "Kimi Code 1.2.0") as unknown as never);
    const result = await getTargetCliVersion("kimi-code");
    expect(result).toMatchObject({
      target: "kimi-code",
      installed: true,
      version: "1.2.0",
    });
  });
});

describe("upgradeKimiCli / runKimiMcpServerTest", () => {
  it("passes the active KIMI_CODE_HOME to the native login command", async () => {
    mockedInvoke.mockResolvedValue(exec(0, "logged in") as unknown as never);

    await startKimiOAuthLogin("kimi-code", undefined, { homePath: "/custom/kimi-home" });

    expect(mockedInvoke).toHaveBeenCalledWith("start_kimi_oauth_login", {
      target: "kimi-code",
      homePath: "/custom/kimi-home",
    });
  });

  it("upgrades via Homebrew and trims output", async () => {
    mockedInvoke.mockResolvedValue(exec(0, " done \n", " warn \n") as unknown as never);
    await expect(upgradeKimiCli()).resolves.toEqual({ ok: true, stdout: "done", stderr: "warn" });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "brew",
      args: ["upgrade", "kimi-code"],
      timeoutMs: 120000,
    });
  });

  it("throws when upgrade exits non-zero", async () => {
    mockedInvoke.mockResolvedValue(exec(1, "", "boom") as unknown as never);
    await expect(upgradeKimiCli()).rejects.toThrow(/boom/);
  });

  it("upgrades kimi-code via Homebrew on non-Windows platforms", async () => {
    mockedInvoke.mockResolvedValue(exec(0, "updated", "") as unknown as never);
    await expect(upgradeTargetCli("kimi-code")).resolves.toEqual({ ok: true, stdout: "updated", stderr: "" });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "brew",
      args: ["upgrade", "kimi-code"],
      timeoutMs: 120000,
    });
  });

  it("installs kimi-code via Homebrew on non-Windows platforms", async () => {
    mockedInvoke.mockResolvedValue(exec(0, "installed", "") as unknown as never);
    await expect(upgradeTargetCli("kimi-code", { install: true })).resolves.toEqual({ ok: true, stdout: "installed", stderr: "" });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "brew",
      args: ["install", "kimi-code"],
      timeoutMs: 120000,
    });
  });

  it("upgrades a non-Homebrew install via the built-in kimi upgrade command", async () => {
    // brew list 失败（非 Homebrew 安装）→ 脚本安装命中 → kimi upgrade
    mockedInvoke
      .mockResolvedValueOnce(exec(1, "Error: No such keg: kimi-code", "") as unknown as never)
      .mockResolvedValueOnce(exec(0, "kimi, version 1.2.0") as unknown as never)
      .mockResolvedValueOnce(exec(0, "updated", "") as unknown as never);
    await expect(upgradeKimiCli()).resolves.toEqual({ ok: true, stdout: "updated", stderr: "" });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "sh",
      args: ["-lc", "kimi upgrade"],
      timeoutMs: 120000,
    });
  });

  it("upgrades kimi-code via the official PowerShell installer on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
    mockedInvoke.mockResolvedValue(exec(0, "updated", "") as unknown as never);
    await expect(upgradeTargetCli("kimi-code")).resolves.toEqual({ ok: true, stdout: "updated", stderr: "" });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", {
      program: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://code.kimi.com/kimi-code/install.ps1 | iex"],
      timeoutMs: 120000,
    });
  });

  it("checks stdio MCP command availability without calling kimi mcp", async () => {
    mockedInvoke.mockResolvedValue(exec(0, "", "") as unknown as never);
    await expect(runKimiMcpServerTest("local", {
      enabled: true,
      transport: "stdio",
      url: "",
      headers: {},
      command: "npx",
      args: ["server"],
      env: {},
    })).resolves.toMatchObject({ ok: true });
    expect(mockedInvoke).toHaveBeenCalledWith("exec_command", expect.objectContaining({
      program: "sh",
      args: ["-lc", "command -v 'npx' >/dev/null"],
    }));
    expect(mockedInvoke).not.toHaveBeenCalledWith("exec_command", expect.objectContaining({
      args: expect.arrayContaining(["mcp"]),
    }));
  });

  it("tests Streamable HTTP MCP endpoints with initialize POST", async () => {
    mockedInvoke.mockResolvedValue(http(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })) as unknown as never);
    await expect(runKimiMcpServerTest("remote", {
      enabled: true,
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer token" },
      command: "",
      args: [],
      env: {},
    })).resolves.toMatchObject({ ok: true });
    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      method: "POST",
      url: "https://example.test/mcp",
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
    }));
  });

  it("reports legacy SSE as supported by Kimi but unavailable in the GUI tester", async () => {
    await expect(runKimiMcpServerTest("amap-maps", {
      enabled: true,
      transport: "sse",
      url: "https://mcp.api-inference.modelscope.net/example/sse",
      headers: {},
      command: "",
      args: [],
      env: {},
    })).rejects.toThrow(/Kimi Code supports this transport/);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("resolves bearerTokenEnvVar for HTTP MCP requests without overriding explicit auth", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "read_environment_variable") return "env-token" as never;
      if (command === "http_request") return http(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })) as never;
      return undefined as never;
    });
    await runKimiMcpServerTest("remote", {
      enabled: true,
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: {},
      command: "",
      args: [],
      env: {},
      extra: { bearerTokenEnvVar: "MCP_TOKEN" },
    });
    expect(mockedInvoke).toHaveBeenCalledWith("read_environment_variable", { name: "MCP_TOKEN" });
    expect(mockedInvoke).toHaveBeenCalledWith("http_request", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer env-token" }),
    }));
  });

  it("parses tools from Streamable HTTP MCP endpoints", async () => {
    mockedInvoke
      .mockResolvedValueOnce(http(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { "mcp-session-id": "s-1" }) as unknown as never)
      .mockResolvedValueOnce(http(202, "") as unknown as never)
      .mockResolvedValueOnce(http(200, JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [{
            name: "search",
            description: "Search things",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          }],
        },
      })) as unknown as never);

    const result = await listKimiMcpServerTools("remote", {
      enabled: true,
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: {},
      command: "",
      args: [],
      env: {},
    });

    expect(result.tools).toEqual([expect.objectContaining({ name: "search" })]);
    const calls = mockedInvoke.mock.calls.filter((call) => call[0] === "http_request");
    expect(JSON.parse((calls[0][1] as { body: string }).body)).toMatchObject({ method: "initialize" });
    expect(JSON.parse((calls[1][1] as { body: string }).body)).toMatchObject({ method: "notifications/initialized" });
    expect(calls[1][1]).toMatchObject({ headers: expect.objectContaining({ "mcp-session-id": "s-1" }) });
    expect(JSON.parse((calls[2][1] as { body: string }).body)).toMatchObject({ method: "tools/list" });
  });

  it("parses tools from stdio MCP endpoints with an extended timeout", async () => {
    mockedInvoke.mockResolvedValueOnce({
      responses: [
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } },
        {
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [{
              name: "read_text_file",
              description: "Read text file",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            }],
          },
        },
      ],
      stderr: "",
    } as never);

    const result = await listKimiMcpServerTools("filesystem", {
      enabled: true,
      transport: "stdio",
      url: "",
      headers: {},
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: {},
    });

    expect(result.tools).toEqual([expect.objectContaining({ name: "read_text_file" })]);
    expect(mockedInvoke).toHaveBeenCalledWith("run_mcp_stdio_session", {
      program: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: {},
      requests: [
        expect.objectContaining({ id: 1, method: "initialize" }),
        expect.objectContaining({ method: "notifications/initialized" }),
        expect.objectContaining({ id: 2, method: "tools/list" }),
      ],
      timeoutMs: 30000,
    });
  });

  it("calls a parsed Streamable HTTP MCP tool with JSON arguments", async () => {
    mockedInvoke
      .mockResolvedValueOnce(http(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })) as unknown as never)
      .mockResolvedValueOnce(http(202, "") as unknown as never)
      .mockResolvedValueOnce(http(200, JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "ok" }] },
      })) as unknown as never);

    const result = await callKimiMcpServerTool("remote", {
      enabled: true,
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: {},
      command: "",
      args: [],
      env: {},
    }, "search", "{\"query\":\"kimi\"}");

    expect(result.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    const call = mockedInvoke.mock.calls.find((item) => {
      const body = (item[1] as { body?: string }).body;
      return body ? JSON.parse(body).method === "tools/call" : false;
    });
    expect(JSON.parse((call![1] as { body: string }).body)).toMatchObject({
      method: "tools/call",
      params: { name: "search", arguments: { query: "kimi" } },
    });
  });
});

describe("runKimiConnectivityTest", () => {
  it("validates model/provider existence before sending", async () => {
    const bad = connectivityState();
    await expect(runKimiConnectivityTest(bad, "missing")).rejects.toThrow(/Model not found/);
  });

  it("builds an OpenAI chat-completions request and extracts the assistant message", async () => {
    mockedInvoke.mockResolvedValue(http(200, JSON.stringify({ choices: [{ message: { content: "hello" } }] })) as unknown as never);
    const result = await runKimiConnectivityTest(connectivityState("openai_legacy"), "p/m");

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello");
    expect(result.status).toBe(200);
    const call = mockedInvoke.mock.calls.find((c) => c[0] === "http_request")![1] as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-1");
    expect(JSON.parse(call.body)).toMatchObject({ model: "m-1" });
  });

  it("applies model base_url only together with an explicit protocol override", async () => {
    const withoutProtocol = connectivityState("openai");
    withoutProtocol.mainConfig.models["p/m"].base_url = "https://model.example/v1";
    mockedInvoke.mockResolvedValue(http(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] })) as never);
    await runKimiConnectivityTest(withoutProtocol, "p/m");
    expect((mockedInvoke.mock.calls.find((call) => call[0] === "http_request")![1] as { url: string }).url)
      .toBe("https://api.example.com/v1/chat/completions");

    mockedInvoke.mockReset();
    const withProtocol = connectivityState("openai");
    withProtocol.mainConfig.models["p/m"].protocol = "openai";
    withProtocol.mainConfig.models["p/m"].base_url = "https://model.example/v1";
    mockedInvoke.mockResolvedValue(http(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] })) as never);
    await runKimiConnectivityTest(withProtocol, "p/m");
    expect((mockedInvoke.mock.calls.find((call) => call[0] === "http_request")![1] as { url: string }).url)
      .toBe("https://model.example/v1/chat/completions");
  });

  it("builds an anthropic request with x-api-key + version headers", async () => {
    mockedInvoke.mockResolvedValue(http(200, JSON.stringify({ content: [{ text: "hi there" }] })) as unknown as never);
    const result = await runKimiConnectivityTest(connectivityState("anthropic"), "p/m");
    expect(result.stdout).toBe("hi there");
    const call = mockedInvoke.mock.calls.find((c) => c[0] === "http_request")![1] as {
      url: string;
      headers: Record<string, string>;
    };
    // base_url already ends with /v1, and joinUrlPath only skips when the suffix matches the tail,
    // so "/v1/messages" is appended verbatim onto the configured base.
    expect(call.url).toBe("https://api.example.com/v1/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-1");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses the Google GenAI generateContent protocol and its default host", async () => {
    const state = connectivityState("google-genai");
    state.mainConfig.providers.p.base_url = "";
    mockedInvoke.mockResolvedValue(http(200, JSON.stringify({
      candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }],
    })) as unknown as never);

    const result = await runKimiConnectivityTest(state, "p/m");

    expect(result.stdout).toBe("gemini-ok");
    expect(result.endpoint).not.toContain("sk-1");
    const call = mockedInvoke.mock.calls.find((item) => item[0] === "http_request")![1] as {
      url: string;
      body: string;
    };
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent?key=sk-1");
    expect(JSON.parse(call.body)).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
  });

  it("uses Vertex generateContent with ADC and configured project/location", async () => {
    const state = connectivityState("vertexai");
    state.mainConfig.providers.p.base_url = "";
    state.mainConfig.providers.p.api_key = "";
    state.mainConfig.providers.p.env = {
      GOOGLE_CLOUD_PROJECT: "project-1",
      GOOGLE_CLOUD_LOCATION: "asia-east1",
    };
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "get_google_adc_access_token") return "adc-token" as never;
      if (command === "http_request") {
        return http(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: "vertex-ok" }] } }] })) as never;
      }
      return undefined as never;
    });

    const result = await runKimiConnectivityTest(state, "p/m");

    expect(result.stdout).toBe("vertex-ok");
    const call = mockedInvoke.mock.calls.find((item) => item[0] === "http_request")![1] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(call.url).toBe("https://asia-east1-aiplatform.googleapis.com/v1beta1/projects/project-1/locations/asia-east1/publishers/google/models/m-1:generateContent");
    expect(call.headers.authorization).toBe("Bearer adc-token");
  });

  it("recognizes an OAuth-managed Kimi provider without requiring a static API key", async () => {
    const state = connectivityState("kimi");
    state.mainConfig.models["p/m"].provider = "managed:kimi-code";
    state.mainConfig.providers = {
      "managed:kimi-code": {
        type: "kimi",
        base_url: "https://api.kimi.com/coding/v1",
        api_key: "",
        oauth: { storage: "file", key: "kimi-code" },
      },
    };
    mockedInvoke.mockResolvedValue({
      active_account_id: "account-1",
      credentials_present: true,
      standard_credentials_path: "~/.kimi-code/credentials",
    } as never);

    const result = await runKimiConnectivityTest(state, "p/m");

    expect(result.stdout).toContain("credentials are active");
    expect(mockedInvoke.mock.calls.some((item) => item[0] === "http_request")).toBe(false);
  });

  it("does not read default credential slots for an isolated managed OAuth environment", async () => {
    const state = connectivityState("kimi");
    state.mainConfig.models["p/m"].provider = "managed:kimi-code";
    state.mainConfig.providers = {
      "managed:kimi-code": {
        type: "kimi",
        base_url: "https://api.kimi.com/coding/v1",
        api_key: "",
        oauth: { storage: "file", key: "kimi-code" },
      },
    };
    state.panelSettings = {
      active_kimi_code_environment_id: "work",
      kimi_code_environments: [{ id: "work", name: "Work", homePath: "/custom/kimi-home" }],
    } as AppState["panelSettings"];

    await expect(runKimiConnectivityTest(state, "p/m"))
      .rejects.toThrow(/isolated in its KIMI_CODE_HOME/);
    const [health] = await runProvidersHealthCheck(state);
    expect(health.reason).toBe("oauth-unverified");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("throws a descriptive error when the upstream returns non-ok", async () => {
    mockedInvoke.mockResolvedValue(http(401, "unauthorized") as unknown as never);
    await expect(runKimiConnectivityTest(connectivityState(), "p/m")).rejects.toThrow(/HTTP 401/);
  });
});

describe("evaluateCliCompatibility", () => {
  it("returns unknown when not installed", () => {
    expect(evaluateCliCompatibility({ version: "", installed: false })).toBe("unknown");
  });

  it("returns unknown when the version is not a clean semver", () => {
    expect(evaluateCliCompatibility({ version: "dev", installed: true })).toBe("unknown");
  });

  it("flags versions below the minimum as outdated", () => {
    expect(evaluateCliCompatibility({ version: "0.9.0", installed: true })).toBe("outdated");
  });

  it("treats the minimum version and above as compatible", () => {
    expect(MIN_CLI_VERSION).toBe("0.38.0");
    expect(evaluateCliCompatibility({ version: MIN_CLI_VERSION, installed: true })).toBe("compatible");
    expect(evaluateCliCompatibility({ version: "9.9.9", installed: true })).toBe("compatible");
  });
});

describe("runProvidersHealthCheck", () => {
  function healthState(): AppState {
    return {
      activeProfile: "work",
      mainConfig: {
        default_model: "ok/m",
        models: {
          "ok/m": { provider: "ok", model: "m-1" },
          "limited/m": { provider: "limited", model: "m-2" },
          "broken/m": { provider: "broken", model: "m-3" },
          "nokey/m": { provider: "nokey", model: "m-4" },
        },
        providers: {
          ok: { type: "openai_legacy", base_url: "https://ok.example.com/v1", api_key: "sk-ok" },
          limited: { type: "openai_legacy", base_url: "https://limited.example.com/v1", api_key: "sk-l" },
          broken: { type: "openai_legacy", base_url: "https://broken.example.com/v1", api_key: "sk-b" },
          nomodel: { type: "openai_legacy", base_url: "https://nm.example.com/v1", api_key: "sk-n" },
          nokey: { type: "openai_legacy", base_url: "https://nk.example.com/v1", api_key: "" },
        },
      },
    } as unknown as AppState;
  }

  it("probes every provider independently and reports per-item results", async () => {
    mockedInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      const url = String(args.url ?? "");
      if (url.includes("ok.example.com")) return Promise.resolve(http(200, "{}") as unknown as never);
      if (url.includes("limited.example.com")) return Promise.resolve(http(429, "slow down") as unknown as never);
      if (url.includes("broken.example.com")) return Promise.reject(new Error("connection refused")) as unknown as never;
      return Promise.resolve(http(500, "boom") as unknown as never);
    });

    const results = await runProvidersHealthCheck(healthState());
    const byName = Object.fromEntries(results.map((r) => [r.providerName, r]));

    expect(byName.ok.ok).toBe(true);
    expect(byName.ok.reason).toBe("ok");
    expect(byName.limited.ok).toBe(false);
    expect(byName.limited.reason).toBe("rate-limited");
    expect(byName.broken.ok).toBe(false);
    expect(byName.broken.reason).toBe("network-error");
    expect(byName.nomodel.reason).toBe("no-model");
    expect(byName.nokey.reason).toBe("missing-api-key");
  });
});

describe("official Kimi provider catalog bridge", () => {
  it("lists models.dev providers through the official CLI JSON output", async () => {
    mockedInvoke.mockResolvedValue(exec(0, JSON.stringify({
      anthropic: { name: "Anthropic", type: "anthropic", models: { opus: {}, sonnet: {} } },
      openai: { name: "OpenAI", type: "openai", models: { gpt: {} } },
    })) as never);

    await expect(listKimiProviderCatalog("/kimi-home", { filter: "an" })).resolves.toEqual([
      { id: "anthropic", name: "Anthropic", type: "anthropic", modelCount: 2 },
      { id: "openai", name: "OpenAI", type: "openai", modelCount: 1 },
    ]);
    expect(mockedInvoke).toHaveBeenCalledWith("run_kimi_provider_command", {
      homePath: "/kimi-home",
      request: { action: "catalog-list", filter: "an", url: undefined },
    });
  });

  it("loads normalized model details and delegates catalog/registry imports", async () => {
    mockedInvoke.mockResolvedValueOnce(exec(0, JSON.stringify({
      providerId: "anthropic",
      models: [{
        id: "claude-opus",
        name: "Claude Opus",
        capability: { tool_use: true, thinking: true, max_context_tokens: 200000 },
      }],
    })) as never);
    await expect(getKimiProviderCatalogModels("/kimi-home", "anthropic")).resolves.toEqual([{
      id: "claude-opus",
      displayName: "Claude Opus",
      maxContextTokens: 200000,
      capabilities: ["tool_use", "thinking"],
    }]);

    mockedInvoke.mockResolvedValue(exec(0) as never);
    await importKimiProviderCatalog("/kimi-home", {
      providerId: "anthropic",
      apiKey: "secret",
      defaultModel: "claude-opus",
    });
    await importKimiProviderRegistry("/kimi-home", {
      url: "https://registry.example/api.json",
      apiKey: "registry-secret",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("run_kimi_provider_command", expect.objectContaining({
      request: expect.objectContaining({ action: "catalog-add", apiKey: "secret" }),
    }));
    expect(mockedInvoke).toHaveBeenCalledWith("run_kimi_provider_command", expect.objectContaining({
      request: expect.objectContaining({ action: "registry-add", apiKey: "registry-secret" }),
    }));
  });
});
