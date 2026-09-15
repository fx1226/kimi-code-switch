import { describe, expect, it } from "vitest";

import { fetchModelCatalog } from "../src/models";
import type { BridgeInstanceConfig, TokenSet } from "../src/types";

const config: BridgeInstanceConfig = {
  port: 8317,
  secret: "s",
  stateDir: "/tmp",
  logPath: "/tmp/bridge.log",
  upstreamBase: "https://example.invalid",
  upstreamResponses: "https://example.invalid/codex/responses",
  tokenEndpoint: "https://example.invalid/oauth/token",
  issuer: "https://example.invalid",
  clientId: "c",
  modelsEndpoint: "https://example.invalid/codex/models",
};

const tokens: TokenSet = { access_token: "at" };

const jsonFetch = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("fetchModelCatalog wire shape", () => {
  it("uses snake_case fetched_at so the Rust host can parse the catalog", async () => {
    const catalog = await fetchModelCatalog(config, tokens, {
      fetchImpl: jsonFetch({ models: [{ slug: "gpt-5.5" }] }),
      now: () => 123,
    });
    expect(catalog.fetched_at).toBe(123);
    expect("fetchedAt" in catalog).toBe(false);
    expect(catalog.models[0]?.slug).toBe("gpt-5.5");
  });

  it("fallback catalog keeps the same fetched_at contract", async () => {
    const catalog = await fetchModelCatalog(config, tokens, {
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      now: () => 456,
    });
    expect(catalog.fetched_at).toBe(456);
    expect("fetchedAt" in catalog).toBe(false);
    expect(catalog.live).toBe(false);
  });
});
