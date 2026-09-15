/**
 * OAuth 登录流程：本地回调服务器 + PKCE。
 * 参考 OpenCode CodexAuthPlugin 的回调路径（/auth/callback）。
 * 仅监听 127.0.0.1；state 校验后才交换授权码。
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { buildAuthorizeUrl, exchangeCodeForTokens, generatePkce } from "./pkce";
import type { TokenSet } from "./types";

export interface LoginFlowOptions {
  redirectPort: number;
  clientId?: string;
  issuer?: string;
  tokenEndpoint?: string;
  fetchImpl?: typeof fetch;
  /** 等待用户完成浏览器授权的最长时间。 */
  timeoutMs?: number;
  originator?: string;
}

export interface LoginFlowHandle {
  authorizeUrl: string;
  done: Promise<TokenSet>;
  cancel: () => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function htmlPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;padding:48px;max-width:560px">
<h1>${title}</h1><p>${message}</p></body></html>`;
}

export function startLoginFlow(options: LoginFlowOptions): LoginFlowHandle {
  const pkce = generatePkce();
  const state = randomUUID();
  const redirectUri = `http://localhost:${options.redirectPort}/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    redirectUri,
    pkce,
    state,
    clientId: options.clientId,
    issuer: options.issuer,
    originator: options.originator,
  });

  let server: Server | null = null;
  let settled = false;

  const done = new Promise<TokenSet>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error("OAuth login timed out"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();
    const finish = (error: Error | null, tokens?: TokenSet): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server?.close();
      if (error) reject(error);
      else resolve(tokens!);
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${options.redirectPort}`);
      if (req.method !== "GET" || url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("登录失败", `授权服务返回错误：${error}`));
        finish(new Error(`OAuth authorization error: ${error}`));
        return;
      }
      const code = url.searchParams.get("code");
      const receivedState = url.searchParams.get("state");
      if (!code || receivedState !== state) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("登录失败", "回调缺少授权码或 state 不匹配，请重新登录。"));
        finish(new Error("OAuth callback failed state/code validation"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlPage("登录成功", "已获取登录凭据，可以关闭此窗口并返回应用。"));
      void exchangeCodeForTokens({
        code,
        redirectUri,
        pkce,
        tokenEndpoint: options.tokenEndpoint,
        clientId: options.clientId,
        fetchImpl: options.fetchImpl,
      }).then(
        (tokens) => finish(null, tokens),
        (error) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });

    server.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    server.listen(options.redirectPort, "127.0.0.1");
  });

  // 抑制“回调先于调用方 attach handler”时的 unhandled-rejection 噪音；
  // 调用方 await handle.done 仍能正常收到拒绝。
  void done.catch(() => undefined);

  return {
    authorizeUrl,
    done,
    cancel: () => {
      // 未完成时触发关闭；Promise 本身由 done 的调用方处理。
      server?.close();
    },
  };
}
