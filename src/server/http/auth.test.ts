import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthToken, extractBearerToken, guardRequest, isHostAllowed, isOriginAllowed, verifyBearerToken } from "./auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createAuthToken", () => {
  it("generates at least 43 url-safe random characters", () => {
    for (let i = 0; i < 10; i += 1) {
      const token = createAuthToken();
      expect(token.length).toBeGreaterThanOrEqual(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("generates a different token on each call", () => {
    expect(createAuthToken()).not.toBe(createAuthToken());
  });
});

describe("verifyBearerToken", () => {
  const token = createAuthToken();

  it("accepts the exact bearer token", () => {
    expect(verifyBearerToken(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects missing header, wrong scheme, and wrong token", () => {
    expect(verifyBearerToken(undefined, token)).toBe(false);
    expect(verifyBearerToken(token, token)).toBe(false);
    expect(verifyBearerToken(`Basic ${token}`, token)).toBe(false);
    expect(verifyBearerToken(`Bearer ${token}x`, token)).toBe(false);
    expect(verifyBearerToken(`Bearer ${token.slice(0, -1)}`, token)).toBe(false);
    expect(verifyBearerToken("Bearer ", token)).toBe(false);
  });
});

describe("isHostAllowed", () => {
  it("allows only 127.0.0.1:port and localhost:port", () => {
    expect(isHostAllowed("127.0.0.1:8417", 8417)).toBe(true);
    expect(isHostAllowed("localhost:8417", 8417)).toBe(true);
    expect(isHostAllowed("LOCALHOST:8417", 8417)).toBe(true);
  });

  it("rejects other hosts, ports, and missing header", () => {
    expect(isHostAllowed("evil.example:8417", 8417)).toBe(false);
    expect(isHostAllowed("127.0.0.1:9999", 8417)).toBe(false);
    expect(isHostAllowed("localhost", 8417)).toBe(false);
    expect(isHostAllowed("[::1]:8417", 8417)).toBe(false);
    expect(isHostAllowed(undefined, 8417)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("allows missing origin (non-browser clients)", () => {
    expect(isOriginAllowed(undefined, 8417)).toBe(true);
    expect(isOriginAllowed("", 8417)).toBe(true);
  });

  it("allows same-origin loopback origins", () => {
    expect(isOriginAllowed("http://127.0.0.1:8417", 8417)).toBe(true);
    expect(isOriginAllowed("http://localhost:8417", 8417)).toBe(true);
  });

  it("rejects cross-origin and mismatched-port origins", () => {
    expect(isOriginAllowed("https://evil.example", 8417)).toBe(false);
    expect(isOriginAllowed("http://evil.example:8417", 8417)).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1:9999", 8417)).toBe(false);
    expect(isOriginAllowed("null", 8417)).toBe(false);
  });
});

describe("extractBearerToken", () => {
  it("returns the raw token for Bearer headers and null otherwise", () => {
    expect(extractBearerToken("Bearer abc-123")).toBe("abc-123");
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull(); // 空 token 形状不合法，交由 verifyBearerToken 把关
  });
});

describe("dev origin allowance (KIMI_DEV_ORIGINS)", () => {
  it("stays strict without the env var", () => {
    expect(isHostAllowed("localhost:1420", 8417)).toBe(false);
    expect(isOriginAllowed("http://localhost:1420", 8417)).toBe(false);
  });

  it("allows declared dev hosts and origins when the env var is set", () => {
    vi.stubEnv("KIMI_DEV_ORIGINS", "http://localhost:1420, 127.0.0.1:1420");

    expect(isHostAllowed("localhost:1420", 8417)).toBe(true);
    expect(isHostAllowed("127.0.0.1:1420", 8417)).toBe(true);
    expect(isHostAllowed("localhost:9999", 8417)).toBe(false);
    expect(isOriginAllowed("http://localhost:1420", 8417)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:1420", 8417)).toBe(true);
    expect(isOriginAllowed("http://evil.example:1420", 8417)).toBe(false);
    // 生产端口白名单在 dev 模式下仍然有效。
    expect(isHostAllowed("127.0.0.1:8417", 8417)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:8417", 8417)).toBe(true);
  });

  it("lets guardRequest pass for an authorized dev-origin request", () => {
    vi.stubEnv("KIMI_DEV_ORIGINS", "http://localhost:1420");
    const token = createAuthToken();
    const request = { headers: {
      host: "localhost:1420",
      origin: "http://localhost:1420",
      authorization: `Bearer ${token}`,
    } } as Parameters<typeof guardRequest>[0];
    expect(guardRequest(request, { port: 8417, token })).toEqual({ ok: true });
  });
});

describe("guardRequest", () => {
  const token = createAuthToken();
  const options = { port: 8417, token };

  const request = (headers: Record<string, string>): Parameters<typeof guardRequest>[0] =>
    ({ headers }) as Parameters<typeof guardRequest>[0];

  it("passes with loopback host, no origin, and valid bearer token", () => {
    expect(guardRequest(request({ host: "127.0.0.1:8417", authorization: `Bearer ${token}` }), options)).toEqual({ ok: true });
  });

  it("returns 403 before auth when host is not allowed", () => {
    expect(guardRequest(request({ host: "evil.example", authorization: `Bearer ${token}` }), options)).toEqual({
      ok: false,
      status: 403,
      message: "host not allowed",
    });
  });

  it("returns 403 when origin is cross-origin", () => {
    expect(guardRequest(request({
      host: "localhost:8417",
      origin: "https://evil.example",
      authorization: `Bearer ${token}`,
    }), options)).toEqual({ ok: false, status: 403, message: "origin not allowed" });
  });

  it("returns 401 when the bearer token is missing or invalid", () => {
    expect(guardRequest(request({ host: "127.0.0.1:8417" }), options)).toEqual({
      ok: false,
      status: 401,
      message: "missing or invalid bearer token",
    });
    expect(guardRequest(request({ host: "127.0.0.1:8417", authorization: "Bearer wrong" }), options)).toEqual({
      ok: false,
      status: 401,
      message: "missing or invalid bearer token",
    });
  });
});
