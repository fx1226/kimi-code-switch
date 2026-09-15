import { afterEach, describe, expect, it } from "vitest";

import { BridgeRuntime } from "../src/bridge";
import type { BridgeInstanceConfig, TokenSet } from "../src/types";
import { createMockUpstream, mockSseResponse, type MockUpstream } from "./mock-upstream";

interface Ctx {
  mock: MockUpstream;
  runtime: BridgeRuntime;
  baseUrl: string;
}

async function makeCtx(initialAuth: TokenSet | null, port = 0): Promise<Ctx> {
  const mock = await createMockUpstream();
  const config: BridgeInstanceConfig = {
    port,
    secret: "test-secret",
    stateDir: "/tmp/unused",
    logPath: "/tmp/unused/bridge.log",
    upstreamBase: mock.baseUrl,
    upstreamResponses: mock.responsesUrl,
    tokenEndpoint: mock.tokenUrl,
    issuer: mock.baseUrl,
    clientId: "test-client",
    modelsEndpoint: mock.modelsUrl,
  };
  const runtime = new BridgeRuntime({
    config,
    initialAuth,
    logger: () => undefined,
  });
  const { port: actualPort } = await runtime.start();
  return { mock, runtime, baseUrl: `http://127.0.0.1:${actualPort}` };
}

describe("bridge server", () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    await ctx?.runtime.stop().catch(() => undefined);
    await ctx?.mock.close().catch(() => undefined);
    ctx = null;
  });

  const signedIn = (): TokenSet => ({
    access_token: "access-token-1",
    refresh_token: "refresh-token-1",
    id_token:
      "eyJhbGciOiJub25lIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEyMyJ9.",
    account_id: "acct_123",
    expires_in: 3600,
    issued_at: new Date().toISOString(),
  });

  it("rejects requests without the bearer secret", async () => {
    ctx = await makeCtx(signedIn());
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-JSON content type", async () => {
    ctx = await makeCtx(signedIn());
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "text/plain",
      },
      body: "x",
    });
    expect(res.status).toBe(415);
  });

  it("returns 401 when not signed in", async () => {
    ctx = await makeCtx(null);
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("normalizes the body and streams frames back", async () => {
    ctx = await makeCtx(signedIn());
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi", stream: true, max_output_tokens: 999 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("hello");

    const sent = ctx.mock.responsesRequests[0];
    const body = sent.body as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(sent.headers.authorization).toBe("Bearer access-token-1");
    expect(sent.headers["chatgpt-account-id"]).toBe("acct_123");
  });

  it("refreshes once on 401 and retries, then streams", async () => {
    ctx = await makeCtx(signedIn());
    let call = 0;
    ctx.mock.setResponses(async () => {
      call += 1;
      if (call === 1) return { status: 401, body: { error: { message: "expired" } } };
      return mockSseResponse(
        { type: "response.created", response: { id: "resp_mock", model: "gpt-mock-pro" } },
        {
          type: "response.completed",
          response: {
            id: "resp_mock",
            model: "gpt-mock-pro",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "retried" }] }],
          },
        },
      );
    });
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi", stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.completed");
    // 第一次用旧 token，刷新后重试用新 token。
    expect(ctx.mock.responsesRequests[0].headers.authorization).toBe("Bearer access-token-1");
    expect(ctx.mock.responsesRequests[1].headers.authorization).toBe("Bearer refreshed-access-token");
    // 刷新确实发生了（用了 refresh_token grant）。
    expect(ctx.mock.tokenRequests.some((r) => r.grant_type === "refresh_token")).toBe(true);
  });

  it("aggregates a non-stream request into a single JSON response", async () => {
    ctx = await makeCtx(signedIn());
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi", stream: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = (await res.json()) as { output: unknown[] };
    expect(data.output).toBeDefined();
  });

  it("propagates upstream errors (429) without looping", async () => {
    ctx = await makeCtx(signedIn());
    ctx.mock.setResponses(async () => ({ status: 429, body: { error: { message: "quota", type: "usage_limit_reached" } } }));
    const res = await fetch(`${ctx.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi" }),
    });
    expect(res.status).toBe(429);
    expect(ctx.mock.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(0);
  });

  it("lists models from the account catalog", async () => {
    ctx = await makeCtx(signedIn());
    await ctx.runtime.refreshModels().catch(() => undefined);
    const res = await fetch(`${ctx.baseUrl}/v1/models`, {
      headers: { authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.data.map((m) => m.id)).toEqual(["gpt-mock-pro", "gpt-mock-lite"]);
  });
});
