// 服务端 invoke 分发中心：按命令名查 commandRegistry。
// Wave 0 只搭骨架：四个存根模块均为空注册表，未注册命令调用时抛
// `unsupported command <name> in server runtime`。
// Wave 2 将按 src-tauri/src/lib.rs:31-126 注册的命令名逐组移植实现。
export type CommandHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type CommandHandlers = Record<string, CommandHandler>;

import { fsCommands } from "./fs";
import { systemCommands } from "./system";
import { usageCommands } from "./usage";
import { storesCommands } from "./stores";

export const commandRegistry: CommandHandlers = {
  ...fsCommands,
  ...systemCommands,
  ...usageCommands,
  ...storesCommands,
};

export async function invokeCommand<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const handler = commandRegistry[command];
  if (!handler) {
    throw new Error(`unsupported command ${command} in server runtime`);
  }
  return (await handler(args)) as T;
}
