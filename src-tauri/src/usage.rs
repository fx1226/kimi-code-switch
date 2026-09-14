//! 用量洞察 SQLite 后端（rusqlite）。对应 Electron 侧 better-sqlite3 的 usageDb.ts。
//!
//! 设计：Rust 持有连接，前端传 SQL + 具名参数。SQL 语句、时间计算、游标编解码、
//! 日志解析等纯逻辑全部保留在前端 TS（usageDb 的 27 条 SQL 几乎原样下传）。
//!
//! 数据库文件：~/.kimi-code-switch-gui/app.db（全局应用数据库）
//! 包含表：usage 相关表、config_history、panel_settings

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Number, Value as Json};

/// 全局应用数据库路径（~/ 前缀由 resolve_home 展开）。
/// 前端 usageDb 也用同一路径打开；其余 Rust 模块（如 official_accounts）应复用此常量，
/// 避免各处硬编码字面量产生漂移。
pub const APP_DB_PATH: &str = "~/.kimi-code-switch-gui/app.db";

pub struct UsageState {
    pub conn: Mutex<Option<Connection>>,
}

impl Default for UsageState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

/// 把前端传来的 JSON 参数值转成 rusqlite 可绑定的值。
fn json_to_sql(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                Value::Null
            }
        }
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

/// 把 SQLite 列值转成 JSON。
fn sql_to_json(value: ValueRef) -> Json {
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(Number::from(i)),
        ValueRef::Real(f) => Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(b) => Json::String(String::from_utf8_lossy(b).to_string()),
    }
}

/// 绑定具名参数：键统一加 `@` 前缀（前端按 usageDb 习惯传 `from_day` 等裸名）。
fn bind_named<'a>(
    stmt: &mut rusqlite::Statement<'a>,
    params: &'a HashMap<String, Json>,
) -> Result<(), String> {
    for (key, val) in params {
        let at_key = format!("@{key}");
        if let Some(idx) = stmt.parameter_index(&at_key).map_err(|e| e.to_string())? {
            stmt.raw_bind_parameter(idx, json_to_sql(val))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 打开（或新建）数据库并执行 schema。dbPath 支持 ~/ 前缀。
#[tauri::command]
pub fn usage_open(
    db_path: String,
    schema_sql: String,
    state: tauri::State<UsageState>,
) -> Result<(), String> {
    let resolved = crate::fs_access::resolve_home(&db_path);
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("ensure db dir: {e}"))?;
    }
    let conn = Connection::open(&resolved).map_err(|e| format!("open db: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; \
         PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;",
    )
    .map_err(|e| format!("pragma: {e}"))?;
    conn.execute_batch(&schema_sql)
        .map_err(|e| format!("schema: {e}"))?;
    *state.conn.lock().unwrap() = Some(conn);
    Ok(())
}

/// 安全地获取数据库连接，处理 poisoned lock。
fn lock_conn<'a>(
    state: &'a tauri::State<UsageState>,
) -> Result<std::sync::MutexGuard<'a, Option<rusqlite::Connection>>, String> {
    state
        .conn
        .lock()
        .map_err(|_| "database lock poisoned".to_string())
}

/// 执行查询，返回行数组（每行是 列名→值 的对象）。
#[tauri::command]
pub fn usage_query(
    sql: String,
    params: Option<HashMap<String, Json>>,
    state: tauri::State<UsageState>,
) -> Result<Vec<Map<String, Json>>, String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("db not open")?;
    let params = params.unwrap_or_default();

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    bind_named(&mut stmt, &params)?;
    let mut rows = stmt.raw_query();

    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("row: {e}"))? {
        let mut obj = Map::new();
        for (i, column_name) in col_names.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| format!("get col {i}: {e}"))?;
            obj.insert(column_name.clone(), sql_to_json(v));
        }
        out.push(obj);
    }
    Ok(out)
}

/// 执行写语句（INSERT/UPDATE/DELETE/DDL），返回受影响行数。
#[tauri::command]
pub fn usage_exec(
    sql: String,
    params: Option<HashMap<String, Json>>,
    state: tauri::State<UsageState>,
) -> Result<usize, String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("db not open")?;
    let params = params.unwrap_or_default();

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
    bind_named(&mut stmt, &params)?;
    let changes = stmt.raw_execute().map_err(|e| format!("execute: {e}"))?;
    Ok(changes)
}

/// 批量插入事件：在单事务内执行同一条 INSERT 多次，返回成功插入数。
/// 对应 usageDb.insertEventsBatch（避免逐行 IPC 往返）。
#[tauri::command]
pub fn usage_exec_batch(
    sql: String,
    rows: Vec<HashMap<String, Json>>,
    state: tauri::State<UsageState>,
) -> Result<usize, String> {
    let mut guard = lock_conn(&state)?;
    let conn = guard.as_mut().ok_or("db not open")?;
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let mut inserted = 0usize;
    {
        let mut stmt = tx.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
        for row in &rows {
            bind_named(&mut stmt, row)?;
            inserted += stmt.raw_execute().map_err(|e| format!("execute: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(inserted)
}

/// 执行多条语句（无返回）。用于 purgeAll 等。
#[tauri::command]
pub fn usage_exec_script(sql: String, state: tauri::State<UsageState>) -> Result<(), String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("db not open")?;
    conn.execute_batch(&sql)
        .map_err(|e| format!("exec script: {e}"))
}

#[tauri::command]
pub fn usage_close(state: tauri::State<UsageState>) -> Result<(), String> {
    *lock_conn(&state)? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_to_sql_maps_primitive_kinds() {
        assert!(matches!(json_to_sql(&Json::Null), Value::Null));
        assert!(matches!(json_to_sql(&Json::Bool(true)), Value::Integer(1)));
        assert!(matches!(json_to_sql(&Json::Bool(false)), Value::Integer(0)));
        assert!(matches!(
            json_to_sql(&Json::Number(Number::from(42))),
            Value::Integer(42)
        ));
        match json_to_sql(&Json::Number(Number::from_f64(1.5).unwrap())) {
            Value::Real(f) => assert_eq!(f, 1.5),
            other => panic!("expected Real, got {other:?}"),
        }
        match json_to_sql(&Json::String("hi".into())) {
            Value::Text(t) => assert_eq!(t, "hi"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn json_to_sql_serializes_compound_kinds_as_text() {
        // 数组/对象等复合类型转字符串文本，避免绑定失败。
        let arr = serde_json::json!([1, 2]);
        match json_to_sql(&arr) {
            Value::Text(t) => assert_eq!(t, "[1,2]"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn resolve_home_expands_tilde_prefix() {
        let home = dirs::home_dir().expect("home dir required");
        assert_eq!(
            crate::fs_access::resolve_home("~/.kimi/usage.db"),
            home.join(".kimi/usage.db")
        );
        assert_eq!(crate::fs_access::resolve_home("~"), home);
    }

    #[test]
    fn resolve_home_keeps_plain_path() {
        assert_eq!(
            crate::fs_access::resolve_home("/tmp/usage.db"),
            std::path::PathBuf::from("/tmp/usage.db")
        );
    }

    fn make_table_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn bind_named_maps_named_params_and_returns_rows() {
        let conn = make_table_conn();
        conn.execute(
            "INSERT INTO events (name, amount) VALUES ('a', 10), ('b', 20), ('a', 30)",
            [],
        )
        .unwrap();

        let mut params: HashMap<String, Json> = HashMap::new();
        params.insert("name".into(), Json::String("a".into()));

        let mut stmt = conn
            .prepare("SELECT amount FROM events WHERE name = @name ORDER BY amount")
            .unwrap();
        bind_named(&mut stmt, &params).unwrap();
        let mut rows = stmt.raw_query();

        let mut amounts = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let v = row.get_ref(0).unwrap();
            amounts.push(sql_to_json(v));
        }
        // 多行映射：name='a' 命中两行 10 与 30。
        assert_eq!(amounts.len(), 2);
        assert_eq!(amounts[0], Json::Number(Number::from(10)));
        assert_eq!(amounts[1], Json::Number(Number::from(30)));
    }

    #[test]
    fn bind_named_empty_result_set() {
        let conn = make_table_conn();
        let mut params: HashMap<String, Json> = HashMap::new();
        params.insert("name".into(), Json::String("missing".into()));

        let mut stmt = conn
            .prepare("SELECT amount FROM events WHERE name = @name")
            .unwrap();
        bind_named(&mut stmt, &params).unwrap();
        let mut rows = stmt.raw_query();
        assert!(rows.next().unwrap().is_none());
    }

    #[test]
    fn bind_named_ignores_unused_param_keys() {
        // SQL 中不含 @ghost 占位符，多余的键应被静默跳过（parameter_index 返回 None）。
        let conn = make_table_conn();
        let mut params: HashMap<String, Json> = HashMap::new();
        params.insert("name".into(), Json::String("a".into()));
        params.insert("ghost".into(), Json::Number(Number::from(99)));

        let mut stmt = conn
            .prepare("SELECT amount FROM events WHERE name = @name")
            .unwrap();
        // 不应 panic / 报错。
        bind_named(&mut stmt, &params).unwrap();
    }

    #[test]
    fn sql_to_json_maps_column_kinds() {
        assert_eq!(sql_to_json(ValueRef::Null), Json::Null);
        assert_eq!(
            sql_to_json(ValueRef::Integer(7)),
            Json::Number(Number::from(7))
        );
        assert_eq!(
            sql_to_json(ValueRef::Text(b"hello")),
            Json::String("hello".into())
        );
    }

    #[test]
    fn merge_legacy_database_keeps_current_rows_and_recovers_non_conflicting_rows() {
        let base = std::env::temp_dir().join(format!(
            "kimi-legacy-db-merge-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let current_path = base.join("current.db");
        let legacy_path = base.join("legacy.db");
        let current = Connection::open(&current_path).unwrap();
        current
            .execute_batch(
                "
                CREATE TABLE events (request_id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE config_history (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  snapshot_at TEXT NOT NULL,
                  kimi_code_environment_id TEXT NOT NULL DEFAULT '',
                  file_id TEXT NOT NULL,
                  sha256 TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  snapshot_path TEXT NOT NULL,
                  target_path TEXT NOT NULL DEFAULT '',
                  description TEXT,
                  UNIQUE(kimi_code_environment_id, file_id, sha256)
                );
                INSERT INTO events VALUES ('shared', 'current');
                INSERT INTO config_history (
                  snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes, snapshot_path, target_path
                ) VALUES ('2026-01-01', 'default', 'config', 'current', 1, '/current.gz', '/cfg');
                ",
            )
            .unwrap();
        let legacy = Connection::open(&legacy_path).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE events (request_id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE config_history (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  snapshot_at TEXT NOT NULL,
                  kimi_code_environment_id TEXT NOT NULL DEFAULT '',
                  file_id TEXT NOT NULL,
                  sha256 TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  snapshot_path TEXT NOT NULL,
                  target_path TEXT NOT NULL DEFAULT '',
                  description TEXT,
                  UNIQUE(kimi_code_environment_id, file_id, sha256)
                );
                INSERT INTO events VALUES ('shared', 'legacy'), ('legacy-only', 'recovered');
                INSERT INTO config_history (
                  snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes, snapshot_path, target_path
                ) VALUES ('2026-01-02', 'default', 'config', 'legacy', 2, '/legacy.gz', '/cfg');
                ",
            )
            .unwrap();
        drop(legacy);

        let (inserted, incomplete) = merge_legacy_database_file(&current, &legacy_path).unwrap();

        assert!(inserted >= 2);
        assert!(incomplete.is_empty());
        assert_eq!(
            current
                .query_row(
                    "SELECT value FROM events WHERE request_id = 'shared'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "current"
        );
        assert_eq!(
            current
                .query_row(
                    "SELECT value FROM events WHERE request_id = 'legacy-only'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "recovered"
        );
        let history_count: i64 = current
            .query_row("SELECT COUNT(*) FROM config_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(history_count, 2);
        let _ = std::fs::remove_dir_all(&base);
    }
}

fn is_safe_sql_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn legacy_table_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map_err(|error| format!("query legacy tables: {error}"))?;
    let result = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| format!("read legacy tables: {error}"))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| format!("collect legacy tables: {error}"));
    result
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|error| format!("check current table {table}: {error}"))
}

fn table_columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>, String> {
    let query = format!("PRAGMA {schema}.table_info({table})");
    let mut statement = conn
        .prepare(&query)
        .map_err(|error| format!("inspect {schema}.{table}: {error}"))?;
    let result = statement
        .query_map([], |row| row.get(1))
        .map_err(|error| format!("read {schema}.{table} columns: {error}"))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| format!("collect {schema}.{table} columns: {error}"));
    result
}

fn merge_legacy_table(conn: &Connection, table: &str) -> Result<(usize, bool), String> {
    if !is_safe_sql_identifier(table) {
        log::warn!("Skipping legacy table with unsafe identifier: {table}");
        return Ok((0, true));
    }
    if !table_exists(conn, table)? {
        let create_sql: String = conn
            .query_row(
                "SELECT sql FROM legacy.sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| format!("read legacy schema for {table}: {error}"))?;
        conn.execute_batch(&create_sql)
            .map_err(|error| format!("create legacy table {table}: {error}"))?;
        let inserted = conn
            .execute(
                &format!("INSERT INTO main.{table} SELECT * FROM legacy.{table}"),
                [],
            )
            .map_err(|error| format!("copy legacy table {table}: {error}"))?;
        return Ok((inserted, false));
    }

    let source_columns = table_columns(conn, "legacy", table)?;
    let target_columns = table_columns(conn, "main", table)?;
    let source_set = source_columns
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let columns = target_columns
        .into_iter()
        .filter(|column| source_set.contains(column))
        // config_history has an auto-assigned integer id and a semantic unique
        // key. Omitting id avoids dropping unrelated old snapshots when the two
        // databases independently allocated the same row id.
        .filter(|column| !(table == "config_history" && column == "id"))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Ok((0, true));
    }
    let column_list = columns.join(", ");
    let inserted = conn
        .execute(
            &format!(
                "INSERT OR IGNORE INTO main.{table} ({column_list}) SELECT {column_list} FROM legacy.{table}"
            ),
            [],
        )
        .map_err(|error| format!("merge legacy table {table}: {error}"))?;
    Ok((inserted, false))
}

fn merge_legacy_database_file(
    conn: &Connection,
    old_db_path: &std::path::Path,
) -> Result<(usize, Vec<String>), String> {
    let old_db_path_text = old_db_path.to_string_lossy().to_string();
    conn.execute("ATTACH DATABASE ?1 AS legacy", [old_db_path_text])
        .map_err(|error| format!("attach legacy database {}: {error}", old_db_path.display()))?;
    let migration = (|| -> Result<(usize, Vec<String>), String> {
        let tables = legacy_table_names(conn)?;
        let mut inserted_rows = 0usize;
        let mut incomplete_tables = Vec::new();
        for table in tables {
            let (inserted, incomplete) = merge_legacy_table(conn, &table)?;
            inserted_rows += inserted;
            if incomplete {
                incomplete_tables.push(table);
            }
        }
        Ok((inserted_rows, incomplete_tables))
    })();
    let detach = conn.execute("DETACH DATABASE legacy", []);
    match (migration, detach) {
        (Ok(result), Ok(_)) => Ok(result),
        (Err(error), Ok(_)) => Err(error),
        (Ok(_), Err(error)) => Err(format!("detach legacy database: {error}")),
        (Err(error), Err(detach_error)) => {
            Err(format!("{error}; detach legacy database: {detach_error}"))
        }
    }
}

/// Merge all known legacy GUI databases into the current database. Existing
/// current rows win on key conflicts; old rows are otherwise inserted and the
/// source database is renamed only after a complete successful merge.
#[tauri::command]
pub fn migrate_legacy_database(state: tauri::State<UsageState>) -> Result<String, String> {
    let legacy_candidates = [
        "~/.kimi-code/.panel/app.db",
        "~/.kimi/app.db",
        "~/.kimi/.panel/usage/index.db",
    ];
    let old_databases = legacy_candidates
        .iter()
        .map(|path| crate::fs_access::resolve_home(path))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    if old_databases.is_empty() {
        return Ok("No legacy database found, migration skipped".to_string());
    }

    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;
    let mut migrated_rows = 0usize;
    let mut migrated_paths = Vec::new();
    for old_db_path in &old_databases {
        let (inserted, incomplete_tables) = merge_legacy_database_file(conn, old_db_path)?;
        if !incomplete_tables.is_empty() {
            return Err(format!(
                "legacy database {} has no compatible columns for: {}; source was retained",
                old_db_path.display(),
                incomplete_tables.join(", "),
            ));
        }
        migrated_rows += inserted;
        migrated_paths.push(old_db_path.clone());
    }
    drop(guard);

    for old_db_path in &migrated_paths {
        let migrated_path = old_db_path.with_extension("db.migrated");
        if migrated_path.exists() {
            return Err(format!(
                "legacy database {} was merged but could not be renamed because {} already exists",
                old_db_path.display(),
                migrated_path.display(),
            ));
        }
        std::fs::rename(old_db_path, &migrated_path).map_err(|error| {
            format!("rename legacy database {}: {error}", old_db_path.display())
        })?;
    }

    Ok(format!(
        "Migrated {migrated_rows} rows from {} legacy database(s); sources renamed after merge",
        migrated_paths.len(),
    ))
}
