//! Read-only recovery bridge for configuration that older GUI releases copied
//! into SQLite. The renderer uses this only during upgrade to merge missing
//! definitions into each registered native KIMI_CODE_HOME.

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

fn lock_conn<'a>(
    state: &'a tauri::State<crate::usage::UsageState>,
) -> Result<std::sync::MutexGuard<'a, Option<rusqlite::Connection>>, String> {
    state
        .conn
        .lock()
        .map_err(|_| "database lock poisoned".to_string())
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|error| format!("check legacy table {table}: {error}"))
}

fn table_has_column(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .map_err(|error| format!("inspect legacy table {table}: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("read legacy table {table}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read legacy table {table}: {error}"))?;
    Ok(columns.iter().any(|value| value == column))
}

fn parse_object(document: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(document)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn parse_array(document: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(document)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn environment_entry<'a>(
    environments: &'a mut Map<String, Value>,
    environment_id: &str,
) -> &'a mut Map<String, Value> {
    if !environments.contains_key(environment_id) {
        environments.insert(
            environment_id.to_string(),
            json!({ "providers": {}, "models": {}, "mcpServers": {} }),
        );
    }
    environments
        .get_mut(environment_id)
        .and_then(Value::as_object_mut)
        .expect("legacy environment entry is always an object")
}

/// Export old SQLite mirrors without mutating or deleting them. Entries are
/// keyed by Kimi Code environment id so the renderer can merge only into
/// registered homes and leave orphaned data untouched.
fn export_from_connection(conn: &rusqlite::Connection) -> Result<String, String> {
    let mut environments = Map::<String, Value>::new();

    if table_exists(conn, "env_config")? {
        let mut statement = conn
            .prepare("SELECT kimi_code_environment_id, providers, models FROM env_config")
            .map_err(|error| format!("read legacy env_config: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("query legacy env_config: {error}"))?;
        for row in rows {
            let (environment_id, providers, models) =
                row.map_err(|error| format!("read legacy env_config row: {error}"))?;
            let entry = environment_entry(&mut environments, &environment_id);
            entry.insert(
                "providers".to_string(),
                Value::Object(parse_object(&providers)),
            );
            entry.insert("models".to_string(), Value::Object(parse_object(&models)));
        }
    }

    if table_exists(conn, "mcp_servers")? && table_has_column(conn, "mcp_servers", "server_name")? {
        // Very old releases had a globally unique server name without an
        // environment column. Those entries belong to the default home.
        let environment_column =
            if table_has_column(conn, "mcp_servers", "kimi_code_environment_id")? {
                "kimi_code_environment_id"
            } else {
                "'default'"
            };
        let mut statement = conn
            .prepare(&format!(
                "SELECT {environment_column}, server_name, enabled, transport, url, command, args, headers, env, extra FROM mcp_servers"
            ))
            .map_err(|error| format!("read legacy mcp_servers: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|error| format!("query legacy mcp_servers: {error}"))?;
        for row in rows {
            let (environment_id, name, enabled, transport, url, command, args, headers, env, extra) =
                row.map_err(|error| format!("read legacy mcp_servers row: {error}"))?;
            let entry = environment_entry(&mut environments, &environment_id);
            let servers = entry
                .get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .expect("legacy MCP map is always an object");
            let mut server = Map::new();
            server.insert("enabled".to_string(), Value::Bool(enabled != 0));
            server.insert("transport".to_string(), Value::String(transport));
            server.insert("url".to_string(), Value::String(url));
            server.insert("command".to_string(), Value::String(command));
            server.insert("args".to_string(), Value::Array(parse_array(&args)));
            server.insert("headers".to_string(), Value::Object(parse_object(&headers)));
            server.insert("env".to_string(), Value::Object(parse_object(&env)));
            if let Some(extra) = extra {
                let parsed = parse_object(&extra);
                if !parsed.is_empty() {
                    server.insert("extra".to_string(), Value::Object(parsed));
                }
            }
            servers.insert(name, Value::Object(server));
        }
    }

    if table_exists(conn, "panel_settings")?
        && table_has_column(conn, "panel_settings", "mcp_servers")?
    {
        let environment_column =
            if table_has_column(conn, "panel_settings", "active_kimi_code_environment_id")? {
                "active_kimi_code_environment_id"
            } else {
                "'default'"
            };
        let row: Option<(String, String)> = conn
            .query_row(
                &format!(
                    "SELECT {environment_column}, mcp_servers FROM panel_settings WHERE id = 1"
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read legacy panel MCP: {error}"))?;
        if let Some((environment_id, document)) = row {
            let entry = environment_entry(&mut environments, &environment_id);
            let servers = entry
                .get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .expect("legacy MCP map is always an object");
            for (name, server) in parse_object(&document) {
                servers.entry(name).or_insert(server);
            }
        }
    }

    Ok(json!({ "environments": environments }).to_string())
}

/// Export old SQLite mirrors without mutating or deleting them. Entries are
/// keyed by Kimi Code environment id so the renderer can merge only into
/// registered homes and leave orphaned data untouched.
#[tauri::command]
pub fn export_legacy_native_config(
    state: tauri::State<crate::usage::UsageState>,
) -> Result<String, String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;
    export_from_connection(conn)
}

/// Clear recovered mirror rows only for environments currently registered by
/// the GUI. Unknown environment ids remain available through the read-only
/// export command instead of being silently discarded.
#[tauri::command]
pub fn clear_recovered_legacy_native_config(
    environment_ids: Vec<String>,
    state: tauri::State<crate::usage::UsageState>,
) -> Result<(), String> {
    if environment_ids.is_empty() {
        return Ok(());
    }
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;
    let placeholders = std::iter::repeat("?")
        .take(environment_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    if table_exists(conn, "env_config")? {
        conn.execute(
            &format!("DELETE FROM env_config WHERE kimi_code_environment_id IN ({placeholders})"),
            rusqlite::params_from_iter(environment_ids.iter()),
        )
        .map_err(|error| format!("clear recovered legacy env_config: {error}"))?;
    }
    if table_exists(conn, "mcp_servers")? {
        if table_has_column(conn, "mcp_servers", "kimi_code_environment_id")? {
            conn.execute(
                &format!(
                    "DELETE FROM mcp_servers WHERE kimi_code_environment_id IN ({placeholders})"
                ),
                rusqlite::params_from_iter(environment_ids.iter()),
            )
            .map_err(|error| format!("clear recovered legacy mcp_servers: {error}"))?;
        } else if environment_ids.iter().any(|id| id == "default") {
            conn.execute("DELETE FROM mcp_servers", [])
                .map_err(|error| format!("clear recovered unscoped legacy mcp_servers: {error}"))?;
        }
    }
    if table_exists(conn, "panel_settings")?
        && table_has_column(conn, "panel_settings", "mcp_servers")?
    {
        let environment_column =
            if table_has_column(conn, "panel_settings", "active_kimi_code_environment_id")? {
                "active_kimi_code_environment_id"
            } else {
                "'default'"
            };
        let active_environment: Option<String> = conn
            .query_row(
                &format!("SELECT {environment_column} FROM panel_settings WHERE id = 1"),
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read recovered legacy panel MCP: {error}"))?;
        if active_environment
            .as_ref()
            .is_some_and(|environment_id| environment_ids.iter().any(|id| id == environment_id))
        {
            conn.execute(
                "UPDATE panel_settings SET mcp_servers = '{}' WHERE id = 1",
                [],
            )
            .map_err(|error| format!("clear recovered legacy panel MCP: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_empty_environment_map_when_no_legacy_tables_exist() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let result: Value = serde_json::from_str(&export_from_connection(&conn).unwrap()).unwrap();

        assert_eq!(result, json!({ "environments": {} }));
    }

    #[test]
    fn exports_env_and_mcp_data_by_environment_without_schema_changes() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
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
            INSERT INTO mcp_servers VALUES ('work', 'local', 1, 'stdio', '', 'npx', '["-y","server"]', '{}', '{"TOKEN":"secret"}', '{"cwd":"/tmp"}');
            "#,
        )
        .unwrap();

        let result: Value = serde_json::from_str(&export_from_connection(&conn).unwrap()).unwrap();
        assert_eq!(
            result["environments"]["work"]["providers"]["openai"]["api_key"],
            "secret"
        );
        assert_eq!(
            result["environments"]["work"]["models"]["model-a"]["provider"],
            "openai"
        );
        assert_eq!(
            result["environments"]["work"]["mcpServers"]["local"],
            json!({
                "enabled": true,
                "transport": "stdio",
                "url": "",
                "command": "npx",
                "args": ["-y", "server"],
                "headers": {},
                "env": {"TOKEN": "secret"},
                "extra": {"cwd": "/tmp"}
            })
        );

        let table_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('env_config', 'mcp_servers')",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(table_count, 2);
    }

    #[test]
    fn assigns_unscoped_old_mcp_table_to_default_environment() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE mcp_servers (
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
            INSERT INTO mcp_servers VALUES ('remote', 0, 'streamable-http', 'https://mcp.example.test', '', '[]', '{"Authorization":"Bearer value"}', '{}', NULL);
            "#,
        ).unwrap();

        let result: Value = serde_json::from_str(&export_from_connection(&conn).unwrap()).unwrap();
        assert_eq!(
            result["environments"]["default"]["mcpServers"]["remote"]["enabled"],
            false
        );
        assert_eq!(
            result["environments"]["default"]["mcpServers"]["remote"]["url"],
            "https://mcp.example.test"
        );
    }

    #[test]
    fn recovers_panel_mcp_when_an_unrelated_mcp_table_has_an_unknown_schema() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE mcp_servers (obsolete INTEGER);
            CREATE TABLE panel_settings (
              id INTEGER PRIMARY KEY,
              active_kimi_code_environment_id TEXT NOT NULL,
              mcp_servers TEXT NOT NULL
            );
            INSERT INTO panel_settings VALUES (
              1, 'work', '{"legacy":{"transport":"stdio","command":"npx"}}'
            );
            "#,
        )
        .unwrap();

        let result: Value = serde_json::from_str(&export_from_connection(&conn).unwrap()).unwrap();
        assert_eq!(
            result["environments"]["work"]["mcpServers"]["legacy"]["command"],
            "npx"
        );
    }
}
