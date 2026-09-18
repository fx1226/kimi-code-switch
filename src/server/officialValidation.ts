import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { evaluateKimiCompatibility } from "../shared/kimiCompatibility";

export interface OfficialCandidateDocument {
  kind: "config" | "tui";
  content: string;
}

export interface OfficialValidationDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  kind?: "config" | "tui";
}

export interface OfficialValidationResult {
  status: "passed" | "rejected" | "unavailable";
  version: string | null;
  diagnostics: OfficialValidationDiagnostic[];
}

export interface OfficialValidationInput {
  /** An absolute CLI path resolved by the server; never accept it from browser input. */
  executable: string | null | undefined;
  documents: readonly OfficialCandidateDocument[];
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(executable, args, {
      cwd, env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" && !error.killed ? error.code : null,
        stdout, stderr,
      });
    });
  });
}

function isolatedEnvironment(root: string, kimiHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    HOME: root, USERPROFILE: root,
    KIMI_CODE_HOME: kimiHome,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
    TMPDIR: root, TMP: root, TEMP: root,
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
  };
}

/** Only parse a CLI version line, preserving prerelease/build suffixes for exact gating. */
export function parseOfficialCliVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^(?:(?:Kimi Code(?: CLI)?|kimi(?:-code)?)\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  return match?.[1] ?? null;
}

interface ExecutableIdentity { executable: string; fingerprint: string }
const versionEvidence = new Map<string, { fingerprint: string; version: string | null }>();
async function executableIdentity(path: string): Promise<ExecutableIdentity> {
  const executable = await realpath(path);
  const info = await stat(executable, { bigint: true });
  if (!info.isFile()) throw new Error("not an executable file");
  await access(executable, constants.X_OK);
  return { executable, fingerprint: [executable, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":") };
}
/** Reuse only the version evidence for the identical executable; candidates are always validated. */
export function verifyOfficialExecutable(executable: string | null | undefined): Promise<OfficialValidationResult> {
  return validateDocuments({ executable, documents: [] }, true);
}

/**
 * Doctor parses candidates only; it does not validate MCP/Skills/plugins or prove
 * Desktop runtime consumption. No inherited credentials, user config, or cwd are used.
 * Raw subprocess output must never cross this boundary: parser errors can echo secrets.
 */
export function validateOfficialDocuments(input: OfficialValidationInput): Promise<OfficialValidationResult> {
  return validateDocuments(input, false);
}
async function validateDocuments(input: OfficialValidationInput, versionOnly: boolean): Promise<OfficialValidationResult> {
  const diagnostics: OfficialValidationDiagnostic[] = [];
  let version: string | null = null;
  const unavailable = (code: string, message: string): OfficialValidationResult => ({
    status: "unavailable", version,
    diagnostics: [...diagnostics, { code, severity: "warning", message }],
  });
  if (!input.executable || !isAbsolute(input.executable)) {
    return unavailable("OFFICIAL_CLI_UNAVAILABLE", "未找到可验证的官方 Kimi Code CLI 可执行文件。");
  }
  if ((!versionOnly && input.documents.length === 0) || input.documents.some((document) => !["config", "tui"].includes(document.kind))) {
    return unavailable("OFFICIAL_TARGET_UNSUPPORTED", "官方 doctor 仅验证 config.toml 与 tui.toml 候选文件。");
  }
  let identity: ExecutableIdentity;
  try {
    identity = await executableIdentity(input.executable);
  } catch {
    return unavailable("OFFICIAL_CLI_UNAVAILABLE", "Kimi Code CLI 文件不存在或不可执行。");
  }
  const executable = identity.executable;
  const cached = versionEvidence.get(executable);
  if (cached?.fingerprint === identity.fingerprint) {
    version = cached.version;
    if (!evaluateKimiCompatibility(version).nativeWritesAllowed) return unavailable("OFFICIAL_VERSION_UNVERIFIED", "当前可执行文件版本尚未验证。");
    if (versionOnly) return { status: "passed", version, diagnostics };
  }
  let root: string;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "kimi-switch-doctor-")));
  } catch {
    return unavailable("OFFICIAL_VALIDATION_IO_FAILED", "无法创建隔离校验目录。");
  }
  try {
    const kimiHome = join(root, "kimi-home");
    await mkdir(kimiHome, { mode: 0o700 });
    const env = isolatedEnvironment(root, kimiHome);
    if (cached?.fingerprint !== identity.fingerprint) {
      const versionResult = await run(executable, ["--version"], root, env);
      version = versionResult.code === 0 ? parseOfficialCliVersion(versionResult.stdout) : null;
      if ((await executableIdentity(input.executable)).fingerprint !== identity.fingerprint) return unavailable("OFFICIAL_EXECUTABLE_CHANGED", "官方可执行文件在版本校验期间发生变化，请重试。");
      if (versionEvidence.size >= 16) versionEvidence.delete(versionEvidence.keys().next().value!);
      versionEvidence.set(executable, { fingerprint: identity.fingerprint, version });
    }
    if (!evaluateKimiCompatibility(version).nativeWritesAllowed) {
      return unavailable("OFFICIAL_VERSION_UNVERIFIED", "官方校验需要已对齐的 Kimi Code CLI 2.0.0；当前版本不可验证。");
    }
    for (const [index, document] of input.documents.entries()) {
      const path = join(root, `${index}-${document.kind}.toml`);
      await writeFile(path, document.content, { mode: 0o600 });
      const result = await run(executable, ["doctor", document.kind, path], root, env);
      if ((await executableIdentity(input.executable)).fingerprint !== identity.fingerprint) return unavailable("OFFICIAL_EXECUTABLE_CHANGED", "官方可执行文件在候选校验期间发生变化，请重新验证。");
      if (result.code === null) {
        return unavailable("OFFICIAL_DOCTOR_UNAVAILABLE", "官方 doctor 未能完成校验（启动失败、超时或输出超限）。");
      }
      if (await readFile(path, "utf8") !== document.content) {
        return { status: "rejected", version, diagnostics: [...diagnostics, {
          code: "OFFICIAL_CANDIDATE_MODIFIED", severity: "error", kind: document.kind,
          message: "官方校验期间候选文件发生变化，禁止写入原生配置。",
        }] };
      }
      if (result.code !== 0) {
        return { status: "rejected", version, diagnostics: [...diagnostics, {
          code: "OFFICIAL_DOCTOR_REJECTED", severity: "error", kind: document.kind,
          message: `官方 doctor 未接受 ${document.kind}.toml 候选文件；请检查本地格式与字段诊断。`,
        }] };
      }
      // Explicit paths must be reported OK, never merely SKIP or an empty exit 0.
      if (!new RegExp(`^OK ${document.kind}\\.toml\\s+`, "m").test(result.stdout)) {
        return unavailable("OFFICIAL_DOCTOR_UNCONFIRMED", "官方 doctor 未返回候选文件的明确校验结果。");
      }
      const warning = /^\s{2}\S/m.test(result.stdout) || result.stderr.trim().length > 0;
      diagnostics.push({
        code: warning ? "OFFICIAL_DOCTOR_WARNING" : "OFFICIAL_DOCTOR_PASSED",
        severity: warning ? "warning" : "info", kind: document.kind,
        message: warning
          ? `官方 doctor 接受 ${document.kind}.toml，但返回了警告；此结果不代表运行时生效。`
          : `官方 doctor 已解析 ${document.kind}.toml 候选文件；此结果不代表运行时生效。`,
      });
    }
    return { status: "passed", version, diagnostics };
  } catch {
    return unavailable("OFFICIAL_VALIDATION_IO_FAILED", "无法完成隔离候选文件校验。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
