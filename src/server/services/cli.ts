// CLI, MCP and connectivity operations run only in the local server.
import { invokeCommand as invoke } from "../native";
import { serverVersion } from "../runtime";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getKimiCodeHome } from "../native/paths";
import { onServerEvent } from "../events";
import { verifyOfficialExecutable } from "../officialValidation";

import { compareReleaseVersions } from "@shared/versionUtils";
import { evaluateKimiCompatibility, KIMI_CODE_CONTRACT_VERSION } from "@shared/kimiCompatibility";
import type { AppState, ConfigTarget, KimiCodeInstallSource, McpServerConfig, ModelConfig, ProfileConnectivityTestResult, ProviderConfig } from "@shared/types";

const KIMI_CODE_INSTALL_SCRIPT_SH = "https://code.kimi.com/kimi-code/install.sh";
const KIMI_CODE_INSTALL_SCRIPT_URL = "https://code.kimi.com/kimi-code/install.ps1";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const LATEST_VERSION_TIMEOUT_MS = 3500;
// 0.38.0 内置 `kimi upgrade`，作为原生安装/脚本/npm/pnpm 的推荐升级入口。
const KIMI_CODE_UPGRADE_COMMAND = "kimi upgrade";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolListResult {
  ok: true;
  tools: McpToolInfo[];
  raw: string;
  stderr?: string;
}

export interface McpToolCallResult {
  ok: true;
  toolName: string;
  result: unknown;
  raw: string;
  stderr?: string;
}

interface McpStdioRpcRequest {
  id?: number;
  method: string;
  params?: unknown;
}

interface McpStdioSessionResponse {
  responses: unknown[];
  stderr: string;
}

function exec(program: string, args: string[], timeoutMs?: number): Promise<ExecResult> {
  return invoke<ExecResult>("exec_command", { program, args, timeoutMs: timeoutMs ?? null });
}

function http(method: string, url: string, headers?: Record<string, string>, body?: string): Promise<HttpResponse> {
  return invoke<HttpResponse>("http_request", { method, url, headers: headers ?? null, body: body ?? null });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function mcpStdioSession(
  program: string,
  args: string[],
  env: Record<string, string>,
  requests: McpStdioRpcRequest[],
  timeoutMs = 30000,
  cwd?: string,
): Promise<McpStdioSessionResponse> {
  return invoke<McpStdioSessionResponse>("run_mcp_stdio_session", {
    program,
    args,
    env,
    requests,
    timeoutMs,
    ...(cwd ? { cwd } : {}),
  });
}

function extractSemver(value: string | undefined): string {
  for (const line of value?.split(/\r?\n/) ?? []) {
    const match = line.trim().match(/^(?:(?:kimi-code|kimi(?:,\s*version)?|Kimi Code(?: CLI)?)\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i);
    if (match) return match[1];
  }
  return "";
}

export function classifyKimiTargetFromSignals(signals: {
  executablePath?: string;
  resolvedPath?: string;
  versionOutput?: string;
  candidates?: string[];
}): { target: ConfigTarget; status: KimiTargetDetectionStatus; reason: string; installSource: KimiCodeInstallSource } {
  const joinedPaths = [
    signals.executablePath,
    signals.resolvedPath,
    ...(signals.candidates ?? []),
  ].filter(Boolean).join("\n").toLowerCase();
  const output = (signals.versionOutput ?? "").toLowerCase();

  // Homebrew 路径判定优先：/opt/homebrew/ 或 /usr/local/Homebrew/ 或 Linuxbrew
  if (/\/(opt\/homebrew|usr\/local\/homebrew|home\/linuxbrew)/i.test(joinedPaths)) {
    return { target: "kimi-code", status: "detected", reason: "homebrew-path-detected", installSource: "homebrew" };
  }

  if (joinedPaths.includes(".kimi-code/bin")) {
    return { target: "kimi-code", status: "detected", reason: "official-script-path-detected", installSource: "official-script" };
  }

  if (joinedPaths.includes("@moonshot-ai/kimi-code") || joinedPaths.includes("/node_modules/") || joinedPaths.includes("\\node_modules\\")) {
    const installSource: KimiCodeInstallSource = joinedPaths.includes("pnpm") ? "pnpm" : "npm";
    return { target: "kimi-code", status: "detected", reason: "node-package-path-detected", installSource };
  }

  // 路径或输出中包含 kimi-code 特征
  if (joinedPaths.includes("kimi-code") || /kimi[-\s]?code|@moonshot-ai\/kimi-code/.test(output)) {
    return { target: "kimi-code", status: "detected", reason: "matched-kimi-code-signal", installSource: "unknown" };
  }

  return { target: "kimi-code", status: "not-installed", reason: "kimi-code-not-found", installSource: "unknown" };
}

export interface CliVersionResult {
  version: string;
  installed: boolean;
  latestVersion?: string;
  hasUpdate?: boolean;
  target?: ConfigTarget;
  packageName?: string;
  installCommand?: string;
  updateCommand?: string;
  installSource?: KimiCodeInstallSource;
}

export type KimiTargetDetectionStatus = "detected" | "not-installed";

export interface KimiTargetDetectionResult {
  target: ConfigTarget;
  installed: boolean;
  status: KimiTargetDetectionStatus;
  version: string;
  executablePath: string;
  resolvedPath: string;
  candidates: string[];
  reason: string;
  installSource: KimiCodeInstallSource;
}

export interface KimiOAuthLoginEvent {
  kind: "start" | "device-code" | "user-code" | "expires-in" | "output" | "success" | "error" | "complete" | "failed" | "account-required";
  target: ConfigTarget;
  stream?: "stdout" | "stderr";
  line?: string;
  url?: string;
  user_code?: string;
  expires_in?: number;
  message?: string;
}

// Retained for callers that display the historical baseline field. This does
// not declare a supported version range; compatibility requires an exact match.
/** @deprecated Use EXPECTED_CLI_VERSION and evaluateCliCompatibility. */
export const MIN_CLI_VERSION = KIMI_CODE_CONTRACT_VERSION;
export const EXPECTED_CLI_VERSION = KIMI_CODE_CONTRACT_VERSION;

export type CliCompatStatus = ReturnType<typeof evaluateKimiCompatibility>["status"];

export function evaluateCliCompatibility(result: Pick<CliVersionResult, "version" | "installed">): CliCompatStatus {
  return evaluateKimiCompatibility(result.installed ? result.version : null, "cli").status;
}

function currentPlatform(): "windows" | "macos" | "linux" | "unknown" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

function versionResultBase(target: ConfigTarget, installSource: KimiCodeInstallSource = "unknown"): Pick<CliVersionResult, "target" | "packageName" | "installCommand" | "updateCommand"> {
  const isWindows = currentPlatform() === "windows";
  const installCommand = isWindows
    ? `irm ${KIMI_CODE_INSTALL_SCRIPT_URL} | iex`
    : "brew install kimi-code";
  return {
    target,
    packageName: "Kimi Code",
    installCommand,
    // 0.38.0：内置 `kimi upgrade` 是原生/官方脚本/npm/pnpm 安装的升级首选；
    // Homebrew 安装仍走 brew upgrade，避免绕过 cask 元数据。Windows 走官方脚本。
    updateCommand: isWindows
      ? installCommand
      : installSource === "homebrew"
        ? "brew upgrade kimi-code"
        : KIMI_CODE_UPGRADE_COMMAND,
  };
}

function withInstallSource(result: CliVersionResult, installSource: KimiCodeInstallSource): CliVersionResult {
  return { ...result, installSource };
}

async function detectActiveKimiTargetOnWindows(): Promise<KimiTargetDetectionResult> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$commands = @(Get-Command kimi -All)",
    "if (-not $commands -or $commands.Count -eq 0) { exit 127 }",
    "$paths = @($commands | ForEach-Object { $_.Source })",
    "$primary = $paths[0]",
    "$version = (& $primary --version) 2>&1 | Out-String",
    "[Console]::Out.Write(($paths -join \"`n\") + \"`n---KIMI_VERSION---`n\" + $version)",
  ].join("; ");
  try {
    const r = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], 5000);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    const [pathsText, versionOutput = ""] = r.stdout.split("\n---KIMI_VERSION---\n");
    const candidates = pathsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const executablePath = candidates[0] ?? "";
    const classified = classifyKimiTargetFromSignals({ executablePath, resolvedPath: executablePath, versionOutput, candidates });
    return {
      target: "kimi-code",
      installed: classified.status === "detected",
      status: classified.status,
      version: extractSemver(versionOutput),
      executablePath,
      resolvedPath: executablePath,
      candidates,
      reason: classified.reason,
      installSource: classified.installSource,
    };
  } catch {
    return {
      target: "kimi-code",
      installed: false,
      status: "not-installed",
      version: "",
      executablePath: "",
      resolvedPath: "",
      candidates: [],
      reason: "kimi-command-not-found",
      installSource: "unknown",
    };
  }
}

interface CliExecutableCandidate { executablePath: string; resolvedPath: string }

function executableCandidate(path: string): CliExecutableCandidate | null {
  if (!isAbsolute(path) || path.includes("\0")) return null;
  try {
    const resolvedPath = realpathSync(path);
    if (!statSync(resolvedPath).isFile()) return null;
    accessSync(path, constants.X_OK);
    return { executablePath: path, resolvedPath };
  } catch { return null; }
}

function pathExecutable(): CliExecutableCandidate | null {
  // Preserve actual PATH precedence. A shadowing executable must not be
  // skipped merely because a later installation has a known product path.
  if (process.env.PATH === undefined) return null;
  for (const directory of process.env.PATH.split(":")) {
    const candidate = executableCandidate(resolve(directory || ".", "kimi"));
    if (candidate) return candidate;
  }
  return null;
}

async function shellExecutable(): Promise<CliExecutableCandidate | null> {
  try {
    // A login shell can reveal installations absent from the launcher's PATH.
    // It only locates the command; version execution is isolated below.
    const result = await exec("sh", ["-lc", "command -v kimi 2>/dev/null"], 2000);
    if (result.code !== 0) return null;
    const path = result.stdout.trim();
    if (path.includes("\n") || path.includes("\r")) return null;
    return executableCandidate(path);
  } catch { return null; }
}

async function detectActiveKimiTargetOnPosix(): Promise<KimiTargetDetectionResult> {
  const candidate = pathExecutable() ?? await shellExecutable();
  const empty: KimiTargetDetectionResult = {
    target: "kimi-code", installed: false, status: "not-installed", version: "",
    executablePath: "", resolvedPath: "", candidates: [], reason: "kimi-command-not-found", installSource: "unknown",
  };
  if (!candidate) return empty;
  const candidates = [candidate.executablePath];
  const classified = classifyKimiTargetFromSignals(candidate);
  // Historical Python kimi-cli uses a different product and version format.
  // A known legacy path never acquires the new product identity from a version.
  if (/\/uv\/tools\/kimi-cli(?:\/|$)/i.test(candidate.resolvedPath)) {
    return { ...empty, ...candidate, candidates, reason: "legacy-kimi-cli-detected" };
  }
  try {
    // This shares fingerprint-bound version evidence with the application and
    // doctor. It never executes --version in the user's HOME or project cwd.
    const evidence = await verifyOfficialExecutable(candidate.executablePath);
    const changed = evidence.diagnostics.some((entry) => entry.code === "OFFICIAL_EXECUTABLE_CHANGED");
    const version = changed ? "" : evidence.version ?? "";
    const recognized = !changed && Boolean(version);
    return {
      ...empty, ...candidate, candidates, version,
      installed: recognized, status: recognized ? "detected" : "not-installed",
      reason: changed ? "kimi-executable-changed" : recognized ? (classified.status === "detected" ? classified.reason : "verified-kimi-code-version") : "kimi-code-version-unrecognized",
      installSource: classified.installSource,
    };
  } catch {
    return { ...empty, ...candidate, candidates, reason: "kimi-code-version-unavailable", installSource: classified.installSource };
  }
}

export async function detectActiveKimiTarget(): Promise<KimiTargetDetectionResult> {
  return currentPlatform() === "windows"
    ? await detectActiveKimiTargetOnWindows()
    : await detectActiveKimiTargetOnPosix();
}

async function detectKimiCodeHomebrewVersion(): Promise<CliVersionResult> {
  const base = versionResultBase("kimi-code", "homebrew");
  try {
    const r = await exec("brew", ["list", "--versions", "kimi-code"], 3000);
    if (r.code !== 0) throw new Error(r.stderr);
    const version = extractSemver(r.stdout);
    if (!version) throw new Error("kimi-code Homebrew version not found");
    return withInstallSource({ ...base, version, installed: true }, "homebrew");
  } catch {
    return withInstallSource({ ...base, version: "", installed: false }, "unknown");
  }
}

async function detectKimiCodeScriptVersion(): Promise<CliVersionResult> {
  const installCommand = `curl -fsSL ${KIMI_CODE_INSTALL_SCRIPT_SH} | bash`;
  const base = {
    ...versionResultBase("kimi-code", "official-script"),
    installCommand,
    updateCommand: KIMI_CODE_UPGRADE_COMMAND,
  };
  try {
    const script = 'p="${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi"; [ -x "$p" ] && "$p" --version';
    const r = await exec("sh", ["-lc", script], 3000);
    if (r.code !== 0) throw new Error(r.stderr);
    const version = extractSemver(`${r.stdout}\n${r.stderr}`);
    if (!version) throw new Error("kimi-code script install version not found");
    return withInstallSource({ ...base, version, installed: true }, "official-script");
  } catch {
    return withInstallSource({ ...versionResultBase("kimi-code", "official-script"), version: "", installed: false }, "unknown");
  }
}

function parseNpmPackageVersion(stdout: string, packageName: string): string {
  try {
    const payload = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
    return extractSemver(payload.dependencies?.[packageName]?.version);
  } catch {
    return "";
  }
}

async function detectKimiCodeWindowsVersion(): Promise<CliVersionResult> {
  const base = versionResultBase("kimi-code");

  try {
    const script = "$d = if ($env:KIMI_INSTALL_DIR) { $env:KIMI_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.kimi-code' }; $p = Join-Path (Join-Path $d 'bin') 'kimi.exe'; if (Test-Path -LiteralPath $p -PathType Leaf) { & $p --version } else { exit 1 }";
    const r = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], 3000);
    if (r.code !== 0) throw new Error(r.stderr);
    const version = extractSemver(`${r.stdout}\n${r.stderr}`);
    if (!version) throw new Error("kimi-code Windows install version not found");
    return { ...base, version, installed: true };
  } catch {
    // Continue with npm and identifiable PATH fallbacks.
  }

  try {
    const r = await exec("npm", ["list", "-g", "@moonshot-ai/kimi-code", "--depth=0", "--json"], 5000);
    const version = parseNpmPackageVersion(r.stdout, "@moonshot-ai/kimi-code");
    if (r.code === 0 && version) {
      return withInstallSource({ ...base, version, installed: true }, "npm");
    }
  } catch {
    // Ignore npm lookup failures; official script installs do not require Node.js.
  }

  try {
    const r = await exec("kimi", ["--version"], 3000);
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0 || !/kimi[-\s]?code|@moonshot-ai\/kimi-code/i.test(output)) {
      throw new Error("kimi command is not identifiable as Kimi Code");
    }
    return withInstallSource({ ...base, version: extractSemver(output), installed: true }, "unknown");
  } catch {
    return withInstallSource({ ...base, version: "", installed: false }, "unknown");
  }
}

async function detectKimiCodeVersion(): Promise<CliVersionResult> {
  if (currentPlatform() === "windows") {
    return await detectKimiCodeWindowsVersion();
  }
  const homebrew = await detectKimiCodeHomebrewVersion();
  if (homebrew.installed) return homebrew;
  const scriptInstall = await detectKimiCodeScriptVersion();
  if (scriptInstall.installed) return scriptInstall;
  const base = versionResultBase("kimi-code");
  try {
    const target = await detectActiveKimiTarget();
    if (!target.installed) throw new Error("kimi-code command not found");
    return withInstallSource({ ...base, version: target.version, installed: true }, target.installSource);
  } catch {
    return withInstallSource({ ...base, version: "", installed: false }, "unknown");
  }
}

// ── 更新检测（Kimi Code 0.38.0：走官方 CDN manifest）──
// CLI 自带 manifest：https://code.{kimi.com|kimi.ai}/kimi-code/latest.json
// 全球/大陆分域：0.38.0 官方标记为 "mainland-cn" / "global"；兼容早期
// 安装脚本写入的 "cn" 与旧 GUI 使用过的 "zh-cn"。缺失或未知值沿用
// Kimi Code 官方默认 mainland-cn，避免把大陆安装误导向全球 CDN。
// 本地缓存 ~/.kimi-code/updates/latest.json 形如
// { source, checkedAt, latest, manifest: { version, ... } }，优先读取它避免每次请求网络。
// brew / GitHub releases 仅作为安装源信息回退，不再是版本检测主路径。
const KIMI_CODE_UPDATES_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

async function readCliManifestCache(): Promise<{ latest?: string; source?: string; checkedAt?: string } | null> {
  try {
    const cached = await invoke<{ status: number; ok: boolean; body: string } | string | null>("read_text", { path: join(getKimiCodeHome(), "updates", "latest.json") });
    if (typeof cached !== "string" || !cached.trim()) {
      return null;
    }
    const parsed = JSON.parse(cached) as { latest?: unknown; source?: unknown; checkedAt?: unknown };
    if (typeof parsed.latest !== "string") {
      return null;
    }
    return {
      latest: parsed.latest,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : undefined,
    };
  } catch {
    return null;
  }
}

async function readKimiCodeRegion(): Promise<string> {
  try {
    const raw = await invoke<string | null>("read_text", { path: join(getKimiCodeHome(), "region") });
    if (!raw) {
      return "mainland-cn";
    }
    const trimmed = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (trimmed === "global") {
      return "global";
    }
    return "mainland-cn";
  } catch {
    return "mainland-cn";
  }
}

function kimiCodeCdnHost(region: string): string {
  return region === "global" ? "code.kimi.ai" : "code.kimi.com";
}

async function getKimiCodeLatestVersionFromCdn(): Promise<string | null> {
  const region = await readKimiCodeRegion();
  const url = `https://${kimiCodeCdnHost(region)}/kimi-code/latest.json`;
  const resp = await http("GET", url, { Accept: "application/json", "User-Agent": "kimi-code-switch" });
  if (!resp.ok) {
    return null;
  }
  const payload = JSON.parse(resp.body) as { version?: unknown; latest?: unknown; manifest?: { version?: unknown } };
  const rawVersion = typeof payload.version === "string"
    ? payload.version
    : typeof payload.latest === "string"
      ? payload.latest
      : payload.manifest?.version;
  return extractSemver(typeof rawVersion === "string" ? rawVersion : undefined) || null;
}

/**
 * 获取 Kimi Code 最新版本。优先读取 CLI 本地更新缓存；无缓存时回退到 CDN manifest。
 * brew / GitHub releases 不再用于版本检测主路径。
 */
async function getKimiCodeLatestVersion(): Promise<string | null> {
  const cached = await readCliManifestCache();
  const checkedAtMs = cached?.checkedAt ? Date.parse(cached.checkedAt) : Number.NaN;
  const cacheAgeMs = Date.now() - checkedAtMs;
  const cacheIsFresh = Number.isFinite(checkedAtMs)
    && cacheAgeMs >= 0
    && cacheAgeMs <= KIMI_CODE_UPDATES_CACHE_MAX_AGE_MS;
  if (cacheIsFresh && cached?.latest) {
    const cachedVersion = extractSemver(cached.latest);
    if (cachedVersion) {
      return cachedVersion;
    }
  }
  return getKimiCodeLatestVersionFromCdn();
}

async function attachLatestVersion(result: CliVersionResult, timeoutMs = LATEST_VERSION_TIMEOUT_MS): Promise<CliVersionResult> {
  try {
    const latestVersion = await withTimeout(
      getKimiCodeLatestVersion(),
      timeoutMs,
      `Kimi Code latest version request timed out after ${timeoutMs}ms`,
    );
    if (!latestVersion) return result;
    return {
      ...result,
      latestVersion,
      hasUpdate: result.version ? compareReleaseVersions(latestVersion, result.version) > 0 : false,
    };
  } catch {
    return result;
  }
}

export async function getCliVersion(options: { checkLatest?: boolean; latestTimeoutMs?: number } = {}): Promise<CliVersionResult> {
  return getTargetCliVersion("kimi-code", options);
}

export async function getTargetCliVersion(
  target: ConfigTarget = "kimi-code",
  options: { checkLatest?: boolean; latestTimeoutMs?: number } = {},
): Promise<CliVersionResult> {
  void target;
  const result = await detectKimiCodeVersion();
  if (!options.checkLatest) return result;
  return await attachLatestVersion(result, options.latestTimeoutMs);
}

export async function upgradeTargetCli(
  target: ConfigTarget = "kimi-code",
  options: { install?: boolean } = {},
): Promise<{ ok: true; stdout: string; stderr: string }> {
  void target;
  const platform = currentPlatform();
  if (platform === "windows") {
    // Windows：官方 PowerShell 安装脚本是唯一安装/升级入口。
    const r = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${KIMI_CODE_INSTALL_SCRIPT_URL} | iex`], 120000);
    if (r.code !== 0) throw new Error(r.stderr || "upgrade failed");
    return { ok: true, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  }

  // 先检测真实安装来源，据此选升级路径：
  // - install 请求（通常因未安装）：Homebrew 安装兜底；
  // - homebrew：brew install/upgrade（保留 cask 元数据）；
  // - official-script / npm / pnpm / unknown：0.38.0 内置 `kimi upgrade` 优先。
  const detected = await detectKimiCodeVersion();
  const isHomebrew = detected.installSource === "homebrew";
  const r = options.install || isHomebrew
    ? await exec("brew", [options.install ? "install" : "upgrade", "kimi-code"], 120000)
    : await exec("sh", ["-lc", "kimi upgrade"], 120000);
  if (r.code !== 0) throw new Error(r.stderr || "upgrade failed");
  return { ok: true, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

export async function upgradeKimiCli(): Promise<{ ok: true; stdout: string; stderr: string }> {
  return upgradeTargetCli("kimi-code");
}

export async function startKimiOAuthLogin(
  target: ConfigTarget,
  onEvent?: (event: KimiOAuthLoginEvent) => void,
  options?: { homePath?: string },
): Promise<{ ok: true; stdout: string; stderr: string }> {
  const unsubscribe = onEvent ? onServerEvent("kimi-oauth-login", onEvent) : undefined;
  try {
    const result = await invoke<ExecResult>("start_kimi_oauth_login", {
      target,
      homePath: options?.homePath ?? null,
    });
    if (result.code !== 0) throw new Error(result.stderr || "kimi login failed");
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } finally {
    unsubscribe?.();
  }
}

export async function runKimiMcpServerTest(
  name: string,
  server: McpServerConfig,
): Promise<{ ok: true; stdout: string; stderr: string }> {
  if (server.transport === "sse") {
    throw new Error(`MCP server "${name}" uses legacy SSE. Kimi Code supports this transport, but the GUI connectivity test does not implement SSE.`);
  }
  if (server.transport === "stdio") {
    if (!server.command.trim()) {
      throw new Error(`MCP server "${name}" uses stdio transport but has no command.`);
    }
    const r = currentPlatform() === "windows"
      ? await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Get-Command ${quoteForPowerShell(server.command)} -ErrorAction Stop | Out-Null`], 5000)
      : await exec("sh", ["-lc", `command -v ${quoteForShell(server.command)} >/dev/null`], 5000);
    if (r.code !== 0) {
      throw new Error(`MCP server "${name}" command is not available: ${server.command}`);
    }
    return { ok: true, stdout: `MCP stdio command is available: ${server.command}`, stderr: "" };
  }

  if (!server.url.trim()) {
    throw new Error(`MCP server "${name}" URL is required.`);
  }

  const resp = await http(
    "POST",
    server.url.trim(),
    {
      ...await resolvedMcpStaticHeaders(server),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "kimi-code-switch",
          version: serverVersion,
        },
      },
    }),
  );
  if (resp.status === 405) {
    throw new Error(`MCP server "${name}" does not accept Streamable HTTP POST requests. This URL is likely an SSE endpoint; use a real HTTP MCP URL or a stdio bridge.`);
  }
  if (!resp.ok) {
    throw new Error(`MCP server "${name}" HTTP test failed: ${resp.status}${resp.body ? ` - ${resp.body.slice(0, 300)}` : ""}`);
  }
  return { ok: true, stdout: resp.body.trim(), stderr: "" };
}

function mcpInitializeRequest(id: number): McpStdioRpcRequest {
  return {
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "kimi-code-switch",
        version: serverVersion,
      },
    },
  } as McpStdioRpcRequest;
}

function mcpInitializedNotification(): McpStdioRpcRequest {
  return { method: "notifications/initialized" };
}

async function resolvedMcpStaticHeaders(server: McpServerConfig): Promise<Record<string, string>> {
  const headers = { ...server.headers };
  const bearerTokenEnvVar = typeof server.extra?.bearerTokenEnvVar === "string"
    ? server.extra.bearerTokenEnvVar.trim()
    : "";
  if (bearerTokenEnvVar && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    const token = await invoke<string | null>("read_environment_variable", { name: bearerTokenEnvVar });
    if (!token) throw new Error(`MCP bearer token environment variable is not set: ${bearerTokenEnvVar}`);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function mcpHttpHeaders(server: McpServerConfig, sessionId?: string, protocolVersion = MCP_PROTOCOL_VERSION): Promise<Record<string, string>> {
  return {
    ...await resolvedMcpStaticHeaders(server),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": protocolVersion,
  };
}

async function postMcpJsonRpc(
  name: string,
  server: McpServerConfig,
  request: McpStdioRpcRequest,
  sessionId?: string,
  protocolVersion = MCP_PROTOCOL_VERSION,
): Promise<HttpResponse> {
  if (!server.url.trim()) {
    throw new Error(`MCP server "${name}" URL is required.`);
  }
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    method: request.method,
  };
  if (request.id !== undefined) payload.id = request.id;
  if (request.params !== undefined) payload.params = request.params;
  const resp = await http("POST", server.url.trim(), await mcpHttpHeaders(server, sessionId, protocolVersion), JSON.stringify(payload));
  if (resp.status === 405) {
    throw new Error(`MCP server "${name}" does not accept Streamable HTTP POST requests. This URL is likely an SSE endpoint; use a real HTTP MCP URL or a stdio bridge.`);
  }
  if (!resp.ok) {
    throw new Error(`MCP server "${name}" HTTP request failed: ${resp.status}${resp.body ? ` - ${resp.body.slice(0, 300)}` : ""}`);
  }
  return resp;
}

function parseJsonRpcBody(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("MCP server returned an empty response.");
  }
  const direct = tryParseJson(trimmed);
  if (direct.ok) return direct.value;

  const eventData = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .find((line) => line && line !== "[DONE]");
  if (eventData) {
    const parsed = tryParseJson(eventData);
    if (parsed.ok) return parsed.value;
  }
  throw new Error("MCP server returned a non-JSON response.");
}

function tryParseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function jsonRpcResult(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    throw new Error("MCP server returned an invalid JSON-RPC response.");
  }
  const record = payload as Record<string, unknown>;
  if (record.error) {
    const error = record.error as Record<string, unknown>;
    throw new Error(`MCP JSON-RPC error: ${String(error.message ?? JSON.stringify(error))}`);
  }
  return record.result;
}

function negotiatedMcpProtocolVersion(initializeResult: unknown): string {
  if (!initializeResult || typeof initializeResult !== "object") {
    return MCP_PROTOCOL_VERSION;
  }
  const version = (initializeResult as Record<string, unknown>).protocolVersion;
  return typeof version === "string" && version.trim() ? version.trim() : MCP_PROTOCOL_VERSION;
}

function parseMcpTools(result: unknown): McpToolInfo[] {
  const tools = result && typeof result === "object" ? (result as Record<string, unknown>).tools : null;
  if (!Array.isArray(tools)) {
    throw new Error("MCP tools/list response does not contain tools.");
  }
  return tools.map((tool, index) => {
    if (!tool || typeof tool !== "object") {
      throw new Error(`MCP tool at index ${index} is invalid.`);
    }
    const record = tool as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) {
      throw new Error(`MCP tool at index ${index} has no name.`);
    }
    return {
      name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema: record.inputSchema ?? record.input_schema ?? null,
    };
  });
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseToolArguments(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function runHttpMcpToolList(name: string, server: McpServerConfig): Promise<McpToolListResult> {
  const init = await postMcpJsonRpc(name, server, mcpInitializeRequest(1));
  const sessionId = init.headers?.["mcp-session-id"] ?? init.headers?.["Mcp-Session-Id"];
  const protocolVersion = negotiatedMcpProtocolVersion(jsonRpcResult(parseJsonRpcBody(init.body)));
  await postMcpJsonRpc(name, server, mcpInitializedNotification(), sessionId, protocolVersion);
  const listResp = await postMcpJsonRpc(name, server, { id: 2, method: "tools/list" }, sessionId, protocolVersion);
  const payload = parseJsonRpcBody(listResp.body);
  const result = jsonRpcResult(payload);
  return { ok: true, tools: parseMcpTools(result), raw: formatJson(payload) };
}

async function runHttpMcpToolCall(
  name: string,
  server: McpServerConfig,
  toolName: string,
  argsJson: string,
): Promise<McpToolCallResult> {
  const init = await postMcpJsonRpc(name, server, mcpInitializeRequest(1));
  const sessionId = init.headers?.["mcp-session-id"] ?? init.headers?.["Mcp-Session-Id"];
  const protocolVersion = negotiatedMcpProtocolVersion(jsonRpcResult(parseJsonRpcBody(init.body)));
  await postMcpJsonRpc(name, server, mcpInitializedNotification(), sessionId, protocolVersion);
  const callResp = await postMcpJsonRpc(name, server, {
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: parseToolArguments(argsJson) },
  }, sessionId, protocolVersion);
  const payload = parseJsonRpcBody(callResp.body);
  return { ok: true, toolName, result: jsonRpcResult(payload), raw: formatJson(payload) };
}

function ensureStdioMcpServer(name: string, server: McpServerConfig): void {
  if (!server.command.trim()) {
    throw new Error(`MCP server "${name}" uses stdio transport but has no command.`);
  }
}

function findJsonRpcResponse(responses: unknown[], id: number): unknown {
  const response = responses.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as Record<string, unknown>).id === id;
  });
  if (!response) {
    throw new Error(`MCP stdio server did not return response for request ${id}.`);
  }
  return response;
}

async function runStdioMcpToolList(name: string, server: McpServerConfig): Promise<McpToolListResult> {
  ensureStdioMcpServer(name, server);
  const session = await mcpStdioSession(server.command, server.args, server.env, [
    mcpInitializeRequest(1),
    mcpInitializedNotification(),
    { id: 2, method: "tools/list" },
  ], 30000, typeof server.extra?.cwd === "string" ? server.extra.cwd : undefined);
  jsonRpcResult(findJsonRpcResponse(session.responses, 1));
  const listPayload = findJsonRpcResponse(session.responses, 2);
  return {
    ok: true,
    tools: parseMcpTools(jsonRpcResult(listPayload)),
    raw: formatJson(listPayload),
    stderr: session.stderr.trim(),
  };
}

async function runStdioMcpToolCall(
  name: string,
  server: McpServerConfig,
  toolName: string,
  argsJson: string,
): Promise<McpToolCallResult> {
  ensureStdioMcpServer(name, server);
  const session = await mcpStdioSession(server.command, server.args, server.env, [
    mcpInitializeRequest(1),
    mcpInitializedNotification(),
    {
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: parseToolArguments(argsJson) },
    },
  ], 30000, typeof server.extra?.cwd === "string" ? server.extra.cwd : undefined);
  jsonRpcResult(findJsonRpcResponse(session.responses, 1));
  const callPayload = findJsonRpcResponse(session.responses, 2);
  return {
    ok: true,
    toolName,
    result: jsonRpcResult(callPayload),
    raw: formatJson(callPayload),
    stderr: session.stderr.trim(),
  };
}

export async function listKimiMcpServerTools(name: string, server: McpServerConfig): Promise<McpToolListResult> {
  if (server.transport === "sse") {
    throw new Error(`MCP server "${name}" uses legacy SSE. Kimi Code supports this transport, but the GUI tool browser does not implement SSE.`);
  }
  return server.transport === "stdio" ? runStdioMcpToolList(name, server) : runHttpMcpToolList(name, server);
}

export async function callKimiMcpServerTool(
  name: string,
  server: McpServerConfig,
  toolName: string,
  argsJson: string,
): Promise<McpToolCallResult> {
  if (!toolName.trim()) {
    throw new Error("MCP tool name is required.");
  }
  if (server.transport === "sse") {
    throw new Error(`MCP server "${name}" uses legacy SSE. Kimi Code supports this transport, but the GUI tool browser does not implement SSE.`);
  }
  return server.transport === "stdio"
    ? runStdioMcpToolCall(name, server, toolName, argsJson)
    : runHttpMcpToolCall(name, server, toolName, argsJson);
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// PowerShell 单引号字符串为字面量，不展开变量/子表达式（$()、反引号）。
// 内部每个单引号需写成两个单引号转义。
function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── 连通性测试（非流式版：通过 Rust http_request 拿完整响应）──
function joinUrlPath(baseUrl: string, suffix: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const re = new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return re.test(trimmed) ? trimmed : `${trimmed}${suffix}`;
}

function readStringPath(value: unknown, path: Array<string | number>): string | null {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return null;
      cur = cur[key];
    } else {
      if (!cur || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return typeof cur === "string" ? cur : null;
}

type Kind = "chat-completions" | "responses" | "anthropic" | "google-genai";

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  kimi: "https://api.moonshot.ai/v1",
  openai: "https://api.openai.com/v1",
  openai_legacy: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "google-genai": "https://generativelanguage.googleapis.com",
};

function effectiveProviderType(provider: ProviderConfig, model: ModelConfig): string {
  return model.protocol?.trim() || provider.type?.trim() || "openai";
}

function providerEnvValue(provider: ProviderConfig, keys: string[]): string {
  for (const key of keys) {
    const value = provider.env?.[key]?.trim();
    if (value) return value;
  }
  return "";
}

function resolvedProviderApiKey(provider: ProviderConfig, type: string): string {
  const direct = provider.api_key?.trim();
  if (direct) return direct;
  if (type === "kimi") return providerEnvValue(provider, ["KIMI_API_KEY"]);
  if (type === "anthropic") return providerEnvValue(provider, ["ANTHROPIC_API_KEY"]);
  if (type === "google-genai") return providerEnvValue(provider, ["GOOGLE_API_KEY"]);
  if (type === "openai" || type === "openai_legacy" || type === "openai_responses") {
    return providerEnvValue(provider, ["OPENAI_API_KEY"]);
  }
  return "";
}

function resolvedProviderBaseUrl(provider: ProviderConfig, model: ModelConfig, type: string): string {
  // Kimi only applies per-model base_url when protocol is explicitly declared;
  // otherwise the field is catalog metadata and provider.base_url remains authoritative.
  const direct = (model.protocol ? model.base_url?.trim() : "") || provider.base_url?.trim();
  if (direct) return direct;
  const envKeys = type === "kimi"
    ? ["KIMI_BASE_URL"]
    : type === "anthropic"
      ? ["ANTHROPIC_BASE_URL"]
      : type === "google-genai"
        ? ["GOOGLE_GEMINI_BASE_URL"]
        : type === "vertexai"
          ? ["GOOGLE_VERTEX_BASE_URL"]
          : ["OPENAI_BASE_URL"];
  return providerEnvValue(provider, envKeys) || PROVIDER_DEFAULT_BASE_URLS[type] || "";
}

function requestHeaders(provider: ProviderConfig, defaults: Record<string, string>): Record<string, string> {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(provider.custom_headers ?? {})) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

async function buildRequest(provider: ProviderConfig, model: ModelConfig, prompt: string): Promise<{
  endpoint: string;
  displayEndpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  kind: Kind;
}> {
  const type = effectiveProviderType(provider, model);
  const baseUrl = resolvedProviderBaseUrl(provider, model, type);
  const apiKey = resolvedProviderApiKey(provider, type);
  if (type === "anthropic") {
    if (!apiKey) throw new Error("Anthropic API key is required.");
    return {
      endpoint: joinUrlPath(baseUrl, "/v1/messages"),
      displayEndpoint: joinUrlPath(baseUrl, "/v1/messages"),
      headers: requestHeaders(provider, { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
      body: { model: model.model, max_tokens: 64, messages: [{ role: "user", content: prompt }] },
      kind: "anthropic",
    };
  }
  if (type === "openai_responses") {
    if (!apiKey) throw new Error("OpenAI API key is required.");
    return {
      endpoint: joinUrlPath(baseUrl, "/responses"),
      displayEndpoint: joinUrlPath(baseUrl, "/responses"),
      headers: requestHeaders(provider, { "content-type": "application/json", authorization: `Bearer ${apiKey}` }),
      body: { model: model.model, input: prompt },
      kind: "responses",
    };
  }
  if (type === "google-genai") {
    if (!apiKey) throw new Error("Google GenAI API key is required.");
    const displayEndpoint = joinUrlPath(baseUrl, `/v1beta/models/${encodeURIComponent(model.model)}:generateContent`);
    return {
      endpoint: `${displayEndpoint}?key=${encodeURIComponent(apiKey)}`,
      displayEndpoint,
      headers: requestHeaders(provider, { "content-type": "application/json" }),
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 64 },
      },
      kind: "google-genai",
    };
  }
  if (type === "vertexai") {
    const project = providerEnvValue(provider, ["GOOGLE_CLOUD_PROJECT"]);
    const location = providerEnvValue(provider, ["GOOGLE_CLOUD_LOCATION"]);
    if (!project || !location) {
      throw new Error("Vertex AI requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION in provider.env.");
    }
    const root = baseUrl || `https://${location}-aiplatform.googleapis.com`;
    const endpoint = joinUrlPath(
      root,
      `/v1beta1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model.model)}:generateContent`,
    );
    const customAuthorization = Object.entries(provider.custom_headers ?? {})
      .find(([key]) => key.toLowerCase() === "authorization")?.[1];
    const accessToken = customAuthorization
      ? ""
      : await invoke<string>("get_google_adc_access_token", { env: provider.env ?? {} });
    return {
      endpoint,
      displayEndpoint: endpoint,
      headers: requestHeaders(provider, {
        "content-type": "application/json",
        ...(customAuthorization ? {} : { authorization: `Bearer ${accessToken}` }),
      }),
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 64 },
      },
      kind: "google-genai",
    };
  }
  if (!baseUrl) throw new Error(`Provider base URL is required for ${type}.`);
  if (!apiKey) throw new Error(`Provider API key is required for ${type}.`);
  return {
    endpoint: joinUrlPath(baseUrl, "/chat/completions"),
    displayEndpoint: joinUrlPath(baseUrl, "/chat/completions"),
    headers: requestHeaders(provider, { "content-type": "application/json", authorization: `Bearer ${apiKey}` }),
    body: { model: model.model, messages: [{ role: "user", content: prompt }] },
    kind: "chat-completions",
  };
}

function extractText(raw: string, kind: Kind): string {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (kind === "anthropic") return readStringPath(v, ["content", 0, "text"]) ?? raw;
    if (kind === "responses") return readStringPath(v, ["output_text"]) ?? readStringPath(v, ["output", 0, "content", 0, "text"]) ?? raw;
    if (kind === "google-genai") return readStringPath(v, ["candidates", 0, "content", "parts", 0, "text"]) ?? raw;
    return readStringPath(v, ["choices", 0, "message", "content"]) ?? raw;
  } catch {
    return raw;
  }
}

export async function runKimiConnectivityTest(state: AppState, modelName: string): Promise<ProfileConnectivityTestResult> {
  const model = state.mainConfig.models[modelName];
  if (!model) throw new Error(`Model not found: ${modelName}`);
  const provider = state.mainConfig.providers[model.provider];
  if (!provider) throw new Error(`Provider not found: ${model.provider}`);
  if (model.auth_mode === "official-account" || (model.provider === "managed:kimi-code" && provider.oauth)) {
    throw new Error("Managed OAuth connectivity is unverified. Launch Kimi in the active KIMI_CODE_HOME to verify the official login.");
  }
  const prompt = "hi";
  const startedAt = performance.now();
  const req = await buildRequest(provider, model, prompt);
  const resp = await http("POST", req.endpoint, req.headers, JSON.stringify(req.body));
  const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
  const text = extractText(resp.body, req.kind);
  if (!resp.ok) {
    throw new Error(`Connectivity test failed: HTTP ${resp.status}${text ? ` - ${text}` : ""}`);
  }
  return {
    ok: true,
    stdout: text.trim(),
    stderr: "",
    profileName: state.activeProfile,
    modelName,
    providerName: model.provider,
    providerType: provider.type,
    prompt,
    endpoint: req.displayEndpoint,
    firstTokenMs: totalMs,
    totalMs,
    status: resp.status,
  };
}

// ── 全 provider 批量健康巡检 ──
// 复用 buildRequest 的请求构造做轻量连通性探测；逐项独立 try/catch，
// 单个 provider 失败（含 429 限流）不阻断其余。
export type ProviderHealthReason = "ok" | "no-model" | "missing-base-url" | "missing-api-key" | "oauth-unverified" | "rate-limited" | "http-error" | "network-error";

export interface ProviderHealthResult {
  providerName: string;
  ok: boolean;
  reason: ProviderHealthReason;
  status?: number;
  latencyMs?: number;
  detail?: string;
}

export interface ProviderCatalogSummary {
  id: string;
  name: string;
  type: string;
  modelCount: number;
}

export interface ProviderCatalogModel {
  id: string;
  displayName: string;
  maxContextTokens?: number;
  capabilities: string[];
}

interface KimiProviderCommandRequest {
  action: "catalog-list" | "catalog-add" | "registry-add" | "configured-list";
  providerId?: string;
  filter?: string;
  url?: string;
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
}

async function runKimiProviderCommand(
  homePath: string,
  request: KimiProviderCommandRequest,
): Promise<ExecResult> {
  const result = await invoke<ExecResult>("run_kimi_provider_command", { homePath, request });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Kimi provider command failed (${result.code}).`);
  }
  return result;
}

function catalogModelCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value as Record<string, unknown>).length;
}

export async function listKimiProviderCatalog(
  homePath: string,
  options: { filter?: string; url?: string } = {},
): Promise<ProviderCatalogSummary[]> {
  const result = await runKimiProviderCommand(homePath, {
    action: "catalog-list",
    filter: options.filter,
    url: options.url,
  });
  const catalog = JSON.parse(result.stdout) as unknown;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("Kimi provider catalog returned invalid JSON.");
  }
  return Object.entries(catalog as Record<string, unknown>)
    .map(([id, raw]) => {
      const entry = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      return {
        id,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
        type: typeof entry.type === "string" ? entry.type : "",
        modelCount: catalogModelCount(entry.models),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function getKimiProviderCatalogModels(
  homePath: string,
  providerId: string,
  options: { url?: string } = {},
): Promise<ProviderCatalogModel[]> {
  const result = await runKimiProviderCommand(homePath, {
    action: "catalog-list",
    providerId,
    url: options.url,
  });
  const payload = JSON.parse(result.stdout) as {
    models?: Array<{
      id?: unknown;
      name?: unknown;
      capability?: Record<string, unknown>;
    }>;
  };
  if (!Array.isArray(payload.models)) throw new Error("Kimi provider catalog model response is invalid.");
  return payload.models.flatMap((model) => {
    if (typeof model.id !== "string" || !model.id.trim()) return [];
    const capability = model.capability ?? {};
    const capabilities = [
      capability.tool_use === true ? "tool_use" : "",
      capability.thinking === true ? "thinking" : "",
      capability.image_in === true ? "image_in" : "",
    ].filter(Boolean);
    return [{
      id: model.id,
      displayName: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
      maxContextTokens: typeof capability.max_context_tokens === "number"
        ? capability.max_context_tokens
        : undefined,
      capabilities,
    }];
  });
}

export async function importKimiProviderCatalog(
  homePath: string,
  options: {
    providerId: string;
    apiKey: string;
    defaultModel?: string;
    baseUrl?: string;
    url?: string;
  },
): Promise<void> {
  await runKimiProviderCommand(homePath, {
    action: "catalog-add",
    ...options,
  });
}

export async function importKimiProviderRegistry(
  homePath: string,
  options: { url: string; apiKey: string },
): Promise<void> {
  await runKimiProviderCommand(homePath, {
    action: "registry-add",
    ...options,
  });
}

// 为某 provider 选一个代表 model（首个引用该 provider 的 model）。
function findRepresentativeModel(state: AppState, providerName: string): { modelName: string; model: ModelConfig } | null {
  for (const [modelName, model] of Object.entries(state.mainConfig.models)) {
    if (model.provider === providerName) return { modelName, model };
  }
  return null;
}

async function probeProvider(
  providerName: string,
  provider: ProviderConfig,
  model: ModelConfig,
): Promise<ProviderHealthResult> {
  if (model.auth_mode === "official-account" || (model.provider === "managed:kimi-code" && provider.oauth)) {
    return {
      providerName,
      ok: false,
      reason: "oauth-unverified",
      detail: "Launch Kimi in the active KIMI_CODE_HOME to verify the official login.",
    };
  }
  const type = effectiveProviderType(provider, model);
  const baseUrl = resolvedProviderBaseUrl(provider, model, type);
  if (!baseUrl && type !== "vertexai") {
    return { providerName, ok: false, reason: "missing-base-url" };
  }
  if (type !== "vertexai" && !resolvedProviderApiKey(provider, type)) {
    return { providerName, ok: false, reason: "missing-api-key" };
  }
  const startedAt = performance.now();
  try {
    const req = await buildRequest(provider, model, "hi");
    const resp = await http("POST", req.endpoint, req.headers, JSON.stringify(req.body));
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (resp.ok) {
      return { providerName, ok: true, reason: "ok", status: resp.status, latencyMs };
    }
    if (resp.status === 429) {
      return { providerName, ok: false, reason: "rate-limited", status: resp.status, latencyMs };
    }
    return { providerName, ok: false, reason: "http-error", status: resp.status, latencyMs, detail: resp.body.slice(0, 200) };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    return { providerName, ok: false, reason: "network-error", latencyMs, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runProvidersHealthCheck(state: AppState): Promise<ProviderHealthResult[]> {
  const entries = Object.entries(state.mainConfig.providers);
  const results = await Promise.all(
    entries.map(async ([providerName, provider]): Promise<ProviderHealthResult> => {
      const rep = findRepresentativeModel(state, providerName);
      if (!rep) {
        return { providerName, ok: false, reason: "no-model" };
      }
      // 逐项独立：单个 provider 探测失败不抛出，统一收敛为结果对象。
      try {
        return await probeProvider(providerName, provider, rep.model);
      } catch (error) {
        return { providerName, ok: false, reason: "network-error", detail: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return results;
}
