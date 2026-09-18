import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Real packaged-process measurements. No mock CLI, API, writer, or timer is used.
// Usage: node scripts/check-performance.mjs [artifact] [--kimi path] [--save-count 100] [--output new-report.json] [--compare original-report.json]
const root = resolve(import.meta.dirname, "..");
let artifact = join(root, "dist-release/kimi-code-switch");
let kimiPath = join(homedir(), ".kimi-code/bin/kimi");
let saveCount = 100;
let outputArgument;
let comparisonPath;
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (["--kimi", "--save-count", "--output", "--compare"].includes(value)) {
    const argument = process.argv[++index];
    if (!argument || argument.startsWith("--")) throw new Error(`${value} requires a value`);
    if (value === "--kimi") kimiPath = resolve(argument);
    else if (value === "--save-count") saveCount = Number(argument);
    else if (value === "--output") outputArgument = resolve(argument);
    else comparisonPath = resolve(argument);
  } else if (!value.startsWith("--") && index === 2) artifact = resolve(value);
  else throw new Error(`Unknown argument: ${value}`);
}
if (!existsSync(artifact)) throw new Error(`Artifact not found: ${artifact}`);
if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Process metrics require macOS or Linux ps.");
if (!Number.isInteger(saveCount) || saveCount < 20 || saveCount > 1000) throw new Error("--save-count must be an integer between 20 and 1000");
const output = outputArgument ?? join(root, "dist-release", `performance-metrics-${saveCount}-${Date.now()}.json`);
if (existsSync(output)) throw new Error(`Refusing to overwrite an existing performance report: ${output}`);
if (comparisonPath === output) throw new Error("The comparison report and new output must be different files");
const hash = content => createHash("sha256").update(content).digest("hex");
const artifactSha256 = hash(readFileSync(artifact));
const comparisonBytes = comparisonPath ? readFileSync(comparisonPath) : undefined;
const comparison = comparisonBytes ? JSON.parse(comparisonBytes.toString("utf8")) : undefined;
if (comparison) {
  if (comparison.artifact?.sha256 !== artifactSha256) throw new Error("Comparison report refers to a different executable; samples cannot be combined");
  for (const key of ["saves", "configSaves"]) {
    const group = comparison[key];
    if (group?.status !== "passed" || !Array.isArray(group.samples) || group.samples.length !== 20) throw new Error("The comparison must contain all 20 verified samples for each resource");
    if (group.samples.some(sample => [sample.planMs, sample.applyMs, sample.planAndApplyMs].some(value => !Number.isFinite(value) || value < 0))) throw new Error("Comparison report contains invalid sample timing");
    if (key === "configSaves" && group.samples.some(sample => !sample.officialDoctor?.some(code => /^OFFICIAL_DOCTOR_(PASSED|WARNING)$/.test(code)))) throw new Error("Comparison config samples lack official doctor evidence");
  }
}

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "kimi-code-switch-performance-")));
const binary = join(temporary, "kimi-code-switch");
copyFileSync(artifact, binary);
const roundCount = 5;
const idleIntervalMs = 10_000;
const configFixture = "default_plan_mode = false\n";
const requestTimeoutMs = 15_000;
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const round = value => Math.round(value * 100) / 100;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
const statistics = values => ({ samples: values.length, min: round(Math.min(...values)), mean: round(values.reduce((a, b) => a + b, 0) / values.length), p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)) });
const parseVersion = value => value.trim().match(/^(?:(?:Kimi Code(?: CLI)?|kimi(?:-code)?)\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)?.[1] ?? null;
const metrics = {
  measuredAt: new Date().toISOString(), status: "running", platform: process.platform, arch: process.arch,
  artifact: { file: artifact, sha256: artifactSha256, bytes: statSync(artifact).size },
  requestedSaveCountPerResource: saveCount,
  writeValidationMode: "Version evidence is reusable only while each write rechecks original-path realpath plus dev/ino/size/mtimeNs/ctimeNs/mode identity; changes invalidate it. Every config candidate still invokes real official doctor. Native transaction and recovery records remain enabled.",
  methodology: {
    startup: "Five new processes with separate fresh HOME, KIMI_CODE_HOME and app data directories; each native directory is seeded with the same credential-free default_plan_mode=false fixture. Measure spawn to successful HTTP /api/ping. Filesystem caches are not flushed; this is not a disk-cold or browser first-paint measurement.",
    idle: "After authenticated bootstrap and a 500 ms settling period, sample ps process CPU time and RSS for 10 seconds per process. Average CPU is cumulative process CPU time delta / measured wall time, where 100% means one fully occupied core. CLI child CPU is excluded after bootstrap.",
    saves: `${saveCount} sequential 1024-byte AGENTS.md changes through authenticated HTTP planChange then applyChange, including initial creation, with the application's current version gate. Each result must succeed and match the native file content and SHA-256 revision. No doctor is claimed for this text resource.`,
    configSaves: `${saveCount} config.toml default_plan_mode boolean toggles through authenticated HTTP planChange then applyChange. Every plan must report a real official doctor success, and every commit must match the native file, SHA-256 revision and parsed readback. The 1000 ms save budget uses P95 of the full HTTP plan plus apply path, including version checks, doctor, transaction and recovery records; apply alone is reported only as a component. Every outlier remains in the report.`,
    comparison: "When --compare is supplied, it must contain the original 20 verified samples per resource for the identical executable hash. New and combined groups are reported separately; all original and new outliers remain in the combined group. Both new and combined P95 must meet the save budget. Original report files are never written.",
    host: "At measurement start, record OS load averages and the count of PIDs returned by ps -A -o pid=. No process command arguments are read. UTC timestamps bracket each save for later correlation; they do not establish causation.",
    cliTimings: "Five isolated real --version and five doctor config fixture calls provide independent subprocess timing for attribution. They are outside the measured HTTP saves and never replace or bypass the application's checks.",
    percentile: "Nearest-rank percentile, rank ceil(p * sample count).",
  },
  officialCli: { requestedPath: kimiPath, status: "unavailable" },
  startupBudgetMs: 2000,
  saveBudgetMs: 1000,
  saveBudgetMetric: "planAndApplyMs.p95",
  idleCpuBudgetPercent: 1,
  peakRssBudgetMiB: 120,
  binaryBudgetMiB: 90,
  ...(comparison ? { comparison: { file: comparisonPath, sha256: hash(comparisonBytes), measuredAt: comparison.measuredAt, artifactSha256: comparison.artifact.sha256, originalStatus: comparison.status, samplesPerResource: 20, agentsPlanAndApplyMs: comparison.saves.planAndApplyMs, configPlanAndApplyMs: comparison.configSaves.planAndApplyMs } } : {}),
  rounds: [],
  saves: { status: "pending", resource: "agents", samples: [] },
  configSaves: { status: "pending", resource: "config", samples: [] },
};
let running;
let peakIdleRssMiB = 0;
let reportCreated = false;
const persist = () => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(metrics, null, 2)}\n`, { flag: reportCreated ? "w" : "wx" });
  reportCreated = true;
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void (async () => {
    metrics.status = "interrupted";
    persist();
    await terminate();
    rmSync(temporary, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  })();
});
function environment(directory, kimiHome) {
  const env = {
    PATH: [join(kimiHome, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: directory, USERPROFILE: directory, KIMI_CODE_HOME: kimiHome,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"),
    APPDATA: join(directory, "appdata"), LOCALAPPDATA: join(directory, "localappdata"),
    TMPDIR: join(directory, "tmp"), TMP: join(directory, "tmp"), TEMP: join(directory, "tmp"),
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
  };
  for (const path of [directory, kimiHome, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.APPDATA, env.LOCALAPPDATA, env.TMPDIR]) mkdirSync(path, { recursive: true, mode: 0o700 });
  return env;
}
function cpuSeconds(value) {
  const dayParts = value.split("-");
  const days = dayParts.length === 2 ? Number(dayParts.shift()) : 0;
  const fields = dayParts[0].split(":").map(Number);
  if (fields.length < 2 || fields.some(value => !Number.isFinite(value))) throw new Error(`Unrecognized ps CPU time: ${value}`);
  return days * 86400 + fields.reduce((sum, value) => sum * 60 + value, 0);
}
function processSample(pid) {
  const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "time=", "-o", "rss="], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/);
  const rssKiB = Number(value[1]);
  if (value.length !== 2 || !Number.isFinite(rssKiB)) throw new Error("ps returned invalid process metrics");
  return { at: performance.now(), cpuSeconds: cpuSeconds(value[0]), rssMiB: rssKiB / 1024 };
}
async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
}
async function rpc(base, info, method, input) {
  const response = await request(`${base}/api/call`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${info.token}`, "x-client-id": "performance-verification" },
    body: JSON.stringify({ method, ...(input === undefined ? {} : { input }) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw new Error(`${method} failed: HTTP ${response.status}; ${payload.error?.code ?? "UNKNOWN"}: ${payload.error?.message ?? "invalid response"}`);
  return payload.result;
}
async function terminate() {
  const child = running;
  running = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  await Promise.race([exited, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(3000)]);
  }
}
function saveContent(index) {
  const header = `# Performance benchmark\n\nTemporary instruction ${String(index).padStart(2, "0")}\n\n`;
  return `${header}${"Local temporary benchmark instruction.\n".repeat(40).slice(0, 1023 - header.length)}\n`;
}
function summarizeSaves(measurement) {
  measurement.planMs = statistics(measurement.samples.map(value => value.planMs));
  measurement.applyMs = statistics(measurement.samples.map(value => value.applyMs));
  measurement.planAndApplyMs = statistics(measurement.samples.map(value => value.planAndApplyMs));
  measurement.allSamplesWithinBudget = measurement.samples.every(value => value.planAndApplyMs <= metrics.saveBudgetMs);
  measurement.p95WithinBudget = measurement.planAndApplyMs.p95 <= metrics.saveBudgetMs;
  measurement.withinBudget = measurement.p95WithinBudget;
  measurement.overBudgetSamples = measurement.samples.filter(value => value.planAndApplyMs > metrics.saveBudgetMs).length;
}
function saveSummary(measurement) {
  return { status: measurement.status, samples: measurement.samples.length, applyMs: measurement.applyMs, planAndApplyMs: measurement.planAndApplyMs, p95WithinBudget: measurement.p95WithinBudget, allSamplesWithinBudget: measurement.allSamplesWithinBudget, overBudgetSamples: measurement.overBudgetSamples, reason: measurement.reason };
}
async function benchmarkSaves(base, info, bootstrap, kimiHome, resource) {
  const key = resource === "agents" ? "saves" : "configSaves";
  const measurement = metrics[key];
  if (metrics.officialCli.status !== "verified" || !bootstrap.compatibility.nativeWritesAllowed) {
    Object.assign(measurement, { status: "blocked", reason: metrics.officialCli.status !== "verified" ? "The real official CLI 2.0.0 is unavailable or unverified." : `The running application rejected writes for CLI ${bootstrap.compatibility.detectedVersion ?? "unknown"}.`, compatibility: bootstrap.compatibility });
    return;
  }
  const target = bootstrap.targets.find(entry => entry.kind === "default");
  if (!target || realpathSync(target.homePath) !== realpathSync(kimiHome)) throw new Error("The default target escaped the isolated KIMI_CODE_HOME");
  let snapshot = await rpc(base, info, "readResource", { targetId: target.id, resource });
  for (let index = 0; index < saveCount; index++) {
    const content = saveContent(index);
    const planMode = index % 2 === 0;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const plan = await rpc(base, info, "planChange", {
      targetId: target.id, resource, expectedRevision: snapshot.revision,
      ...(resource === "agents" ? { content } : { changes: [{ op: "set", path: ["default_plan_mode"], value: planMode }] }),
    });
    const applyStart = performance.now();
    const plannedAt = new Date().toISOString();
    if (!plan.changed) throw new Error("The benchmark change produced no write");
    const doctor = resource === "config" ? plan.diagnostics.filter(entry => /^OFFICIAL_DOCTOR_(PASSED|WARNING)$/.test(entry.code)) : [];
    if (resource === "config" && (plan.validation !== "passed" || doctor.length === 0)) throw new Error("The config benchmark plan did not provide an explicit official doctor success");
    const operation = await rpc(base, info, "applyChange", { targetId: target.id, planId: plan.id, expectedRevision: plan.expectedRevision });
    const completed = performance.now();
    const completedAt = new Date().toISOString();
    const actual = readFileSync(join(kimiHome, resource === "agents" ? "AGENTS.md" : "config.toml"), "utf8");
    if (operation.status !== "succeeded" || (resource === "agents" && actual !== content) || operation.afterRevision !== hash(actual)) throw new Error(`${resource} save ${index + 1} did not produce the expected native file and revision`);
    snapshot = await rpc(base, info, "readResource", { targetId: target.id, resource });
    if (snapshot.revision !== operation.afterRevision || snapshot.content !== actual || (resource === "config" && snapshot.data?.default_plan_mode !== planMode)) throw new Error(`${resource} save ${index + 1} readback disagrees with the committed file`);
    measurement.samples.push({ index: index + 1, startedAt, plannedAt, completedAt, bytes: Buffer.byteLength(actual), planMs: round(applyStart - start), applyMs: round(completed - applyStart), planAndApplyMs: round(completed - start), withinBudget: completed - start <= metrics.saveBudgetMs, ...(resource === "config" ? { officialDoctor: doctor.map(entry => entry.code) } : {}) });
    if ((index + 1) % 5 === 0) {
      persist();
      console.log(`${resource}: ${index + 1}/${saveCount} verified saves; latest plan + apply ${round(completed - start)} ms.`);
    }
  }
  measurement.status = "passed";
  summarizeSaves(measurement);
}
try {
  const processIds = execFileSync("/bin/ps", ["-A", "-o", "pid="], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/).filter(Boolean);
  if (processIds.some(pid => !/^\d+$/.test(pid))) throw new Error("ps returned invalid PID-only process data");
  metrics.hostStart = { measuredAt: new Date().toISOString(), loadAverage1m5m15m: loadavg(), processCount: processIds.length, availableParallelism: availableParallelism() };
  persist();
  console.log(`Measurement start: ${JSON.stringify({ host: metrics.hostStart, artifactSha256, saveCountPerResource: saveCount, output, comparison: metrics.comparison })}`);
  const cliHome = join(temporary, "cli-preflight");
  const cliEnv = environment(cliHome, join(cliHome, ".kimi-code"));
  try {
    const executable = realpathSync(kimiPath);
    accessSync(executable, constants.X_OK);
    const version = execFileSync(executable, ["--version"], { cwd: cliHome, env: cliEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 }).trim();
    const parsed = parseVersion(version);
    metrics.officialCli = { requestedPath: kimiPath, resolvedPath: executable, version: parsed, status: parsed === "2.0.0" ? "verified" : "unverified" };
  } catch {
    metrics.officialCli.reason = "The real CLI executable could not complete --version in an isolated environment.";
  }
  if (metrics.officialCli.status === "verified") {
    const candidate = join(cliHome, "config.toml");
    writeFileSync(candidate, configFixture, { mode: 0o600 });
    const timings = { versionMs: [], doctorConfigMs: [] };
    for (let index = 0; index < 5; index++) {
      let start = performance.now();
      const version = execFileSync(metrics.officialCli.resolvedPath, ["--version"], { cwd: cliHome, env: cliEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
      timings.versionMs.push(performance.now() - start);
      if (parseVersion(version) !== "2.0.0") throw new Error("The official CLI version changed during timing preflight");
      start = performance.now();
      const doctor = execFileSync(metrics.officialCli.resolvedPath, ["doctor", "config", candidate], { cwd: cliHome, env: cliEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
      timings.doctorConfigMs.push(performance.now() - start);
      if (!/^OK config\.toml\s+/m.test(doctor) || readFileSync(candidate, "utf8") !== configFixture) throw new Error("The real official doctor did not accept the unchanged config fixture");
    }
    metrics.officialCliTimings = { versionMs: statistics(timings.versionMs), doctorConfigMs: statistics(timings.doctorConfigMs), fixture: configFixture };
    console.log(`Official CLI 2.0.0: isolated --version P95 ${metrics.officialCliTimings.versionMs.p95} ms; doctor config P95 ${metrics.officialCliTimings.doctorConfigMs.p95} ms.`);
  }
  for (let index = 0; index < roundCount; index++) {
    const directory = join(temporary, `round-${index + 1}`);
    const home = join(directory, "home");
    const kimiHome = join(home, ".kimi-code");
    const dataDir = join(directory, "panel-data");
    const env = environment(home, kimiHome);
    writeFileSync(join(kimiHome, "config.toml"), configFixture, { mode: 0o600 });
    if (metrics.officialCli.resolvedPath) {
      mkdirSync(join(kimiHome, "bin"));
      symlinkSync(metrics.officialCli.resolvedPath, join(kimiHome, "bin", "kimi"));
    }
    let spawnError;
    const start = performance.now();
    running = spawn(binary, ["--no-open", "--port", "19417", "--data-dir", dataDir], { cwd: directory, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    running.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
    running.once("error", error => { spawnError = error; });
    let info;
    let ready = false;
    while (performance.now() - start < requestTimeoutMs) {
      if (spawnError) throw spawnError;
      if (running.exitCode !== null || running.signalCode !== null) throw new Error(`Packaged service exited during startup: ${stderr.replace(/(?:token|Bearer)[=: ]+\S+/gi, "token=[redacted]")}`);
      try {
        info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8"));
        if ((await request(`http://127.0.0.1:${info.port}/api/ping`)).ok) { ready = true; break; }
      } catch { info = undefined; }
      await sleep(20);
    }
    if (!ready || !info) throw new Error("Packaged service did not become HTTP-ready within 15 seconds");
    const readyMs = performance.now() - start;
    if (info.pid !== running.pid) throw new Error("Readiness metadata refers to another process");
    const base = `http://127.0.0.1:${info.port}`;
    const bootstrapStart = performance.now();
    const bootstrap = await rpc(base, info, "bootstrap");
    const bootstrapMs = performance.now() - bootstrapStart;
    await sleep(500);
    const samples = [processSample(info.pid)];
    for (let tick = 1; tick <= 10; tick++) {
      await sleep(Math.max(0, samples[0].at + tick * 1000 - performance.now()));
      samples.push(processSample(info.pid));
    }
    const first = samples[0];
    const last = samples.at(-1);
    peakIdleRssMiB = Math.max(peakIdleRssMiB, ...samples.map(value => value.rssMiB));
    const measuredIntervalMs = last.at - first.at;
    const cpuDeltaSeconds = Math.max(0, last.cpuSeconds - first.cpuSeconds);
    const measurement = {
      index: index + 1, readyMs: round(readyMs), bootstrapMs: round(bootstrapMs), startupWithinBudget: readyMs <= metrics.startupBudgetMs,
      idle: { requestedIntervalMs: idleIntervalMs, measuredIntervalMs: round(measuredIntervalMs), cpuTimeSeconds: round(cpuDeltaSeconds), averageCpuPercent: round(cpuDeltaSeconds * 100_000 / measuredIntervalMs), rssMiB: { first: round(first.rssMiB), last: round(last.rssMiB), mean: round(samples.reduce((total, value) => total + value.rssMiB, 0) / samples.length), peak: round(Math.max(...samples.map(value => value.rssMiB))) } },
    };
    metrics.rounds.push(measurement);
    if (index === roundCount - 1) {
      await benchmarkSaves(base, info, bootstrap, kimiHome, "agents");
      await benchmarkSaves(base, info, bootstrap, kimiHome, "config");
    }
    const stop = execFileSync(binary, ["stop", "--data-dir", dataDir], { cwd: directory, env, encoding: "utf8", timeout: 15_000 });
    if (!stop.includes("stopped") || existsSync(join(dataDir, "server.lock")) || existsSync(join(dataDir, "server.json"))) throw new Error("Packaged stop did not complete discovery cleanup");
    await terminate();
    persist();
    console.log(`Round ${index + 1}/${roundCount}: HTTP ready ${measurement.readyMs} ms; idle ${measurement.idle.averageCpuPercent}% CPU; RSS ${measurement.idle.rssMiB.last} MiB.`);
  }
  metrics.startupMs = statistics(metrics.rounds.map(value => value.readyMs));
  metrics.startupWithinBudget = metrics.rounds.every(value => value.startupWithinBudget);
  metrics.idleAverageCpuPercent = statistics(metrics.rounds.map(value => value.idle.averageCpuPercent));
  metrics.idleRssMiB = statistics(metrics.rounds.map(value => value.idle.rssMiB.last));
  const averageIdleCpuPercent = metrics.rounds.reduce((total, value) => total + value.idle.cpuTimeSeconds, 0) * 100_000 / metrics.rounds.reduce((total, value) => total + value.idle.measuredIntervalMs, 0);
  metrics.idleCpuMeasuredPercent = round(averageIdleCpuPercent);
  metrics.idleCpuWithinBudget = averageIdleCpuPercent < metrics.idleCpuBudgetPercent;
  metrics.peakRssMiB = round(peakIdleRssMiB);
  metrics.peakRssWithinBudget = peakIdleRssMiB <= metrics.peakRssBudgetMiB;
  metrics.binaryMiB = round(metrics.artifact.bytes / 1024 / 1024);
  metrics.binaryWithinBudget = metrics.artifact.bytes / 1024 / 1024 <= metrics.binaryBudgetMiB;
  metrics.saveBudgetWithinLimit = metrics.saves.p95WithinBudget === true && metrics.configSaves.p95WithinBudget === true;
  metrics.allSaveSamplesWithinBudget = metrics.saves.allSamplesWithinBudget === true && metrics.configSaves.allSamplesWithinBudget === true;
  if (comparison && metrics.saves.status === "passed" && metrics.configSaves.status === "passed") {
    metrics.combined = { comparisonSamplesPerResource: 20, newSamplesPerResource: saveCount, artifactSha256 };
    for (const key of ["saves", "configSaves"]) {
      if (metrics[key].samples.length !== saveCount) throw new Error("The new save sample set is incomplete");
      const group = { status: "passed", resource: metrics[key].resource, samples: [
        ...comparison[key].samples.map(sample => ({ ...sample, sampleSource: "original-20" })),
        ...metrics[key].samples.map(sample => ({ ...sample, sampleSource: "new" })),
      ] };
      summarizeSaves(group);
      metrics.combined[key] = group;
    }
    metrics.combined.saveBudgetWithinLimit = metrics.combined.saves.p95WithinBudget && metrics.combined.configSaves.p95WithinBudget;
    metrics.combined.allSaveSamplesWithinBudget = metrics.combined.saves.allSamplesWithinBudget && metrics.combined.configSaves.allSamplesWithinBudget;
    if (hash(readFileSync(comparisonPath)) !== metrics.comparison.sha256) throw new Error("The original comparison report changed during measurement");
    metrics.comparison.unchanged = true;
  }
  if (hash(readFileSync(artifact)) !== artifactSha256) throw new Error("The executable changed during measurement");
  const budgetsPassed = metrics.startupWithinBudget && metrics.saveBudgetWithinLimit && (!comparison || metrics.combined?.saveBudgetWithinLimit === true) && metrics.idleCpuWithinBudget && metrics.peakRssWithinBudget && metrics.binaryWithinBudget;
  metrics.status = metrics.saves.status !== "passed" || metrics.configSaves.status !== "passed" ? "partial" : budgetsPassed ? "passed" : "budget-exceeded";
  metrics.completedAt = new Date().toISOString();
  persist();
  console.log(JSON.stringify({ status: metrics.status, startupMs: metrics.startupMs, startupWithinBudget: metrics.startupWithinBudget, idleAverageCpuPercent: metrics.idleAverageCpuPercent, idleCpuWithinBudget: metrics.idleCpuWithinBudget, idleRssMiB: metrics.idleRssMiB, peakRssMiB: metrics.peakRssMiB, peakRssWithinBudget: metrics.peakRssWithinBudget, binaryMiB: metrics.binaryMiB, binaryWithinBudget: metrics.binaryWithinBudget, saves: saveSummary(metrics.saves), configSaves: saveSummary(metrics.configSaves), ...(metrics.combined ? { combined: { saves: saveSummary(metrics.combined.saves), configSaves: saveSummary(metrics.combined.configSaves), saveBudgetWithinLimit: metrics.combined.saveBudgetWithinLimit } } : {}), output }));
  if (!budgetsPassed) process.exitCode = 1;
} catch (error) {
  metrics.status = "failed";
  metrics.error = error instanceof Error ? error.message : String(error);
  persist();
  console.error(metrics.error);
  process.exitCode = 1;
} finally {
  await terminate();
  rmSync(temporary, { recursive: true, force: true });
}
