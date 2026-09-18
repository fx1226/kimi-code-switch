import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeLaunchToken, createWebApi } from "./webApi";

describe("browser HTTP client", () => {
  beforeEach(() => { sessionStorage.clear(); history.replaceState(null, "", "/"); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("consumes launch credentials without leaving them in the address bar", () => {
    history.replaceState(null, "", "/?view=config#token=local-fixture&section=one");
    expect(consumeLaunchToken()).toBe("local-fixture");
    expect(location.hash).toBe("#section=one");
    expect(location.search).toBe("?view=config");
    expect(consumeLaunchToken()).toBe("local-fixture");
  });
  it("does not call an unauthenticated API or fabricate defaults", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(createWebApi().bootstrap()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps an uncertain apply single-shot and permits explicit result lookup", async () => {
    sessionStorage.setItem("kimi-code-switch-token", "local-fixture");
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { id: "plan-id", status: "succeeded" } })));
    vi.stubGlobal("fetch", fetcher);
    const api = createWebApi();
    await expect(api.applyChange({ targetId: "default", planId: "plan-id", expectedRevision: "revision" })).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await api.getOperation({ id: "plan-id" })).toMatchObject({ status: "succeeded" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const requests = fetcher.mock.calls.map(([, options]) => ({ body: JSON.parse(options.body), headers: options.headers }));
    expect(requests.map(request => request.body.method)).toEqual(["applyChange", "getOperation"]);
    expect(requests[0].headers["x-client-id"]).toBe(requests[1].headers["x-client-id"]);
  });
  it("distinguishes an expired credential from transport loss", async () => {
    sessionStorage.setItem("kimi-code-switch-token", "expired");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    await expect(createWebApi().bootstrap()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
