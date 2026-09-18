import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { renderPackageReadme } from "./package-readme.mjs";
const root = resolve(import.meta.dirname, "..");
const artifact = resolve(process.argv[2] ?? join(root, "dist-release/kimi-code-switch"));
if (!existsSync(artifact)) throw new Error(`Artifact not found: ${artifact}`);
const webHtml = readFileSync(join(root, "dist/index.html"), "utf8");
const entryAssets = [...new Set([...webHtml.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]))];
if (!entryAssets.some(asset => asset.endsWith(".js")) || !entryAssets.some(asset => asset.endsWith(".css"))) throw new Error("Web entry scripts and styles could not be identified");
const webAssets = entryAssets.map(asset => {
  const bytes = readFileSync(join(root, "dist", asset));
  return { asset, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
});
const initialWebGzipBytes = webAssets.reduce((total, asset) => total + asset.gzipBytes, 0);
const initialWebBudgetBytes = 350 * 1024;
if (initialWebGzipBytes > initialWebBudgetBytes) throw new Error(`Web entry scripts and styles exceed the 350-KiB gzip budget: ${initialWebGzipBytes} bytes`);
const binarySha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
let archiveSha256 = null;
const temporary = mkdtempSync(join(tmpdir(), "kimi-code-switch package "));
const home = join(temporary, "home");
const dataDir = join(temporary, "panel data");
const binary = join(temporary, "kimi-code-switch");
mkdirSync(home);
const env = { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: join(home, ".kimi-code"), PATH: "/usr/bin:/bin", TMPDIR: temporary, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
const cli = args => execFileSync(binary, args, { cwd: temporary, env, encoding: "utf8", timeout: 15_000 });
let server;
let logs = "";
let startTime = 0;
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
try {
  if (!process.argv[2]) {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const stem = `kimi-code-switch-${version}-macos-arm64`;
    const archive = join(root, "dist-release", `${stem}.tar.gz`);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    archiveSha256 = digest;
    if (readFileSync(`${archive}.sha256`, "utf8").trim() !== `${digest}  ${stem}.tar.gz`) throw new Error("Release archive checksum mismatch");
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    const expected = new Set([`${stem}/`, `${stem}/kimi-code-switch`, `${stem}/LICENSE`, `${stem}/README.md`]);
    if (entries.length !== expected.size || entries.some(entry => !expected.has(entry))) throw new Error("Release archive contains unexpected files");
    execFileSync("tar", ["-xzf", archive, "-C", temporary]);
    if (!readFileSync(join(temporary, stem, "LICENSE")).equals(readFileSync(join(root, "LICENSE")))) throw new Error("Release archive LICENSE differs from the source notice");
    const readme = readFileSync(join(temporary, stem, "README.md"), "utf8");
    if (readme !== renderPackageReadme(version)) throw new Error("Release archive contains a stale self-contained README");
    const required = [`Kimi Code Switch ${version}`, "macOS Apple Silicon (arm64)", "无需安装系统 Node.js", "--help", "start", "open", "status", "stop", "--no-open", "--data-dir", "--port", "127.0.0.1", "~/.kimi-code-switch", "KIMI_CODE_HOME", "apply", "https://github.com/fx1226/kimi-code-switch"];
    if (required.some(value => !readme.includes(value))) throw new Error("Release README omits product, platform, command or native-file guidance");
    const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
    if (links.some(link => !/^https:\/\//.test(link) && link !== "LICENSE")) throw new Error("Release README depends on a file outside the archive");
    const archivedBinary = join(temporary, stem, "kimi-code-switch");
    if (!readFileSync(archivedBinary).equals(readFileSync(artifact)) || !(statSync(archivedBinary).mode & 0o111)) throw new Error("Archive executable differs or lacks execute permissions");
    copyFileSync(archivedBinary, binary);
    rmSync(join(temporary, stem), { recursive: true, force: true });
  } else copyFileSync(artifact, binary);
  if (!cli(["--help"]).includes("kimi-code-switch")) throw new Error("Packaged --help failed");
  if (!cli(["status", "--data-dir", dataDir]).includes("not running")) throw new Error("Fresh status is incorrect");
  startTime = performance.now();
  server = spawn(binary, ["--no-open", "--port", "18417", "--data-dir", dataDir], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => { logs += chunk; });
  server.stderr.on("data", chunk => { logs += chunk; });
  let info;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")); break; } catch { /* Startup in progress. */ }
    if (server.exitCode !== null) throw new Error(`Packaged server exited: ${logs}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!info) throw new Error(`Packaged server did not become ready: ${logs}`);
  const readyMs = Math.round(performance.now() - startTime);
  if (readyMs > 2000) throw new Error(`Packaged readiness exceeded the 2-second budget: ${readyMs} ms`);
  const base = `http://127.0.0.1:${info.port}`;
  const html = await request(base).then(response => response.text());
  if (!html.includes("Kimi Code Switch") || !html.includes("/assets/")) throw new Error("Embedded web assets are unavailable");
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  if (!script || !(await request(new URL(script, base))).ok) throw new Error("Embedded JavaScript is unavailable");
  const unauthorized = await request(`${base}/api/call`, { method: "POST", headers: {"content-type":"application/json"}, body:JSON.stringify({method:"bootstrap"}) });
  if (unauthorized.status !== 401) throw new Error("Packaged API did not enforce authentication");
  const response = await request(`${base}/api/call`, { method:"POST", headers:{"content-type":"application/json",authorization:`Bearer ${info.token}`,"x-client-id":"package-smoke-test"}, body:JSON.stringify({method:"bootstrap"}) });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(`Packaged bootstrap failed: ${JSON.stringify(result)}`);
  if (!/running \(pid \d+\)/.test(cli(["status", "--data-dir", dataDir]))) throw new Error("Running status failed");
  await new Promise(resolveWait => setTimeout(resolveWait, 2000));
  let memory = null;
  try {
    const [rssKiB, cpuPercent] = execFileSync("/bin/ps", ["-p", String(info.pid), "-o", "rss=,%cpu="], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
    memory = { rssMiB: Math.round(rssKiB / 1024 * 10) / 10, cpuPercent };
  } catch { /* Some sandboxes disallow process metrics; never claim a fabricated reading. */ }
  const metrics = { measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch, binarySha256, archiveSha256, executableMiB: Math.round(statSync(artifact).size / 1024 / 1024 * 10) / 10, readyMs, startupBudgetMs: 2000, startupWithinBudget: readyMs <= 2000, initialWebGzipBytes, initialWebBudgetBytes, initialWebWithinBudget: initialWebGzipBytes <= initialWebBudgetBytes, webAssets, ...memory };
  writeFileSync(join(root, "dist-release/package-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(JSON.stringify(metrics));
  cli(["stop", "--data-dir", dataDir]);
  if (existsSync(join(dataDir, "server.lock")) || existsSync(join(dataDir, "server.json"))) throw new Error("Shutdown left discovery files behind");
  console.log("Packaged artifact verified: standalone help/status/start, embedded SPA, authenticated bootstrap, and graceful stop.");
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise(resolveExit => server.once("exit", resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 3000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  }
  rmSync(temporary, { recursive: true, force: true });
}
