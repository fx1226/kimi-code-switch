// @tauri-apps/plugin-process 的 Node shim：exit 触发优雅停机。
// 复用 main.ts 的 SIGTERM 处理链（关 http、跑 shutdown 钩子、删锁）。
export function exit(): Promise<never> {
  process.kill(process.pid, "SIGTERM");
  // 信号处理需要等下一个事件循环 tick；挂起当前调用链，避免退出前的后续逻辑继续执行。
  return new Promise<never>(() => undefined);
}
