// Shared private SQLite connection for panel settings and configuration history.
// Legacy data is handled only by the explicit copy-only migration facade.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { expandHome } from "./paths";
import type { CommandHandlers } from "./index";

type SqlParams = Record<string, unknown> | unknown[] | null | undefined;

let db: DatabaseSync | null = null;

/** 返回共享连接；未打开时抛错（对齐 Rust lock_conn 的 "db not open"）。 */
export function getDb(): DatabaseSync {
  if (!db) throw new Error("db not open");
  return db;
}

/** 连接是否已打开。 */
export function isDbOpen(): boolean {
  return db !== null;
}

/** 打开（或新建）共享数据库并执行 schema（对齐 usage_open）；已打开时幂等返回，避免覆盖未关闭连接泄漏。 */
export function openUsageDb(dbPath: string, schemaSql: string): void {
  if (db !== null) return;
  const resolved = expandHome(dbPath);
  const parent = dirname(resolved);
  mkdirSync(parent, { recursive: true });
  const conn = new DatabaseSync(resolved);
  conn.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; " +
      "PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;",
  );
  conn.exec(schemaSql);
  db = conn;
}

/** 关闭共享连接（对齐 usage_close）。 */
export function closeUsageDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // 连接可能已被外部关闭；幂等关闭即可。
    }
    db = null;
  }
}

/** JSON 参数值 → SQLite 可绑定值（对齐 Rust json_to_sql）。 */
export function sqlParam(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
      return value ? 1 : 0;
    case "number":
      return value;
    case "string":
      return value;
    case "bigint":
      return Number(value);
    default:
      return JSON.stringify(value);
  }
}

/** SQLite 列值 → JSON（对齐 Rust sql_to_json）。 */
export function sqlToJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value;
}

/** 绑定具名参数：键加 @ 前缀；多余键被 setAllowUnknownNamedParameters 静默忽略。 */
export function bindNamed(
  stmt: import("node:sqlite").StatementSync,
  params: Record<string, unknown> | null | undefined,
): Record<string, SQLInputValue> | undefined {
  if (!params) return undefined;
  stmt.setAllowUnknownNamedParameters(true);
  const bound: Record<string, SQLInputValue> = {};
  for (const [key, value] of Object.entries(params)) {
    bound[key.startsWith("@") ? key : `@${key}`] = sqlParam(value);
  }
  return bound;
}

/** 执行查询，返回 {列名: 值} 的行数组。 */
export function queryRows(sql: string, params: SqlParams = null): Record<string, unknown>[] {
  const conn = getDb();
  const stmt = conn.prepare(sql);
  const colNames = stmt.columns().map((c) => c.name);
  let rows: Record<string, unknown>[];
  if (Array.isArray(params)) {
    rows = stmt.all(...params.map(sqlParam)) as unknown as Record<string, unknown>[];
  } else {
    const bound = bindNamed(stmt, params as Record<string, unknown> | null);
    rows = (bound === undefined ? stmt.all() : stmt.all(bound)) as unknown as Record<string, unknown>[];
  }
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const name of colNames) obj[name] = sqlToJson(row[name]);
    return obj;
  });
}

/** 查询单行（无行返回 null）。 */
export function queryRow(sql: string, params: SqlParams = null): Record<string, unknown> | null {
  const rows = queryRows(sql, params);
  return rows[0] ?? null;
}

/** 执行写语句（INSERT/UPDATE/DELETE/DDL），返回受影响行数（对齐 usage_exec）。 */
export function run(sql: string, params: SqlParams = null): number {
  const conn = getDb();
  const stmt = conn.prepare(sql);
  if (Array.isArray(params)) {
    return Number(stmt.run(...params.map(sqlParam)).changes);
  }
  const bound = bindNamed(stmt, params as Record<string, unknown> | null);
  return Number((bound === undefined ? stmt.run() : stmt.run(bound)).changes);
}

/** 单行查询并返回首列原始值（供 last_insert_rowid 等场景）。 */
export function scalar(sql: string, params: SqlParams = null): unknown {
  const row = queryRow(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

// ─────────────────────────── 命令注册 ───────────────────────────

function bindNamedArgs(
  stmt: import("node:sqlite").StatementSync,
  params: Record<string, unknown> | null | undefined,
): Record<string, SQLInputValue> | undefined {
  return bindNamed(stmt, params);
}

export const usageCommands: CommandHandlers = {
  usage_open(args: Record<string, unknown>): void {
    openUsageDb(String(args.dbPath ?? ""), String(args.schemaSql ?? ""));
  },

  usage_query(args: Record<string, unknown>): Record<string, unknown>[] {
    const sql = String(args.sql ?? "");
    const params = (args.params ?? null) as Record<string, unknown> | null;
    return queryRows(sql, params);
  },

  usage_exec(args: Record<string, unknown>): number {
    const sql = String(args.sql ?? "");
    const params = (args.params ?? null) as Record<string, unknown> | null;
    return run(sql, params);
  },

  usage_exec_batch(args: Record<string, unknown>): number {
    const sql = String(args.sql ?? "");
    const rows = (args.rows ?? []) as Record<string, unknown>[];
    const conn = getDb();
    conn.exec("BEGIN;");
    let inserted = 0;
    try {
      const stmt = conn.prepare(sql);
      for (const row of rows) {
        const bound = bindNamedArgs(stmt, row);
        inserted += Number((bound === undefined ? stmt.run() : stmt.run(bound)).changes);
      }
      conn.exec("COMMIT;");
    } catch (error) {
      conn.exec("ROLLBACK;");
      throw error;
    }
    return inserted;
  },

  usage_exec_script(args: Record<string, unknown>): void {
    getDb().exec(String(args.sql ?? ""));
  },

  usage_close(): void {
    closeUsageDb();
  },

};
