import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMockUpstream, type MockUpstream } from "./mock-upstream";

const BRIDGE_PATH = resolve(__dirname, "../../../dist-bridge/bridge.mjs");
const hasBridge = existsSync(BRIDGE_PATH);

function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

function waitForLine(stream: NodeJS.ReadableStream, predicate: (line: string) => boolean, timeoutMs = 10000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({ input: stream });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("timed out waiting for bridge output"));
    }, timeoutMs);
    rl.on("line", (line) => {
      if (predicate(line)) {
        clearTimeout(timer);
        rl.close();
        resolvePromise(line);
      }
    });
    rl.on("close", () => clearTimeout(timer));
  });
}

describe("bridge process (built bundle)", () => {
  let mock: MockUpstream | null = null;
  let stateDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
    mock = await createMockUpstream();
  });

  afterAll(async () => {
    child?.kill("SIGKILL");
    await mock?.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it.skipIf(!hasBridge)("logs in via callback and serves a streamed response", async () => {
    const bridgePort = await getFreePort();
    const redirectPort = await getFreePort();
    const secret = "e2e-secret";
    child = spawn("node", [BRIDGE_PATH, "serve", "--state-dir", stateDir, "--port", String(bridgePort), "--redirect-port", String(redirectPort), "--secret", secret], {
      env: {
        ...process.env,
        BRIDGE_UPSTREAM_BASE: mock!.baseUrl,
        BRIDGE_RESPONSES_URL: mock!.responsesUrl,
        BRIDGE_TOKEN_ENDPOINT: mock!.tokenUrl,
        BRIDGE_MODELS_URL: mock!.modelsUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const loginLine = await waitForLine(child.stdout, (line) => line.includes("state="));
    const urlMatch = loginLine.match(/https?:\/\/\S+/);
    expect(urlMatch).not.toBeNull();
    const url = new URL(urlMatch![0].trim());
    const state = url.searchParams.get("state") ?? "";

    // 回调端口可能在 URL 打印后才完成绑定：轮询直到可连。
    const callbackUrl = `http://127.0.0.1:${redirectPort}/auth/callback?code=CODE&state=${state}`;
    let callback: Response | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        callback = await fetch(callbackUrl);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(callback?.status).toBe(200);

    const readyLine = await waitForLine(child.stdout, (line) => line.includes("桥接已就绪"));
    const readyUrl = readyLine.slice(readyLine.indexOf("http")).trim();
    const port = Number(new URL(readyUrl).port);

    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(modelsRes.status).toBe(200);
    const models = (await modelsRes.json()) as { data: Array<{ id: string }> };
    expect(models.data.map((m) => m.id)).toEqual(["gpt-mock-pro", "gpt-mock-lite"]);

    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi", stream: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("response.completed");

    // 无鉴权请求应被拒绝。
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-mock-pro", input: "hi" }),
    });
    expect(unauthorized.status).toBe(401);

    // 进程收到 SIGTERM 应优雅退出。
    const exit = new Promise<number | null>((resolvePromise) => {
      child!.on("exit", (code) => resolvePromise(code));
    });
    child.kill("SIGTERM");
    const code = await Promise.race([exit, new Promise<number | null>((r) => setTimeout(() => r(-999), 5000))]);
    expect(code).toBe(0);
    child = null;
  }, 30000);

  it.skipIf(!hasBridge)("exits when the parent closes stdin (no orphan)", async () => {
    const bridgePort = await getFreePort();
    const child = spawn("node", [BRIDGE_PATH, "stdio"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 先启动，确认进程存活并进入控制循环。
    child.stdin.write(JSON.stringify({
      id: 1,
      type: "start",
      config: {
        port: bridgePort,
        secret: "s",
        state_dir: stateDir,
        upstream_base: "https://example.invalid",
        upstream_responses: "https://example.invalid/codex/responses",
        token_endpoint: "https://example.invalid/oauth/token",
        issuer: "https://example.invalid",
        client_id: "c",
        models_endpoint: "https://example.invalid/codex/models",
        log_path: join(stateDir, "bridge.log"),
      },
    }) + "\n");
    const ready = await waitForLine(child.stdout, (line) => line.includes('"type":"ready"'));
    expect(ready).toContain("ready");

    const exit = new Promise<number | null>((resolvePromise) => {
      child.on("exit", (code) => resolvePromise(code));
    });
    // 关闭 stdin = 宿主退出 → 桥接必须自行退出，不留下孤儿。
    child.stdin.end();
    const code = await Promise.race([exit, new Promise<number | null>((r) => setTimeout(() => r(-999), 5000))]);
    expect(code).toBe(0);
  }, 20000);

  it.skipIf(!hasBridge)("uses the redirect port from stdio login requests", async () => {
    const bridgePort = await getFreePort();
    const redirectPort = await getFreePort();
    const loginChild = spawn("node", [BRIDGE_PATH, "stdio"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      loginChild.stdin.write(`${JSON.stringify({
        id: 1,
        type: "start",
        config: {
          port: bridgePort,
          secret: "s",
          state_dir: stateDir,
          upstream_base: "https://example.invalid",
          upstream_responses: "https://example.invalid/codex/responses",
          token_endpoint: "https://example.invalid/oauth/token",
          issuer: "https://example.invalid",
          client_id: "c",
          models_endpoint: "https://example.invalid/codex/models",
          log_path: join(stateDir, "bridge.log"),
        },
      })}\n`);
      await waitForLine(loginChild.stdout, (line) => line.includes('"type":"ready"'));

      loginChild.stdin.write(`${JSON.stringify({ id: 2, type: "login", redirectPort })}\n`);
      const loginLine = await waitForLine(loginChild.stdout, (line) => line.includes('"type":"login-url"'));
      const login = JSON.parse(loginLine) as { url: string };
      const authorizeUrl = new URL(login.url);
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
        `http://localhost:${redirectPort}/auth/callback`,
      );

      let callback: Response | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          callback = await fetch(`http://127.0.0.1:${redirectPort}/auth/callback?error=cancelled`);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(callback?.status).toBe(200);
    } finally {
      loginChild.kill("SIGKILL");
    }
  }, 20000);
});
