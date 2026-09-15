/**
 * Proxy：Responses 请求体规范化与上游 SSE 处理。
 * 规范化规则参考 kimi-codex-oauth（v0.1.1）：后端要求 store=false + stream=true；
 * 剥离后端拒绝的参数（含 Kimi 可能注入的 max_output_tokens）。
 */

// 后端拒绝或不兼容的参数。其余字段原样透传。
export const BODY_STRIP = new Set([
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "n",
  "user",
  "seed",
  "metadata",
  "response_format",
  "previous_response_id",
  "background",
  "max_tool_calls",
  "service_tier",
  "max_output_tokens",
]);

export const DEFAULT_INSTRUCTIONS = "You are a helpful coding assistant.";

export interface NormalizedBody {
  body: Record<string, unknown>;
  changed: boolean;
}

/** 规整请求体：强制 store=false/stream=true，默认 instructions，剥离不兼容参数。 */
export function normalizeBody(input: unknown): NormalizedBody {
  const body = (input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >;
  let changed = false;
  if (body.store !== false) {
    body.store = false;
    changed = true;
  }
  if (body.stream !== true) {
    body.stream = true;
    changed = true;
  }
  if (typeof body.instructions !== "string" || body.instructions.length === 0) {
    body.instructions = DEFAULT_INSTRUCTIONS;
    changed = true;
  }
  const include = Array.isArray(body.include) ? [...(body.include as unknown[])] : [];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
    body.include = include;
    changed = true;
  }
  for (const key of BODY_STRIP) {
    if (key in body) {
      delete body[key];
      changed = true;
    }
  }
  return { body, changed };
}

export const TERMINAL_RESPONSE_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/** 按 SSE 帧边界切分文本；返回完整帧与未成帧的剩余部分（调用方必须回写 rest）。 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = rest.match(/\r\n\r\n|\r\r|\n\n/);
    if (!match) break;
    const frameEnd = match.index! + match[0].length;
    frames.push(rest.slice(0, frameEnd));
    rest = rest.slice(frameEnd);
  }
  return { frames, rest };
}

export function isTerminalFrame(frame: string): boolean {
  const data = extractSseData(frame);
  if (data == null || data === "[DONE]") return false;
  try {
    const event = JSON.parse(data) as { type?: string };
    return typeof event.type === "string" && TERMINAL_RESPONSE_EVENTS.has(event.type);
  } catch {
    return false;
  }
}

/** 提取 SSE 帧中的 data 行（忽略注释与 event 行）。 */
export function extractSseData(frame: string): string | null {
  let data: string | null = null;
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).trimStart();
      data = data === null ? value : `${data}\n${value}`;
    }
  }
  return data;
}

/** 断言上游流在合理时间内终止；超时/缺失终态视为上游故障。 */
export async function collectResponseObject(
  upstream: Response,
  signal?: AbortSignal,
): Promise<{ response: Record<string, unknown>; sawTerminal: boolean }> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("upstream stream unavailable");
  let buffer = "";
  let sawTerminal = false;
  const terminalEvent = new Promise<{ type: string; response?: unknown; message?: string }>(
    (resolve, reject) => {
      const onAbort = () => reject(new Error("request aborted"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += Buffer.from(value).toString("utf8");
            const { frames, rest } = splitSseFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
              const data = extractSseData(frame);
              if (data == null || data === "[DONE]") continue;
              let event: { type?: string; response?: unknown; message?: string; error?: unknown };
              try {
                event = JSON.parse(data) as { type?: string; response?: unknown; message?: string; error?: unknown };
              } catch {
                continue;
              }
              if (event.type === "error") {
                const errRecord = (event.error ?? {}) as Record<string, unknown>;
                reject(new Error(typeof errRecord.message === "string" ? errRecord.message : "upstream stream error"));
                return;
              }
              if (typeof event.type === "string" && TERMINAL_RESPONSE_EVENTS.has(event.type)) {
                resolve({ type: event.type, response: event.response, message: event.message });
                return;
              }
            }
          }
          reject(new Error("upstream stream ended before a terminal response event"));
        } catch (error) {
          reject(error);
        }
      })();
    },
  );

  try {
    const event = await Promise.race([terminalEvent, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("upstream stream timed out")), 120000).unref();
    })]);
    const response =
      event.response && typeof event.response === "object"
        ? (event.response as Record<string, unknown>)
        : {};
    sawTerminal = true;
    return { response, sawTerminal };
  } finally {
    signal?.removeEventListener("abort", () => {});
  }
}
