import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

let temporary: string;
let entry: string;
let dataDir: string;
const children = new Set<ChildProcess>();
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: join(temporary, "home"), KIMI_CODE_HOME: join(temporary, "native"), KIMI_SERVER_DIST: join(temporary, "dist") });

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), "switch-cli-life-"));
  entry = join(temporary, "server.mjs");
  dataDir = join(temporary, "private");
  mkdirSync(join(temporary, "home"));
  mkdirSync(join(temporary, "dist"));
  writeFileSync(join(temporary, "dist", "index.html"), "<!doctype html><title>isolated lifecycle</title>");
  await build({
    entryPoints: [resolve("src/server/main.ts")], outfile: entry, bundle: true,
    platform: "node", format: "esm", target: "node22", logLevel: "silent",
    alias: { "@shared": resolve("src/shared") }, define: { SERVER_VERSION: JSON.stringify("lifecycle-test") },
    banner: { js: 'import { createRequire } from "node:module"; globalThis.require ??= createRequire(import.meta.url);' },
  });
}, 30_000);
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
  }
  await Promise.all([...children].map((child) => child.exitCode === null && child.signalCode === null ? once(child, "exit").catch(() => undefined) : Promise.resolve()));
  rmSync(temporary, { recursive: true, force: true });
});

function launch(args: string[]): ChildProcess {
  const child = spawn(process.execPath, [entry, ...args, "--data-dir", dataDir], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  return child;
}
async function command(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = launch(args);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, "exit");
  return { code, output };
}
async function waitReady(child: ChildProcess): Promise<{ pid: number; port: number; token: string; instanceId: string }> {
  let errorOutput = "";
  child.stderr!.on("data", (chunk) => { errorOutput += chunk.toString(); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited ${child.exitCode}: ${errorOutput}`);
    try {
      const info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8"));
      if (info.pid === child.pid) return info;
    } catch { /* identity has not been published */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`server did not publish identity: ${errorOutput}`);
}
async function reservePort(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing reserved address");
  return { server, port: address.port };
}

describe("isolated CLI lifecycle", () => {
  it("uses private identity, reuses a live instance, stops and restarts without touching native files", async () => {
    const absent = await command(["status"]);
    expect(absent).toMatchObject({ code: 0, output: expect.stringContaining("not running") });
    expect(existsSync(dataDir)).toBe(false);
    const reserved = await reservePort();
    let child: ChildProcess | undefined;
    try {
      child = launch(["--no-open", "--port", String(reserved.port)]);
      const info = await waitReady(child);
      expect(info.port).toBeGreaterThan(reserved.port);
      expect(statSync(join(dataDir, "server.json")).mode & 0o777).toBe(0o600);
      expect((await command(["status"])).output).toContain(`pid ${info.pid}`);
      expect((await command(["--no-open"])).output).toContain(`pid ${info.pid}`);
      expect((await command(["open", "--no-open"])).output).toContain(`pid ${info.pid}`);
      expect((await command(["stop"]))).toMatchObject({ code: 0, output: expect.stringContaining("stopped") });
      expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
      expect(existsSync(join(dataDir, "server.json"))).toBe(false);
      expect(existsSync(join(temporary, "native"))).toBe(false);
      child = launch(["--no-open", "--port", String(reserved.port)]);
      const restarted = await waitReady(child);
      expect(restarted.instanceId).not.toBe(info.instanceId);
      expect((await command(["stop"])).code).toBe(0);
    } finally {
      if (child?.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => reserved.server.close(() => resolvePromise()));
    }
  }, 30_000);

  it("reuses one authenticated winner when several processes take over a stale identity together", async () => {
    mkdirSync(dataDir, { recursive: true });
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    writeFileSync(join(dataDir, "server.lock"), JSON.stringify({ pid: exited.pid, token: "stale-owner", startedAt: "previous" }));
    const contenders = Array.from({ length: 6 }, () => {
      const child = launch(["--no-open", "--port", "19471"]);
      let output = "";
      child.stdout!.on("data", chunk => { output += chunk.toString(); });
      child.stderr!.on("data", chunk => { output += chunk.toString(); });
      const completion = once(child, "exit").then(([code]) => ({ code, output }));
      return { child, completion };
    });
    try {
      let info: { pid: number; instanceId: string; token: string; port: number } | undefined;
      for (let attempt = 0; attempt < 400; attempt++) {
        try {
          const current = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8"));
          if (contenders.some(({ child }) => child.pid === current.pid)) { info = current; break; }
        } catch { /* The winner is still starting. */ }
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      expect(info).toBeDefined();
      const results = await Promise.all(contenders.filter(({ child }) => child.pid !== info!.pid).map(({ completion }) => completion));
      expect(results).toHaveLength(5);
      for (const result of results) expect(result).toMatchObject({ code: 0, output: expect.stringContaining(`running (pid ${info!.pid})`) });
      const response = await fetch(`http://127.0.0.1:${info!.port}/api/instance`, { headers: { authorization: `Bearer ${info!.token}` } });
      expect(await response.json()).toMatchObject({ pid: info!.pid, instanceId: info!.instanceId });
      expect(contenders.filter(({ child }) => child.exitCode === null && child.signalCode === null)).toHaveLength(1);
      expect((await command(["stop"])).code).toBe(0);
    } finally {
      for (const { child } of contenders) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.all(contenders.map(({ completion }) => completion));
    }
  }, 30_000);

  it("recovers the lifetime lease after a running owner is killed", async () => {
    const first = launch(["--no-open", "--port", "19471"]);
    const original = await waitReady(first);
    const terminated = once(first, "exit");
    first.kill("SIGKILL");
    await terminated;
    expect(existsSync(join(dataDir, "server.lock"))).toBe(true);
    const replacement = launch(["--no-open", "--port", "19471"]);
    try {
      const current = await waitReady(replacement);
      expect(current.instanceId).not.toBe(original.instanceId);
      expect((await command(["status"])).output).toContain(`pid ${current.pid}`);
      expect((await command(["stop"]))).toMatchObject({ code: 0, output: expect.stringContaining("stopped") });
    } finally { if (replacement.exitCode === null && replacement.signalCode === null) replacement.kill("SIGTERM"); }
  }, 15_000);

  it("refuses to start while the old program has a live lock", async () => {
    const legacy = join(temporary, "home", ".kimi-code-switch-gui");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "server.lock"), JSON.stringify({ pid: process.pid, token: "old", startedAt: "now" }));
    const result = await command(["--no-open"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("legacy kimi-code-switch-gui is running");
    expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
  });
});
