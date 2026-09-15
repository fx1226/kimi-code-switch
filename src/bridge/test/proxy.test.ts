import { describe, expect, it } from "vitest";

import {
  BODY_STRIP,
  collectResponseObject,
  extractSseData,
  isTerminalFrame,
  normalizeBody,
  splitSseFrames,
} from "../src/proxy";

describe("normalizeBody", () => {
  it("forces store=false and stream=true", () => {
    const { body, changed } = normalizeBody({ store: true, stream: false, instructions: "x", input: "hi" });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(changed).toBe(true);
  });

  it("strips backend-rejected parameters including max_output_tokens", () => {
    const input: Record<string, unknown> = {};
    for (const key of BODY_STRIP) input[key] = "value";
    const { body, changed } = normalizeBody({ ...input, model: "m", input: "hi" });
    expect(changed).toBe(true);
    for (const key of BODY_STRIP) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.model).toBe("m");
  });

  it("sets default instructions when empty", () => {
    const { body } = normalizeBody({ instructions: "" });
    expect(body.instructions).toBe("You are a helpful coding assistant.");
  });

  it("adds reasoning.encrypted_content to include", () => {
    const { body, changed } = normalizeBody({ include: [] });
    expect(body.include).toContain("reasoning.encrypted_content");
    expect(changed).toBe(true);
  });
});

describe("SSE handling", () => {
  const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

  it("splits frames and extracts data", () => {
    const { frames, rest } = splitSseFrames(frame({ type: "a" }) + frame({ type: "b" }));
    expect(frames).toHaveLength(2);
    expect(rest).toBe("");
    expect(extractSseData(frames[0])).toContain('"a"');
  });

  it("keeps unconsumed tail in rest so chunked arrivals do not repeat frames", () => {
    const first = frame({ type: "a" });
    const second = frame({ type: "b" });
    const step1 = splitSseFrames(first.slice(0, first.length - 1));
    expect(step1.frames).toHaveLength(0);
    expect(step1.rest).toBe(first.slice(0, first.length - 1));
    const step2 = splitSseFrames(step1.rest + first.slice(-1) + second);
    expect(step2.frames).toHaveLength(2);
    expect(extractSseData(step2.frames[0])).toContain('"a"');
  });

  it("detects terminal events", () => {
    expect(isTerminalFrame(frame({ type: "response.completed" }))).toBe(true);
    expect(isTerminalFrame(frame({ type: "response.output_item.done" }))).toBe(false);
    expect(isTerminalFrame('data: [DONE]\n\n')).toBe(false);
  });

  it("collects the terminal response object", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame({ type: "response.created", response: { id: "r1" } }) +
              frame({ type: "response.completed", response: { id: "r1", output: [] } }),
          ),
        );
        controller.close();
      },
    });
    const { response, sawTerminal } = await collectResponseObject(new Response(stream));
    expect(sawTerminal).toBe(true);
    expect(response.id).toBe("r1");
  });

  it("rejects a stream that never terminates", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({ type: "response.created" })));
        controller.close();
      },
    });
    await expect(collectResponseObject(new Response(stream))).rejects.toThrow(
      /before a terminal/,
    );
  });
});
