// Explicit internal native capabilities. HTTP exposes its own narrower typed API.
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
  const handler = Object.hasOwn(commandRegistry, command) ? commandRegistry[command] : undefined;
  if (!handler) {
    throw new Error(`unsupported command ${command} in server runtime`);
  }
  return (await handler(args)) as T;
}
