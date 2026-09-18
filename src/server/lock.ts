// 单实例锁：~/.kimi-code-switch-gui/server.lock（pid + 时间戳）。
// 陈旧锁检测：kill(pid, 0) 失败（ESRCH）说明持锁进程已退出，直接接管。
import { readFile, rm, writeFile } from "node:fs/promises";

export interface ServerLock {
  lockPath: string;
  release(): Promise<void>;
}

interface LockPayload {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但属于其他用户，仍视为占用；其余（ESRCH）视为已退出。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读取现有锁；缺失或损坏（无法解析）返回 null，视为可接管。 */
async function readLock(lockPath: string): Promise<LockPayload | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "" };
  } catch {
    return null;
  }
}

export async function acquireServerLock(lockPath: string): Promise<ServerLock> {
  const existing = await readLock(lockPath);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    throw new Error(`another server instance is running (pid ${existing.pid}, startedAt ${existing.startedAt}); lock: ${lockPath}`);
  }
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } as LockPayload, null, 2)}\n`, { mode: 0o600 });
  return {
    lockPath,
    release: async () => {
      await rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}
