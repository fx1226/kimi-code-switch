import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_USAGE, parseServerArgs } from "./args";
import { serverFailureMessage } from "./messages";
import { createAuthToken } from "./http/auth";
import type { ServerApp } from "./http/routes";
import { acquireServerLock, isProcessAlive, readLock, ServerAlreadyRunningError, type ServerLock } from "./lock";
import { configureAppPaths, getAppPaths } from "./native/paths";
import { findLegacyProcessBlocker } from "./migration/legacy";
import { closeUsageDb } from "./native/usage";

declare const SERVER_VERSION: string | undefined;
const serverVersion = typeof SERVER_VERSION === "undefined" ? "0.0.0-dev" : SERVER_VERSION;

const MAX_PORT_SCAN_OFFSET = 100;

/** 优雅停机钩子：进程退出前运行的清理回调（当前注册了关闭 SQLite 共享连接）。 */
const shutdownHooks: Array<() => void | Promise<void>> = [];

export function registerShutdownHook(hook: () => void | Promise<void>): void {
  shutdownHooks.push(hook);
}

async function runShutdownHooks(): Promise<void> {
  for (const hook of shutdownHooks) {
    await Promise.resolve(hook()).catch(() => {
      console.error("shutdown cleanup failed; check the private service state before restarting");
    });
  }
}

function listenOnce(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** 从 startPort 起递增扫描（最多 +100），只绑定 127.0.0.1。 */
async function listenWithPortScan(server: Server, startPort: number): Promise<number> {
  let lastError: unknown = null;
  for (let offset = 0; offset <= MAX_PORT_SCAN_OFFSET; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) break;
    try {
      await listenOnce(server, port);
      return port;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`no available port in ${startPort}-${startPort + MAX_PORT_SCAN_OFFSET}: ${lastError}`);
}

/** 实际端口 + token 写 server.json（0600），供外部工具发现服务。 */
function writeServerJson(path: string, port: number, token: string, instanceId: string): void {
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, instanceId, port, token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  // spawn 的 ENOENT 等错误是异步事件，需监听 error 而不是 try/catch。
  const child = platform === "darwin"
    ? spawn("open", [url], { detached: true, stdio: "ignore" })
    : platform === "win32"
      // start 把首个带引号参数当作窗口标题，需先传空标题再传 URL。
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    console.warn("failed to open browser; retry with kimi-code-switch open");
  });
  child.unref();
}

/** 等待 SIGINT/SIGTERM；第二次信号强制退出。 */
function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    let signalCount = 0;
    const onSignal = (signal: string): void => {
      signalCount += 1;
      if (signalCount > 1) {
        console.error(`received ${signal} again, forcing exit`);
        process.exit(1);
      }
      resolvePromise();
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  });
}

/** 打包产物位于 dist-server/，仓库根是其父目录；从源码运行（测试）时回退两级。 */
function resolveRepoRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return basename(currentDir) === "dist-server" ? resolve(currentDir, "..") : resolve(currentDir, "..", "..");
}

/**
 * dist/ 解析顺序：KIMI_SERVER_DIST 环境变量 → 可执行文件旁（打包 sidecar 的部署形态，
 * process.execPath 所在的目录即是本地服务根）→ 源码仓库 dist/ 回退。
 */
function resolveServerDist(): string {
  const fromEnv = process.env.KIMI_SERVER_DIST;
  if (fromEnv) return fromEnv;
  const besideExecutable = join(dirname(process.execPath), "dist");
  if (existsSync(besideExecutable) && statSync(besideExecutable).isDirectory()) {
    return besideExecutable;
  }
  return join(resolveRepoRoot(), "dist");
}

interface RunningInstance {
  pid: number;
  instanceId: string;
  port: number;
  token: string;
}

/** Refuse to signal a reused PID: both local lock and authenticated HTTP identity must match. */
async function findRunningInstance(waitForOwner = false): Promise<RunningInstance | null> {
  const paths = getAppPaths();
  let lock = readLock(paths.serverLockPath);
  if (waitForOwner) {
    for (let attempt = 0; attempt < 20 && (!lock || !isProcessAlive(lock.pid)); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      lock = readLock(paths.serverLockPath);
    }
  }
  if (!lock || !isProcessAlive(lock.pid)) return null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const info = JSON.parse(readFileSync(paths.serverInfoPath, "utf8")) as RunningInstance;
      if (info.pid !== lock.pid || info.instanceId !== lock.token
        || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535
        || typeof info.token !== "string" || !info.token) throw new Error("invalid server identity");
      const response = await fetch(`http://127.0.0.1:${info.port}/api/instance`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(1000),
      });
      const identity = await response.json() as { pid?: number; instanceId?: string };
      if (response.ok && identity.pid === info.pid && identity.instanceId === info.instanceId) return info;
    } catch { /* Startup publishes identity only after listening. */ }
    if (!isProcessAlive(lock.pid)) return null;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`an active lock exists but server identity could not be verified: ${paths.serverLockPath}`);
}

export async function runServer(argv: readonly string[]): Promise<void> {
  const args = parseServerArgs(argv);
  if (args.help) {
    console.log(SERVER_USAGE);
    return;
  }
  const paths = configureAppPaths({ dataDir: args.dataDir });
  const existing = await findRunningInstance();
  if (existing) {
    const url = `http://127.0.0.1:${existing.port}/`;
    if (args.command === "stop") {
      // Recheck the lock immediately before signalling the authenticated owner.
      if (readLock(paths.serverLockPath)?.token !== existing.instanceId) throw new Error("server identity changed");
      process.kill(existing.pid, "SIGTERM");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!isProcessAlive(existing.pid) || !existsSync(paths.serverLockPath)) {
          console.log("kimi-code-switch stopped");
          return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error("server is still shutting down; no force signal was sent");
    }
    console.log(`kimi-code-switch running (pid ${existing.pid}) at ${url}`);
    if (args.command !== "status" && !args.noOpen) openBrowser(`${url}#token=${existing.token}`);
    return;
  }
  if (args.command === "status" || args.command === "stop") {
    console.log("kimi-code-switch is not running");
    return;
  }
  const legacyBlocker = findLegacyProcessBlocker();
  if (legacyBlocker) throw new Error(legacyBlocker);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dataDir, 0o700);
  let lock: ServerLock;
  try { lock = await acquireServerLock(paths.serverLockPath); }
  catch (error) {
    if (!(error instanceof ServerAlreadyRunningError)) throw error;
    // The winner may own its lifetime lease before publishing HTTP discovery.
    const owner = await findRunningInstance(true);
    if (!owner) throw error;
    const url = `http://127.0.0.1:${owner.port}/`;
    console.log(`kimi-code-switch running (pid ${owner.pid}) at ${url}`);
    if (!args.noOpen) openBrowser(`${url}#token=${owner.token}`);
    return;
  }
  registerShutdownHook(closeUsageDb);
  let server: Server | null = null;
  let app: ServerApp | null = null;
  try {
    const token = createAuthToken();
    const distDir = resolveServerDist();
    const distAvailable = existsSync(distDir) && statSync(distDir).isDirectory();
    if (!distAvailable) console.warn(`dist/ not found at ${distDir}; run npm run build:web`);
    let actualPort = args.port;
    // Services obtain the configured path context only after CLI options are applied.
    const { createServerApp } = await import("./http/routes");
    app = createServerApp({
      get port() { return actualPort; },
      token,
      instanceId: lock.token,
      distDir,
      distAvailable,
    });
    server = createServer(app.handler);
    actualPort = await listenWithPortScan(server, args.port);
    writeServerJson(paths.serverInfoPath, actualPort, token, lock.token);
    console.log(`kimi-code-switch server v${serverVersion} listening on http://127.0.0.1:${actualPort}`);
    console.log(`server info: ${paths.serverInfoPath}`);
    if (!args.noOpen) openBrowser(`http://127.0.0.1:${actualPort}/#token=${token}`);
    await waitForShutdownSignal();
  } finally {
    if (server && app) await shutdownServer(server, app, lock, paths.serverInfoPath);
    else {
      await runShutdownHooks();
      await lock.release();
    }
  }
}

async function shutdownServer(
  server: Server,
  app: ServerApp,
  lock: ServerLock,
  serverJsonPath: string,
): Promise<void> {
  // 1) 先结束全部 SSE 连接，否则 server.close() 的回调会等流式连接断开
  app.close();
  await app.drain();
  // 2) 关闭监听；空闲 keep-alive 连接立即结束，剩余连接最多等 3s 后强制断开
  await Promise.race([
    new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
    }),
    new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        resolvePromise();
      }, 3000);
      timer.unref?.();
    }),
  ]);
  // 3) 跑 shutdown 钩子（关 SQLite），删锁并清理 server.json（否则下次启动会看到陈旧端口/token）
  await runShutdownHooks();
  // Keep ownership until discovery data is gone; a replacement process must not
  // publish its server.json between lock release and this cleanup.
  rmSync(serverJsonPath, { force: true });
  await lock.release();
}

const isDirectEntry = process.argv[1] !== undefined
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  runServer(process.argv.slice(2)).catch((error) => {
    console.error(serverFailureMessage(error));
    process.exit(1);
  });
}
