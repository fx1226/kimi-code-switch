/**
 * Upstream：调用 ChatGPT Codex 订阅后端。
 * - 注入 OAuth 请求头与账号头。
 * - 401 时单飞刷新一次并重试一次（未向下游输出内容时）。
 * - 将上游错误归一化为 UpstreamErrorInfo，识别额度类错误与恢复时间。
 */
import type { BridgeInstanceConfig, TokenSet, UpstreamErrorInfo } from "./types";
import { refreshTokens } from "./pkce";

const USAGE_LIMIT_TYPES = new Set([
  "usage_limit_reached",
  "usage_not_included",
  "rate_limit_exceeded",
  "quota_exceeded",
]);

export interface UpstreamDeps {
  fetchImpl?: typeof fetch;
  refreshImpl?: (refreshToken: string) => Promise<TokenSet>;
  now?: () => number;
}

export function upstreamHeaders(config: BridgeInstanceConfig, tokens: TokenSet): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id ?? "",
    "content-type": "application/json",
    accept: "text/event-stream",
    "openai-beta": "responses=experimental",
    originator: "kimi-code-switch-gui",
    "user-agent": "kimi-code-switch-gui-bridge (chatgpt subscription)",
  };
}

export async function upstreamErrorInfo(response: Response): Promise<UpstreamErrorInfo> {
  const status = response.status;
  let data: unknown = null;
  const text = await response.text().catch(() => "");
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON（如拦截页），沿用文本
  }
  const record = (data ?? {}) as Record<string, unknown>;
  const error = (record.error ?? {}) as Record<string, unknown>;
  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof record.message === "string" && record.message) ||
    (typeof record.detail === "string" && record.detail) ||
    text ||
    `HTTP ${status}`;
  const type = typeof error.type === "string" ? error.type : undefined;
  const code = typeof error.code === "string" ? error.code : undefined;
  const planType = typeof record.plan_type === "string" ? record.plan_type : undefined;
  const rawResets = error.resets_at ?? record.resets_at;
  const resetsAt =
    typeof rawResets === "number" && Number.isFinite(rawResets) ? rawResets : undefined;
  const isLimit =
    status === 429 || (type !== undefined && USAGE_LIMIT_TYPES.has(type)) ||
    (code !== undefined && USAGE_LIMIT_TYPES.has(code));
  return {
    status,
    message: message.slice(0, 1000),
    type,
    code,
    resetsAt: isLimit ? resetsAt : undefined,
    planType: isLimit ? planType : undefined,
  };
}

export interface UpstreamCall {
  response: Response;
  tokensUsed: TokenSet;
}

/**
 * 发送一次 Responses 请求；遇到 401 时刷新并重试一次。
 * 注意：调用方负责确认在“尚未向下游输出内容”时调用，避免已开始流式输出后重放。
 */
export async function callUpstream(
  config: BridgeInstanceConfig,
  tokens: TokenSet,
  body: unknown,
  deps: UpstreamDeps = {},
): Promise<UpstreamCall> {
  const doFetch = deps.fetchImpl ?? fetch;
  const doRefresh =
    deps.refreshImpl ??
    ((refreshToken: string) =>
      refreshTokens({
        refreshToken,
        tokenEndpoint: config.tokenEndpoint,
        clientId: config.clientId,
        fetchImpl: doFetch,
      }));

  const send = (auth: TokenSet): Promise<Response> =>
    doFetch(config.upstreamResponses, {
      method: "POST",
      headers: upstreamHeaders(config, auth),
      body: JSON.stringify(body),
    });

  let auth = tokens;
  let response = await send(auth);
  if (response.status === 401 && auth.refresh_token) {
    auth = await doRefresh(auth.refresh_token);
    response = await send(auth);
  }
  return { response, tokensUsed: auth };
}
