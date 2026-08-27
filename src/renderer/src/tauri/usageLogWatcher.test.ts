import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageEvent } from "@shared/usageTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./usageDb", () => ({
  getIngestState: vi.fn(),
  insertEvent: vi.fn(),
  setIngestState: vi.fn(),
  updateEventTiming: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import * as db from "./usageDb";
import { UsageLogWatcher } from "./usageLogWatcher";

const mockedInvoke = vi.mocked(invoke);
const mockedInsert = vi.mocked(db.insertEvent);
const mockedGetIngestState = vi.mocked(db.getIngestState);
const mockedSetIngestState = vi.mocked(db.setIngestState);
const mockedUpdateEventTiming = vi.mocked(db.updateEventTiming);

// A realistic kimi.log excerpt: provider -> model -> session create -> two LLM steps.
const SESSION = "11111111-2222-3333-4444-555555555555";
// The module-path token before ":create"/":_run"/":_step" matters: the regexes require `.+`
// (≥1 char) before the function-name suffix, so a dotted logger path is mandatory.
const SAMPLE_LOG = [
  `2026-01-02 10:00:00.100 | INFO     | kimi.providers.factory:create:12 |  - Using LLM provider: type='kimi' base_url='https://api.kimi.test'`,
  `2026-01-02 10:00:00.200 | INFO     | kimi.providers.factory:create:34 |  - Using LLM model: provider='kimi' model='kimi-k2.5'`,
  `2026-01-02 10:00:00.300 | INFO     | kimi.runtime:_run:56 |  - Created new session: ${SESSION}`,
  `2026-01-02 10:00:01.000 | INFO     | kimi.soul.kimisoul:_step:78 | ${SESSION} - LLM step completed in 1.50s (input=120, output=45)`,
  `2026-01-02 10:00:02.000 | INFO     | kimi.soul.kimisoul:_step:79 | ${SESSION} - LLM step completed in 0.25s (input=10, output=5)`,
  "this line should be ignored",
].join("\n");

const KIMI_CODE_LOG = [
  "2026-06-13T14:30:27.035Z INFO  llm config  turnStep=0.1 provider=kimi model=kimi-k2.5 modelAlias=moonshot/kimi-k2.5 thinkingEffort=high systemPromptChars=42111 toolCount=36",
  "2026-06-13T14:30:27.035Z INFO  llm request  turnStep=0.1",
  "2026-06-13T14:30:27.994Z WARN  llm request failed  turnStep=0.1 attempt=1/3 model=moonshot/kimi-k2.5 errorName=APIStatusError errorMessage=\"403 Payment Required\" statusCode=403",
].join("\n");

const KIMI_CODE_WIRE_LOG = [
  JSON.stringify({
    type: "usage.record",
    model: "牛逼公益站/gpt-5.5",
    usage: {
      inputOther: 19269,
      output: 11,
      inputCacheRead: 120,
      inputCacheCreation: 42,
    },
    usageScope: "turn",
    time: 1781448319664,
  }),
].join("\n");

const WIRE_MAIN = [
  JSON.stringify({
    type: "usage.record",
    model: "kimi/main-model",
    usage: { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 0 },
    usageScope: "turn",
    time: 1781448319664,
  }),
  JSON.stringify({
    type: "usage.record",
    model: "kimi/main-model",
    usage: { inputOther: 200, output: 20, inputCacheRead: 0, inputCacheCreation: 0 },
    usageScope: "turn",
    time: 1781448319665,
  }),
].join("\n");

const WIRE_SUB = [
  JSON.stringify({
    type: "usage.record",
    model: "kimi/sub-model",
    usage: { inputOther: 300, output: 30, inputCacheRead: 0, inputCacheCreation: 7 },
    usageScope: "subagent",
    time: 1781448319666,
  }),
].join("\n");

/** Drives a watcher through one historical-ingest pass over SAMPLE_LOG. */
function primeInvokeForHistoricalIngest(log: string): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as { path?: string };
    if (cmd === "list_dir") return ["kimi.2026-01-01.log"] as never;
    if (cmd === "file_stat") {
      // historical file has content; live kimi.log is empty so readNewLines is a no-op
      if (a.path?.endsWith("kimi.log")) return { size: 0, mtime_ms: 0, ino: 1 } as never;
      if (a.path?.startsWith("~/.kimi-code/sessions/")) return null as never;
      return { size: log.length, mtime_ms: 0, ino: 2 } as never;
    }
    if (cmd === "read_file_slice") {
      return a.path?.endsWith("kimi-code.log") ? "" as never : log as never;
    }
    return undefined as never;
  });
}

function primeInvokeForKimiCodeSessionLog(log: string): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as { path?: string };
    if (cmd === "list_dir") {
      if (a.path === "~/.kimi-code/logs") return [] as never;
      if (a.path === "~/.kimi-code/sessions") return ["wd_project"] as never;
      if (a.path === "~/.kimi-code/sessions/wd_project") return ["session_abc"] as never;
      return [] as never;
    }
    if (cmd === "file_stat") {
      if (a.path === "~/.kimi-code/logs/kimi-code.log") return { size: 0, mtime_ms: 0, ino: 1 } as never;
      if (a.path === "~/.kimi-code/sessions/wd_project/session_abc/logs/kimi-code.log") {
        return { size: log.length, mtime_ms: 100, ino: 2 } as never;
      }
      return null as never;
    }
    if (cmd === "read_file_slice") return log as never;
    if (cmd === "usage_query") return [] as never;
    if (cmd === "usage_exec") return 1 as never;
    return undefined as never;
  });
}

/**
 * Session with two agent wire files: y/agents/{main,agent-1}/wire.jsonl — the union of
 * every wire path (plus a per-wire read_file_slice matching readNewLines' per-file
 * read), while logs/kimi-code.log does not exist. list_dir must not be invoked for the
 * roots-walk of ingestHistoricalLogs (it is not, since running is already true by then).
 */
function primeInvokeForMultiAgentWireLogs(mainLog: string, subLog: string): void {
  const MAIN_WIRE = "~/.kimi-code/sessions/wd_project/y/agents/main/wire.jsonl";
  const SUB_WIRE = "~/.kimi-code/sessions/wd_project/y/agents/agent-1/wire.jsonl";
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as { path?: string };
    if (cmd === "list_dir") {
      if (a.path === "~/.kimi-code/sessions") return ["wd_project"] as never;
      if (a.path === "~/.kimi-code/sessions/wd_project") return ["y"] as never;
      if (a.path === "~/.kimi-code/sessions/wd_project/y/agents") return ["main", "agent-1"] as never;
      return [] as never;
    }
    if (cmd === "file_stat") {
      if (a.path === "~/.kimi-code/sessions/wd_project/y/logs/kimi-code.log") return null as never;
      if (a.path === MAIN_WIRE) return { size: mainLog.length, mtime_ms: 100, ino: 2 } as never;
      if (a.path === SUB_WIRE) return { size: subLog.length, mtime_ms: 200, ino: 3 } as never;
      return null as never;
    }
    if (cmd === "read_file_slice") {
      if (a.path === MAIN_WIRE) return mainLog as never;
      if (a.path === SUB_WIRE) return subLog as never;
      return "" as never;
    }
    if (cmd === "usage_query") return [] as never;
    if (cmd === "usage_exec") return 1 as never;
    return undefined as never;
  });
}

function primeInvokeForKimiCodeWireLog(log: string): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as { path?: string };
    if (cmd === "list_dir") {
      if (a.path === "~/.kimi-code/logs") return [] as never;
      if (a.path === "~/.kimi-code/sessions") return ["wd_project"] as never;
      if (a.path === "~/.kimi-code/sessions/wd_project") return ["session_abc"] as never;
      if (a.path === "~/.kimi-code/sessions/wd_project/session_abc/agents") return ["main"] as never;
      return [] as never;
    }
    if (cmd === "file_stat") {
      if (a.path === "~/.kimi-code/logs/kimi-code.log") return { size: 0, mtime_ms: 0, ino: 1 } as never;
      if (a.path === "~/.kimi-code/sessions/wd_project/session_abc/logs/kimi-code.log") return null as never;
      if (a.path === "~/.kimi-code/sessions/wd_project/session_abc/agents/main/wire.jsonl") {
        return { size: log.length, mtime_ms: 100, ino: 2 } as never;
      }
      return null as never;
    }
    if (cmd === "read_file_slice") return log as never;
    if (cmd === "usage_query") return [] as never;
    if (cmd === "usage_exec") return 1 as never;
    return undefined as never;
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInsert.mockReset();
  mockedGetIngestState.mockReset();
  mockedSetIngestState.mockReset();
  mockedInsert.mockResolvedValue(true);
  mockedGetIngestState.mockResolvedValue(null);
  mockedSetIngestState.mockResolvedValue(undefined);
  mockedUpdateEventTiming.mockResolvedValue(undefined);
});

describe("UsageLogWatcher parsing", () => {
  it("resolves logs and sessions from the active KIMI_CODE_HOME", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_dir") return [] as never;
      if (cmd === "file_stat") return null as never;
      return undefined as never;
    });
    const watcher = new UsageLogWatcher({
      getActiveProfile: () => "work",
      getActiveEnvironmentHome: () => "/custom/kimi-home",
    });

    await watcher.start();
    watcher.stop();

    expect(mockedInvoke).toHaveBeenCalledWith("list_dir", { path: "/custom/kimi-home/logs" });
    expect(mockedInvoke).toHaveBeenCalledWith("list_dir", { path: "/custom/kimi-home/sessions" });
    expect(mockedInvoke).toHaveBeenCalledWith("file_stat", { path: "/custom/kimi-home/logs/kimi-code.log" });
  });

  it("resets the global offset when log rotation changes the inode", async () => {
    const first = `${JSON.stringify({
      type: "usage.record",
      model: "kimi/first",
      usage: { inputOther: 1, output: 1 },
      time: 1000,
    })}\n`;
    const second = `${JSON.stringify({
      type: "usage.record",
      model: "kimi/second",
      usage: { inputOther: 2, output: 2 },
      time: 2000,
    })}\n`;
    let content = first;
    let inode = 1;
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const path = (args as { path?: string } | undefined)?.path ?? "";
      if (cmd === "list_dir") return [] as never;
      if (cmd === "file_stat" && path.endsWith("logs/kimi-code.log")) {
        return { size: content.length, mtime_ms: inode, ino: inode } as never;
      }
      if (cmd === "file_stat") return null as never;
      if (cmd === "read_file_slice") return content as never;
      return undefined as never;
    });
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default" });

    await watcher.start();
    content = second;
    inode = 2;
    await watcher.ingestNow();
    watcher.stop();

    expect(mockedInsert).toHaveBeenCalledTimes(2);
    expect(mockedInsert.mock.calls.map(([event]) => event.model)).toEqual(["kimi/first", "kimi/second"]);
  });

  it("parses LLM step lines into UsageEvents with provider/model/session context", async () => {
    primeInvokeForHistoricalIngest(SAMPLE_LOG);
    const events: UsageEvent[] = [];
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "work", onEvent: (e) => events.push(e) });

    await watcher.start();
    watcher.stop();

    expect(events).toHaveLength(2);
    const [first, second] = events;
    expect(first.provider).toBe("kimi");
    expect(first.model).toBe("kimi-k2.5");
    expect(first.profile).toBe("work");
    expect(first.session_hint).toBe(SESSION);
    expect(first.prompt_tokens).toBe(120);
    expect(first.completion_tokens).toBe(45);
    expect(first.latency_ms).toBe(1500); // 1.50s -> ms
    expect(first.ts).toBe(new Date("2026-01-02T10:00:01.000").getTime());
    expect(second.latency_ms).toBe(250); // 0.25s -> ms
  });

  it("counts only events that insertEvent reports as newly inserted", async () => {
    primeInvokeForHistoricalIngest(SAMPLE_LOG);
    mockedInsert.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // second is a duplicate
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default" });

    await watcher.start();
    watcher.stop();

    expect(mockedInsert).toHaveBeenCalledTimes(2);
    expect(watcher.getStats()).toMatchObject({ sessionsTracked: 1, eventsIngested: 1 });
  });

  it("ignores non-matching lines and never emits events for them", async () => {
    primeInvokeForHistoricalIngest("garbage line one\nanother non-log line\n");
    const events: UsageEvent[] = [];
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default", onEvent: (e) => events.push(e) });

    await watcher.start();
    watcher.stop();

    expect(events).toHaveLength(0);
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("discovers Kimi Code session logs and records failed LLM requests", async () => {
    primeInvokeForKimiCodeSessionLog(KIMI_CODE_LOG);
    const events: UsageEvent[] = [];
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default", onEvent: (e) => events.push(e) });

    await watcher.start();
    watcher.stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "kimi",
      model: "moonshot/kimi-k2.5",
      profile: "default",
      prompt_tokens: 0,
      completion_tokens: 0,
      error_code: "APIStatusError",
      error_message: "403 Payment Required",
      http_status: 403,
      session_hint: "session_abc",
    });
    expect(events[0].latency_ms).toBe(959);
    expect(events[0].request_id).toMatch(/^log-/);
    expect(watcher.getStats()).toMatchObject({ eventsIngested: 1 });
  });

  it("does not turn a stale request context into multi-day latency", async () => {
    primeInvokeForKimiCodeSessionLog([
      "2026-08-04T01:15:42.000Z INFO  llm config  turnStep=1.2 provider=kimi model=k3 modelAlias=kimi-code/k3",
      "2026-08-25T15:42:23.000Z WARN  llm request failed  turnStep=1.2 model=kimi-code/k3 errorName=APIEmptyResponseError",
    ].join("\n"));
    const events: UsageEvent[] = [];
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default", onEvent: (event) => events.push(event) });

    await watcher.start();
    watcher.stop();

    expect(events).toHaveLength(1);
    expect(events[0].latency_ms).toBe(0);
    expect(events[0].ts).toBe(new Date("2026-08-25T15:42:23.000Z").getTime());
  });

  it("discovers Kimi Code wire logs and records usage tokens", async () => {
    primeInvokeForKimiCodeWireLog(KIMI_CODE_WIRE_LOG);
    const events: UsageEvent[] = [];
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "牛逼公益站", onEvent: (e) => events.push(e) });

    await watcher.start();
    watcher.stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "牛逼公益站",
      model: "牛逼公益站/gpt-5.5",
      profile: "牛逼公益站",
      prompt_tokens: 19269,
      completion_tokens: 11,
      cache_read_tokens: 120,
      cache_creation_tokens: 42,
      error_code: null,
      http_status: 200,
      session_hint: "session_abc",
    });
    expect(events[0].request_id).toMatch(/^log-/);
    expect(watcher.getStats()).toMatchObject({ eventsIngested: 1 });
  });

  it("uses step.end timing for the matching wire usage record", async () => {
    const usage = { inputOther: 120, output: 30, inputCacheRead: 400, inputCacheCreation: 5 };
    const log = [
      JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi/k3", usage, usageScope: "turn", time: 2000 }),
      JSON.stringify({
        type: "context.append_loop_event",
        agentId: "main",
        event: { type: "step.end", usage, llmFirstTokenLatencyMs: 800, llmStreamDurationMs: 250 },
        time: 3050,
      }),
    ].join("\n");
    primeInvokeForKimiCodeWireLog(log);
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default" });

    await watcher.start();
    watcher.stop();

    const requestId = mockedInsert.mock.calls[0][0].request_id;
    expect(mockedUpdateEventTiming).toHaveBeenCalledWith(requestId, 1050, 3050);
  });

  it("ignores session-scope summaries to avoid double-counting turn usage", async () => {
    const log = JSON.stringify({
      type: "usage.record",
      agentId: "main",
      model: "kimi/k3",
      usage: { inputOther: 100, output: 20, inputCacheRead: 300, inputCacheCreation: 0 },
      usageScope: "session",
      time: 4000,
    });
    primeInvokeForKimiCodeWireLog(log);
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default" });

    await watcher.start();
    watcher.stop();

    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("ingests usage from subagent wire logs alongside the main agent", async () => {
    primeInvokeForMultiAgentWireLogs(WIRE_MAIN, WIRE_SUB);
    const events: UsageEvent[] = [];
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "work", onEvent: (e) => events.push(e) });

    await watcher.start();
    watcher.stop();

    expect(events).toHaveLength(3);
    expect(mockedInsert).toHaveBeenCalledTimes(3);

    // main agent: both usage.record events ingested
    expect(events[0]).toMatchObject({ model: "kimi/main-model", prompt_tokens: 100, completion_tokens: 10, cache_read_tokens: 5, session_hint: "y" });
    expect(events[1]).toMatchObject({ model: "kimi/main-model", prompt_tokens: 200, completion_tokens: 20, session_hint: "y" });
    // subagent: agents/agent-1/wire.jsonl also ingested, not duplicated with main
    expect(events[2]).toMatchObject({
      model: "kimi/sub-model",
      prompt_tokens: 300,
      completion_tokens: 30,
      cache_creation_tokens: 7,
      session_hint: "y",
    });
    expect(new Set(events.map((e) => e.request_id)).size).toBe(3);

    // per-file offset persistence: main and subagent wire files each get their own row
    expect(mockedSetIngestState).toHaveBeenCalledWith(
      "~/.kimi-code/sessions/wd_project/y/agents/main/wire.jsonl",
      expect.any(Number),
      expect.any(String),
    );
    expect(mockedSetIngestState).toHaveBeenCalledWith(
      "~/.kimi-code/sessions/wd_project/y/agents/agent-1/wire.jsonl",
      expect.any(Number),
      expect.any(String),
    );
    expect(watcher.getStats()).toMatchObject({ eventsIngested: 3 });
  });

  it("start() is idempotent and isRunning reflects lifecycle", async () => {
    primeInvokeForHistoricalIngest("");
    const watcher = new UsageLogWatcher({ getActiveProfile: () => "default" });
    expect(watcher.isRunning()).toBe(false);

    await watcher.start();
    expect(watcher.isRunning()).toBe(true);
    await watcher.start(); // second start is a no-op (already running)

    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });
});
