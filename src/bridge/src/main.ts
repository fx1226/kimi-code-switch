/**
 * Bridge CLI 入口。
 * - `stdio`：宿主驱动模式。配置/登录等由控制通道下发；桥接不持久化凭据（生产路径）。
 * - `serve`：独立原型模式。从 stateDir 恢复私密文件凭据；未登录则走 OAuth 并打印授权地址。
 * 零运行时依赖；入口被 esbuild 打包为单文件，再由 pkg 编译为自包含二进制。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import { BridgeRuntime, fileTokenStore } from "./bridge";
import { runControlLoop } from "./control";
import { OAUTH_CLIENT_ID, OAUTH_ISSUER } from "./pkce";
import type { BridgeInstanceConfig } from "./types";

function defaultConfig(overrides: Partial<BridgeInstanceConfig> = {}): BridgeInstanceConfig {
  const port = Number(overrides.port ?? 8317);
  const secret = overrides.secret ?? randomSecret();
  const stateDir = overrides.stateDir ?? join(homedir(), ".kimi-code-switch-gui", "chatgpt-bridge");
  // env 覆盖仅用于测试/开发（serve 模式）；生产宿主经控制通道下发完整 config。
  const upstreamBase = process.env.BRIDGE_UPSTREAM_BASE ?? "https://chatgpt.com/backend-api";
  const issuer = process.env.BRIDGE_ISSUER ?? OAUTH_ISSUER;
  const clientId = process.env.BRIDGE_CLIENT_ID ?? OAUTH_CLIENT_ID;
  return {
    port,
    secret,
    stateDir,
    logPath: overrides.logPath ?? join(stateDir, "bridge.log"),
    upstreamBase,
    upstreamResponses:
      overrides.upstreamResponses ?? process.env.BRIDGE_RESPONSES_URL ?? `${upstreamBase}/codex/responses`,
    tokenEndpoint: overrides.tokenEndpoint ?? process.env.BRIDGE_TOKEN_ENDPOINT ?? `${issuer}/oauth/token`,
    issuer,
    clientId,
    modelsEndpoint:
      overrides.modelsEndpoint ??
      process.env.BRIDGE_MODELS_URL ??
      `${upstreamBase}/codex/models?client_version=1.0.0`,
  };
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function parseServeArgs(argv: string[]): { stateDir: string; port: number; redirectPort: number; secret: string } {
  const get = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    stateDir: get("--state-dir", join(homedir(), ".kimi-code-switch-gui", "chatgpt-bridge")),
    port: Number(get("--port", "8317")),
    redirectPort: Number(get("--redirect-port", "1455")),
    secret: get("--secret", ""),
  };
}

async function runServe(argv: string[]): Promise<void> {
  const { stateDir, port, redirectPort, secret } = parseServeArgs(argv);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const config = defaultConfig({ port, stateDir, ...(secret ? { secret } : {}) });
  const store = fileTokenStore(stateDir);
  const initial = await store.load();
  const runtime = new BridgeRuntime({
    config,
    initialAuth: initial,
    tokenStore: store,
    logger: (line) => process.stderr.write(`[bridge] ${line}\n`),
  });

  let tokens = runtime.getAuthState();
  if (tokens.status !== "signed-in") {
    const handle = runtime.login(redirectPort);
    process.stdout.write(`\n请在弹出的浏览器中登录 ChatGPT。若未自动打开，请访问：\n${handle.url}\n\n`);
    tokens = await handle.done.then(() => runtime.getAuthState());
  }

  await runtime.start();
  const models = await runtime.refreshModels().catch(() => null);
  process.stdout.write(
    `\n桥接已就绪：http://127.0.0.1:${port}/v1  （模型目录 live=${models?.live ?? false}，共 ${models?.models.length ?? 0} 个）\n`,
  );

  const shutdown = (): void => {
    void runtime.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "stdio") {
    // 宿主模式：config/auth 由 start 控制请求下发。
    runControlLoop({
      onShutdown: () => undefined,
    });
    return;
  }
  if (mode === "serve") {
    await runServe(process.argv.slice(3));
    return;
  }
  process.stderr.write("usage: bridge <stdio|serve> [options]\n");
  process.exit(2);
}

void main();
