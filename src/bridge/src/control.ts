/**
 * Control：宿主与桥接之间的 JSONL 控制协议（stdin/stdout）。
 * 每行一个 JSON；对请求的应答带 id，事件无 id。桥接检测 stdin 关闭视为父进程退出。
 * runtime 由 `start` 请求（携带 config/auth）惰性构造；生产路径桥接不持久化凭据。
 */
import { createInterface } from "node:readline";

import type { ControlRequest, ControlResponse, TokenSet } from "./types";
import { BridgeRuntime } from "./bridge";

export interface ControlOptions {
  onShutdown?: () => void;
}

function writeLine(message: ControlResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function runControlLoop(options: ControlOptions = {}): void {
  let runtime: BridgeRuntime | null = null;

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line) => {
    let request: ControlRequest;
    try {
      request = JSON.parse(line) as ControlRequest;
    } catch {
      writeLine({ type: "error", message: "invalid control JSON" });
      return;
    }
    void dispatch(runtime, request, (next) => {
      runtime = next;
    }, options).catch((error) => {
      if (request.id !== undefined) {
        writeLine({
          id: request.id,
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });

  rl.on("close", () => {
    // stdin 关闭 = 宿主退出；同步退出。
    options.onShutdown?.();
    process.exit(0);
  });
}

async function dispatch(
  current: BridgeRuntime | null,
  request: ControlRequest,
  setRuntime: (next: BridgeRuntime | null) => void,
  options: ControlOptions,
): Promise<void> {
  switch (request.type) {
    case "start": {
      const runtime = new BridgeRuntime({
        config: request.config,
        initialAuth: request.auth ?? null,
        onTokens: (tokens) => writeLine({ type: "tokens", tokens }),
        logger: (line) => process.stderr.write(`[bridge] ${line}\n`),
      });
      setRuntime(runtime);
      await runtime.start();
      writeLine({ id: request.id, type: "ready", port: runtime.port, pid: process.pid });
      return;
    }
    case "login": {
      const runtime = requireRuntime(current);
      let handle: { url: string; done: Promise<TokenSet> };
      try {
        handle = runtime.login(request.redirectPort);
      } catch (error) {
        if (request.id !== undefined) {
          writeLine({
            id: request.id,
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      writeLine({ id: request.id, type: "login-url", url: handle.url });
      handle.done.then(
        (tokens) => {
          writeLine({ type: "login-result", ok: true, tokens });
        },
        (error) => {
          writeLine({
            type: "login-result",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      return;
    }
    case "logout": {
      const runtime = requireRuntime(current);
      await runtime.logout();
      writeLine({ id: request.id, type: "logout-result", ok: true });
      return;
    }
    case "status": {
      const runtime = requireRuntime(current);
      const auth = runtime.getAuthState();
      writeLine({
        id: request.id,
        type: "status",
        port: runtime.port,
        auth,
        catalog: runtime.getCatalog(),
        ok: auth.status === "signed-in",
      });
      return;
    }
    case "refresh-models": {
      const runtime = requireRuntime(current);
      const catalog = await runtime.refreshModels();
      writeLine({ id: request.id, type: "models", catalog });
      return;
    }
    case "shutdown": {
      writeLine({ id: request.id, type: "shutdown-ok" });
      if (current) await current.stop();
      options.onShutdown?.();
      process.exit(0);
      return;
    }
    default:
      throw new Error(`unknown control request: ${(request as ControlRequest).type}`);
  }
}

function requireRuntime(current: BridgeRuntime | null): BridgeRuntime {
  if (!current) throw new Error("bridge not started; send start first");
  return current;
}
