import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { WebApi } from "@shared/webApi";
import { createServerApp, type ServerApp } from "./routes";

const TOKEN = "test-token-123";
const headers = { Authorization: `Bearer ${TOKEN}`, "x-client-id": "test-tab-1", "Content-Type": "application/json" };
describe("typed HTTP boundary", () => {
  let server: Server; let app: ServerApp; let url: string;
  const bootstrap = vi.fn(async () => ({ product: "Kimi Code Switch" }));
  const savePreferences = vi.fn(async () => ({ theme: "dark" }));
  const testMcp = vi.fn();
  beforeEach(async () => {
    bootstrap.mockReset().mockResolvedValue({ product: "Kimi Code Switch" });
    savePreferences.mockReset().mockResolvedValue({ theme: "dark" });
    testMcp.mockReset();
    let port = 0;
    app = createServerApp({ get port() { return port; }, token: TOKEN, distDir: "/absent", distAvailable: false, instanceId: "test-instance", api: { bootstrap, savePreferences, testMcp } as unknown as WebApi });
    server = createServer(app.handler);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
    port = address.port; url = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => { app.close(); await app.drain(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const post = (body: unknown, customHeaders = headers) => fetch(`${url}/api/call`, { method: "POST", headers: customHeaders, body: JSON.stringify(body) });
  it("serves liveness publicly but guards identity and business calls", async () => {
    expect((await fetch(`${url}/api/ping`)).status).toBe(200);
    expect((await fetch(`${url}/api/instance`)).status).toBe(401);
    expect((await post({ method: "bootstrap" }, { ...headers, Authorization: "" })).status).toBe(401);
    const identity = await fetch(`${url}/api/instance`, { headers });
    expect(await identity.json()).toEqual({ pid: process.pid, instanceId: "test-instance" });
    expect(bootstrap).not.toHaveBeenCalled();
  });
  it("rejects foreign origins and requires per-tab identity", async () => {
    expect((await post({ method: "bootstrap" }, { ...headers, "x-client-id": "" })).status).toBe(400);
    expect((await fetch(`${url}/api/ping`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });
  it("never exposes prototype methods or malformed calls", async () => {
    for (const body of [{ method: "constructor" }, { method: "toString" }, { method: "loadState" }, { method: "bootstrap", args: [] }, { method: "savePreferences", input: { theme: "aurora" } }, { method: "planChange", input: { targetId: "default", resource: "config", expectedRevision: "", changes: [{ op: "set", path: ["__proto__"], value: true }] } }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(bootstrap).not.toHaveBeenCalled(); expect(savePreferences).not.toHaveBeenCalled();
  });
  it("dispatches an explicitly validated async method", async () => {
    const result = await post({ method: "savePreferences", input: { theme: "dark" } });
    expect(await result.json()).toEqual({ ok: true, result: { theme: "dark" } });
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
  });
  it("keeps raw provider errors and arbitrary codes out of responses and logs", async () => {
    const secret = "sensitive-provider-value-8b7d";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      testMcp.mockRejectedValue(Object.assign(new Error(`Authorization: Bearer ${secret}; MCP JSON-RPC error api_key=${secret}`), { code: secret }));
      const result = await post({ method: "testMcp", input: { targetId: "default", name: "local" } });
      expect(result.status).toBe(200);
      const payload = await result.json();
      expect(payload).toMatchObject({ ok: false, error: { code: "MCP_REQUEST_FAILED" } });
      expect(JSON.stringify(payload)).not.toContain(secret);
      expect(errorLog).not.toHaveBeenCalled(); expect(warningLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); warningLog.mockRestore(); }
  });
  it("does not echo unrecognized request keys or exception messages for known recovery codes", async () => {
    const secret = "sensitive-unparsed-value-dfe1";
    const invalid = await post({ method: "bootstrap", input: { [secret]: true } });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).not.toContain(secret);
    savePreferences.mockRejectedValue(Object.assign(new Error(secret), { code: "recovery-required" }));
    const blocked = await post({ method: "savePreferences", input: { theme: "dark" } });
    const payload = await blocked.json();
    expect(payload).toMatchObject({ ok: false, error: { code: "recovery-required" } });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });
  it("drains a transaction before shutdown and refuses new work", async () => {
    let release!: () => void;
    savePreferences.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { theme: "dark" }; });
    const pending = post({ method: "savePreferences", input: { theme: "dark" } });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    app.close(); let drained = false;
    const drain = app.drain().then(() => { drained = true; });
    expect((await post({ method: "bootstrap" })).status).toBe(503); expect(drained).toBe(false);
    release(); expect((await pending).status).toBe(200); await drain; expect(drained).toBe(true);
  });
  it("streams authenticated SSE and closes it on shutdown", async () => {
    const response = await fetch(`${url}/api/events`, { headers });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/event-stream");
    app.close(); expect(await response.text()).toBe("");
  });
});
