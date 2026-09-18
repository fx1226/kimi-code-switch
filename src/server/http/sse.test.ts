import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

import { createSseHub, type SseHub } from "./sse";
import { emitServerEvent } from "../events";

interface WindowEventFrame {
  type: "service-event";
  name: string;
  detail?: unknown;
}

interface CallEventFrame {
  type: "call-event";
  callId: string;
  event: unknown;
}

/** 最小可用的 ServerResponse 假件：记录写出的帧，并支持手动触发 close 回调。 */
function createFakeRes(): { res: ServerResponse; frames: Array<WindowEventFrame | CallEventFrame>; emitClose: () => void } {
  const frames: Array<WindowEventFrame | CallEventFrame> = [];
  const closeHandlers: Array<() => void> = [];
  const res = {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      const match = /^data: (.+?)\n\n$/.exec(String(chunk));
      if (match) frames.push(JSON.parse(match[1]) as WindowEventFrame | CallEventFrame);
      return true;
    }),
    end: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "close") closeHandlers.push(handler);
      return res;
    }),
    off: vi.fn(),
    destroyed: false,
    writableEnded: false,
  };
  const emitClose = (): void => {
    for (const handler of closeHandlers) handler();
  };
  return { res: res as unknown as ServerResponse, frames, emitClose };
}

describe("sseHub", () => {
  let hub: SseHub | null = null;

  afterEach(() => {
    hub?.close();
    hub = null;
  });

  it("routes call-events only to the owning session", () => {
    hub = createSseHub();
    const sessionA = createFakeRes();
    const sessionB = createFakeRes();
    hub.handleEventsRequest(sessionA.res, "session-a");
    hub.handleEventsRequest(sessionB.res, "session-b");
    expect(hub.connectionCount).toBe(2);

    hub.sendCallEvent("session-a", "call-1", { kind: "start", userCode: "CODE-A" });
    hub.sendCallEvent("session-b", "call-2", { kind: "start", userCode: "CODE-B" });

    const callEventsA = sessionA.frames.filter((frame): frame is CallEventFrame => frame.type === "call-event");
    const callEventsB = sessionB.frames.filter((frame): frame is CallEventFrame => frame.type === "call-event");
    expect(callEventsA).toHaveLength(1);
    expect(callEventsA[0]!.callId).toBe("call-1");
    expect(callEventsA[0]!.event).toEqual({ kind: "start", userCode: "CODE-A" });
    expect(callEventsB).toHaveLength(1);
    expect(callEventsB[0]!.callId).toBe("call-2");
    expect(callEventsB[0]!.event).toEqual({ kind: "start", userCode: "CODE-B" });
  });

  it("keeps broadcasting non-sensitive window-events to every connection", () => {
    hub = createSseHub();
    const sessionA = createFakeRes();
    const sessionB = createFakeRes();
    hub.handleEventsRequest(sessionA.res, "session-a");
    hub.handleEventsRequest(sessionB.res, "session-b");

    emitServerEvent("kimi-target-detection", { status: "detected" });
    emitServerEvent("kimi-oauth-login", { secret: "must-not-leak" });

    const windowEventsA = sessionA.frames.filter((frame): frame is WindowEventFrame => frame.type === "service-event");
    const windowEventsB = sessionB.frames.filter((frame): frame is WindowEventFrame => frame.type === "service-event");
    expect(windowEventsA).toHaveLength(1);
    expect(windowEventsA[0]!.name).toBe("kimi-target-detection");
    expect(windowEventsA[0]!.detail).toEqual({ status: "detected" });
    expect(windowEventsB).toHaveLength(1);
    expect(windowEventsB[0]!.name).toBe("kimi-target-detection");
  });

  it("removes a connection from the hub when its response closes", () => {
    hub = createSseHub();
    const sessionA = createFakeRes();
    const sessionB = createFakeRes();
    hub.handleEventsRequest(sessionA.res, "session-a");
    hub.handleEventsRequest(sessionB.res, "session-b");
    expect(hub.connectionCount).toBe(2);

    sessionA.emitClose();
    expect(hub.connectionCount).toBe(1);

    hub.sendCallEvent("session-a", "call-1", { kind: "start" });
    expect(sessionA.frames.some((frame) => frame.type === "call-event")).toBe(false);
  });
});
