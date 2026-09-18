// SSE 连接中心：/api/events 的流式响应（浏览器端 fetch + ReadableStream 消费，不用原生 EventSource）。
// data 帧契约：
//   {"type":"window-event","name":...,"detail":...}  进程内 window.dispatchEvent 的 CustomEvent
//   {"type":"call-event","callId":...,"event":...}   /api/call 的 __onEvent 回调事件
//   {"type":"heartbeat"}                              每 15s
import type { ServerResponse } from "node:http";

import { addWindowEventSink } from "../runtime";

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SseHub {
  /** 处理已通过鉴权的 /api/events 请求（负责写响应头并保持连接）。 */
  handleEventsRequest(res: ServerResponse): void;
  /** 向 callId 关联的 SSE 流发送 call-event 帧。 */
  sendCallEvent(callId: string, event: unknown): void;
  /** 当前连接数（测试/诊断用）。 */
  readonly connectionCount: number;
  /** 停机时结束全部连接并清理心跳定时器。 */
  close(): void;
}

function writeFrame(res: ServerResponse, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createSseHub(): SseHub {
  const connections = new Set<ServerResponse>();
  const heartbeat = setInterval(() => {
    for (const res of connections) {
      writeFrame(res, { type: "heartbeat" });
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  // 拦截 window shim 的 dispatchEvent：CustomEvent → window-event 帧。
  // （kimi-target-detection 等事件由 renderer 适配层在服务进程内派发。）
  const removeSink = addWindowEventSink((event) => {
    if (!(event instanceof CustomEvent)) return;
    for (const res of connections) {
      writeFrame(res, { type: "window-event", name: event.type, detail: event.detail });
    }
  });

  return {
    get connectionCount() {
      return connections.size;
    },
    handleEventsRequest(res: ServerResponse): void {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // SSE：writeHead 不会立刻发送响应头，必须显式 flush，
      // 否则客户端要等到第一帧（心跳 15s）才能拿到 200。
      res.flushHeaders();
      connections.add(res);
      res.on("close", () => {
        connections.delete(res);
      });
    },
    // 单用户本地服务：call-event 广播到全部已连接 SSE 流，客户端按帧内 callId 过滤。
    sendCallEvent(callId: string, event: unknown): void {
      for (const res of connections) {
        writeFrame(res, { type: "call-event", callId, event });
      }
    },
    close(): void {
      clearInterval(heartbeat);
      removeSink();
      for (const res of connections) {
        res.end();
      }
      connections.clear();
    },
  };
}
