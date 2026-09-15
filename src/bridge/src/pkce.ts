/**
 * PKCE（S256）工具：verifier / challenge 生成与 base64url。
 * 常量取自 OpenCode CodexAuthPlugin（e03db9bc）的 OAuth 实现。
 */
import { createHash, randomBytes } from "node:crypto";

import type { TokenSet } from "./types";

export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OAUTH_ISSUER = "https://auth.openai.com";
export const OAUTH_SCOPE = "openid profile email offline_access";

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

export function base64UrlEncode(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): PkceCodes {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** 构造 ChatGPT 授权地址（PKCE + state）。 */
export function buildAuthorizeUrl(options: {
  redirectUri: string;
  pkce: PkceCodes;
  state: string;
  clientId?: string;
  issuer?: string;
  originator?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId ?? OAUTH_CLIENT_ID,
    redirect_uri: options.redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: options.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: options.originator ?? "kimi-code-switch-gui",
  });
  return `${options.issuer ?? OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

/** 用授权码换 token（form-encoded POST）。 */
export async function exchangeCodeForTokens(options: {
  code: string;
  redirectUri: string;
  pkce: PkceCodes;
  tokenEndpoint?: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(options.tokenEndpoint ?? `${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId ?? OAUTH_CLIENT_ID,
      code_verifier: options.pkce.verifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status}`);
  }
  return toTokenSet(await response.json());
}

/** 用 refresh_token 换取新 token。 */
export async function refreshTokens(options: {
  refreshToken: string;
  tokenEndpoint?: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(options.tokenEndpoint ?? `${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId ?? OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`token refresh failed: HTTP ${response.status}`);
  }
  return toTokenSet(await response.json());
}

/** 把 OAuth 原始响应规整为 TokenSet。 */
export function toTokenSet(raw: unknown): TokenSet {
  const record = (raw ?? {}) as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new Error("token response missing access_token");
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : undefined;
  return {
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    id_token: typeof record.id_token === "string" ? record.id_token : undefined,
    expires_in: expiresIn,
    account_id: extractAccountId(record),
    issued_at: new Date().toISOString(),
  };
}

interface JwtClaims {
  chatgpt_account_id?: string;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
  exp?: number;
}

/** 解析 JWT 负载（不校验签名，仅用于取声明）。 */
export function parseJwtClaims(token: string): JwtClaims | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload) as JwtClaims;
  } catch {
    return undefined;
  }
}

/** 从 token 响应中提取 account id（id_token 优先，其次 access_token）。 */
export function extractAccountId(record: Record<string, unknown>): string | undefined {
  for (const key of ["id_token", "access_token"]) {
    const token = record[key];
    if (typeof token !== "string") continue;
    const claims = parseJwtClaims(token);
    if (!claims) continue;
    const id =
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (id) return id;
  }
  return undefined;
}
