// 鉴权与请求来源校验：随机 bearer token、Host 白名单、Origin 同源检查。
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 32 字节 base64url 恰好 43 个随机字符，满足 43+ 要求。 */
export function createAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 校验 Authorization: Bearer <token>（常数时间比较，避免时序侧信道）。 */
export function verifyBearerToken(authorizationHeader: string | undefined, expected: string): boolean {
  const match = /^Bearer (.+)$/.exec(authorizationHeader ?? "");
  if (!match) return false;
  const presented = Buffer.from(match[1], "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return presented.length === expectedBuffer.length && timingSafeEqual(presented, expectedBuffer);
}

/** Host 白名单：仅允许 127.0.0.1:port | localhost:port（防 DNS rebinding）。 */
export function isHostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Origin 若存在必须同源；非浏览器客户端（curl 等）不带 Origin，放行。 */
export function isOriginAllowed(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  const origin = originHeader.trim().toLowerCase().replace(/\/+$/, "");
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export type RequestGuardResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

/** 受保护路由（/api/call、/api/events）的统一入口校验。 */
export function guardRequest(req: IncomingMessage, options: { port: number; token: string }): RequestGuardResult {
  if (!isHostAllowed(req.headers.host, options.port)) {
    return { ok: false, status: 403, message: "host not allowed" };
  }
  if (!isOriginAllowed(req.headers.origin, options.port)) {
    return { ok: false, status: 403, message: "origin not allowed" };
  }
  if (!verifyBearerToken(req.headers.authorization, options.token)) {
    return { ok: false, status: 401, message: "missing or invalid bearer token" };
  }
  return { ok: true };
}
