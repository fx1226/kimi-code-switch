// @tauri-apps/api/event 的 Node shim：接进程内 EventEmitter。
// Wave 2 的 native 实现（fs/system 等模块）通过 emitTauriEvent 发布
// kimi-oauth-login、tray://command 等事件，renderer 适配层经 listen 消费。
import { EventEmitter } from "node:events";

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type UnlistenFn = () => void;

const bus = new EventEmitter();
let nextEventId = 0;

/** native 侧发布事件（对应 Tauri 后端 emit）；payload 形状与 Tauri Event<T> 一致。 */
export function emitTauriEvent<T>(name: string, payload: T): void {
  bus.emit(name, { event: name, id: (nextEventId += 1), payload });
}

export async function listen<T>(name: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  const listener = (event: Event<T>): void => handler(event);
  bus.on(name, listener);
  return () => {
    bus.off(name, listener);
  };
}
