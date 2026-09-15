/**
 * Server：仅监听 127.0.0.1 的 OpenAI-compatible HTTP 服务。
 * 只提供 POST /v1/responses 与 GET /v1/models，随机 bearer 鉴权。
 * 健康/管理动作走控制通道，不开放 HTTP 管理后台。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import type { BridgeInstanceConfig, ModelCatalog, TokenSet, UpstreamErrorInfo } from "./types";
import { callUpstream, upstreamErrorInfo } from "./upstream";
import { collectResponseObject, isTerminalFrame, normalizeBody, splitSseFrames } from "./proxy";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface BridgeServerOptions {
  config: BridgeInstanceConfig;
  /** 返回当前有效凭据；forceRefresh 强制刷新（单飞由 TokenManager 保证）。null 表示未登录。 */
  getAuth: (forceRefresh?: boolean) => Promise<TokenSet | null>;
  getCatalog: () => ModelCatalog | null;
  refreshCatalog?: () => Promise<ModelCatalog>;
  fetchImpl?: typeof fetch;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        fail(new Error("request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    };
    const onError = (err: Error) => fail(err);
    const onAborted = () => fail(new Error("request aborted"));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: error instanceof Error ? error.message : "invalid request body" },
    });
  }

  const tokens = await options.getAuth();
  if (!tokens) {
    return sendJson(res, 401, { error: { message: "not signed in to ChatGPT" } });
  }

  const { body: upstreamBody } = normalizeBody(body);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);

  try {
    const { response, tokensUsed } = await callUpstream(
      options.config,
      tokens,
      upstreamBody,
      {
        fetchImpl: options.fetchImpl,
        refreshImpl: tokens.refresh_token
          ? async () => {
              // 复用宿主统一刷新（TokenManager 单飞 + 持久化）。
              const refreshed = await options.getAuth(true);
              if (!refreshed) throw new Error("refresh unavailable");
              return refreshed;
            }
          : undefined,
      },
    );
    void tokensUsed;

    if (!response.ok) {
      const info = await upstreamErrorInfo(response);
      res.writeHead(info.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: info.message, type: info.type, code: info.code } }));
      return;
    }

    const requestedStream = (body as Record<string, unknown>)?.stream === true;
    if (requestedStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const reader = response.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      let buffer = "";
      let sawTerminal = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += Buffer.from(value).toString("utf8");
          const { frames, rest } = splitSseFrames(buffer);
          buffer = rest;
          for (const frame of frames) {
            if (isTerminalFrame(frame)) sawTerminal = true;
            if (res.destroyed || res.writableEnded) return;
            res.write(frame);
          }
        }
        if (!sawTerminal && !res.destroyed) {
          sendSseError(res, new Error("upstream stream ended before a terminal event"));
        }
        res.end();
      } catch (error) {
        if (!res.destroyed) sendSseError(res, error instanceof Error ? error : new Error(String(error)));
        res.end();
      }
      return;
    }

    const { response: collected } = await collectResponseObject(response, controller.signal);
    sendJson(res, 200, collected);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: error instanceof Error ? error.message : "upstream error" },
      });
    } else if (!res.destroyed) {
      sendSseError(res, error instanceof Error ? error : new Error(String(error)));
      res.end();
    }
  }
}

function sendSseError(res: ServerResponse, error: Error): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ type: "error", message: error.message })}\n\n`);
}

function isAuthorized(req: IncomingMessage, secret: string): boolean {
  return req.headers.authorization === `Bearer ${secret}`;
}

function handleModels(res: ServerResponse, options: BridgeServerOptions): void {
  const catalog = options.getCatalog();
  const models = catalog?.models ?? [];
  sendJson(res, 200, {
    object: "list",
    live: catalog?.live ?? false,
    data: models.map((m) => ({
      id: m.slug,
      object: "model",
      created: 0,
      owned_by: "chatgpt-subscription",
    })),
  });
}

export function createBridgeServer(options: BridgeServerOptions): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.config.port}`);
    try {
      if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
        if (!isAuthorized(req, options.config.secret)) {
          return sendJson(res, 401, { error: { message: "invalid bearer token" } });
        }
        const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          return sendJson(res, 415, { error: { message: "content-type must be application/json" } });
        }
        return await handleResponses(req, res, options);
      }
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        if (!isAuthorized(req, options.config.secret)) {
          return sendJson(res, 401, { error: { message: "invalid bearer token" } });
        }
        if (options.refreshCatalog) {
          void options.refreshCatalog().catch(() => undefined);
        }
        return handleModels(res, options);
      }
      sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { message: error instanceof Error ? error.message : "internal error" },
        });
      } else if (!res.destroyed) {
        res.end();
      }
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  return server;
}
