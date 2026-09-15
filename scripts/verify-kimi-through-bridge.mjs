// P1 纵向原型验证：真实 Kimi CLI → 本地桥接 → 模拟上游，跑通一次真实响应。
// 用法：node scripts/verify-kimi-through-bridge.mjs [kimi-bin]
// 前提：已 `npm run build:bridge`；本机已安装 kimi（默认 ~/.kimi-code/bin/kimi）。
// 本脚本只操作临时目录，不访问真实 OpenAI。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const BRIDGE_PATH = resolve(import.meta.dirname, "../dist-bridge/bridge.mjs");
const KIMI_BIN = process.argv[2] ?? join(process.env.HOME ?? "", ".kimi-code/bin/kimi");

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolvePromise(port));
    });
  });
}

function waitForLine(stream, predicate, timeoutMs = 15000) {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({ input: stream });
    const timer = setTimeout(() => { rl.close(); reject(new Error("timeout waiting for output")); }, timeoutMs);
    rl.on("line", (line) => {
      if (predicate(line)) { clearTimeout(timer); rl.close(); resolvePromise(line); }
    });
    rl.on("close", () => clearTimeout(timer));
  });
}

// 最小模拟上游：token 交换 + /codex/responses + /codex/models。
function startMock() {
  return new Promise((resolvePromise) => {
    const requests = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, path: url.pathname, body: raw.slice(0, 300) });
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const p = new URLSearchParams(raw);
        const refreshed = p.get("grant_type") === "refresh_token";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: refreshed ? "refreshed-at" : "at-1",
          refresh_token: "rt-1",
          id_token: "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({ chatgpt_account_id: "acct_123" })).toString("base64url") + ".",
          expires_in: 3600,
        }));
        return;
      }
      if (url.pathname === "/codex/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ slug: "gpt-mock-pro", display_name: "GPT Mock Pro", context_window: 128000, input_modalities: ["text"], supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }], visibility: "list", supported_in_api: true }] }));
        return;
      }
      if (url.pathname === "/codex/responses" && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        const messageItem = {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "mock-ok" }],
        };
        const frames = [
          { type: "response.created", response: { id: "resp_mock", model: body.model, output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "mock-ok" },
          { type: "response.output_item.done", output_index: 0, item: messageItem },
          { type: "response.completed", response: { id: "resp_mock", model: body.model, status: "completed", output: [messageItem], usage: { input_tokens: 5, output_tokens: 3 } } },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frames.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => resolvePromise({ server, requests }));
  });
}

async function main() {
  const { server: mock, requests } = await startMock();
  const port = mock.address().port;
  const bridgePort = await getFreePort();
  const redirectPort = await getFreePort();
  const secret = "p1-secret";
  const tmp = mkdtempSync(join(tmpdir(), "kimi-bridge-p1-"));
  const env = {
    ...process.env,
    BRIDGE_UPSTREAM_BASE: `http://127.0.0.1:${port}`,
    BRIDGE_RESPONSES_URL: `http://127.0.0.1:${port}/codex/responses`,
    BRIDGE_TOKEN_ENDPOINT: `http://127.0.0.1:${port}/oauth/token`,
    BRIDGE_MODELS_URL: `http://127.0.0.1:${port}/codex/models`,
  };

  const bridge = spawn("node", [BRIDGE_PATH, "serve", "--state-dir", join(tmp, "state"), "--port", String(bridgePort), "--redirect-port", String(redirectPort), "--secret", secret], { env, stdio: ["pipe", "pipe", "pipe"] });
  let bridgeErr = "";
  bridge.stderr.on("data", (d) => { bridgeErr += d; });

  const loginLine = await waitForLine(bridge.stdout, (l) => l.includes("state="));
  const loginUrl = loginLine.match(/https?:\/\/\S+/)[0];
  const state = new URL(loginUrl).searchParams.get("state");
  const cb = await fetch(`http://127.0.0.1:${redirectPort}/auth/callback?code=CODE&state=${state}`);
  if (cb.status !== 200) throw new Error(`callback failed: ${cb.status}`);

  const readyLine = await waitForLine(bridge.stdout, (l) => l.includes("桥接已就绪"));
  const actualPort = Number(new URL(readyLine.match(/https?:\/\/\S+/)[0]).port);

  const configToml = `default_model = "chatgpt/subscription"
default_plan_mode = false
default_permission_mode = "manual"

[providers.chatgpt-bridge]
type = "openai_responses"
base_url = "http://127.0.0.1:${actualPort}/v1"
api_key = "${secret}"

[models."chatgpt/subscription"]
provider = "chatgpt-bridge"
model = "gpt-mock-pro"
max_context_size = 128000
capabilities = [ "thinking", "tool_use" ]
support_efforts = [ "low", "medium" ]
default_effort = "medium"
`;
  writeFileSync(join(tmp, "config.toml"), configToml);

  const doctor = await runWithTimeout(KIMI_BIN, ["doctor"], { ...env, KIMI_CODE_HOME: tmp }, 20000);
  if (doctor.code !== 0) {
    throw new Error(`kimi doctor rejected isolated config:\n${doctor.stdout}\n${doctor.stderr}`);
  }

  const result = await runWithTimeout(KIMI_BIN, ["-p", "Say ok", "-m", "chatgpt/subscription", "--output-format", "text"], { ...env, KIMI_CODE_HOME: tmp }, 30000);
  console.log("=== mock requests ===");
  for (const r of requests) console.log(r.method, r.path, r.body);
  console.log("=== kimi exit:", result.code, "===");
  console.log("=== kimi stdout ===");
  console.log(result.stdout ?? "");
  console.log("=== kimi stderr (tail) ===");
  console.log((result.stderr ?? "").split("\n").slice(-15).join("\n"));

  const ok = result.code === 0 && /mock-ok/.test(result.stdout ?? "");
  bridge.kill("SIGTERM");
  mock.close();
  rmSync(tmp, { recursive: true, force: true });
  if (!ok) {
    console.error("\nP1 vertical slice FAILED: kimi did not return the mock response.");
    console.error("bridge stderr:", bridgeErr);
    process.exit(1);
  }
  console.log("\nP1 vertical slice OK: real kimi CLI → bridge → mock upstream produced a response.");
}

/** 运行命令，超时则 SIGTERM，返回退出码与输出。 */
function runWithTimeout(bin, args, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
