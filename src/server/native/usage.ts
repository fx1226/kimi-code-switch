// Wave 2：用量洞察 SQLite 后端（对齐 src-tauri/src/usage.rs 与
// src-tauri/src/legacy_native_config.rs）。Rust 用一个共享 UsageState 连接供
// usage / config_history / panel_settings / official_accounts 共用；Node 端同样
// 用模块级单例 DatabaseSync 连接，usage_open 打开 + 跑 schema，usage_close 关闭。
// stores.ts 通过本文件导出的 getDb()/queryRows()/run() 等复用同一连接。
//
// 语义对齐点：
// - 前端传裸参数名（from_day 等），绑定前统一加 @ 前缀；只绑定语句里存在的参数
//   （对齐 Rust bind_named 的 parameter_index 检查），多余键静默忽略。
// - 查询返回 {列名: 值} 的行数组；SQLite 值类型映射对齐 rusqlite（INTEGER/REAL→number、
//   TEXT→string、NULL→null、BLOB→string(utf8-lossy)）。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, renameSync } from "node:fs";
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

/** 打开（或新建）共享数据库并执行 schema（对齐 usage_open）。 */
export function openUsageDb(dbPath: string, schemaSql: string): void {
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
export function sqlParam(value: unknown): unknown {
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
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  stmt.setAllowUnknownNamedParameters(true);
  const bound: Record<string, unknown> = {};
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
    return stmt.run(...params.map(sqlParam)).changes;
  }
  const bound = bindNamed(stmt, params as Record<string, unknown> | null);
  return (bound === undefined ? stmt.run() : stmt.run(bound)).changes;
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
): Record<string, unknown> | undefined {
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
        inserted += (bound === undefined ? stmt.run() : stmt.run(bound)).changes;
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

  migrate_legacy_database(): string {
    const candidates = [
      "~/.kimi-code/.panel/app.db",
      "~/.kimi/app.db",
      "~/.kimi/.panel/usage/index.db",
    ];
    const oldDatabases = candidates
      .map((path) => expandHome(path))
      .filter((path) => existsSync(path));
    if (oldDatabases.length === 0) {
      return "No legacy database found, migration skipped";
    }

    const conn = getDb();
    let migratedRows = 0;
    const migratedPaths: string[] = [];
    for (const oldDbPath of oldDatabases) {
      const { inserted, incompleteTables } = mergeLegacyDatabaseFile(conn, oldDbPath);
      if (incompleteTables.length > 0) {
        throw new Error(
          `legacy database ${oldDbPath} has no compatible columns for: ${incompleteTables.join(", ")}; source was retained`,
        );
      }
      migratedRows += inserted;
      migratedPaths.push(oldDbPath);
    }

    for (const oldDbPath of migratedPaths) {
      const target = withExtensionReplaced(oldDbPath, "db.migrated");
      if (existsSync(target)) {
        throw new Error(
          `legacy database ${oldDbPath} was merged but could not be renamed because ${target} already exists`,
        );
      }
      renameSync(oldDbPath, target);
    }

    return `Migrated ${migratedRows} rows from ${migratedPaths.length} legacy database(s); sources renamed after merge`;
  },

  export_legacy_native_config(): string {
    return exportFromConnection(getDb());
  },

  clear_recovered_legacy_native_config(args: Record<string, unknown>): void {
    const environmentIds = (args.environmentIds ?? []) as string[];
    if (environmentIds.length === 0) return;
    const conn = getDb();
    const placeholders = environmentIds.map(() => "?").join(", ");

    if (tableExists(conn, "env_config")) {
      conn
        .prepare(`DELETE FROM env_config WHERE kimi_code_environment_id IN (${placeholders})`)
        .run(...environmentIds);
    }
    if (tableExists(conn, "mcp_servers")) {
      if (tableHasColumn(conn, "mcp_servers", "kimi_code_environment_id")) {
        conn
          .prepare(`DELETE FROM mcp_servers WHERE kimi_code_environment_id IN (${placeholders})`)
          .run(...environmentIds);
      } else if (environmentIds.some((id) => id === "default")) {
        conn.prepare("DELETE FROM mcp_servers").run();
      }
    }
    if (tableExists(conn, "panel_settings") && tableHasColumn(conn, "panel_settings", "mcp_servers")) {
      const environmentColumn = tableHasColumn(conn, "panel_settings", "active_kimi_code_environment_id")
        ? "active_kimi_code_environment_id"
        : "'default'";
      const row = conn
        .prepare(`SELECT ${environmentColumn} FROM panel_settings WHERE id = 1`)
        .get() as { [key: string]: unknown } | undefined;
      const active = row ? String(Object.values(row)[0] ?? "") : "";
      if (environmentIds.some((id) => id === active)) {
        conn.prepare("UPDATE panel_settings SET mcp_servers = '{}' WHERE id = 1").run();
      }
    }
  },
};

// ─────────────────────────── 内部工具 ───────────────────────────

function isSafeSqlIdentifier(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_]+$/.test(value);
}

/** 对齐 Rust Path::with_extension：替换 basename 最后一个点号后的部分。 */
function withExtensionReplaced(path: string, ext: string): string {
  const idx = path.lastIndexOf(".");
  const slashIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= slashIdx) return `${path}.${ext}`;
  return `${path.slice(0, idx)}.${ext}`;
}

function tableExists(conn: DatabaseSync, table: string): boolean {
  const row = conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1")
    .get(table) as { [key: string]: unknown } | undefined;
  return row !== undefined;
}

function tableHasColumn(conn: DatabaseSync, table: string, column: string): boolean {
  const rows = conn.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
    name: string;
  }[];
  return rows.some((r) => r.name === column);
}

function legacyTableNames(conn: DatabaseSync): string[] {
  const rows = conn
    .prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableColumns(conn: DatabaseSync, schema: string, table: string): string[] {
  const rows = conn.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

function mergeLegacyTable(conn: DatabaseSync, table: string): { inserted: number; incomplete: boolean } {
  if (!isSafeSqlIdentifier(table)) {
    return { inserted: 0, incomplete: true };
  }
  if (!tableExists(conn, table)) {
    const createRow = conn
      .prepare("SELECT sql FROM legacy.sqlite_master WHERE type = 'table' AND name = ?1")
      .get(table) as { sql: string } | undefined;
    const createSql = createRow ? createRow.sql : "";
    conn.exec(createSql);
    const inserted = conn
      .prepare(`INSERT INTO main.${table} SELECT * FROM legacy.${table}`)
      .run().changes;
    return { inserted, incomplete: false };
  }

  const sourceColumns = tableColumns(conn, "legacy", table);
  const targetColumns = tableColumns(conn, "main", table);
  const sourceSet = new Set(sourceColumns);
  const columns = targetColumns.filter(
    (column) => sourceSet.has(column) && !(table === "config_history" && column === "id"),
  );
  if (columns.length === 0) {
    return { inserted: 0, incomplete: true };
  }
  const columnList = columns.join(", ");
  const inserted = conn
    .prepare(`INSERT OR IGNORE INTO main.${table} (${columnList}) SELECT ${columnList} FROM legacy.${table}`)
    .run().changes;
  return { inserted, incomplete: false };
}

function mergeLegacyDatabaseFile(
  conn: DatabaseSync,
  oldDbPath: string,
): { inserted: number; incompleteTables: string[] } {
  const escaped = oldDbPath.replace(/'/g, "''");
  conn.exec(`ATTACH DATABASE '${escaped}' AS legacy`);
  let result: { inserted: number; incompleteTables: string[] };
  try {
    const tables = legacyTableNames(conn);
    let insertedRows = 0;
    const incompleteTables: string[] = [];
    for (const table of tables) {
      const { inserted, incomplete } = mergeLegacyTable(conn, table);
      insertedRows += inserted;
      if (incomplete) incompleteTables.push(table);
    }
    result = { inserted: insertedRows, incompleteTables };
  } catch (error) {
    try {
      conn.exec("DETACH DATABASE legacy");
    } catch {
      // 忽略 detach 失败
    }
    throw error;
  }
  try {
    conn.exec("DETACH DATABASE legacy");
  } catch {
    // 忽略 detach 失败
  }
  return result;
}

// ── legacy_native_config.rs：只读导出 ──

function parseObject(document: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(document);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(document: string): unknown[] {
  try {
    const parsed = JSON.parse(document);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function environmentEntry(
  environments: Record<string, Record<string, unknown>>,
  environmentId: string,
): Record<string, unknown> {
  if (!environments[environmentId]) {
    environments[environmentId] = { providers: {}, models: {}, mcpServers: {} };
  }
  return environments[environmentId];
}

function exportFromConnection(conn: DatabaseSync): string {
  const environments: Record<string, Record<string, unknown>> = {};

  if (tableExists(conn, "env_config")) {
    const stmt = conn.prepare("SELECT kimi_code_environment_id, providers, models FROM env_config");
    const rows = stmt.all() as Array<{
      kimi_code_environment_id: string;
      providers: string;
      models: string;
    }>;
    for (const row of rows) {
      const entry = environmentEntry(environments, row.kimi_code_environment_id);
      entry.providers = parseObject(row.providers);
      entry.models = parseObject(row.models);
    }
  }

  if (tableExists(conn, "mcp_servers") && tableHasColumn(conn, "mcp_servers", "server_name")) {
    const environmentColumn = tableHasColumn(conn, "mcp_servers", "kimi_code_environment_id")
      ? "kimi_code_environment_id"
      : "'default'";
    const stmt = conn.prepare(
      `SELECT ${environmentColumn}, server_name, enabled, transport, url, command, args, headers, env, extra FROM mcp_servers`,
    );
    const rows = stmt.all() as Array<{
      [key: string]: unknown;
      enabled: number;
      transport: string;
      url: string;
      command: string;
      args: string;
      headers: string;
      env: string;
      extra: string | null;
    }>;
    for (const row of rows) {
      const environmentId = String(row[environmentColumn] ?? "");
      const entry = environmentEntry(environments, environmentId);
      const servers = entry.mcpServers as Record<string, unknown>;
      const server: Record<string, unknown> = {
        enabled: row.enabled !== 0,
        transport: row.transport,
        url: row.url,
        command: row.command,
        args: parseArray(row.args),
        headers: parseObject(row.headers),
        env: parseObject(row.env),
      };
      if (row.extra != null) {
        const parsed = parseObject(row.extra);
        if (Object.keys(parsed).length > 0) server.extra = parsed;
      }
      servers[String(row.server_name)] = server;
    }
  }

  if (tableExists(conn, "panel_settings") && tableHasColumn(conn, "panel_settings", "mcp_servers")) {
    const environmentColumn = tableHasColumn(conn, "panel_settings", "active_kimi_code_environment_id")
      ? "active_kimi_code_environment_id"
      : "'default'";
    const row = conn
      .prepare(`SELECT ${environmentColumn}, mcp_servers FROM panel_settings WHERE id = 1`)
      .get() as { [key: string]: unknown } | undefined;
    if (row) {
      const keys = Object.keys(row);
      const environmentId = String(row[keys[0]] ?? "");
      const document = String(row[keys[1]] ?? "");
      const entry = environmentEntry(environments, environmentId);
      const servers = entry.mcpServers as Record<string, unknown>;
      for (const [name, server] of Object.entries(parseObject(document))) {
        if (!(name in servers)) servers[name] = server;
      }
    }
  }

  return JSON.stringify({ environments });
}
