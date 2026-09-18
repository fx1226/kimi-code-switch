// 服务端进程入口（Phase 0 骨架）：Node 单二进制本地服务，托管 dist/ 并在进程内
// 直接运行 renderer 侧的 kimiSwitch 业务编排（经 tauriShims 分发到 native 存根）。
// 注意："./runtime" 必须是第一个 import——window shim 先就位，kimiSwitch 链才能加载。
import "./runtime";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_USAGE, parseServerArgs } from "./args";
import { createAuthToken } from "./http/auth";
import { createServerApp, type ServerApp } from "./http/routes";
import { acquireServerLock, type ServerLock } from "./lock";
import { serverVersion } from "./runtime";

const MAX_PORT_SCAN_OFFSET = 100;

/** 优雅停机钩子（Wave 2 的 native 实现可注册清理逻辑，如关闭 SQLite 连接）。 */
const shutdownHooks: Array<() => void | Promise<void>> = [];

export function registerShutdownHook(hook: () => void | Promise<void>): void {
  shutdownHooks.push(hook);
}

async function runShutdownHooks(): Promise<void> {
  for (const hook of shutdownHooks) {
    await Promise.resolve(hook()).catch((error: unknown) => {
      console.error("shutdown hook failed:", error);
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
function writeServerJson(path: string, port: number, token: string): void {
  writeFileSync(path, `${JSON.stringify({ port, token }, null, 2)}\n`, { mode: 0o600 });
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
  child.on("error", (error) => {
    console.warn("failed to open browser:", error instanceof Error ? error.message : error);
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

async function runServer(argv: readonly string[]): Promise<void> {
  const args = parseServerArgs(argv);
  if (args.help) {
    console.log(SERVER_USAGE);
    return;
  }

  const dataDir = args.dataDir ?? join(homedir(), ".kimi-code-switch-gui");
  mkdirSync(dataDir, { recursive: true });

  // 1) 单实例锁（陈旧锁自动接管，活动锁报错退出）
  const lock = await acquireServerLock(join(dataDir, "server.lock"));

  // 2) token + HTTP 服务（127.0.0.1，端口被占则递增）
  const token = createAuthToken();
  const distDir = join(resolveRepoRoot(), "dist");
  const distAvailable = existsSync(distDir) && statSync(distDir).isDirectory();
  if (!distAvailable) {
    console.warn(`dist/ not found at ${distDir}; static routes will 404 until "npm run build:web"`);
  }
  // Host/Origin 校验必须用“实际绑定端口”：端口被占递增后才知道，
  // 因此以 getter 形式在请求时读取。
  let actualPort = args.port;
  const app = createServerApp({
    get port() { return actualPort; },
    token,
    distDir,
    distAvailable,
  });
  const server = createServer(app.handler);
  const port = await listenWithPortScan(server, args.port);
  actualPort = port;

  // 3) 写 server.json（实际端口 + token）
  const serverJsonPath = join(dataDir, "server.json");
  writeServerJson(serverJsonPath, port, token);

  const launchUrl = `http://127.0.0.1:${port}/#token=${token}`;
  console.log(`kimi-code-switch-gui server v${serverVersion} listening on http://127.0.0.1:${port}`);
  console.log(`server info: ${serverJsonPath}`);
  console.log(`launch url: ${launchUrl}`);

  // 4) 打开浏览器（--no-open 跳过）
  if (!args.noOpen) {
    openBrowser(launchUrl);
  }

  // 5) 优雅停机：关 http → 跑 shutdown 钩子 → 删锁
  await waitForShutdownSignal();
  console.log("shutting down...");
  await shutdownServer(server, app, lock);
}

async function shutdownServer(server: Server, app: ServerApp, lock: ServerLock): Promise<void> {
  // 1) 先结束全部 SSE 连接，否则 server.close() 的回调会等流式连接断开
  app.close();
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
  // 3) 跑 shutdown 钩子并删锁
  await runShutdownHooks();
  await lock.release();
}

const isDirectEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  runServer(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
