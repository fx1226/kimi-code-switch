import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { WebApi, WebMethod } from "@shared/webApi";
import { guardRequest, isHostAllowed, isOriginAllowed } from "./auth";
import { createSseHub, type SseHub } from "./sse";
import { createStaticHandler, sendStaticResult } from "./static";
import { createApplicationApi } from "../application";
import { validateCall, ApiInputError } from "./validation";
import { serverVersion } from "../runtime";
import { sanitizePublicResult, toPublicError } from "./publicError";

// Backup JSON is itself carried in an RPC JSON string (up to 2x escaping).
const MAX_BODY_BYTES = 65 * 1024 * 1024;
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; chunks.length = 0; reject(new ApiInputError("BODY_TOO_LARGE", "Request body exceeds the limit")); return; }
      chunks.push(chunk);
    });
    req.once("error", reject);
    req.once("end", () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiInputError("INVALID_JSON", "Request body must be valid JSON")); }
    });
  });
}

export interface ServerAppOptions {
  port: number;
  token: string;
  distDir: string;
  distAvailable: boolean;
  instanceId?: string;
  /** Injectable typed application boundary for HTTP integration tests. */
  api?: WebApi;
}
export interface ServerApp { handler: RequestListener; sseHub: SseHub; close(): void; drain(): Promise<void> }

export function createServerApp(options: ServerAppOptions): ServerApp {
  const sseHub = createSseHub();
  const api = options.api ?? createApplicationApi();
  const staticHandler = createStaticHandler(options.distDir);
  let closing = false;
  const pending = new Set<Promise<void>>();
  const handler: RequestListener = (req, res) => {
    if (closing) { sendJson(res, 503, { ok: false, error: { code: "SERVICE_STOPPING", message: "The service is stopping" } }); return; }
    const task = (async () => {
      let method: WebMethod | undefined;
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port}`);
        if (!isHostAllowed(req.headers.host, options.port) || !isOriginAllowed(req.headers.origin, options.port)) {
          return sendJson(res, 403, { ok: false, error: { code: "ORIGIN_REJECTED", message: "Request origin or host is not allowed" } });
        }
        if (url.pathname === "/api/ping" && req.method === "GET") return sendJson(res, 200, { ok: true });
        if (url.pathname === "/api/version" && req.method === "GET") return sendJson(res, 200, { version: serverVersion });
        if (url.pathname.startsWith("/api/")) {
          const guard = guardRequest(req, options);
          if (!guard.ok) return sendJson(res, guard.status, { ok: false, error: { code: "AUTH_REQUIRED", message: guard.message } });
          if (url.pathname === "/api/instance" && req.method === "GET") {
            return sendJson(res, 200, { pid: process.pid, instanceId: options.instanceId });
          }
          const clientId = req.headers["x-client-id"];
          if (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) {
            return sendJson(res, 400, { ok: false, error: { code: "INVALID_CLIENT", message: "A per-tab client identifier is required" } });
          }
          if (url.pathname === "/api/events" && req.method === "GET") return sseHub.handleEventsRequest(res, clientId);
          if (url.pathname === "/api/call" && req.method === "POST") {
            if (!req.headers["content-type"]?.startsWith("application/json")) throw new ApiInputError("INVALID_CONTENT_TYPE", "Use application/json");
            const call = validateCall(await readBody(req));
            method = call.method;
            // Membership and each argument shape were checked against the explicit public contract.
            const result = await (api[method] as (input?: unknown) => Promise<unknown>)(call.input);
            return sendJson(res, 200, { ok: true, result: sanitizePublicResult(method, result) ?? null });
          }
          return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "API route not found" } });
        }
        if (req.method === "GET" || req.method === "HEAD") {
          const result = options.distAvailable ? staticHandler.resolve(url.pathname) : null;
          if (result) return sendStaticResult(res, result, req.method === "GET");
        }
        sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Web assets are unavailable" } });
      } catch (error) {
        if (res.headersSent) { res.end(); return; }
        sendJson(res, error instanceof ApiInputError ? 400 : 200, { ok: false, error: toPublicError(error, method) });
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  return { handler, sseHub, close: () => { closing = true; sseHub.close(); }, drain: async () => { await Promise.allSettled([...pending]); } };
}
