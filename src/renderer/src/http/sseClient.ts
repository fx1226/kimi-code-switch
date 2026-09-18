// SSE 订阅客户端：用 fetch + ReadableStream 消费本地服务的 /api/events。
// 不用原生 EventSource，因为鉴权需要自定义 Authorization 头；断线后指数退避重连。

export type SseServerFrame =
  | { type: "window-event"; name: string; detail?: unknown }
  | { type: "call-event"; callId: string; event: unknown }
  | { type: "heartbeat" };

export interface SseClientOptions {
  url: string;
  getAuthorization: () => string;
  onFrame: (frame: SseServerFrame) => void;
  fetchImpl?: typeof fetch;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface SseClient {
  start: () => void;
  stop: () => void;
  /** 等待事件流连接就绪；当前连接失败时随该次尝试 reject，后台仍会继续重连。 */
  ready: () => Promise<void>;
}

export function createSseClient(options: SseClientOptions): SseClient {
  const fetchImpl = options.fetchImpl
    ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const initialDelay = options.initialReconnectDelayMs ?? 500;
  const maxDelay = options.maxReconnectDelayMs ?? 15000;
  let started = false;
  let stopped = false;
  let connected = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  let waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  const settleWaiters = (error?: Error): void => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    const delay = Math.min(initialDelay * 2 ** reconnectAttempts, maxDelay);
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const consumeStream = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const dispatchData = (): void => {
      if (dataLines.length === 0) return;
      const payload = dataLines.join("\n");
      dataLines = [];
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (isServerFrame(parsed)) options.onFrame(parsed);
      } catch {
        // 非 JSON 的 data 帧直接忽略，避免单帧异常中断整条订阅。
      }
    };
    const processLine = (line: string): void => {
      if (line === "") {
        dispatchData();
        return;
      }
      if (line.startsWith(":")) return;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true }))
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    processLine(buffer);
    dispatchData();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const authorization = options.getAuthorization();
    try {
      const response = await fetchImpl(options.url, {
        headers: {
          Accept: "text/event-stream",
          ...(authorization ? { Authorization: authorization } : {}),
        },
      });
      if (!response.ok || !response.body) {
        throw new Error(`Event stream request failed (HTTP ${response.status}).`);
      }
      reconnectAttempts = 0;
      connected = true;
      settleWaiters();
      await consumeStream(response.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settleWaiters(new Error(`Event stream connection error: ${message}`));
    } finally {
      connected = false;
    }
    scheduleReconnect();
  };

  const start = (): void => {
    if (started || stopped) return;
    started = true;
    void connect();
  };

  const stop = (): void => {
    stopped = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    settleWaiters(new Error("Event stream client is stopped."));
  };

  const ready = (): Promise<void> => {
    if (connected) return Promise.resolve();
    if (stopped) return Promise.reject(new Error("Event stream client is stopped."));
    if (!started) start();
    return new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };

  return { start, stop, ready };
}

function isServerFrame(value: unknown): value is SseServerFrame {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "window-event" || type === "call-event" || type === "heartbeat";
}
