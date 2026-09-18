// HTTP 路由：/api/ping、/api/version、/api/call、/api/events 与静态资源。
// 注意："../runtime" 必须先于 kimiSwitch 链 import（window shim 先就位）。
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { serverVersion } from "../runtime";
// kimiSwitch 适配层依赖 window shim，必须排在 "../runtime" 之后加载。
import { kimiSwitchTauri } from "../../renderer/src/tauri/kimiSwitch";
import { guardRequest } from "./auth";
import { createSseHub, type SseHub } from "./sse";
import { createStaticHandler, sendStaticResult } from "./static";

const MAX_CALL_BODY_BYTES = 32 * 1024 * 1024;

/** args 深层扫描命中的事件回调标记；服务端把它替换为向 callId 的 SSE 流发帧的函数。 */
interface OnEventMarker {
  __onEvent: true;
  callId: string;
}

type CallEventHandler = (callId: string, event: unknown) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOnEventMarker(value: Record<string, unknown>): OnEventMarker | null {
  if (value.__onEvent !== true) return null;
  if (typeof value.callId !== "string" || !value.callId) return null;
  return { __onEvent: true, callId: value.callId };
}

/** 深扫描 args（数组/普通对象递归），把 {__onEvent:true,callId} 标记替换为事件回调。 */
function hydrateEventArgs(args: readonly unknown[], onEvent: CallEventHandler): unknown[] {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isPlainObject(value)) return value;
    const marker = readOnEventMarker(value);
    if (marker) {
      return (event: unknown): void => onEvent(marker.callId, event);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  };
  return args.map(visit);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
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
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_CALL_BODY_BYTES) {
        fail(new Error("request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => fail(error);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

// method 白名单：kimiSwitchTauri 上类型为 function 的成员。
const callMethodWhitelist = new Set(
  Object.entries(kimiSwitchTauri)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name),
);

export interface ServerAppOptions {
  port: number;
  token: string;
  /** Vite 产物目录（仓库 dist/）。 */
  distDir: string;
  /** dist 是否存在；缺失时由启动方打 warning，路由照常回落 404。 */
  distAvailable: boolean;
}

export interface ServerApp {
  handler: RequestListener;
  sseHub: SseHub;
  close(): void;
}

async function handleCall(req: IncomingMessage, res: ServerResponse, options: ServerAppOptions, sseHub: SseHub): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "invalid request body" });
  }
  if (!isPlainObject(body)) {
    return sendJson(res, 400, { ok: false, error: "request body must be a JSON object" });
  }
  const { method, args } = body;
  if (typeof method !== "string" || !method) {
    return sendJson(res, 200, { ok: false, error: "method must be a non-empty string" });
  }
  if (args !== undefined && !Array.isArray(args)) {
    return sendJson(res, 200, { ok: false, error: "args must be an array" });
  }
  if (!callMethodWhitelist.has(method)) {
    return sendJson(res, 200, { ok: false, error: `unknown method: ${method}` });
  }

  const handler = (kimiSwitchTauri as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[method];
  const hydratedArgs = hydrateEventArgs(args ?? [], (callId, event) => sseHub.sendCallEvent(callId, event));
  try {
    const result = await handler(...hydratedArgs);
    return sendJson(res, 200, { ok: true, result });
  } catch (error) {
    // 业务异常约定为 HTTP 200 + ok:false，与契约一致。
    return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function createServerApp(options: ServerAppOptions): ServerApp {
  const sseHub = createSseHub();
  const staticHandler = createStaticHandler(options.distDir);
  const handler: RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port}`);
      try {
        if (url.pathname === "/api/ping" && req.method === "GET") {
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === "/api/version" && req.method === "GET") {
          return sendJson(res, 200, { version: serverVersion });
        }
        if (url.pathname === "/api/call" && req.method === "POST") {
          const guard = guardRequest(req, options);
          if (!guard.ok) return sendJson(res, guard.status, { ok: false, error: guard.message });
          return await handleCall(req, res, options, sseHub);
        }
        if (url.pathname === "/api/events" && req.method === "GET") {
          const guard = guardRequest(req, options);
          if (!guard.ok) return sendJson(res, guard.status, { ok: false, error: guard.message });
          return sseHub.handleEventsRequest(res);
        }
        if (url.pathname.startsWith("/api/")) {
          return sendJson(res, 404, { ok: false, error: `not found: ${req.method} ${url.pathname}` });
        }
        if (req.method === "GET" || req.method === "HEAD") {
          const result = options.distAvailable ? staticHandler.resolve(url.pathname) : null;
          if (result) return sendStaticResult(res, result, req.method === "GET");
          return sendJson(res, 404, { ok: false, error: "dist assets are not available; run npm run build:web" });
        }
        return sendJson(res, 404, { ok: false, error: `not found: ${req.method} ${url.pathname}` });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "internal error" });
        } else if (!res.destroyed) {
          res.end();
        }
      }
    })();
  };
  return {
    handler,
    sseHub,
    close(): void {
      sseHub.close();
    },
  };
}
