import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveFinalTarget, sha256Text } from "./fs";

function isBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const sqliteCode = (error as { errcode?: number }).errcode;
  return typeof sqliteCode === "number" && ((sqliteCode & 0xff) === 5 || (sqliteCode & 0xff) === 6);
}

/**
 * A SQLite reserved write lock coordinates every process using a canonical target.
 * Lock files are never unlinked: closing or terminating the owner releases the OS
 * lock, so no stale-file read/unlink race or PID reuse can create a second owner.
 */
export async function withTargetWriteLock<T>(targetPath: string, task: () => Promise<T> | T): Promise<T> {
  const uid = process.getuid?.() ?? "local";
  // POSIX /tmp is deliberately independent of each process's HOME/TMPDIR/data-dir.
  const directory = join(process.platform === "win32" ? tmpdir() : "/tmp", `kimi-code-switch-target-locks-${uid}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof uid === "number" && (info.uid !== uid || (info.mode & 0o077) !== 0))) {
    throw new Error("native target lock directory has unsafe ownership or permissions");
  }
  const path = join(directory, `${sha256Text(resolveFinalTarget(targetPath))}.sqlite`);
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1
    || (typeof uid === "number" && (file.uid !== uid || (file.mode & 0o077) !== 0))) {
    throw new Error("native target lock file has unsafe ownership or permissions");
  }
  const connection = new DatabaseSync(path);
  let acquired = false;
  try {
    connection.exec("PRAGMA busy_timeout=0;");
    const deadline = Date.now() + 30_000;
    while (!acquired) {
      try { connection.exec("BEGIN IMMEDIATE;"); acquired = true; }
      catch (error) {
        if (!isBusy(error)) throw error;
        if (Date.now() >= deadline) throw new Error("native configuration is busy in another operation; retry after it completes");
        // Never block the event loop while another local request owns the lock.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return await task();
  } finally {
    if (acquired) {
      try { connection.exec("ROLLBACK;"); } catch { /* close releases the OS lock even after an I/O error. */ }
    }
    connection.close();
  }
}
