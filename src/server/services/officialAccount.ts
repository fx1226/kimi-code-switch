import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import parseToml from "@iarna/toml/parse-string.js";
import { evaluateKimiCompatibility, KIMI_CODE_CONTRACT_COMMIT } from "@shared/kimiCompatibility";

export interface OfficialAccountStatus {
  status: "stored" | "expired" | "missing" | "revoked" | "invalid" | "unavailable";
  source: "official-2.0-local-files";
  message: string;
  /** Local file inspection never establishes whether the server accepts an account. */
  remoteValidated: false;
}
interface ManagedEnvironment {
  KIMI_CODE_BASE_URL?: string;
  KIMI_CODE_OAUTH_HOST?: string;
  KIMI_OAUTH_HOST?: string;
}

/** Fixed upstream evidence. CLI 2.0.0 has `login`, but no account-status subcommand. */
export const OFFICIAL_ACCOUNT_CONTRACT_SOURCES = [
  "apps/kimi-code/src/cli/commands.ts",
  "packages/oauth/src/managed-kimi-code.ts",
  "packages/oauth/src/managed-usage.ts",
  "packages/oauth/src/toolkit.ts",
  "packages/oauth/src/storage.ts",
  "packages/oauth/src/types.ts",
  "packages/oauth/src/token-state.ts",
].map((path) => `https://github.com/MoonshotAI/kimi-code/blob/${KIMI_CODE_CONTRACT_COMMIT}/${path}`);

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_KEY = "oauth/kimi-code";
const SOURCE = "official-2.0-local-files" as const;
const result = (status: OfficialAccountStatus["status"], message: string): OfficialAccountStatus => ({ status, source: SOURCE, message, remoteValidated: false });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class UnsafeLocalRecord extends Error {}
async function readBounded(root: string, path: string, maxBytes: number): Promise<string | null> {
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!canonical.startsWith(`${root}${sep}`)) throw new UnsafeLocalRecord();
  const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new UnsafeLocalRecord();
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

function readOptionalString(record: Record<string, unknown>, snake: string, camel = snake): string | undefined {
  const value = record[snake] ?? record[camel];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new UnsafeLocalRecord();
  return value;
}

/** Mirrors resolveKimiCodeRuntimeAuth + resolveKimiTokenStorageName at the pinned commit. */
function resolveSlot(config: unknown, env: ManagedEnvironment): { storage: string; name: string } {
  if (!isRecord(config)) throw new UnsafeLocalRecord();
  const providers = config.providers;
  if (providers !== undefined && !isRecord(providers)) throw new UnsafeLocalRecord();
  const provider = isRecord(providers) ? providers["managed:kimi-code"] : undefined;
  if (provider !== undefined && !isRecord(provider)) throw new UnsafeLocalRecord();
  const record = isRecord(provider) ? provider : {};
  const configuredBaseUrl = readOptionalString(record, "base_url", "baseUrl");
  const ref = record.oauth;
  if (ref !== undefined && !isRecord(ref)) throw new UnsafeLocalRecord();
  const oauth = isRecord(ref) ? ref : {};
  const configuredKey = readOptionalString(oauth, "key");
  const configuredHost = readOptionalString(oauth, "oauth_host", "oauthHost");
  const configuredStorage = readOptionalString(oauth, "storage");
  if (ref !== undefined && (!configuredKey || !["file", "keyring"].includes(configuredStorage ?? ""))) throw new UnsafeLocalRecord();
  const envBaseUrl = env.KIMI_CODE_BASE_URL;
  const envOAuthHost = env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST;
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const baseUrl = (envBaseUrl ?? configuredBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const oauthHost = ((hasEnvOverride ? envOAuthHost : configuredHost) ?? DEFAULT_OAUTH_HOST).trim().replace(/\/+$/, "");
  const expectedKey = oauthHost === DEFAULT_OAUTH_HOST && baseUrl === DEFAULT_BASE_URL
    ? DEFAULT_KEY
    : `oauth/kimi-code-env-${createHash("sha256").update(JSON.stringify({ oauthHost, baseUrl })).digest("hex").slice(0, 16)}`;
  const storage = !hasEnvOverride && configuredKey === expectedKey ? configuredStorage ?? "file" : "file";
  return { storage, name: expectedKey.slice("oauth/".length) };
}

/**
 * Read only the selected target's official local record. No CLI spawn, network
 * request, token refresh, account rotation, logging, or filesystem mutation.
 */
export async function readOfficialAccountStatus(input: {
  homePath: string;
  cliVersion?: string | null;
  nowMs?: number;
  env?: ManagedEnvironment;
}): Promise<OfficialAccountStatus> {
  if (!evaluateKimiCompatibility(input.cliVersion).nativeWritesAllowed) {
    return result("unavailable", "当前 CLI 版本的账号存储格式尚未验证，请通过官方客户端查看登录状态。");
  }
  if (!isAbsolute(input.homePath)) return result("unavailable", "账号状态需要明确的 Kimi 数据目录。");
  let root: string;
  try { root = await realpath(input.homePath); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? result("missing", "此数据目录尚无官方登录凭据。")
      : result("unavailable", "无法读取此数据目录的账号状态。");
  }
  try {
    const configText = await readBounded(root, join(root, "config.toml"), 4 * 1024 * 1024);
    let config: unknown = {};
    if (configText !== null) {
      try { config = parseToml(configText); }
      catch { return result("invalid", "原生配置无法解析，无法确定官方账号凭据位置。"); }
    }
    let slot: { storage: string; name: string };
    try { slot = resolveSlot(config, input.env ?? process.env); }
    catch { return result("invalid", "官方账号配置引用的格式无效，请通过官方客户端检查。"); }
    if (slot.storage !== "file") return result("unavailable", "此账号使用的凭据存储方式不在已验证的只读范围内。");
    const text = await readBounded(root, join(root, "credentials", `${slot.name}.json`), 1024 * 1024);
    if (text === null) return result("missing", "当前配置对应的官方登录凭据不存在。");
    let token: unknown;
    try { token = JSON.parse(text); }
    catch { return result("invalid", "本地官方凭据文件无法解析，请通过官方客户端重新登录。"); }
    if (!isRecord(token)
      || typeof token.access_token !== "string" || typeof token.refresh_token !== "string"
      || typeof token.scope !== "string" || typeof token.token_type !== "string"
      || typeof token.expires_at !== "number" || !Number.isFinite(token.expires_at) || token.expires_at < 0
      || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in < 0) {
      return result("invalid", "本地官方凭据结构不符合已验证格式，请通过官方客户端检查。");
    }
    if (token.access_token.length === 0) {
      if (token.refresh_token.length === 0 && token.expires_at === 0 && token.expires_in === 0) {
        return result("revoked", "官方客户端已记录凭据失效，需要重新登录。");
      }
      return result("invalid", "本地官方凭据缺少访问令牌，请通过官方客户端检查。");
    }
    if (token.expires_at <= (input.nowMs ?? Date.now()) / 1000) {
      return result("expired", "本地访问令牌已过期；是否可自动刷新须由官方客户端确认。");
    }
    return result("stored", "本地官方凭据已保存，尚未验证远端登录有效性。");
  } catch (error) {
    return error instanceof UnsafeLocalRecord
      ? result("unavailable", "凭据文件超出已验证读取范围，已停止读取。")
      : result("unavailable", "无法读取本地官方凭据；文件内容未返回或记录。");
  }
}
