import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeResource } from "@shared/resourceProtocol";
import type { ApiResponse, WebApi, WebMethod } from "@shared/webApi";

vi.mock("../services/cli", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cli")>(),
  detectActiveKimiTarget: vi.fn(),
}));

import { detectActiveKimiTarget } from "../services/cli";
import { clearDurableGrants } from "../native/fs";
import { configureAppPaths } from "../native/paths";
import { closeUsageDb } from "../native/usage";
import { createServerApp, type ServerApp } from "./routes";

const TOKEN = "plan-context-test-token";
const original = '{\n  "futureRoot": { "preserve": true },\n  "mcpServers": {\n    "local": { "command": "node", "args": ["server.mjs"], "futureServer": true }\n  }\n}\n';
const updated = original.replace('"node"', '"bun"');

describe("plan context through the real HTTP application", () => {
  let base: string;
  let nativeHome: string;
  let dataDir: string;
  let server: Server | undefined;
  let app: ServerApp | undefined;
  let url: string;

  beforeEach(async () => {
    closeUsageDb();
    clearDurableGrants();
    vi.clearAllMocks();
    base = realpathSync(mkdtempSync(join(tmpdir(), "kimi-http-plan-context-")));
    const osHome = join(base, "home");
    nativeHome = join(osHome, ".kimi-code");
    dataDir = join(base, "private");
    mkdirSync(nativeHome, { recursive: true });
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("USERPROFILE", osHome);
    vi.stubEnv("KIMI_CODE_HOME", nativeHome);
    configureAppPaths({ dataDir });

    // MCP changes need version verification but never invoke doctor or a server.
    const executable = join(base, "kimi");
    writeFileSync(executable, '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n  printf "Kimi Code CLI 2.0.0\\n"\n  exit 0\nfi\nexit 64\n');
    chmodSync(executable, 0o700);
    vi.mocked(detectActiveKimiTarget).mockResolvedValue({
      target: "kimi-code", installed: true, status: "detected", version: "2.0.0",
      executablePath: executable, resolvedPath: executable,
      candidates: [executable], reason: "test-fixture", installSource: "official-script",
    });

    let port = 0;
    app = createServerApp({
      get port() { return port; }, token: TOKEN, distDir: join(base, "absent-web-assets"),
      distAvailable: false, instanceId: "plan-context-test-instance",
    });
    server = createServer(app.handler);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    port = address.port;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    try {
      app?.close();
      await app?.drain();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    } finally {
      server = undefined;
      app = undefined;
      closeUsageDb();
      clearDurableGrants();
      configureAppPaths();
      vi.unstubAllEnvs();
      rmSync(base, { recursive: true, force: true });
    }
  });

  async function post<M extends WebMethod>(method: M, input?: Parameters<WebApi[M]>[0]): Promise<ApiResponse<Awaited<ReturnType<WebApi[M]>>>> {
    const response = await fetch(`${url}/api/call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`, "x-client-id": "plan-context-tab", Origin: url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, input }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<ApiResponse<Awaited<ReturnType<WebApi[M]>>>>;
  }

  async function call<M extends WebMethod>(method: M, input?: Parameters<WebApi[M]>[0]): Promise<Awaited<ReturnType<WebApi[M]>>> {
    const payload = await post(method, input);
    expect(payload).toMatchObject({ ok: true });
    if (!payload.ok) throw new Error(`Unexpected HTTP application error: ${payload.error.code}`);
    return payload.result;
  }

  async function plan(resource: NativeResource) {
    const snapshot = await call("readResource", { targetId: "default", resource });
    return call("planChange", {
      targetId: "default", resource, expectedRevision: snapshot.revision,
      changes: [{ op: "set", path: ["mcpServers", "local", "command"], value: "bun" }],
    });
  }

  it("reads, previews, applies and reads back an MCP change through HTTP", async () => {
    const path = join(nativeHome, "mcp.json");
    writeFileSync(path, original);

    const preview = await plan("mcp");
    expect(preview).toMatchObject({ path, changed: true });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(await call("getOperation", { id: preview.id })).toBeNull();

    const operation = await call("applyChange", {
      targetId: "default", planId: preview.id, expectedRevision: preview.expectedRevision,
    });
    expect(operation).toMatchObject({ status: "succeeded", path, resource: "mcp" });
    expect(readFileSync(path, "utf8")).toBe(updated);
    expect(await call("readResource", { targetId: "default", resource: "mcp" }))
      .toMatchObject({ path, content: updated, revision: operation.afterRevision });
    expect(await call("getOperation", { id: preview.id })).toEqual(operation);
  });

  it.each([
    { name: "empty", content: "" },
    { name: "whitespace-only", content: " \t\n\r\n" },
  ])("adds an MCP server to an $name file through HTTP", async ({ content }) => {
    const path = join(nativeHome, "mcp.json");
    writeFileSync(path, content);
    const snapshot = await call("readResource", { targetId: "default", resource: "mcp" });
    expect(snapshot).toMatchObject({ exists: true, path, content });
    const value = { command: "node", args: ["server.mjs"] };
    const preview = await call("planChange", {
      targetId: "default", resource: "mcp", expectedRevision: snapshot.revision,
      changes: [{ op: "set", path: ["mcpServers", "local"], value }],
    });
    expect(preview).toMatchObject({ path, changed: true });
    expect(readFileSync(path, "utf8")).toBe(content);

    const operation = await call("applyChange", {
      targetId: "default", planId: preview.id, expectedRevision: preview.expectedRevision,
    });
    expect(operation).toMatchObject({ status: "succeeded", path, resource: "mcp" });
    const saved = readFileSync(path, "utf8");
    expect(JSON.parse(saved)).toEqual({ mcpServers: { local: value } });
    expect(await call("readResource", { targetId: "default", resource: "mcp" }))
      .toMatchObject({ path, content: saved, revision: operation.afterRevision });
  });

  it.each(["mcp-project", "mcp-local"] as const)("rejects an old %s preview after switching working directories and accepts a new preview", async (resource) => {
    const projects = ["project-a", "project-b"].map((name) => {
      const root = join(base, name);
      const cwd = join(root, "nested");
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(join(cwd, ".kimi-code"), { recursive: true });
      const path = resource === "mcp-project" ? join(root, ".mcp.json") : join(cwd, ".kimi-code/mcp.json");
      // Identical revisions ensure path/context binding is the rejection reason.
      writeFileSync(path, original);
      return { cwd, path };
    });
    const [first, second] = projects;
    await call("updateTarget", { targetId: "default", workingDirectory: first.cwd });
    const stale = await plan(resource);
    expect(stale.path).toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toBe(original);

    await call("updateTarget", { targetId: "default", workingDirectory: second.cwd });
    const rejected = await post("applyChange", {
      targetId: "default", planId: stale.id, expectedRevision: stale.expectedRevision,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "unknown-plan" } });
    expect(readFileSync(first.path, "utf8")).toBe(original);
    expect(readFileSync(second.path, "utf8")).toBe(original);
    expect(await call("getOperation", { id: stale.id })).toBeNull();
    expect(existsSync(join(dataDir, "configuration-backups"))).toBe(false);

    const current = await plan(resource);
    expect(current).toMatchObject({ path: second.path, expectedRevision: stale.expectedRevision });
    expect(await call("applyChange", {
      targetId: "default", planId: current.id, expectedRevision: current.expectedRevision,
    })).toMatchObject({ status: "succeeded", resource, path: second.path });
    expect(readFileSync(first.path, "utf8")).toBe(original);
    expect(readFileSync(second.path, "utf8")).toBe(updated);
    expect(await call("readResource", { targetId: "default", resource }))
      .toMatchObject({ path: second.path, content: updated });
  });
});
