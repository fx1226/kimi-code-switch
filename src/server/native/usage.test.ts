import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { usageCommands } from "./usage";
import { storesCommands } from "./stores";

let tmpDir: string;
let dbPath: string;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  request_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  ratio REAL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS ingest_state (source_path TEXT PRIMARY KEY);
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kimi-usage-test-"));
  dbPath = join(tmpDir, "app.db");
  usageCommands.usage_open({ dbPath, schemaSql: SCHEMA });
});

afterEach(() => {
  try {
    usageCommands.usage_close({});
  } catch {
    // 可能已被关闭
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("usage_open / usage_close / reuse", () => {
  it("creates the schema tables from schemaSql", () => {
    const tables = usageCommands.usage_query({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','ingest_state') ORDER BY name",
      params: null,
    });
    expect(tables.map((r) => r.name).sort()).toEqual(["events", "ingest_state"]);
  });

  it("throws db not open after close, then works again after reopen", () => {
    usageCommands.usage_close({});
    expect(() => usageCommands.usage_query({ sql: "SELECT 1", params: null })).toThrow("db not open");

    usageCommands.usage_open({ dbPath, schemaSql: SCHEMA });
    const rows = usageCommands.usage_query({ sql: "SELECT 1 AS one", params: null });
    expect(rows).toEqual([{ one: 1 }]);
  });
});

describe("usage_query / usage_exec / value mapping", () => {
  it("maps SQLite value kinds to JSON (int/real/text/null)", () => {
    const changes = usageCommands.usage_exec({
      sql: "INSERT INTO events (request_id, value, amount, ratio, note) VALUES (@id, @value, @amount, @ratio, @note)",
      params: { id: "req-1", value: "hello", amount: 42, ratio: 1.5, note: null },
    });
    expect(changes).toBe(1);

    const rows = usageCommands.usage_query({
      sql: "SELECT amount, ratio, value, note FROM events WHERE request_id = @id",
      params: { id: "req-1" },
    });
    expect(rows).toEqual([{ amount: 42, ratio: 1.5, value: "hello", note: null }]);
  });

  it("ignores unused named params and binds booleans as integers", () => {
    const changes = usageCommands.usage_exec({
      sql: "INSERT INTO events (request_id, value) VALUES (@id, @value)",
      params: { id: "req-2", value: "x", ghost: 99, flag: true },
    });
    expect(changes).toBe(1);
    expect(usageCommands.usage_query({
      sql: "SELECT COUNT(*) AS cnt FROM events WHERE request_id = @id",
      params: { id: "req-2" },
    })).toEqual([{ cnt: 1 }]);
  });

  it("executes a plain DDL via usage_exec_script", () => {
    usageCommands.usage_exec_script({ sql: "CREATE TABLE extra (a INTEGER); INSERT INTO extra VALUES (1), (2);" });
    const rows = usageCommands.usage_query({ sql: "SELECT SUM(a) AS total FROM extra", params: null });
    expect(rows).toEqual([{ total: 3 }]);
  });
});

describe("usage_exec_batch", () => {
  it("inserts multiple rows in a transaction and returns the affected count", () => {
    const rows = [
      { request_id: "a", value: "1" },
      { request_id: "b", value: "2" },
      { request_id: "c", value: "3" },
    ];
    const inserted = usageCommands.usage_exec_batch({
      sql: "INSERT OR IGNORE INTO events (request_id, value) VALUES (@request_id, @value)",
      rows,
    });
    expect(inserted).toBe(3);
    const count = usageCommands.usage_query({
      sql: "SELECT COUNT(*) AS cnt FROM events",
      params: null,
    });
    expect(count).toEqual([{ cnt: 3 }]);
  });

  it("rolls back on error", () => {
    const rows = [
      { request_id: "dup", value: "1" },
      { request_id: "dup", value: "2" }, // duplicate PK
    ];
    expect(() =>
      usageCommands.usage_exec_batch({
        sql: "INSERT INTO events (request_id, value) VALUES (@request_id, @value)",
        rows,
      }),
    ).toThrow();
    const count = usageCommands.usage_query({ sql: "SELECT COUNT(*) AS cnt FROM events", params: null });
    expect(count).toEqual([{ cnt: 0 }]);
  });
});

describe("legacy native config export/clear", () => {
  it("exports env_config and mcp_servers by environment without mutating", () => {
    usageCommands.usage_exec_script({
      sql: `
        CREATE TABLE env_config (
          kimi_code_environment_id TEXT PRIMARY KEY,
          providers TEXT NOT NULL,
          models TEXT NOT NULL
        );
        CREATE TABLE mcp_servers (
          kimi_code_environment_id TEXT NOT NULL,
          server_name TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          transport TEXT NOT NULL,
          url TEXT NOT NULL,
          command TEXT NOT NULL,
          args TEXT NOT NULL,
          headers TEXT NOT NULL,
          env TEXT NOT NULL,
          extra TEXT
        );
        INSERT INTO env_config VALUES ('work', '{"openai":{"api_key":"secret"}}', '{"model-a":{"provider":"openai"}}');
        INSERT INTO mcp_servers VALUES ('work','local',1,'stdio','','npx','["-y","server"]','{}','{"TOKEN":"secret"}','{"cwd":"/tmp"}');
      `,
    });

    const doc = usageCommands.export_legacy_native_config({});
    const parsed = JSON.parse(doc) as { environments: Record<string, any> };
    expect(parsed.environments.work.providers.openai.api_key).toBe("secret");
    expect(parsed.environments.work.mcpServers.local).toMatchObject({
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
    });
  });

  it("clears recovered rows for registered environments only", () => {
    usageCommands.usage_exec_script({
      sql: `
        CREATE TABLE env_config (
          kimi_code_environment_id TEXT PRIMARY KEY,
          providers TEXT NOT NULL,
          models TEXT NOT NULL
        );
        INSERT INTO env_config VALUES ('work','{}','{}');
        INSERT INTO env_config VALUES ('orphan','{}','{}');
      `,
    });

    usageCommands.clear_recovered_legacy_native_config({ environmentIds: ["work"] });
    const rows = usageCommands.usage_query({
      sql: "SELECT kimi_code_environment_id AS id FROM env_config ORDER BY id",
      params: null,
    });
    expect(rows).toEqual([{ id: "orphan" }]);
  });

  it("returns an empty environment map when no legacy tables exist", () => {
    const doc = usageCommands.export_legacy_native_config({});
    expect(JSON.parse(doc)).toEqual({ environments: {} });
  });
});

// 用 stores 的 init_config_history 验证共享连接复用（同一 db）。
describe("shared connection across stores", () => {
  it("reuses the usage connection for config_history schema", () => {
    storesCommands.init_config_history({});
    const tables = usageCommands.usage_query({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='config_history'",
      params: null,
    });
    expect(tables).toHaveLength(1);
  });
});
