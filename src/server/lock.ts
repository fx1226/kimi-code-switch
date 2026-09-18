// Single-instance ownership uses an OS-backed SQLite lease plus a readable process identity.
import { closeSync, fchmodSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface ServerLock {
  lockPath: string;
  token: string;
  release(): Promise<void>;
}

export interface LockPayload {
  pid: number;
  token: string;
  startedAt: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows 下 process.kill(pid, 0) 与 POSIX 语义一致（ESRCH=已退出）；
    // 非 ESRCH 无法确认进程已死，按保守取存活处理。
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 读取现有锁；缺失、损坏或 pid 非法返回 null。 */
export function readLock(lockPath: string): LockPayload | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    return {
      pid: parsed.pid as number,
      token: typeof parsed.token === "string" ? parsed.token : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** Busy means another process owns the OS-backed lifetime lease, even before publishing its PID. */
export class ServerAlreadyRunningError extends Error {
  constructor() { super("another server instance is running"); }
}

/**
 * The JSON identity remains readable by status/stop, while a private SQLite
 * transaction owns the process lifetime. All stale identity replacement happens
 * under that lease; its persistent file is never unlinked during takeover.
 */
export async function acquireServerLock(lockPath: string): Promise<ServerLock> {
  const leasePath = `${lockPath}.sqlite`;
  try { closeSync(openSync(leasePath, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const leaseFile = lstatSync(leasePath);
  if (!leaseFile.isFile() || leaseFile.isSymbolicLink() || leaseFile.nlink !== 1
    || (process.getuid && (leaseFile.uid !== process.getuid() || (leaseFile.mode & 0o077) !== 0))) {
    throw new Error("server lifetime lock file has unsafe ownership or permissions");
  }
  const connection = new DatabaseSync(leasePath);
  let acquired = false;
  const close = () => {
    if (acquired) { try { connection.exec("ROLLBACK;"); } catch { /* close still releases the OS lease. */ } }
    connection.close();
  };
  try {
    connection.exec("PRAGMA busy_timeout=0;");
    try { connection.exec("BEGIN IMMEDIATE;"); acquired = true; }
    catch (error) {
      const code = error && typeof error === "object" ? (error as { errcode?: number }).errcode : undefined;
      if (typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6)) throw new ServerAlreadyRunningError();
      throw error;
    }
    try {
      const identityFile = lstatSync(lockPath);
      if (!identityFile.isFile() || identityFile.isSymbolicLink() || identityFile.nlink !== 1) throw new Error("server identity path is not a private regular file");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const existing = readLock(lockPath);
    // Also respect an older process that only knows the JSON identity format.
    if (existing && isProcessAlive(existing.pid)) throw new ServerAlreadyRunningError();
    const token = randomUUID();
    const fd = openSync(lockPath, "w", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() } satisfies LockPayload)}\n`);
    } finally { closeSync(fd); }
    let released = false;
    return {
      lockPath,
      token,
      release: async () => {
        if (released) return;
        released = true;
        try {
          const current = readLock(lockPath);
          if (current === null || current.token === token) rmSync(lockPath, { force: true });
        } finally { close(); }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
