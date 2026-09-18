import type { ServerResponse } from "node:http";
import type { WebEvent } from "@shared/webApi";
import { onAllServerEvents } from "../events";

export interface SseHub {
  handleEventsRequest(res: ServerResponse, clientId: string): void;
  sendCallEvent(clientId: string, callId: string, event: unknown): void;
  broadcast(event: WebEvent): void;
  readonly connectionCount: number;
  close(): void;
}
function frame(res: ServerResponse, event: unknown): void {
  if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
export function createSseHub(): SseHub {
  const clients = new Set<{ res: ServerResponse; clientId: string }>();
  const broadcast = (event: WebEvent): void => { for (const client of clients) frame(client.res, event); };
  const heartbeat = setInterval(() => { for (const client of clients) frame(client.res, { type: "heartbeat" }); }, 15_000);
  heartbeat.unref?.();
  const unsubscribe = onAllServerEvents(({ name, payload }) => {
    // OAuth codes, request payloads and unreviewed service events are never broadcast.
    if (name === "resource-changed") broadcast(payload as WebEvent);
    else if (name === "kimi-target-detection") broadcast({ type: "service-event", name, detail: payload });
  });
  return {
    get connectionCount() { return clients.size; },
    handleEventsRequest(res, clientId) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
      res.flushHeaders();
      const client = { res, clientId };
      clients.add(client);
      res.on("close", () => clients.delete(client));
    },
    sendCallEvent(clientId, callId, event) {
      for (const client of clients) if (client.clientId === clientId) frame(client.res, { type: "call-event", callId, event });
    },
    broadcast,
    close() { clearInterval(heartbeat); unsubscribe(); for (const client of clients) client.res.end(); clients.clear(); },
  };
}
