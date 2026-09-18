import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireServerLock } from "./lock";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kimi-lock-"));
  lockPath = join(dir, "server.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  return child.pid;
}

function writeLock(payload: { pid: number; token: string }): void {
  writeFileSync(
    lockPath,
    `${JSON.stringify({ pid: payload.pid, token: payload.token, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

describe("acquireServerLock", () => {
  it("creates a lock with the current pid and a non-empty token", async () => {
    const lock = await acquireServerLock(lockPath);
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
    expect(payload.pid).toBe(process.pid);
    expect(payload.token.length).toBeGreaterThan(0);
    await lock.release();
  });

  it("takes over a stale lock left by a dead process", async () => {
    writeLock({ pid: deadPid(), token: "stale-token" });
    const lock = await acquireServerLock(lockPath);
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
    expect(payload.pid).toBe(process.pid);
    expect(payload.token).not.toBe("stale-token");
    await lock.release();
  });

  it("rejects a lock held by a live process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeLock({ pid: child.pid!, token: "live-token" });
      await expect(acquireServerLock(lockPath)).rejects.toThrow(/another server instance is running/);
    } finally {
      child.kill();
    }
  });

  it("reclaims a corrupt unparseable lock", async () => {
    writeFileSync(lockPath, "not-valid-json{");
    const lock = await acquireServerLock(lockPath);
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    expect(payload.pid).toBe(process.pid);
    await lock.release();
  });

  it("release removes its own lock", async () => {
    const lock = await acquireServerLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release does not remove a lock whose token changed (taken over)", async () => {
    const first = await acquireServerLock(lockPath);
    // 模拟 first 崩溃后被另一实例接管：覆盖为 token 不同的活锁。
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeLock({ pid: child.pid!, token: "replacement-token" });
      await first.release();
      expect(existsSync(lockPath)).toBe(true);
      const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
      expect(payload.token).toBe("replacement-token");
    } finally {
      child.kill();
    }
  });
  it("keeps a live owner exclusive even when the identity file becomes corrupt", async () => {
    const first = await acquireServerLock(lockPath);
    writeFileSync(lockPath, "corrupt identity");
    const second = acquireServerLock(lockPath);
    try {
      await expect(second).rejects.toThrow(/another server instance is running/);
    } finally {
      await second.then(lock => lock.release(), () => undefined);
      await first.release();
    }
  });

});
