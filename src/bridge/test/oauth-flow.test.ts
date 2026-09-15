import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { startLoginFlow } from "../src/oauth-flow";
import { createMockUpstream, type MockUpstream } from "./mock-upstream";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe("oauth-flow", () => {
  let mock: MockUpstream | null = null;
  afterEach(async () => {
    await mock?.close();
    mock = null;
  });

  it("completes login via the callback URL with valid state", async () => {
    mock = await createMockUpstream();
    const port = await getFreePort();
    const handle = startLoginFlow({
      redirectPort: port,
      tokenEndpoint: mock.tokenUrl,
      issuer: mock.baseUrl,
    });
    const url = new URL(handle.authorizeUrl);
    const state = url.searchParams.get("state") ?? "";

    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=CODE123&state=${state}`);
    expect(callback.status).toBe(200);

    const tokens = await handle.done;
    expect(tokens.access_token).toBe("access-token-1");
    expect(tokens.account_id).toBe("acct_123");
    expect(tokens.refresh_token).toBe("refresh-token-1");
  });

  it("rejects a callback with a mismatched state", async () => {
    mock = await createMockUpstream();
    const port = await getFreePort();
    const handle = startLoginFlow({
      redirectPort: port,
      tokenEndpoint: mock.tokenUrl,
      issuer: mock.baseUrl,
      timeoutMs: 5000,
    });
    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=CODE123&state=WRONG`);
    expect(callback.status).toBe(200);
    await expect(handle.done).rejects.toThrow(/state/);
  });
});
