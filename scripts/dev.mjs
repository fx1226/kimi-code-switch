import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.KIMI_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "kimi-code-switch-dev-"));
const children = [];
const origin = "http://127.0.0.1:1420";
let vite;
let stopping = false;
function launch(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", ...options });
  children.push(child);
  return child;
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await vite?.close();
  await Promise.all(children.map(child => new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    child.once("exit", resolveExit);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  })));
  if (!process.env.KIMI_DEV_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  const build = launch(["scripts/build-server.mjs"]);
  await new Promise((resolveBuild, reject) => build.once("exit", code => code === 0 ? resolveBuild() : reject(new Error("Server build failed"))));
  const backend = launch(["dist-server/server.mjs", "--no-open", "--data-dir", dataDir], {
    env: { ...process.env, KIMI_DEV_ORIGINS: origin },
  });
  let info;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")); break; } catch { /* Wait for authenticated service discovery. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!info) throw new Error("Development server did not start.");
  process.env.KIMI_DEV_SERVER_URL = `http://127.0.0.1:${info.port}`;
  vite = await createServer({ configFile: join(root, "vite.config.ts") });
  await vite.listen();
  console.log(`Development UI: ${origin}; API proxy: ${process.env.KIMI_DEV_SERVER_URL}`);
  console.log("Frontend changes use Vite HMR. Restart npm run dev after server/shared service changes to issue a fresh authenticated browser session.");
  console.log(`Development panel data: ${dataDir}. Browser receives the token via URL fragment; token is not logged.`);
  const url = `${origin}/#token=${encodeURIComponent(info.token)}`;
  if (process.env.KIMI_DEV_NO_OPEN !== "1") {
    const opener = spawn("open", [url], { stdio: "ignore" });
    opener.on("error", () => console.warn("Browser could not open. Restart npm run dev after enabling a browser opener."));
  }
  backend.once("exit", code => { if (!stopping) void stop(code ?? 1); });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}
