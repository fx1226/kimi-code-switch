import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageEvent } from "@shared/usageTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  SCHEMA_SQL,
  getEventCount,
  getIngestState,
  insertEvent,
  insertEventsBatch,
  open,
  pruneOldEvents,
  purgeAll,
  queryBreakdown,
  queryEvents,
  queryHeaviestSessions,
  queryModelTokenSums,
  queryOverview,
  queryTokenTotals,
  queryTrend,
  queryTrendTokens,
  resolveTrendGranularity,
  fillTrendTokenBuckets,
  setIngestState,
  updateEventTiming,
} from "./usageDb";

const mockedInvoke = vi.mocked(invoke);

function lastQuery(command: string): { sql: string; params: Record<string, unknown> | null } {
  const call = [...mockedInvoke.mock.calls].reverse().find((c) => c[0] === command);
  if (!call) throw new Error(`no invoke for ${command}`);
  return call[1] as { sql: string; params: Record<string, unknown> | null };
}

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    request_id: "req-1",
    kimi_code_environment_id: "",
    ts: 1700000000000,
    ts_end: null,
    profile: "default",
    provider: "kimi",
    model: "k2",
    prompt_tokens: 10,
    completion_tokens: 20,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    latency_ms: 100,
    proxy_overhead_ms: 0,
    error_code: null,
    error_message: null,
    http_status: 200,
    session_hint: "sess-1",
    cost_estimate: null,
    pricing_version: null,
    metadata_json: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue([] as unknown as never);
});

describe("open", () => {
  it("keeps environment index creation out of the bootstrap schema for legacy events tables", () => {
    expect(SCHEMA_SQL).not.toContain("idx_events_environment_ts");
  });

  it("opens the db with schema and applies the schema version when missing", async () => {
    mockedInvoke
      .mockResolvedValueOnce(undefined as unknown as never) // usage_open
      .mockResolvedValueOnce(0 as unknown as never) // ALTER environment column
      .mockResolvedValueOnce(0 as unknown as never) // CREATE environment index
      .mockResolvedValueOnce(0 as unknown as never) // DROP TRIGGER trg_events_aggregate
      .mockResolvedValueOnce(0 as unknown as never) // DROP TABLE daily_aggregate
      .mockResolvedValueOnce(undefined as unknown as never) // usage_exec_script canonical view
      .mockResolvedValueOnce([{ version: null }] as unknown as never) // SELECT MAX(version)
      .mockResolvedValueOnce(1 as unknown as never); // usage_exec INSERT
    await open("/tmp/usage.db");

    expect(mockedInvoke).toHaveBeenCalledWith("usage_open", { dbPath: "/tmp/usage.db", schemaSql: SCHEMA_SQL });
    const insert = lastQuery("usage_exec");
    expect(insert.sql).toMatch(/INSERT OR IGNORE INTO schema_versions/);
    expect(insert.params).toMatchObject({ v: 2, d: "create canonical usage view" });
    expect(mockedInvoke).toHaveBeenCalledWith("usage_exec_script", expect.objectContaining({
      sql: expect.stringContaining("ROW_NUMBER() OVER"),
    }));
    expect(mockedInvoke).toHaveBeenCalledWith("usage_exec_script", expect.objectContaining({
      sql: expect.stringContaining("CREATE VIEW usage_events"),
    }));
  });

  it("skips schema version insert when already current", async () => {
    mockedInvoke
      .mockResolvedValueOnce(undefined as unknown as never)
      .mockResolvedValueOnce(0 as unknown as never)
      .mockResolvedValueOnce(0 as unknown as never)
      .mockResolvedValueOnce(0 as unknown as never) // DROP TRIGGER trg_events_aggregate
      .mockResolvedValueOnce(0 as unknown as never) // DROP TABLE daily_aggregate
      .mockResolvedValueOnce(undefined as unknown as never) // usage_exec_script canonical view
      .mockResolvedValueOnce([{ version: 2 }] as unknown as never);
    await open("/tmp/usage.db");
    const schemaVersionInserts = mockedInvoke.mock.calls.filter((call) => {
      const args = call[1] as { sql?: unknown } | undefined;
      return call[0] === "usage_exec"
        && typeof args?.sql === "string"
        && args.sql.includes("INSERT OR IGNORE INTO schema_versions");
    });
    expect(schemaVersionInserts).toHaveLength(0);
  });
});

describe("insertEvent / insertEventsBatch", () => {
  it("maps an event onto named params and reports inserted=true when rows change", async () => {
    mockedInvoke.mockResolvedValue(1 as unknown as never);
    const inserted = await insertEvent(event({ request_id: "abc", kimi_code_environment_id: "env-2" }));
    expect(inserted).toBe(true);

    const call = lastQuery("usage_exec");
    expect(call.sql).toMatch(/INSERT OR IGNORE INTO events/);
    expect(call.params).toMatchObject({ request_id: "abc", kimi_code_environment_id: "env-2", prompt_tokens: 10 });
    expect((call.params as Record<string, unknown>).ingested_at_utc).toEqual(expect.any(Number));
  });

  it("reports inserted=false when no rows change (duplicate)", async () => {
    mockedInvoke.mockResolvedValue(0 as unknown as never);
    await expect(insertEvent(event())).resolves.toBe(false);
  });

  it("short-circuits an empty batch without invoking", async () => {
    await expect(insertEventsBatch([])).resolves.toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("passes rows with a shared ingested timestamp to usage_exec_batch", async () => {
    mockedInvoke.mockResolvedValue(2 as unknown as never);
    await insertEventsBatch([event({ request_id: "a" }), event({ request_id: "b" })]);
    const call = mockedInvoke.mock.calls.find((c) => c[0] === "usage_exec_batch")![1] as {
      rows: Array<{ ingested_at_utc: number }>;
    };
    expect(call.rows).toHaveLength(2);
    expect(call.rows[0].ingested_at_utc).toBe(call.rows[1].ingested_at_utc);
  });
});

describe("updateEventTiming", () => {
  it("updates only a plausible measured latency for the matching event", async () => {
    mockedInvoke.mockResolvedValue(1 as unknown as never);
    await updateEventTiming("req-1", 1250, 1700000001250);
    const call = lastQuery("usage_exec");
    expect(call.sql).toContain("UPDATE events SET latency_ms = @latency_ms, ts_end = @ts_end");
    expect(call.params).toMatchObject({ request_id: "req-1", latency_ms: 1250, ts_end: 1700000001250 });
  });
});

describe("getEventCount", () => {
  it("maps the COUNT(*) result", async () => {
    mockedInvoke.mockResolvedValue([{ cnt: 42 }] as unknown as never);
    await expect(getEventCount()).resolves.toBe(42);
  });
});

describe("queryOverview", () => {
  it("derives cache hit rate / avg latency / error rate from aggregate sums", async () => {
    mockedInvoke.mockResolvedValue([{
      calls: 4,
      tokens: 1000,
      cache_read: 200,
      cache_input: 600,
      reasoning: 50,
      latency_sum: 800,
      latency_samples: 2,
      errors: 1,
    }] as unknown as never);

    const slice = await queryOverview("7d");
    expect(slice.totalCalls).toBe(4);
    expect(slice.totalTokens).toBe(1000);
    expect(slice.cacheHitRate).toBeCloseTo(1 / 3);
    expect(slice.avgLatencyMs).toBe(400);
    expect(slice.latencySamples).toBe(2);
    expect(slice.errorRate).toBe(0.25);

    const call = lastQuery("usage_query");
    expect(call.sql).toMatch(/FROM usage_events WHERE ts >= @from_ms AND ts < @to_ms/);
    expect(call.params).toHaveProperty("from_ms");
    expect(call.params).toHaveProperty("to_ms");
  });

  it("avoids divide-by-zero when there are no calls", async () => {
    mockedInvoke.mockResolvedValue([{ calls: 0, cache_input: 0, latency_samples: 0 }] as unknown as never);
    const slice = await queryOverview("today");
    expect(slice.cacheHitRate).toBe(0);
    expect(slice.avgLatencyMs).toBe(0);
    expect(slice.latencySamples).toBe(0);
    expect(slice.errorRate).toBe(0);
  });

  it("filters a non-default environment strictly by environment id", async () => {
    mockedInvoke.mockResolvedValue([{ calls: 0, cache_input: 0 }] as unknown as never);
    await queryOverview("7d", "env-2");

    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.sql).not.toContain("kimi_code_environment_id = ''");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });

  it("keeps legacy unscoped rows visible for the default environment", async () => {
    mockedInvoke.mockResolvedValue([{ calls: 0, cache_input: 0 }] as unknown as never);
    await queryOverview("7d", "default");

    const call = lastQuery("usage_query");
    expect(call.sql).toContain("(kimi_code_environment_id = @environment_id OR kimi_code_environment_id = '')");
    expect(call.params).toMatchObject({ environment_id: "default" });
  });
});

describe("queryTrend", () => {
  it("uses hour buckets from the events table and maps points", async () => {
    mockedInvoke.mockResolvedValue([{ bucket: 3600000, grp: "default", tokens: 5, calls: 1 }] as unknown as never);
    const points = await queryTrend("today", "hour", "profile");
    expect(points).toEqual([{ bucket: 3600000, group: "default", tokens: 5, calls: 1 }]);
    const call = lastQuery("usage_query");
    expect(call.sql).toMatch(/FROM usage_events WHERE ts >= @from_ms AND ts < @to_ms/);
    expect(call.sql).toContain("profile AS grp");
  });

  it("uses day buckets from events and converts local day strings to ms", async () => {
    mockedInvoke.mockResolvedValue([{ bucket: "2026-01-02", grp: "", tokens: 7, calls: 2 }] as unknown as never);
    const points = await queryTrend("7d", "day", null);
    expect(points[0].bucket).toBe(new Date(2026, 0, 2).getTime());
    const call = lastQuery("usage_query");
    expect(call.sql).toMatch(/FROM usage_events WHERE ts >= @from_ms AND ts < @to_ms/);
    expect(call.sql).toContain("localtime");
  });

  it("applies the environment filter to trend queries", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryTrend("7d", "day", "model", "env-2");
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });
});

describe("queryBreakdown", () => {
  it("clamps limit to [1,50] and orders by the requested column", async () => {
    mockedInvoke.mockResolvedValue([{ name: "m", calls: 3, tokens: 9, errors: 0, avg_latency_ms: 100, cache_hit_rate: 0.3 }] as unknown as never);
    await queryBreakdown("model", "30d", 999, "errors");
    const call = lastQuery("usage_query");
    expect(call.sql).toMatch(/FROM usage_events WHERE ts >= @from_ms AND ts < @to_ms/);
    expect(call.sql).toContain("ORDER BY errors DESC");
    expect(call.sql).toContain("prompt_tokens+cache_read_tokens+cache_creation_tokens");
    expect(call.params).toMatchObject({ limit: 50 });
  });

  it("applies the environment filter to breakdown queries", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryBreakdown("profile", "30d", 10, "tokens", "env-2");
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });
});

describe("queryModelTokenSums", () => {
  it("sums token dimensions from events within the exact range for hour buckets", async () => {
    mockedInvoke.mockResolvedValue([{
      model: "k2",
      bucket: 1700000000000,
      prompt_tokens: 10,
      completion_tokens: 20,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      reasoning_tokens: 5,
    }] as unknown as never);

    const rows = await queryModelTokenSums("today", "hour");
    expect(rows).toEqual([{
      model: "k2",
      bucketMs: 1700000000000,
      prompt_tokens: 10,
      completion_tokens: 20,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      reasoning_tokens: 5,
    }]);
    const call = lastQuery("usage_query");
    expect(call.sql).toMatch(/FROM usage_events WHERE ts >= @from_ms AND ts < @to_ms/);
    expect(call.sql).toContain("(ts/3600000)*3600000");
    expect(call.sql).toContain("GROUP BY model, bucket");
  });

  it("converts day bucket strings to local midnight ms like queryTrend", async () => {
    mockedInvoke.mockResolvedValue([{
      model: "k2",
      bucket: "2026-01-02",
      prompt_tokens: 10,
      completion_tokens: 20,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      reasoning_tokens: 5,
    }] as unknown as never);

    const rows = await queryModelTokenSums("7d", "day");
    expect(rows[0].bucketMs).toBe(new Date(2026, 0, 2).getTime());
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')");
    expect(call.sql).toContain("localtime");
  });

  it("returns a zero bucket and no bucket grouping for the none granularity", async () => {
    mockedInvoke.mockResolvedValue([{
      model: "k2",
      bucket: 0,
      prompt_tokens: 1,
      completion_tokens: 2,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      reasoning_tokens: 0,
    }] as unknown as never);

    const rows = await queryModelTokenSums("7d", "none");
    expect(rows[0].bucketMs).toBe(0);
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("GROUP BY model");
    expect(call.sql).not.toContain("GROUP BY model, bucket");
  });

  it("applies the environment filter to cost token sums", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryModelTokenSums("7d", "none", "env-2");
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });
});

describe("queryTokenTotals", () => {
  it("maps the four summed token columns, defaulting missing buckets to 0", async () => {
    mockedInvoke.mockResolvedValue([{
      prompt_tokens: 100,
      completion_tokens: 200,
      cache_read_tokens: 30,
      cache_creation_tokens: 40,
    }] as unknown as never);
    await expect(queryTokenTotals("7d")).resolves.toEqual({
      promptTokens: 100,
      completionTokens: 200,
      cacheCreationTokens: 40,
      cacheReadTokens: 30,
    });
    const call = lastQuery("usage_query");
    expect(call.sql).toMatch(/COALESCE\(SUM\(prompt_tokens\),0\)/);
    expect(call.sql).toMatch(/FROM usage_events WHERE ts >= @from_ms AND ts < @to_ms/);
  });

  it("returns all-zero totals when no rows match", async () => {
    mockedInvoke.mockResolvedValue([{}] as unknown as never);
    await expect(queryTokenTotals("30d")).resolves.toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("applies the environment filter to token totals", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryTokenTotals("7d", "env-2");
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });
});

describe("queryTrendTokens", () => {
  it("aggregates hour buckets with raw ms timestamps", async () => {
    mockedInvoke.mockResolvedValue([{
      bucket: 3600000,
      prompt_tokens: 10,
      completion_tokens: 20,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
    }] as unknown as never);
    await expect(queryTrendTokens({ fromUtc: 3600000, toUtc: 7200000 }, "hour")).resolves.toEqual([{
      bucket: 3600000,
      prompt: 10,
      completion: 20,
      cacheCreation: 4,
      cacheRead: 3,
    }]);
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("(ts/3600000)*3600000");
    expect(call.sql).toContain("GROUP BY bucket ORDER BY bucket");
  });

  it("converts day bucket strings to local midnight ms", async () => {
    mockedInvoke.mockResolvedValue([{
      bucket: "2026-01-02",
      prompt_tokens: 1,
      completion_tokens: 2,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
    }] as unknown as never);
    const dayStart = new Date(2026, 0, 2).getTime();
    const points = await queryTrendTokens({ fromUtc: dayStart, toUtc: new Date(2026, 0, 3).getTime() }, "day");
    expect(points[0].bucket).toBe(new Date(2026, 0, 2).getTime());
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')");
  });

  it("applies the environment filter to trend token queries", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryTrendTokens("7d", "day", "env-2");
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });
});

describe("resolveTrendGranularity", () => {
  it("uses hour for today / 3d presets", () => {
    expect(resolveTrendGranularity("today")).toBe("hour");
    expect(resolveTrendGranularity("3d")).toBe("hour");
  });

  it("uses day for 7d / 14d / 30d / 90d / mtd presets", () => {
    expect(resolveTrendGranularity("7d")).toBe("day");
    expect(resolveTrendGranularity("14d")).toBe("day");
    expect(resolveTrendGranularity("30d")).toBe("day");
    expect(resolveTrendGranularity("90d")).toBe("day");
    expect(resolveTrendGranularity("mtd")).toBe("day");
  });

  it("uses hour for custom ranges spanning at most 3 days", () => {
    const now = Date.now();
    expect(resolveTrendGranularity({ fromUtc: now - 3 * 86400000, toUtc: now })).toBe("hour");
    expect(resolveTrendGranularity({ fromUtc: now - 86400000, toUtc: now })).toBe("hour");
  });

  it("uses day for custom ranges spanning more than 3 days", () => {
    const now = Date.now();
    expect(resolveTrendGranularity({ fromUtc: now - 4 * 86400000, toUtc: now })).toBe("day");
  });
});

describe("fillTrendTokenBuckets", () => {
  it("fills missing day buckets with zeros across the requested range", () => {
    const from = new Date(2026, 0, 1).getTime();
    const to = new Date(2026, 0, 4).getTime();
    const points = fillTrendTokenBuckets([
      { bucket: new Date(2026, 0, 2).getTime(), prompt: 10, completion: 2, cacheCreation: 0, cacheRead: 5 },
    ], { fromUtc: from, toUtc: to }, "day");

    expect(points.map((point) => point.bucket)).toEqual([
      new Date(2026, 0, 1).getTime(),
      new Date(2026, 0, 2).getTime(),
      new Date(2026, 0, 3).getTime(),
    ]);
    expect(points.map((point) => point.prompt)).toEqual([0, 10, 0]);
  });
});

describe("queryHeaviestSessions", () => {
  it("applies the environment filter to session aggregation and profile lookup", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryHeaviestSessions("7d", 10, "env-2");

    const call = lastQuery("usage_query");
    expect(call.sql).toContain("FROM usage_events ue WHERE ts >= @from_ms AND ts < @to_ms AND kimi_code_environment_id = @environment_id");
    expect(call.sql).toContain("SUBSTR(MIN(printf('%020d', ts) || profile), 21) AS profile");
    expect(call.sql).not.toContain("SELECT profile FROM usage_events e2");
    expect(call.params).toMatchObject({ environment_id: "env-2", limit: 10 });
  });
});

describe("queryEvents cursor + filters", () => {
  it("builds IN clauses and a paging cursor", async () => {
    // page returns size+1 rows -> hasMore true -> nextCursor produced
    mockedInvoke.mockResolvedValue([
      { ...event({ request_id: "r2", ts: 200 }) },
      { ...event({ request_id: "r1", ts: 100 }) },
    ] as unknown as never);

    const page = await queryEvents(
      { range: "7d", profiles: ["a", "b"], errorState: "error" },
      null,
      1,
    );
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf("string");

    const call = lastQuery("usage_query");
    expect(call.sql).toContain("profile IN (@p_0,@p_1)");
    expect(call.sql).toContain("error_code IS NOT NULL");
    expect(call.params).toMatchObject({ p_0: "a", p_1: "b", limit: 2 });
  });

  it("applies the environment filter to event pages", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryEvents({ range: "7d" }, null, 10, "env-2");
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("kimi_code_environment_id = @environment_id");
    expect(call.params).toMatchObject({ environment_id: "env-2" });
  });

  it("decodes a cursor into ts/id predicate params", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    const cursor = btoa(JSON.stringify({ ts: 500, id: "xyz" }));
    await queryEvents({ range: "7d" }, cursor, 10);
    const call = lastQuery("usage_query");
    expect(call.sql).toContain("ts < @cursor_ts");
    expect(call.params).toMatchObject({ cursor_ts: 500, cursor_id: "xyz" });
  });

  it("ignores a malformed cursor", async () => {
    mockedInvoke.mockResolvedValue([] as unknown as never);
    await queryEvents({ range: "7d" }, "not-base64-json", 10);
    expect(lastQuery("usage_query").sql).not.toContain("cursor_ts");
  });
});

describe("pruneOldEvents / purgeAll", () => {
  it("computes a cutoff and issues a DELETE", async () => {
    mockedInvoke.mockResolvedValue(3 as unknown as never);
    await expect(pruneOldEvents(7)).resolves.toBe(3);
    const call = lastQuery("usage_exec");
    expect(call.sql).toMatch(/DELETE FROM events WHERE ts < @cutoff/);
    expect((call.params as Record<string, number>).cutoff).toBeLessThan(Date.now());
  });

  it("purges every table via a script", async () => {
    await purgeAll();
    expect(mockedInvoke).toHaveBeenCalledWith("usage_exec_script", expect.objectContaining({
      sql: expect.stringContaining("DELETE FROM events"),
    }));
  });
});

describe("ingest state", () => {
  it("returns null when no row exists and maps a present row", async () => {
    mockedInvoke.mockResolvedValueOnce([] as unknown as never);
    await expect(getIngestState("/log")).resolves.toBeNull();

    mockedInvoke.mockResolvedValueOnce([{ byte_offset: 99, inode_signature: "sig" }] as unknown as never);
    await expect(getIngestState("/log")).resolves.toEqual({ byteOffset: 99, inodeSignature: "sig" });
  });

  it("upserts ingest state with named params", async () => {
    mockedInvoke.mockResolvedValue(1 as unknown as never);
    await setIngestState("/log", 128, "sig", "ok");
    const call = lastQuery("usage_exec");
    expect(call.sql).toMatch(/INSERT INTO ingest_state/);
    expect(call.params).toMatchObject({ p: "/log", o: 128, sig: "sig", st: "ok" });
  });
});
