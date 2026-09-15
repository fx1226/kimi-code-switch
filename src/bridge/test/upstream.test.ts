import { afterEach, describe, expect, it } from "vitest";

import { createMockUpstream, type MockUpstream } from "./mock-upstream";
import { upstreamErrorInfo } from "../src/upstream";

describe("upstream", () => {
  let mock: MockUpstream | null = null;
  afterEach(async () => {
    await mock?.close();
    mock = null;
  });

  it("normalizes usage-limit errors with reset time", async () => {
    const response = new Response(
      JSON.stringify({
        error: { type: "usage_limit_reached", message: "out of quota" },
        plan_type: "plus",
        resets_at: 1750000000,
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const info = await upstreamErrorInfo(response);
    expect(info.status).toBe(429);
    expect(info.type).toBe("usage_limit_reached");
    expect(info.planType).toBe("plus");
    expect(info.resetsAt).toBe(1750000000);
  });

  it("falls back to text body on non-JSON upstream error", async () => {
    const response = new Response("cloudflare page", { status: 502 });
    const info = await upstreamErrorInfo(response);
    expect(info.status).toBe(502);
    expect(info.message).toContain("cloudflare");
  });

  it("reaches the loopback mock models endpoint", async () => {
    mock = await createMockUpstream();
    const res = await fetch(mock.modelsUrl);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { models: unknown[] };
    expect(data.models.length).toBeGreaterThan(0);
  });
});
