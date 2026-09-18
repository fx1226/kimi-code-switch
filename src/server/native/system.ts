// Wave 2：src-tauri/src/system.rs 的系统集成原子命令的 Node 移植。
// 纯 Node ESM，只允许 node: 内置模块 + 服务端共享路径件 paths.ts；
// http_request 用 Node 22+ 全局 fetch（不引 node-fetch）。
// 失败一律 throw new Error(...)；返回 JSON 可序列化纯值。
import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createInterface } from "node:readline";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
} from "node:path";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";

import type { CommandHandlers } from "./index";
import { expandHome, getAppPaths } from "./paths";
import { emitServerEvent } from "../events";

const ALLOWED_COMMANDS = [
  "kimi",
  "kimi-code",
  "brew",
  "sh",
  "powershell.exe",
  "open",
  "osascript",
  "uv",
  "uvx",
  "python",
  "python3",
  "node",
  "npm",
  "npx",
];

const MCP_MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16MB
const MAX_FILE_SLICE = 10 * 1024 * 1024; // 10MB

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface FileStatResult {
  size: number;
  mtime_ms: number;
  ino: number;
}

interface HttpResponseResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

interface OAuthLoginEvent {
  kind: string;
  target: string;
  stream: string | null;
  line: string | null;
  url: string | null;
  user_code: string | null;
  expires_in: number | null;
  message: string | null;
}

interface McpStdioRequest {
  id?: number;
  method: string;
  params?: unknown;
}

interface McpStdioResponseResult {
  responses: unknown[];
  stderr: string;
}

interface RunExecOptions {
  timeoutMs?: number | null;
  env?: Record<string, string>;
  /** spawn 失败时抛出的错误前缀（默认 "spawn error: "）。 */
  spawnErrorPrefix?: string;
}

// ── 路径 / 环境辅助（对齐 fs_access.rs 的 resolve_home 与 system.rs 的 augmented_path）──

function expandShellLikePathValue(value: string): string {
  return expandHome(value);
}

function executablePathIfExists(p: string): string | null {
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** macOS / 类 Unix：在常见路径基础上补齐 CLI 查找路径（对应 cli.ts 的 getCliEnv）。 */
export function augmentedPath(): string {
  const separator = process.platform === "win32" ? ";" : ":";
  const entries: string[] = [];
  if (process.env.PATH) {
    entries.push(...process.env.PATH.split(separator));
  }
  const home = homedir();
  if (process.platform === "win32") {
    entries.push(
      join(home, ".kimi-code/bin"),
      join(home, "AppData/Roaming/npm"),
      join(home, ".cargo/bin"),
      join(home, ".volta/bin"),
    );
  } else {
    entries.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".kimi-code/bin"),
      join(home, ".local/bin"),
      join(home, ".cargo/bin"),
      join(home, ".npm-global/bin"),
      join(home, ".volta/bin"),
    );
  }
  const seen = new Set<string>();
  return entries
    .map((e) => e.trim())
    .filter((e) => e !== "" && !seen.has(e))
    .join(separator);
}

// ── 命令白名单（仅校验 basename；args 由前端完全控制，对齐 Rust 的信任边界）──

export function validateCommand(program: string): void {
  const programName = basename(program);
  if (ALLOWED_COMMANDS.includes(programName)) return;
  throw new Error(
    `Command '${program}' is not in the allowed list: ${JSON.stringify(ALLOWED_COMMANDS)}`,
  );
}

// ── 进程执行 ──

/**
 * spawn 并收集 stdout/stderr/退出码。timeoutMs<=0（或 null/undefined）表示不超时；
 * 超时则杀进程并报错（对齐 Rust 的 tokio::timeout 语义）。
 */
export function runExec(
  program: string,
  args: string[],
  options: RunExecOptions = {},
): Promise<ExecResult> {
  const spawnErrorPrefix = options.spawnErrorPrefix ?? "spawn error: ";
  const timeoutMs = options.timeoutMs;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, {
        env: { ...process.env, PATH: augmentedPath(), ...(options.env ?? {}) },
      });
    } catch (err) {
      reject(new Error(`${spawnErrorPrefix}${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error, code?: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code: code ?? -1, stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish(new Error(`${spawnErrorPrefix}${err.message}`)));
    child.on("close", (code) => finish(undefined, code ?? -1));

    if (timeoutMs !== null && timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(new Error(`command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

// ── 命令 1：exec_command ──

async function execCommand(args: Record<string, unknown>): Promise<ExecResult> {
  const program = String(args.program);
  const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const rawTimeout = args.timeoutMs;
  const timeoutMs =
    rawTimeout === null || rawTimeout === undefined ? null : Number(rawTimeout);
  validateCommand(program);
  return runExec(program, cmdArgs, { timeoutMs });
}

// ── 命令 2：read_environment_variable ──

function readEnvironmentVariable(args: Record<string, unknown>): string | null {
  const name = String(args.name);
  if (name === "" || name.length > 128 || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error("environment variable name is invalid");
  }
  const value = process.env[name];
  return value === undefined ? null : value;
}

// ── 命令 3：get_google_adc_access_token ──

const GOOGLE_ADC_ALLOWED_ENV = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
];

export async function getGoogleAdcAccessToken(args: Record<string, unknown>): Promise<string> {
  const env =
    args.env && typeof args.env === "object"
      ? (args.env as Record<string, unknown>)
      : {};
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GOOGLE_ADC_ALLOWED_ENV.includes(key)) continue;
    const v = String(value);
    if (v.length > 4096 || v.includes("\0")) {
      throw new Error(`invalid Google ADC environment value for ${key}`);
    }
    filtered[key] = v;
  }
  const result = await runExec(
    "gcloud",
    ["auth", "application-default", "print-access-token", "--quiet"],
    { timeoutMs: 15000, env: filtered, spawnErrorPrefix: "cannot run gcloud for Vertex ADC: " },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      detail === ""
        ? "gcloud could not resolve Application Default Credentials"
        : `gcloud could not resolve Application Default Credentials: ${detail}`,
    );
  }
  const token = result.stdout.trim();
  if (token === "" || token.length > 8192) {
    throw new Error("gcloud returned an invalid ADC access token");
  }
  return token;
}

// ── 命令 4：run_kimi_provider_command ──

function safeProviderArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 512 || trimmed.includes("\0")) {
    throw new Error(`invalid ${label}`);
  }
  return trimmed;
}

function safeProviderUrl(value: string, label: string): string {
  const v = safeProviderArgument(value, label);
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return v;
}

function safeProviderRegistryUrl(value: string, label: string): string {
  const v = safeProviderUrl(value, label);
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS when credentials are supplied`);
  }
  try {
    validateHttpUrl(v);
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return v;
}

function safeProviderCatalogUrl(value: string, label: string): string {
  const v = safeProviderUrl(value, label);
  try {
    validateHttpUrl(v);
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return v;
}

function safeProviderId(value: string): string {
  const v = safeProviderArgument(value, "provider id");
  if (!/^[A-Za-z0-9]/.test(v) || !/^[A-Za-z0-9\-_.:]*$/.test(v.slice(1))) {
    throw new Error("invalid provider id");
  }
  return v;
}

export function buildKimiProviderCommand(
  request: Record<string, unknown>,
): { args: string[]; registryApiKey: string | null } {
  const args = ["provider"];
  let registryApiKey: string | null = null;
  const action = String(request.action ?? "");
  const readOptional = (key: string): string | null => {
    const value = request[key];
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s === "" ? null : s;
  };

  if (action === "catalog-list") {
    args.push("catalog", "list");
    const providerId = readOptional("provider_id");
    if (providerId !== null) args.push(safeProviderId(providerId));
    const filter = readOptional("filter");
    if (filter !== null) args.push("--filter", safeProviderArgument(filter, "filter"));
    const url = readOptional("url");
    if (url !== null) args.push("--url", safeProviderCatalogUrl(url, "catalog URL"));
    args.push("--json");
  } else if (action === "catalog-add") {
    const providerId = readOptional("provider_id");
    if (providerId === null) throw new Error("provider id is required");
    args.push("catalog", "add", safeProviderId(providerId));
    const apiKey = readOptional("api_key");
    if (apiKey === null) throw new Error("API key is required");
    registryApiKey = safeProviderArgument(apiKey, "API key");
    const defaultModel = readOptional("default_model");
    if (defaultModel !== null) {
      args.push("--default-model", safeProviderArgument(defaultModel, "default model"));
    }
    const baseUrl = readOptional("base_url");
    if (baseUrl !== null) args.push("--base-url", safeProviderUrl(baseUrl, "base URL"));
    const url = readOptional("url");
    if (url !== null) args.push("--url", safeProviderRegistryUrl(url, "catalog URL"));
  } else if (action === "registry-add") {
    const url = readOptional("url");
    if (url === null) throw new Error("registry URL is required");
    args.push("add", safeProviderRegistryUrl(url, "registry URL"));
    const apiKey = readOptional("api_key");
    if (apiKey === null) throw new Error("API key is required");
    registryApiKey = safeProviderArgument(apiKey, "API key");
  } else if (action === "configured-list") {
    args.push("list", "--json");
  } else {
    throw new Error(`unsupported provider action: ${action}`);
  }
  return { args, registryApiKey };
}

async function validateProviderRemoteResolution(value: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid provider source URL");
  }
  const host = parsed.hostname;
  if (!host) throw new Error("provider source URL has no host");
  if (isIP(host) !== 0) return;
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    throw new Error(
      `cannot resolve provider source host ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`provider source host ${host} did not resolve`);
  }
  if (addresses.some((entry) => ipIsBlocked(entry.address))) {
    throw new Error(
      `provider source host ${host} resolves to a loopback/private/link-local address`,
    );
  }
}

export async function runKimiProviderCommand(args: Record<string, unknown>): Promise<ExecResult> {
  const homePath = String(args.homePath);
  const request =
    args.request && typeof args.request === "object"
      ? (args.request as Record<string, unknown>)
      : {};
  const { args: cmdArgs, registryApiKey } = buildKimiProviderCommand(request);
  const url = typeof request.url === "string" ? request.url.trim() : "";
  if (url !== "") {
    await validateProviderRemoteResolution(url);
  }
  const env: Record<string, string> = { KIMI_CODE_HOME: expandHome(homePath) };
  if (registryApiKey !== null) env.KIMI_REGISTRY_API_KEY = registryApiKey;
  return runExec("kimi", cmdArgs, {
    timeoutMs: 90000,
    env,
    spawnErrorPrefix: "cannot run kimi provider command: ",
  });
}

// ── HTTP URL 校验（SSRF 防护，对齐 Rust validate_http_url / ip_is_blocked）──

function v6Segments(ip: string): number[] {
  const lower = ip.toLowerCase();
  const dbl = lower.indexOf("::");
  let head = lower;
  let tail = "";
  if (dbl !== -1) {
    head = lower.slice(0, dbl);
    tail = lower.slice(dbl + 2);
  }
  const parseGroup = (s: string): number[] =>
    s === "" ? [] : s.split(":").map((h) => parseInt(h, 16) || 0);
  const headSegs = parseGroup(head);
  const tailSegs = parseGroup(tail);
  const missing = Math.max(0, 8 - headSegs.length - tailSegs.length);
  return [...headSegs, ...Array<number>(missing).fill(0), ...tailSegs];
}

function isPrivateV4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4) return false;
  const [a, b, c, d] = o;
  const loopback = a === 127;
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const linkLocal = a === 169 && b === 254;
  const unspecified = a === 0 && b === 0 && c === 0 && d === 0;
  const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
  const cgnat = a === 100 && b >= 64 && b <= 127;
  return loopback || privateRange || linkLocal || unspecified || broadcast || cgnat;
}

export function ipIsBlocked(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipIsBlocked(mapped[1]);
    const seg = v6Segments(lower);
    return (seg[0] & 0xfe00) === 0xfc00 || (seg[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

function hostIsLoopbackOrPrivate(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return isIP(h) !== 0 ? ipIsBlocked(h) : false;
}

export function validateHttpUrl(url: string): void {
  const allowedDomains = ["api.github.com", "github.com", "pypi.org", "files.pythonhosted.org"];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  const host = parsed.hostname;
  if (!host) throw new Error("URL has no host");
  const hostLc = host.toLowerCase();
  if (allowedDomains.some((d) => hostLc === d || hostLc.endsWith(`.${d}`))) return;
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    if (hostIsLoopbackOrPrivate(host)) {
      throw new Error(
        `URL host '${host}' refers to a loopback/private/link-local address and is not allowed`,
      );
    }
    return;
  }
  throw new Error(`URL scheme '${parsed.protocol.replace(":", "")}' is not allowed (only http/https)`);
}

// ── 命令 10：http_request ──

const HTTP_METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

async function httpRequest(args: Record<string, unknown>): Promise<HttpResponseResult> {
  const method = String(args.method);
  const url = String(args.url);
  const methodUpper = method.toUpperCase();
  if (!HTTP_METHOD_TOKEN.test(methodUpper)) {
    throw new Error(`invalid method ${method}: invalid HTTP method token`);
  }
  const headers =
    args.headers && typeof args.headers === "object"
      ? (args.headers as Record<string, string>)
      : {};
  const body = args.body === null || args.body === undefined ? undefined : String(args.body);

  validateHttpUrl(url);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: methodUpper,
      headers,
      body,
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(`request: ${error instanceof Error ? error.message : String(error)}`);
  }
  const outHeaders: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    outHeaders[key.toLowerCase()] = value;
  });
  const text = await resp.text();
  return {
    status: resp.status,
    ok: resp.status >= 200 && resp.status < 300,
    body: text,
    headers: outHeaders,
  };
}

// ── 命令 7：file_stat ──

export function fileStat(args: Record<string, unknown>): FileStatResult | null {
  const resolved = expandHome(String(args.path));
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`file_stat: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { size: stat.size, mtime_ms: stat.mtimeMs, ino: stat.ino ?? 0 };
}

// ── 命令 9：read_file_slice ──

export function readFileSlice(args: Record<string, unknown>): string {
  const resolved = expandHome(String(args.path));
  const offset = Number(args.offset);
  const length = Number(args.length);
  let fd: number | undefined;
  try {
    fd = openSync(resolved, "r");
    let out = Buffer.alloc(0);
    let remaining = length;
    let position = offset;
    while (remaining > 0) {
      const chunkSize = Math.min(remaining, MAX_FILE_SLICE);
      const buf = Buffer.alloc(chunkSize);
      const n = readSync(fd, buf, 0, chunkSize, position);
      if (n === 0) break;
      out = Buffer.concat([out, buf.subarray(0, n)]);
      position += n;
      remaining -= n;
    }
    return out.toString("utf8");
  } catch (error) {
    throw new Error(
      `read_file_slice: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── 命令 8：resolve_workspace_directory ──

export function resolveWorkspaceDirectory(args: Record<string, unknown>): string {
  const projectRoot = String(args.projectRoot);
  const inputPath = String(args.inputPath);
  const input = inputPath.trim();
  if (input === "" || /[\0\r\n]/.test(input)) {
    throw new Error("workspace.additional_dir must exist and be a directory");
  }
  const expanded = expandHome(input);
  const candidate = isAbsolute(expanded)
    ? expanded
    : join(expandHome(projectRoot), expanded);
  const resolved = normalize(candidate);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error("workspace.additional_dir must exist and be a directory");
  }
  if (!stat.isDirectory()) {
    throw new Error("workspace.additional_dir must exist and be a directory");
  }
  return resolved;
}

// ── 命令 6：write_executable ──

export function writeExecutable(args: Record<string, unknown>): void {
  const resolved = expandHome(String(args.path));
  const content = String(args.content);

  const tempDir = tmpdir();
  const panelTmp = getAppPaths().tmpDir;
  const inAllowedDir = resolved.startsWith(tempDir) || resolved.startsWith(panelTmp);
  if (!inAllowedDir) {
    throw new Error(`write_executable only allowed in temp directories, got: ${resolved}`);
  }

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
  if (process.platform !== "win32") {
    chmodSync(resolved, 0o755);
  }
}

// ── OAuth 登录事件解析（对齐 Rust parse_device_login_line）──

function extractQueryValue(url: string, key: string): string | null {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return null;
  const query = url.slice(queryIndex + 1);
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const candidateKey = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (candidateKey === key && value.trim() !== "") return value.trim();
  }
  return null;
}

export function isOauthModelsPaymentRequired(value: string): boolean {
  const lower = value.toLowerCase();
  const mentionsModels = lower.includes("models") || lower.includes("coding/v1/models");
  const mentionsPayment =
    lower.includes("payment required") ||
    lower.includes("http 402") ||
    lower.includes(" 402,") ||
    lower.includes(": 402");
  return mentionsModels && mentionsPayment;
}

export function kimiOauthAccountRequiredMessage(): string {
  return "Kimi OAuth authorization completed, but the Kimi models endpoint returned 402 Payment Required. Check account billing, plan, or quota, then retry.";
}

export function parseDeviceLoginLine(target: string, line: string): OAuthLoginEvent {
  const base = (kind: string, extra: Partial<OAuthLoginEvent>): OAuthLoginEvent => ({
    kind,
    target,
    stream: null,
    line,
    url: null,
    user_code: null,
    expires_in: null,
    message: null,
    ...extra,
  });

  const PREFIX = {
    opening: "Opening browser for Kimi device login: ",
    verification: "Verification URL: ",
    pasteCode: "If the browser did not open, paste the URL above and enter code: ",
    userCode: "User Code: ",
    codeExpires: "Code expires in ",
    loginFailed: "Login failed: ",
  };

  if (line.startsWith(PREFIX.opening)) {
    const url = line.slice(PREFIX.opening.length);
    return base("device-code", { url: url.trim() });
  }
  if (line.startsWith(PREFIX.verification)) {
    const url = line.slice(PREFIX.verification.length).trim();
    return base("device-code", { url, user_code: extractQueryValue(url, "user_code") });
  }
  if (line.startsWith(PREFIX.pasteCode)) {
    const rest = line.slice(PREFIX.pasteCode.length);
    return base("user-code", { user_code: rest.trim() });
  }
  if (line.startsWith(PREFIX.userCode)) {
    const rest = line.slice(PREFIX.userCode.length);
    return base("user-code", { user_code: rest.trim() });
  }
  if (line.startsWith(PREFIX.codeExpires)) {
    let rest = line.slice(PREFIX.codeExpires.length);
    rest = rest.replace(/\.+$/, "");
    rest = rest.replace(/s+$/, "");
    rest = rest.trim();
    const seconds = /^\d+$/.test(rest) ? Number(rest) : null;
    return base("expires-in", { expires_in: seconds });
  }
  if (line.trim().startsWith("Logged in")) {
    const trimmed = line.trim();
    const message = trimmed.startsWith("Logged in to ")
      ? `Logged in to ${trimmed.slice("Logged in to ".length).replace(/\.$/, "")}`
      : trimmed;
    return base("success", { message });
  }
  if (isOauthModelsPaymentRequired(line)) {
    return base("account-required", { message: kimiOauthAccountRequiredMessage() });
  }
  if (line.trim() === "Login cancelled.") {
    return base("error", { message: "Login cancelled." });
  }
  if (line.trim().startsWith("Already logged in.")) {
    const rest = line.trim().slice("Already logged in.".length);
    return base("success", { message: `Already logged in. ${rest.trimStart()}` });
  }
  if (line.startsWith(PREFIX.loginFailed)) {
    const rest = line.slice(PREFIX.loginFailed.length);
    return base("error", { message: rest });
  }
  return base("output", {});
}

export function lastNonEmptyLine(value: string): string | undefined {
  const lines = value.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

export function summarizeOauthLoginFailure(result: ExecResult): string {
  const combinedOutput = `${result.stderr}\n${result.stdout}`;
  if (isOauthModelsPaymentRequired(combinedOutput)) {
    return kimiOauthAccountRequiredMessage();
  }
  return (
    lastNonEmptyLine(result.stderr) ??
    lastNonEmptyLine(result.stdout) ??
    `Kimi OAuth login failed with exit code ${result.code}.`
  );
}

// ── 登录命令发现（对齐 Rust find_oauth_login_command）──

interface OAuthLoginCommand {
  program: string;
  args: string[];
}

export function findKimiCodeLoginCommand(): OAuthLoginCommand {
  if (process.platform === "win32") {
    const root = process.env.KIMI_INSTALL_DIR
      ? process.env.KIMI_INSTALL_DIR
      : join(homedir(), ".kimi-code");
    const exe = executablePathIfExists(join(root, "bin/kimi.exe"));
    if (exe) return { program: exe, args: ["login"] };
    return { program: "kimi", args: ["login"] };
  }
  try {
    const prefix = spawnSync("brew", ["--prefix", "kimi-code"], {
      env: { ...process.env, PATH: augmentedPath() },
    });
    if (prefix.status === 0) {
      const brewPath = prefix.stdout.toString().trim();
      const candidate = executablePathIfExists(join(brewPath, "bin/kimi"));
      if (candidate) return { program: candidate, args: ["login"] };
    }
  } catch {
    /* brew unavailable; fall through */
  }
  const root = process.env.KIMI_INSTALL_DIR
    ? process.env.KIMI_INSTALL_DIR
    : join(homedir(), ".kimi-code");
  const candidate = executablePathIfExists(join(root, "bin/kimi"));
  if (candidate) return { program: candidate, args: ["login"] };
  return { program: "kimi", args: ["login"] };
}

function oauthTargetLabel(): string {
  return "Kimi Code";
}

let kimiOauthLoginRunning = false;

// ── 命令 5：start_kimi_oauth_login ──

async function startKimiOauthLogin(args: Record<string, unknown>): Promise<ExecResult> {
  const target = String(args.target ?? "kimi-code");
  const homePath = args.homePath === null || args.homePath === undefined
    ? null
    : String(args.homePath).trim();

  if (kimiOauthLoginRunning) {
    throw new Error("Kimi OAuth login is already running.");
  }
  kimiOauthLoginRunning = true;
  const targetLabel = oauthTargetLabel();

  let finalEmitted = false;
  const emitFinal = (kind: string, message: string): void => {
    if (finalEmitted) return;
    finalEmitted = true;
    emitServerEvent<OAuthLoginEvent>("kimi-oauth-login", {
      kind,
      target,
      stream: null,
      line: null,
      url: null,
      user_code: null,
      expires_in: null,
      message,
    });
  };

  try {
    emitServerEvent<OAuthLoginEvent>("kimi-oauth-login", {
      kind: "start",
      target,
      stream: null,
      line: null,
      url: null,
      user_code: null,
      expires_in: null,
      message: `Starting ${targetLabel} OAuth login.`,
    });

    const loginCommand = findKimiCodeLoginCommand();
    const spawnEnv: Record<string, string> = { PATH: augmentedPath() };
    if (homePath) spawnEnv.KIMI_CODE_HOME = expandHome(homePath);

    const child = spawn(loginCommand.program, loginCommand.args, {
      env: { ...process.env, ...spawnEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const streamEvent = (streamName: string, line: string): void => {
      const event = parseDeviceLoginLine(target, line);
      event.stream = streamName;
      emitServerEvent<OAuthLoginEvent>("kimi-oauth-login", event);
    };

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        stdout += `${line}\n`;
        streamEvent("stdout", line);
      });
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        stderr += `${line}\n`;
        streamEvent("stderr", line);
      });
    }

    const code: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? -1));
    });

    const execResult: ExecResult = { code, stdout, stderr };
    if (code === 0) {
      emitFinal("complete", `${targetLabel} OAuth login completed.`);
      return execResult;
    }
    const failMessage = summarizeOauthLoginFailure(execResult);
    emitFinal("failed", failMessage);
    throw new Error(failMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitFinal("failed", message);
    throw error;
  } finally {
    kimiOauthLoginRunning = false;
  }
}

// ── MCP stdio ──

export function normalizeMcpStdioArgs(program: string, args: string[]): string[] {
  const programName = basename(program).toLowerCase();
  const normalized = args.map((arg) => expandShellLikePathValue(arg));
  if (
    programName === "npx" &&
    normalized.includes("@modelcontextprotocol/server-filesystem") &&
    !normalized.some((arg) => arg === "-y" || arg === "--yes")
  ) {
    normalized.unshift("-y");
  }
  return normalized;
}

interface BufferedReader {
  readLine: () => Promise<Buffer | null>;
  readExact: (n: number) => Promise<Buffer | null>;
}

function createBufferedReader(stream: NodeJS.ReadableStream): BufferedReader {
  let buffer = Buffer.alloc(0);
  let ended = false;
  const waiters: Array<() => void> = [];
  const wake = (): void => {
    const pending = waiters.splice(0);
    for (const waiter of pending) waiter();
  };
  stream.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    wake();
  });
  stream.on("end", () => {
    ended = true;
    wake();
  });
  stream.on("error", () => {
    ended = true;
    wake();
  });

  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      waiters.push(resolve);
    });

  return {
    async readLine() {
      for (;;) {
        const idx = buffer.indexOf(0x0a);
        if (idx !== -1) {
          const line = buffer.subarray(0, idx);
          buffer = buffer.subarray(idx + 1);
          return line;
        }
        if (ended) return null;
        await wait();
      }
    },
    async readExact(n) {
      while (buffer.length < n) {
        if (ended) return null;
        await wait();
      }
      const data = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return data;
    },
  };
}

export async function readMcpStdioMessage(
  reader: BufferedReader,
): Promise<unknown | null> {
  for (;;) {
    const lineBuf = await reader.readLine();
    if (lineBuf === null) return null;
    const trimmed = lineBuf.toString("utf8").replace(/[\r\n]+$/, "");
    if (trimmed === "") continue;
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch (error) {
        throw new Error(
          `parse MCP stdio JSON-RPC line: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const name = trimmed.slice(0, colonIdx);
      const value = trimmed.slice(colonIdx + 1).trim();
      if (name.toLowerCase() === "content-length") {
        const length = Number(value);
        if (!Number.isInteger(length) || length < 0) {
          throw new Error(`parse MCP stdio content-length: ${value}`);
        }
        if (length > MCP_MAX_MESSAGE_SIZE) {
          throw new Error(
            `MCP stdio content-length ${length} exceeds limit ${MCP_MAX_MESSAGE_SIZE}`,
          );
        }
        for (;;) {
          const headerLine = await reader.readLine();
          if (headerLine === null) return null;
          if (headerLine.toString("utf8").replace(/[\r\n]+$/, "") === "") break;
        }
        const body = await reader.readExact(length);
        if (body === null) return null;
        try {
          return JSON.parse(body.toString("utf8")) as unknown;
        } catch (error) {
          throw new Error(
            `parse MCP stdio JSON-RPC body: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

// ── 命令 11：run_mcp_stdio_session ──

export async function runMcpStdioSession(args: Record<string, unknown>): Promise<McpStdioResponseResult> {
  const program = String(args.program);
  const rawArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const env =
    args.env && typeof args.env === "object"
      ? (args.env as Record<string, unknown>)
      : {};
  const requests = Array.isArray(args.requests)
    ? (args.requests as McpStdioRequest[])
    : [];
  const rawTimeout = args.timeoutMs;
  const timeoutMs = rawTimeout === null || rawTimeout === undefined
    ? 30000
    : Number(rawTimeout);

  validateCommand(program);
  if (requests.length === 0) {
    throw new Error("MCP stdio request list cannot be empty.");
  }

  const cmdArgs = normalizeMcpStdioArgs(program, rawArgs);
  const envExpanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    envExpanded[key] = expandShellLikePathValue(String(value));
  }
  const timeout = Math.max(1000, timeoutMs);

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, cmdArgs, {
        env: { ...process.env, PATH: augmentedPath(), ...envExpanded },
        cwd: typeof args.cwd === "string" && args.cwd ? expandHome(args.cwd) : undefined,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new Error(`spawn MCP stdio server: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }

    let stderr = "";
    let settled = false;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const finish = (err?: Error, result?: McpStdioResponseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve(result as McpStdioResponseResult);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(new Error(`MCP stdio session timed out after ${timeout}ms`));
    }, timeout);

    child.on("error", (error) =>
      finish(new Error(`spawn MCP stdio server: ${error.message}`)),
    );

    const run = async (): Promise<void> => {
      const responses: unknown[] = [];
      for (const request of requests) {
        const payload: Record<string, unknown> = {
          jsonrpc: "2.0",
          method: request.method,
        };
        if (request.id !== undefined && request.id !== null) payload.id = request.id;
        if (request.params !== undefined) payload.params = request.params;
        await new Promise<void>((res, rej) => {
          child.stdin!.write(`${JSON.stringify(payload)}\n`, (error) =>
            error ? rej(error) : res(),
          );
        });
        const expectedId = request.id;
        if (expectedId === undefined || expectedId === null) continue;
        for (;;) {
          const parsed = await readMcpStdioMessage(reader);
          if (parsed === null) break;
          const id = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).id : undefined;
          if (typeof id === "number" && id === expectedId) {
            responses.push(parsed);
            break;
          }
        }
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      const waitClose = (): Promise<void> => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        return new Promise((res) => {
          child.once("close", () => res());
          child.once("error", () => res());
        });
      };
      await waitClose();
      if (responses.length === 0) {
        const suffix = stderr.trim() === "" ? "" : ` stderr: ${stderr.trim()}`;
        finish(new Error(`MCP stdio server returned no JSON-RPC response.${suffix}`));
        return;
      }
      finish(undefined, { responses, stderr });
    };

    const reader = createBufferedReader(child.stdout as NodeJS.ReadableStream);
    run().catch((error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

// ── 注册表 ──

export const systemCommands: CommandHandlers = {
  exec_command: execCommand,
  read_environment_variable: readEnvironmentVariable,
  write_executable: writeExecutable,
  resolve_workspace_directory: resolveWorkspaceDirectory,
  http_request: httpRequest,
  run_mcp_stdio_session: runMcpStdioSession,
};
