import { EventEmitter } from "node:events";

export interface ServerEvent<T = unknown> {
  name: string;
  payload: T;
}

const events = new EventEmitter();
const ALL_EVENTS = Symbol("all-server-events");

/** Domain events stay inside the server until an authenticated transport subscribes. */
export function emitServerEvent<T>(name: string, payload: T): void {
  events.emit(name, payload);
  events.emit(ALL_EVENTS, { name, payload } satisfies ServerEvent<T>);
}

export function onServerEvent<T>(name: string, handler: (payload: T) => void): () => void {
  events.on(name, handler);
  return () => { events.off(name, handler); };
}

export function onAllServerEvents(handler: (event: ServerEvent) => void): () => void {
  events.on(ALL_EVENTS, handler);
  return () => { events.off(ALL_EVENTS, handler); };
}
