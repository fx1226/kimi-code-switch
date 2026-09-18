// @tauri-apps/api/core 的 Node shim（esbuild alias 替换）。
// invoke 按命令名查 native/index.ts 的注册表分发；未注册命令调用时才报错。
import { invokeCommand } from "../index";

export function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(command, args);
}
