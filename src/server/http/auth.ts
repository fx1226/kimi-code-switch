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

/** 提取 Authorization: Bearer <token> 中的 token 原文（非 Bearer 或缺失时返回 null）。 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  const match = /^Bearer (.+)$/.exec(authorizationHeader ?? "");
  return match ? match[1] : null;
}

interface DevOrigin {
  origin: string;
  host: string;
}

/** 开发联调白名单：KIMI_DEV_ORIGINS（逗号分隔的 origin，如 http://localhost:1420），仅显式设置时生效，生产保持严格。 */
function readDevOrigins(): readonly DevOrigin[] {
  const raw = process.env.KIMI_DEV_ORIGINS;
  if (!raw) return [];
  const devOrigins: DevOrigin[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (!candidate) continue;
    try {
      const url = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
      devOrigins.push({ origin: url.origin, host: url.host });
    } catch {
      // 无法解析的条目忽略，保持默认严格校验。
    }
  }
  return devOrigins;
}

/** Host 白名单：127.0.0.1:port | localhost:port，以及 KIMI_DEV_ORIGINS 声明的 dev host（防 DNS rebinding）。 */
export function isHostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}`
    || host === `localhost:${port}`
    || readDevOrigins().some((dev) => dev.host === host);
}

/** Origin 若存在必须同源；非浏览器客户端（curl 等）不带 Origin，放行。 */
export function isOriginAllowed(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  const origin = originHeader.trim().toLowerCase().replace(/\/+$/, "");
  return origin === `http://127.0.0.1:${port}`
    || origin === `http://localhost:${port}`
    || readDevOrigins().some((dev) => dev.origin === origin);
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
