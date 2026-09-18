import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { buildSync } from "esbuild";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withTargetWriteLock } from "./targetLock";

describe("native target coordination", () => {
  it("serializes canonical aliases and releases after failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "switch-target-lock-"));
    const alias = `${directory}-alias`;
    symlinkSync(directory, alias);
    const order: string[] = [];
    try {
      await Promise.all([
        withTargetWriteLock(directory, async () => {
          order.push("first-start");
          await new Promise((resolve) => setTimeout(resolve, 80));
          order.push("first-end");
        }),
        withTargetWriteLock(alias, () => { order.push("second"); }),
      ]);
      expect(order).toEqual(["first-start", "first-end", "second"]);
      await expect(withTargetWriteLock(directory, () => { throw new Error("failure"); })).rejects.toThrow("failure");
      await expect(withTargetWriteLock(directory, () => "ready")).resolves.toBe("ready");
    } finally {
      rmSync(alias);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function worker(modulePath: string, target: string, temporary: string, release: string) {
  const child = spawn(process.execPath, ["-e", `
    const { withTargetWriteLock } = require(process.argv[1]);
    const fs = require("node:fs");
    (async () => {
      console.log("attempt");
      await withTargetWriteLock(process.argv[2], async () => {
        const before = Number(fs.readFileSync(process.argv[2], "utf8"));
        console.log("locked");
        if (process.argv[3]) while (!fs.existsSync(process.argv[3])) await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(process.argv[2], String(before + 1));
      });
      console.log("finished");
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, modulePath, target, release], { env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { errors += chunk; });
  return { child, async waitFor(message: string) {
    const deadline = Date.now() + 5000;
    while (!output.includes(message)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited before ${message}: ${errors}`);
      if (Date.now() >= deadline) throw new Error(`Worker timed out before ${message}: ${errors}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  } };
}
async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolveClose => child.once("close", () => resolveClose()));
  child.kill("SIGKILL");
  await closed;
}
function bundledLock(directory: string): string {
  const outfile = join(directory, "target-lock.cjs");
  buildSync({ entryPoints: [resolve("src/server/native/targetLock.ts")], outfile, platform: "node", format: "cjs", bundle: true, target: "node22", logLevel: "silent" });
  return outfile;
}

describe("cross-process native target coordination", () => {
  it("serializes writes to one canonical resource even when processes have different temporary directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "switch-process-lock-"));
    const target = join(directory, "resource.txt");
    const release = join(directory, "release");
    const firstTmp = join(directory, "tmp-one");
    const secondTmp = join(directory, "tmp-two");
    mkdirSync(firstTmp); mkdirSync(secondTmp); writeFileSync(target, "0");
    const modulePath = bundledLock(directory);
    const first = worker(modulePath, target, firstTmp, release);
    let second: ReturnType<typeof worker> | undefined;
    try {
      await first.waitFor("locked");
      second = worker(modulePath, target, secondTmp, "");
      await second.waitFor("attempt");
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      writeFileSync(release, "release");
      await Promise.all([first.waitFor("finished"), second.waitFor("finished")]);
      expect(readFileSync(target, "utf8")).toBe("2");
    } finally {
      await stopWorker(first.child);
      if (second) await stopWorker(second.child);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("hands a crashed owner's resource to waiting processes without stale-file takeover", async () => {
    const directory = mkdtempSync(join(tmpdir(), "switch-crashed-lock-"));
    const target = join(directory, "resource.txt");
    const alias = join(directory, "resource-alias.txt");
    writeFileSync(target, "0"); symlinkSync(target, alias);
    const modulePath = bundledLock(directory);
    const first = worker(modulePath, target, directory, join(directory, "never-release"));
    const waiters: ReturnType<typeof worker>[] = [];
    try {
      await first.waitFor("locked");
      waiters.push(worker(modulePath, alias, directory, ""), worker(modulePath, target, directory, ""));
      await Promise.all(waiters.map(child => child.waitFor("attempt")));
      await stopWorker(first.child);
      await Promise.all(waiters.map(child => child.waitFor("finished")));
      expect(readFileSync(target, "utf8")).toBe("2");
    } finally {
      await stopWorker(first.child);
      await Promise.all(waiters.map(child => stopWorker(child.child)));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets an unrelated target make progress while another resource is held", async () => {
    const directory = mkdtempSync(join(tmpdir(), "switch-independent-lock-"));
    try {
      await withTargetWriteLock(join(directory, "first.toml"), async () => {
        await expect(withTargetWriteLock(join(directory, "second.toml"), () => "independent")).resolves.toBe("independent");
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
