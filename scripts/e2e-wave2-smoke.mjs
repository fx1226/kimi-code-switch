// Wave 2 收口 E2E：临时 HOME 启动服务端，经 /api/call 调用 loadState 全链路，
// 验证 fs/system/usage/stores 三组 native 命令不再抛 unsupported command。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/Users/xfang/Code/Github/kimi-code-switch-gui";
const tempHome = mkdtempSync(join(tmpdir(), "ksg-e2e-home-"));
const tempData = mkdtempSync(join(tmpdir(), "ksg-e2e-data-"));
// 隔离真实 ~/.kimi-code / ~/.kimi-code-switch-gui：native 的 ~ 展开读 $HOME。
mkdirSync(join(tempHome, ".kimi-code"), { recursive: true });

const server = spawn("node", [join(ROOT, "dist-server/server.mjs"), "--no-open", "--data-dir", tempData, "--port", "8431"], {
  env: { ...process.env, HOME: tempHome },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (d) => { logs += d; });
server.stderr.on("data", (d) => { logs += d; });

function fail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(detail);
  console.error("--- server logs ---\n" + logs.slice(-3000));
  server.kill("SIGKILL");
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempData, { recursive: true, force: true });
  process.exit(1);
}

async function waitForServerJson(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(join(tempData, "server.json"), "utf8"));
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail("server.json not written in time");
}

async function post(port, token, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

try {
  const { port, token } = await waitForServerJson(15000);
  console.log(`server up on port ${port}`);

  // 1) 无 token → 401（鉴权仍生效）
  const unauthed = await post(port, null, "/api/call", { method: "loadState", args: [] });
  if (unauthed.status !== 401) fail(`expected 401 without token, got ${unauthed.status}`);
  console.log("✓ 无 token 被 401 拒绝");

  // 2) loadState 全链路（核心断言：ok:true 且无 unsupported command）
  const started = Date.now();
  const call = await post(port, token, "/api/call", { method: "loadState", args: [] });
  const elapsed = Date.now() - started;
  if (call.status !== 200) fail(`loadState HTTP ${call.status}`, call.text);
  if (call.json?.ok !== true) {
    const msg = call.json?.error ?? call.text;
    if (/unsupported command/.test(msg)) fail("loadState 仍撞 unsupported command", msg);
    fail(`loadState 返回 ok:false: ${msg}`);
  }
  const state = call.json.result;
  const checks = {
    "返回 AppState 对象": state && typeof state === "object",
    "有 configPath": typeof state.configPath === "string" && state.configPath.length > 0,
    "有 panelSettings": state.panelSettings && typeof state.panelSettings === "object",
    "有 mainConfig": state.mainConfig && typeof state.mainConfig === "object",
    "有 mcpConfig": state.mcpConfig && typeof state.mcpConfig === "object",
  };
  for (const [name, pass] of Object.entries(checks)) {
    if (!pass) fail(`loadState 结果缺少: ${name}`, JSON.stringify(state, null, 2).slice(0, 1500));
    console.log(`✓ loadState ${name}`);
  }
  console.log(`✓ loadState 完成，耗时 ${elapsed}ms，configPath=${state.configPath}`);

  // 3) 再触发一次（验证 SQLite 连接复用 / 幂等 open）
  const again = await post(port, token, "/api/call", { method: "loadState", args: [] });
  if (again.json?.ok !== true) fail(`第二次 loadState 失败: ${again.json?.error ?? again.text}`);
  console.log("✓ 第二次 loadState 幂等通过（SQLite 复用正常）");

  // 4) saveState 写回往返：触发 config.toml 原子写 + config history 快照 + panel settings 保存
  const saved = await post(port, token, "/api/call", { method: "saveState", args: [state] });
  if (saved.json?.ok !== true) fail(`saveState 失败: ${saved.json?.error ?? saved.text}`);
  const saveResult = saved.json.result;
  if (saveResult && typeof saveResult === "object" && saveResult.ok === false) {
    fail(`saveState 返回 ok:false: ${JSON.stringify(saveResult).slice(0, 800)}`);
  }
  console.log("✓ saveState 写回往返通过");

  // 5) 确认真实落盘：config.toml + SQLite（usage/panel_settings 共用 app.db）
  const { existsSync } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  const configToml = joinPath(tempHome, ".kimi-code", "config.toml");
  const appDb = joinPath(tempHome, ".kimi-code-switch-gui", "app.db");
  if (!existsSync(configToml)) fail(`config.toml 未落盘: ${configToml}`);
  console.log("✓ config.toml 已落盘");
  if (!existsSync(appDb)) fail(`SQLite app.db 未落盘: ${appDb}`);
  console.log("✓ SQLite app.db 已落盘");

  // 6) 验证服务端日志没有未捕获错误
  if (/UnhandledPromiseRejection|ERR_|Error: unsupported command/i.test(logs)) {
    fail("服务端日志出现未处理错误", logs.slice(-2000));
  }
  console.log("✓ 服务端日志无未处理错误");

  console.log("\n✅ Wave 2 E2E 全部通过");
} finally {
  const cleanup = () => {
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      rmSync(tempData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch { /* best-effort：失败由 OS 清理临时目录 */ }
  };
  const forceKill = setTimeout(() => {
    server.kill("SIGKILL");
    setTimeout(cleanup, 500);
  }, 2500);
  forceKill.unref();
  server.once("exit", () => {
    clearTimeout(forceKill);
    setTimeout(cleanup, 300);
  });
  server.kill("SIGTERM");
}
