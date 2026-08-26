//! 配置历史版本管理。
//!
//! 功能：自动快照、版本查询、回滚、自动清理。
//! 存储：SQLite 元数据（~/.kimi-code-switch-gui/app.db 的 config_history 表）
//!       + 文件系统快照内容（~/.kimi-code-switch-gui/history/{id}.toml.gz）

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;

/// 安全地获取数据库连接，处理 poisoned lock。
fn lock_conn<'a>(
    state: &'a tauri::State<crate::usage::UsageState>,
) -> Result<std::sync::MutexGuard<'a, Option<rusqlite::Connection>>, String> {
    state
        .conn
        .lock()
        .map_err(|_| "database lock poisoned".to_string())
}

/// 配置历史表 schema。
///
/// 设计要点：
/// - UNIQUE(kimi_code_environment_id, file_id, sha256) 实现环境内去重
/// - snapshot_at 索引支持时间范围查询
/// - file_id 索引支持按文件类型过滤
pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS config_history (
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

CREATE INDEX IF NOT EXISTS idx_history_time
  ON config_history(snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_history_file
  ON config_history(file_id, snapshot_at DESC);
"#;

fn history_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("cannot resolve home dir")?
        .join(".kimi-code-switch-gui/history"))
}

fn legacy_history_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    Ok(vec![
        home.join(".kimi-code/.panel/history"),
        home.join(".kimi/.panel/history"),
    ])
}

fn ensure_history_dir() -> Result<PathBuf, String> {
    let target = history_dir()?;
    std::fs::create_dir_all(&target).map_err(|e| format!("create history dir: {e}"))?;
    set_private_directory_permissions(&target)?;

    if let Ok(legacy_dirs) = legacy_history_dirs() {
        for legacy in legacy_dirs {
            if legacy.exists() && legacy != target {
                if let Ok(entries) = std::fs::read_dir(&legacy) {
                    for entry in entries.flatten() {
                        let source = entry.path();
                        if !source.is_file() {
                            continue;
                        }
                        let Some(file_name) = source.file_name() else {
                            continue;
                        };
                        let destination = target.join(file_name);
                        if !destination.exists() {
                            // 优先 rename；跨设备失败时退回 copy 并删源（避免旧文件残留，
                            // 否则每次启动都会重复尝试迁移）。失败仅告警，不中断启动。
                            if std::fs::rename(&source, &destination).is_err() {
                                match std::fs::copy(&source, &destination) {
                                    Ok(_) => {
                                        let _ = std::fs::remove_file(&source);
                                    }
                                    Err(e) => {
                                        log::warn!(
                                            "migrate history snapshot {} failed: {e}",
                                            source.display()
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(target)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("set history directory permissions: {e}"))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn write_private_snapshot(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("create private snapshot {}: {e}", path.display()))?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("write private snapshot {}: {e}", path.display()))
}

fn migrate_history_snapshot_paths(
    conn: &rusqlite::Connection,
    legacy: &PathBuf,
    target: &PathBuf,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, snapshot_path FROM config_history")
        .map_err(|e| format!("query history snapshot paths: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("map history snapshot paths: {e}"))?;

    for row in rows {
        let (id, snapshot_path) =
            row.map_err(|e| format!("read history snapshot path row: {e}"))?;
        let current = PathBuf::from(&snapshot_path);
        if !current.starts_with(legacy) {
            continue;
        }
        let Some(file_name) = current.file_name() else {
            continue;
        };
        let next = target.join(file_name);
        conn.execute(
            "UPDATE config_history SET snapshot_path = ?1 WHERE id = ?2",
            rusqlite::params![next.to_string_lossy().to_string(), id],
        )
        .map_err(|e| format!("update history snapshot path: {e}"))?;
    }

    Ok(())
}

fn ensure_config_history_environment_column(conn: &rusqlite::Connection) -> Result<(), String> {
    // C4：多步 schema 迁移放进单一 savepoint。任一步失败则回滚到 SAVEPOINT，
    // 避免中途崩溃/报错留下半迁移状态。migrate_config_history_unique_constraint 内部的
    // BEGIN/COMMIT 在已开启外层 write 事务时被 SQLite 当作同一事务的一部分处理，
    // savepoint 保证整个迁移原子可回滚。
    conn.execute_batch("SAVEPOINT cfg_history_migration;")
        .map_err(|e| format!("begin config_history migration transaction: {e}"))?;
    let migration_result = (|| -> Result<(), String> {
        conn.execute(
            "ALTER TABLE config_history ADD COLUMN kimi_code_environment_id TEXT NOT NULL DEFAULT ''",
            [],
        )
        .or_else(|e| {
            if e.to_string().contains("duplicate column name") {
                Ok(0)
            } else {
                Err(e)
            }
        })
        .map_err(|e| format!("add config_history environment column: {e}"))?;
        conn.execute(
            "ALTER TABLE config_history ADD COLUMN target_path TEXT NOT NULL DEFAULT ''",
            [],
        )
        .or_else(|e| {
            if e.to_string().contains("duplicate column name") {
                Ok(0)
            } else {
                Err(e)
            }
        })
        .map_err(|e| format!("add config_history target path column: {e}"))?;

        conn.execute(
            "UPDATE config_history SET kimi_code_environment_id = 'legacy-unassigned'
             WHERE TRIM(kimi_code_environment_id) = ''",
            [],
        )
        .map_err(|e| format!("mark legacy config_history rows: {e}"))?;

        migrate_config_history_unique_constraint(conn)?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_history_environment_time ON config_history(kimi_code_environment_id, snapshot_at DESC)",
            [],
        )
        .map_err(|e| format!("create config_history environment index: {e}"))?;
        Ok(())
    })();
    match migration_result {
        Ok(()) => conn
            .execute_batch("RELEASE SAVEPOINT cfg_history_migration;")
            .map_err(|e| format!("commit config_history migration: {e}")),
        Err(error) => {
            let rollback = conn.execute_batch("ROLLBACK TO SAVEPOINT cfg_history_migration;");
            let _ = conn.execute_batch("RELEASE SAVEPOINT cfg_history_migration;");
            if let Err(rollback_error) = rollback {
                return Err(format!(
                    "migrate config_history environment column failed ({error}) and rollback failed ({rollback_error})"
                ));
            }
            Err(error)
        }
    }
}

fn migrate_config_history_unique_constraint(conn: &rusqlite::Connection) -> Result<(), String> {
    let create_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'config_history'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("read config_history schema: {e}"))?;
    let normalized = create_sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.contains("UNIQUE(kimi_code_environment_id, file_id, sha256)") {
        return Ok(());
    }

    let migration_result = conn.execute_batch(
        r#"
        SAVEPOINT cfg_history_unique_migration;
        DROP INDEX IF EXISTS idx_history_time;
        DROP INDEX IF EXISTS idx_history_file;
        DROP INDEX IF EXISTS idx_history_environment_time;
        ALTER TABLE config_history RENAME TO config_history_legacy;
        CREATE TABLE config_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          snapshot_at TEXT NOT NULL,
          kimi_code_environment_id TEXT NOT NULL DEFAULT 'legacy-unassigned',
          file_id TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          snapshot_path TEXT NOT NULL,
          target_path TEXT NOT NULL DEFAULT '',
          description TEXT,
          UNIQUE(kimi_code_environment_id, file_id, sha256)
        );
        INSERT INTO config_history (
          id, snapshot_at, kimi_code_environment_id, file_id, sha256,
          size_bytes, snapshot_path, target_path, description
        )
        SELECT
          id, snapshot_at,
          CASE WHEN TRIM(kimi_code_environment_id) = '' THEN 'legacy-unassigned'
               ELSE kimi_code_environment_id END,
          file_id, sha256, size_bytes, snapshot_path, target_path, description
        FROM config_history_legacy;
        DROP TABLE config_history_legacy;
        CREATE INDEX idx_history_time ON config_history(snapshot_at DESC);
        CREATE INDEX idx_history_file ON config_history(file_id, snapshot_at DESC);
        RELEASE SAVEPOINT cfg_history_unique_migration;
        "#,
    );
    if let Err(error) = migration_result {
        let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT cfg_history_unique_migration;");
        let _ = conn.execute_batch("RELEASE SAVEPOINT cfg_history_unique_migration;");
        return Err(format!("migrate config_history unique constraint: {error}"));
    }
    Ok(())
}

fn backfill_history_target_paths(conn: &rusqlite::Connection) -> Result<(), String> {
    let panel_table_exists: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='panel_settings'")
        .map_err(|e| format!("prepare panel_settings existence check: {e}"))?
        .exists([])
        .map_err(|e| format!("check panel_settings existence: {e}"))?;
    if !panel_table_exists {
        return Ok(());
    }

    let environments_json: Option<String> = conn
        .query_row(
            "SELECT kimi_code_environments FROM panel_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(environments_json) = environments_json else {
        return Ok(());
    };
    let environments = serde_json::from_str::<serde_json::Value>(&environments_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();

    for environment in environments {
        let Some(environment_id) = environment.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(home_path) = environment.get("homePath").and_then(|value| value.as_str()) else {
            continue;
        };
        if environment_id.trim().is_empty() || home_path.trim().is_empty() {
            continue;
        }
        let home = home_path.trim_end_matches('/');
        for (file_id, file_name) in [
            ("config", "config.toml"),
            ("mcp", "mcp.json"),
            ("tui", "tui.toml"),
            ("agents", "AGENTS.md"),
            ("skills", "skills"),
        ] {
            let target_path = format!("{home}/{file_name}");
            conn.execute(
                "UPDATE config_history SET target_path = ?1
                 WHERE kimi_code_environment_id = ?2 AND file_id = ?3
                   AND TRIM(target_path) = ''",
                rusqlite::params![target_path, environment_id, file_id],
            )
            .map_err(|e| format!("backfill history target for {environment_id}/{file_id}: {e}"))?;
        }
    }
    Ok(())
}

/// 初始化配置历史表。
///
/// 调用时机：应用启动时，在 usage_open 之后执行。
/// 注意：复用 usage.rs 的 SQLite 连接，不单独创建数据库文件。
#[tauri::command]
pub fn init_config_history(state: tauri::State<crate::usage::UsageState>) -> Result<(), String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;

    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("init config_history schema: {e}"))?;
    ensure_config_history_environment_column(conn)?;
    backfill_history_target_paths(conn)?;

    // 确保 history 目录存在，并把旧目录中的快照路径迁移到 Kimi Code 标准目录。
    let target_history_dir = ensure_history_dir()?;
    if let Ok(legacy_dirs) = legacy_history_dirs() {
        for legacy in legacy_dirs {
            migrate_history_snapshot_paths(conn, &legacy, &target_history_dir)?;
        }
    }

    Ok(())
}

/// 辅助函数：计算字符串的 SHA256
fn compute_sha256(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 辅助函数：gzip 压缩
fn gzip_compress(content: &str) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(content.as_bytes())
        .map_err(|e| format!("gzip write: {e}"))?;
    encoder.finish().map_err(|e| format!("gzip finish: {e}"))
}

/// 捕获配置快照。
///
/// 流程：
/// 1. 读取配置内容：
///    - file_id="panel": 从 SQLite 导出 JSON（无需文件路径）
///    - 其他: 读取 TOML 文件
/// 2. 计算 SHA256
/// 3. 检查是否已存在（去重）
/// 4. gzip 压缩
/// 5. 保存到 ~/.kimi-code-switch-gui/history/{timestamp_ms}-{file_id}.{json|toml}.gz
/// 6. 插入 SQLite 记录
///
/// 错误处理：快照失败时记录错误日志，返回 Ok(None)，不阻塞调用方。
#[tauri::command]
pub fn capture_snapshot(
    file_id: String,
    file_path: String,
    description: Option<String>,
    kimi_code_environment_id: Option<String>,
    state: tauri::State<crate::usage::UsageState>,
) -> Result<Option<i64>, String> {
    if !matches!(
        file_id.as_str(),
        "config" | "panel" | "mcp" | "tui" | "agents" | "skills"
    ) {
        return Err(format!("unsupported snapshot file_id: {file_id}"));
    }
    // 读取配置内容
    let content = if file_id == "panel" {
        // Panel settings 从 SQLite 导出 JSON
        match crate::panel_settings_store::get_panel_settings(state.clone())? {
            Some(json) => json,
            None => {
                log::warn!("Panel settings not found in database, skipping snapshot");
                return Ok(None);
            }
        }
    } else if file_id == "skills" {
        match crate::fs_access::export_portable_directory(file_path.clone()) {
            Ok(bundle) => serde_json::to_string(&bundle)
                .map_err(|error| format!("serialize Skills snapshot: {error}"))?,
            Err(error) => {
                log::error!("Failed to read Skills for snapshot: {error}");
                return Ok(None);
            }
        }
    } else {
        // 其他配置文件从磁盘读取
        let resolved_path = crate::fs_access::resolve_home(&file_path);
        match fs::read_to_string(&resolved_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("Failed to read file for snapshot: {e}");
                return Ok(None); // 失败不阻塞
            }
        }
    };

    let size_bytes = content.len() as i64;
    let sha256 = compute_sha256(&content);

    // 检查是否已存在（去重）
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;

    let environment_id = kimi_code_environment_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "legacy-unassigned".to_string());
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM config_history
             WHERE kimi_code_environment_id = ?1 AND file_id = ?2 AND sha256 = ?3",
            rusqlite::params![environment_id, file_id, sha256],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if exists {
        log::info!("Snapshot already exists (deduplicated): {file_id} {sha256}");
        return Ok(None);
    }

    // gzip 压缩
    let compressed = match gzip_compress(&content) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to compress snapshot: {e}");
            return Ok(None);
        }
    };

    // 保存到文件系统
    let history_dir = ensure_history_dir()?;

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let safe_environment_id: String = environment_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    let extension = if file_id == "panel" || file_id == "skills" {
        "json"
    } else {
        "toml"
    };
    let snapshot_filename = format!(
        "{}-{}-{}.{}.gz",
        timestamp_ms, safe_environment_id, file_id, extension
    );
    let snapshot_path = history_dir.join(&snapshot_filename);

    if let Err(e) = write_private_snapshot(&snapshot_path, &compressed) {
        log::error!("Failed to write snapshot file: {e}");
        return Ok(None);
    }

    // 插入 SQLite 记录
    let snapshot_at = chrono::Utc::now().to_rfc3339();
    let snapshot_path_str = snapshot_path.to_string_lossy().to_string();
    match conn.execute(
        "INSERT INTO config_history (
           snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes,
           snapshot_path, target_path, description
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            snapshot_at,
            environment_id,
            file_id,
            sha256,
            size_bytes,
            snapshot_path_str,
            file_path,
            description
        ],
    ) {
        Ok(_) => {
            let id = conn.last_insert_rowid();
            log::info!("Snapshot created: id={id}, file_id={file_id}, size={size_bytes}");
            Ok(Some(id))
        }
        Err(e) => {
            log::error!("Failed to insert snapshot record: {e}");
            // 清理文件系统快照
            let _ = fs::remove_file(&snapshot_path);
            Ok(None)
        }
    }
}

/// 快照记录（查询结果）
#[derive(serde::Serialize)]
pub struct SnapshotRecord {
    pub id: i64,
    pub snapshot_at: String,
    pub kimi_code_environment_id: String,
    pub file_id: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub snapshot_path: String,
    pub target_path: String,
    pub description: Option<String>,
}

/// 列出快照历史。
///
/// 参数：
/// - file_id: 可选，过滤指定文件类型
/// - limit: 返回记录数上限（默认 100）
///
/// 返回：按时间倒序排列的快照列表
#[tauri::command]
pub fn list_snapshots(
    kimi_code_environment_id: String,
    file_id: Option<String>,
    limit: Option<i64>,
    state: tauri::State<crate::usage::UsageState>,
) -> Result<Vec<SnapshotRecord>, String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;

    let limit = limit.unwrap_or(100);

    let environment_id = if kimi_code_environment_id.trim().is_empty() {
        "legacy-unassigned".to_string()
    } else {
        kimi_code_environment_id
    };
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(fid) = file_id {
        (
            "SELECT id, snapshot_at, kimi_code_environment_id, file_id, sha256,
                    size_bytes, snapshot_path, target_path, description
             FROM config_history
             WHERE kimi_code_environment_id = ?1 AND file_id = ?2
             ORDER BY snapshot_at DESC
             LIMIT ?3"
                .to_string(),
            vec![Box::new(environment_id), Box::new(fid), Box::new(limit)],
        )
    } else {
        (
            "SELECT id, snapshot_at, kimi_code_environment_id, file_id, sha256,
                    size_bytes, snapshot_path, target_path, description
             FROM config_history
             WHERE kimi_code_environment_id = ?1
             ORDER BY snapshot_at DESC
             LIMIT ?2"
                .to_string(),
            vec![Box::new(environment_id), Box::new(limit)],
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(SnapshotRecord {
                id: row.get(0)?,
                snapshot_at: row.get(1)?,
                kimi_code_environment_id: row.get(2)?,
                file_id: row.get(3)?,
                sha256: row.get(4)?,
                size_bytes: row.get(5)?,
                snapshot_path: row.get(6)?,
                target_path: row.get(7)?,
                description: row.get(8)?,
            })
        })
        .map_err(|e| format!("query: {e}"))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("row: {e}"))?);
    }

    Ok(result)
}

fn assign_legacy_snapshot(
    conn: &rusqlite::Connection,
    snapshot_id: i64,
    environment_id: &str,
) -> Result<(), String> {
    if environment_id.trim().is_empty() || environment_id == "legacy-unassigned" {
        return Err("choose a registered Kimi Code environment".to_string());
    }
    let (current_environment_id, file_id): (String, String) = conn
        .query_row(
            "SELECT kimi_code_environment_id, file_id FROM config_history WHERE id = ?1",
            [snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("snapshot not found: {error}"))?;
    if current_environment_id != "legacy-unassigned" && !current_environment_id.trim().is_empty() {
        return Err(format!(
            "snapshot #{snapshot_id} is already assigned to {current_environment_id}"
        ));
    }
    if file_id != "config"
        && file_id != "mcp"
        && file_id != "tui"
        && file_id != "agents"
        && file_id != "skills"
    {
        return Err(format!(
            "legacy {file_id} snapshots cannot be assigned to an environment"
        ));
    }
    let target =
        registered_environment_target(conn, environment_id, &file_id)?.ok_or_else(|| {
            format!("environment {environment_id} is not registered; assignment is disabled")
        })?;
    conn.execute(
        "UPDATE config_history
         SET kimi_code_environment_id = ?1, target_path = ?2
         WHERE id = ?3",
        rusqlite::params![environment_id, target.to_string_lossy(), snapshot_id],
    )
    .map_err(|error| format!("assign legacy snapshot: {error}"))?;
    Ok(())
}

/// Bind a pre-environment snapshot to a registered environment. The restore
/// destination is derived from the environment registry, never supplied by the
/// renderer or backup payload.
#[tauri::command]
pub fn assign_legacy_snapshot_environment(
    snapshot_id: i64,
    kimi_code_environment_id: String,
    state: tauri::State<crate::usage::UsageState>,
) -> Result<(), String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|error| format!("begin legacy snapshot assignment: {error}"))?;
    match assign_legacy_snapshot(conn, snapshot_id, &kimi_code_environment_id) {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(|error| format!("commit legacy snapshot assignment: {error}")),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

/// 获取快照内容。
///
/// 流程：
/// 1. 从数据库查询快照记录
/// 2. 读取 gzip 文件
/// 3. 解压缩
/// 4. 返回原始文本
#[tauri::command]
pub fn get_snapshot_content(
    snapshot_id: i64,
    state: tauri::State<crate::usage::UsageState>,
) -> Result<String, String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;

    // 查询快照路径
    let snapshot_path: String = conn
        .query_row(
            "SELECT snapshot_path FROM config_history WHERE id = ?1",
            [snapshot_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("snapshot not found: {e}"))?;

    // 读取 gzip 文件
    let compressed = fs::read(&snapshot_path).map_err(|e| format!("read snapshot file: {e}"))?;

    // 解压缩
    let mut decoder = GzDecoder::new(&compressed[..]);
    let mut content = String::new();
    decoder
        .read_to_string(&mut content)
        .map_err(|e| format!("decompress: {e}"))?;

    Ok(content)
}

/// 回滚到指定快照。
///
/// 流程：
/// 1. 读取快照内容（解压）
/// 2. 创建"回滚点"快照（当前配置，支持撤销）
/// 3. 覆盖配置文件
/// 4. 记录回滚操作到 SQLite
///
/// 错误处理：回滚失败时不修改文件，返回错误
#[tauri::command]
pub fn restore_snapshot(
    snapshot_id: i64,
    state: tauri::State<crate::usage::UsageState>,
) -> Result<(), String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;

    // 1. 查询快照信息
    let (file_id, snapshot_path, snapshot_environment_id, snapshot_target_path): (
        String,
        String,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT file_id, snapshot_path, kimi_code_environment_id, target_path
             FROM config_history WHERE id = ?1",
            [snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("snapshot not found: {e}"))?;

    // 2. 读取快照内容
    let compressed = fs::read(&snapshot_path).map_err(|e| format!("read snapshot file: {e}"))?;

    let mut decoder = GzDecoder::new(&compressed[..]);
    let mut snapshot_content = String::new();
    decoder
        .read_to_string(&mut snapshot_content)
        .map_err(|e| format!("decompress: {e}"))?;

    // 3. 恢复配置
    if file_id == "panel" {
        // Panel settings：导入到 SQLite
        drop(guard); // 释放数据库连接锁，避免 import_panel_settings 死锁

        crate::panel_settings_store::import_panel_settings(
            snapshot_content.to_string(),
            state.clone(),
        )?;

        log::info!("Restored panel settings from snapshot {snapshot_id}");
        return Ok(());
    }

    // 其他配置文件：写入磁盘
    match file_id.as_str() {
        "config" | "mcp" | "tui" | "agents" | "skills" => {}
        "profiles" => return Err(
            "profiles snapshots are legacy-only; Profile data is stored in SQLite panel settings"
                .to_string(),
        ),
        _ => return Err(format!("unknown file_id: {file_id}")),
    }

    let target_path =
        resolve_snapshot_restore_target(&snapshot_environment_id, &snapshot_target_path)?;
    let registered_target =
        registered_environment_target(conn, &snapshot_environment_id, &file_id)?.ok_or_else(
            || {
                format!(
                    "environment {} is not registered; automatic restore is disabled",
                    snapshot_environment_id
                )
            },
        )?;
    if target_path != registered_target {
        log::warn!(
            "Snapshot target {} moved to registered environment path {}",
            target_path.display(),
            registered_target.display()
        );
    }
    let target_path = registered_target;

    if file_id == "skills" {
        let snapshot_bundle: crate::fs_access::PortableDirectoryBundle =
            serde_json::from_str(&snapshot_content)
                .map_err(|error| format!("parse Skills snapshot: {error}"))?;
        let current_bundle =
            crate::fs_access::export_portable_directory(target_path.to_string_lossy().to_string())?;
        let current_content = serde_json::to_string(&current_bundle)
            .map_err(|error| format!("serialize current Skills rollback point: {error}"))?;
        let current_hash = compute_sha256(&current_content);
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM config_history
                 WHERE kimi_code_environment_id = ?1 AND file_id = 'skills' AND sha256 = ?2",
                rusqlite::params![snapshot_environment_id, current_hash],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            let compressed = gzip_compress(&current_content)
                .map_err(|error| format!("compress Skills rollback point: {error}"))?;
            let history_dir = ensure_history_dir()?;
            let timestamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            let rollback_path = history_dir.join(format!("{timestamp_ms}-skills.json.gz"));
            write_private_snapshot(&rollback_path, &compressed)
                .map_err(|error| format!("write Skills rollback point: {error}"))?;
            conn.execute(
                "INSERT INTO config_history (
                   snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes,
                   snapshot_path, target_path, description
                 ) VALUES (?1, ?2, 'skills', ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    chrono::Utc::now().to_rfc3339(),
                    snapshot_environment_id,
                    current_hash,
                    current_content.len() as i64,
                    rollback_path.to_string_lossy(),
                    target_path.to_string_lossy(),
                    format!("Rollback point before restoring snapshot #{}", snapshot_id),
                ],
            )
            .map_err(|error| format!("insert Skills rollback point: {error}"))?;
        }
        crate::fs_access::replace_portable_directory_inner(
            target_path.to_string_lossy().as_ref(),
            snapshot_bundle,
            current_bundle.sha256,
            &crate::fs_access::PathGrantState::default(),
        )?;
        log::info!("Restored snapshot #{snapshot_id} to skills");
        return Ok(());
    }

    // 4. 创建"回滚点"快照（当前配置），并保留 hash 作为最终 CAS 基线。
    let current_content = if target_path.exists() {
        Some(
            fs::read_to_string(&target_path)
                .map_err(|e| format!("read current config for rollback point: {e}"))?,
        )
    } else {
        None
    };
    let expected_target_hash = current_content
        .as_deref()
        .map(compute_sha256)
        .unwrap_or_default();
    if let Some(current_content) = current_content {
        let sha256 = expected_target_hash.clone();
        let size_bytes = current_content.len() as i64;

        // 检查是否已存在（去重）
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM config_history
                 WHERE kimi_code_environment_id = ?1 AND file_id = ?2 AND sha256 = ?3",
                rusqlite::params![snapshot_environment_id, file_id, sha256],
                |_| Ok(true),
            )
            .unwrap_or(false);

        if !exists {
            // 压缩并保存
            let compressed = gzip_compress(&current_content)
                .map_err(|e| format!("compress rollback point: {e}"))?;

            let history_dir = ensure_history_dir()?;

            let timestamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);

            let rollback_point_filename = format!("{}-{}.toml.gz", timestamp_ms, file_id);
            let rollback_point_path = history_dir.join(&rollback_point_filename);

            // 写入文件失败应该阻止回滚
            write_private_snapshot(&rollback_point_path, &compressed)
                .map_err(|e| format!("write rollback point file: {e}"))?;

            let snapshot_at = chrono::Utc::now().to_rfc3339();
            let rollback_point_path_str = rollback_point_path.to_string_lossy().to_string();

            // 插入记录失败也应该阻止回滚
            conn.execute(
                "INSERT INTO config_history (
                   snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes,
                   snapshot_path, target_path, description
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    snapshot_at,
                    snapshot_environment_id,
                    file_id,
                    sha256,
                    size_bytes,
                    rollback_point_path_str,
                    snapshot_target_path,
                    format!("Rollback point before restoring snapshot #{}", snapshot_id)
                ],
            )
            .map_err(|e| format!("insert rollback point record: {e}"))?;

            log::info!(
                "Created rollback point for {} before restoring snapshot #{}",
                file_id,
                snapshot_id
            );
        }
    }

    // 5. 覆盖配置文件
    crate::fs_access::atomic_write_text(
        &target_path,
        &snapshot_content,
        Some(&expected_target_hash),
    )
    .map_err(|e| format!("write config file: {e}"))?;

    log::info!("Restored snapshot #{snapshot_id} to {file_id}");

    Ok(())
}

fn resolve_snapshot_restore_target(
    environment_id: &str,
    target_path: &str,
) -> Result<PathBuf, String> {
    if environment_id.trim().is_empty() || environment_id == "legacy-unassigned" {
        return Err(
            "legacy snapshot has no environment assignment; choose a target environment before restoring"
                .to_string(),
        );
    }
    if target_path.trim().is_empty() {
        return Err(
            "snapshot has no recorded target path; automatic restore is disabled".to_string(),
        );
    }
    let resolved = crate::fs_access::resolve_home(target_path);
    // 记录路径仅拒绝穿越；权威 gate 是调用方的 registered_environment_target（从受信环境注册表解析）。
    crate::fs_access::validate_read_scope(&resolved)?;
    Ok(resolved)
}

fn registered_environment_target(
    conn: &rusqlite::Connection,
    environment_id: &str,
    file_id: &str,
) -> Result<Option<PathBuf>, String> {
    let environments_json: Option<String> = conn
        .query_row(
            "SELECT kimi_code_environments FROM panel_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(environments_json) = environments_json else {
        return Ok(None);
    };
    let environments = serde_json::from_str::<serde_json::Value>(&environments_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let Some(home_path) = environments.iter().find_map(|environment| {
        (environment.get("id").and_then(|value| value.as_str()) == Some(environment_id))
            .then(|| environment.get("homePath").and_then(|value| value.as_str()))
            .flatten()
    }) else {
        return Ok(None);
    };
    let file_name = match file_id {
        "config" => "config.toml",
        "mcp" => "mcp.json",
        "tui" => "tui.toml",
        "agents" => "AGENTS.md",
        "skills" => "skills",
        _ => return Err(format!("unsupported environment file_id: {file_id}")),
    };
    let home = crate::fs_access::resolve_home(home_path);
    let target = home.join(file_name);
    crate::fs_access::validate_path_scope_including(&target, Some(&home))?;
    Ok(Some(target))
}

/// 清理旧快照。
///
/// 删除 30 天前的快照记录和对应的文件系统文件。
///
/// 调用时机：每次保存配置后（saveAppState 后）
#[tauri::command]
pub fn cleanup_old_snapshots(state: tauri::State<crate::usage::UsageState>) -> Result<i64, String> {
    let guard = lock_conn(&state)?;
    let conn = guard.as_ref().ok_or("usage db not open")?;

    // 计算 30 天前的时间戳
    let thirty_days_ago = chrono::Utc::now() - chrono::Duration::days(30);
    let cutoff_time = thirty_days_ago.to_rfc3339();

    // 查询待删除的快照路径
    let mut stmt = conn
        .prepare("SELECT snapshot_path FROM config_history WHERE snapshot_at < ?1")
        .map_err(|e| format!("prepare: {e}"))?;

    let paths: Vec<String> = stmt
        .query_map([&cutoff_time], |row| row.get(0))
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // 删除文件系统快照
    let mut deleted_files = 0;
    for path in &paths {
        if fs::remove_file(path).is_ok() {
            deleted_files += 1;
        }
    }

    // 删除数据库记录
    let deleted_rows = conn
        .execute(
            "DELETE FROM config_history WHERE snapshot_at < ?1",
            [&cutoff_time],
        )
        .map_err(|e| format!("delete: {e}"))?;

    log::info!("Cleaned up {deleted_rows} old snapshots ({deleted_files} files deleted)");

    Ok(deleted_rows as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_schema_creates_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        // 验证表存在
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='config_history'")
            .unwrap();
        let exists = stmt.exists([]).unwrap();
        assert!(exists, "config_history table should exist");

        // 验证索引存在
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_history_time'",
            )
            .unwrap();
        let exists = stmt.exists([]).unwrap();
        assert!(exists, "idx_history_time index should exist");

        let create_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='config_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(create_sql.contains("target_path TEXT NOT NULL"));
        assert!(create_sql.contains("UNIQUE(kimi_code_environment_id, file_id, sha256)"));

        assert!(
            !SCHEMA_SQL.contains("idx_history_environment_time"),
            "environment index must be created after legacy column migration"
        );
    }

    #[test]
    fn test_legacy_schema_adds_environment_column_before_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE config_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              snapshot_at TEXT NOT NULL,
              file_id TEXT NOT NULL,
              sha256 TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              snapshot_path TEXT NOT NULL,
              description TEXT,
              UNIQUE(file_id, sha256)
            );
            CREATE INDEX IF NOT EXISTS idx_history_time
              ON config_history(snapshot_at DESC);
            CREATE INDEX IF NOT EXISTS idx_history_file
              ON config_history(file_id, snapshot_at DESC);
            "#,
        )
        .unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        ensure_config_history_environment_column(&conn).unwrap();

        let has_column: bool = conn
            .prepare("SELECT name FROM pragma_table_info('config_history') WHERE name = 'kimi_code_environment_id'")
            .unwrap()
            .exists([])
            .unwrap();
        let has_index: bool = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_history_environment_time'")
            .unwrap()
            .exists([])
            .unwrap();
        assert!(has_column);
        assert!(has_index);
        let has_target_path: bool = conn
            .prepare(
                "SELECT name FROM pragma_table_info('config_history') WHERE name = 'target_path'",
            )
            .unwrap()
            .exists([])
            .unwrap();
        let create_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='config_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_target_path);
        assert!(create_sql.contains("UNIQUE(kimi_code_environment_id, file_id, sha256)"));
    }

    #[test]
    fn migration_failure_rolls_back_environment_column_to_legacy_schema() {
        // C4：迁移任一步失败时 savepoint 回滚——表结构必须停留在「旧 schema」，
        // 绝不能留下半迁移状态（列已加但唯一约束/索引未更新）。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE config_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              snapshot_at TEXT NOT NULL,
              file_id TEXT NOT NULL,
              sha256 TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              snapshot_path TEXT NOT NULL,
              description TEXT,
              UNIQUE(file_id, sha256)
            );
            CREATE INDEX IF NOT EXISTS idx_history_time
              ON config_history(snapshot_at DESC);
            CREATE INDEX IF NOT EXISTS idx_history_file
              ON config_history(file_id, snapshot_at DESC);
            -- 让 RENAME 阶段失败：已存在同名 legacy 表。
            CREATE TABLE config_history_legacy (id INTEGER PRIMARY KEY);
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_history (snapshot_at, file_id, sha256, size_bytes, snapshot_path)
             VALUES ('2026-06-08T00:00:00Z', 'config', 'abc123', 1024, '/path/1.gz')",
            [],
        )
        .unwrap();

        let result = ensure_config_history_environment_column(&conn);
        assert!(
            result.is_err(),
            "migration must fail when rename target exists"
        );

        // ALTER ADD COLUMN 已执行，但 savepoint 回滚必须撤销它们。
        let has_environment_column: bool = conn
            .prepare("SELECT name FROM pragma_table_info('config_history') WHERE name = 'kimi_code_environment_id'")
            .unwrap()
            .exists([])
            .unwrap();
        let has_target_path: bool = conn
            .prepare(
                "SELECT name FROM pragma_table_info('config_history') WHERE name = 'target_path'",
            )
            .unwrap()
            .exists([])
            .unwrap();
        assert!(!has_environment_column, "column must be rolled back");
        assert!(!has_target_path, "target_path column must be rolled back");

        // 旧表唯一约束与索引保留，数据未丢失。
        let create_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='config_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let normalized = create_sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.contains("UNIQUE(file_id, sha256)"),
            "legacy unique constraint must survive rollback"
        );
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM config_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(row_count, 1, "data must survive rollback");

        // 重新执行迁移（排除冲突表后）应成功——证明状态可重试。
        conn.execute_batch("DROP TABLE config_history_legacy;")
            .unwrap();
        ensure_config_history_environment_column(&conn).unwrap();
        let has_environment_column_after: bool = conn
            .prepare("SELECT name FROM pragma_table_info('config_history') WHERE name = 'kimi_code_environment_id'")
            .unwrap()
            .exists([])
            .unwrap();
        assert!(has_environment_column_after);
    }

    #[test]
    fn test_unique_constraint() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        // 插入第一条记录
        conn.execute(
            "INSERT INTO config_history (snapshot_at, file_id, sha256, size_bytes, snapshot_path)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                "2026-06-08T00:00:00Z",
                "config",
                "abc123",
                "1024",
                "/path/1.gz",
            ],
        )
        .unwrap();

        // 同一环境内相同 file_id + sha256 应失败。
        let result = conn.execute(
            "INSERT INTO config_history (snapshot_at, file_id, sha256, size_bytes, snapshot_path)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                "2026-06-08T01:00:00Z",
                "config",
                "abc123",
                "2048",
                "/path/2.gz",
            ],
        );

        assert!(
            result.is_err(),
            "duplicate file_id+sha256 should be rejected"
        );

        // 不同环境允许保存相同内容。
        conn.execute(
            "INSERT INTO config_history (
               snapshot_at, kimi_code_environment_id, file_id, sha256,
               size_bytes, snapshot_path
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [
                "2026-06-08T02:00:00Z",
                "work",
                "config",
                "abc123",
                "1024",
                "/path/work.gz",
            ],
        )
        .expect("same content in another environment should be retained");
    }

    #[test]
    fn test_compute_sha256() {
        let hash = compute_sha256("hello world");
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_gzip_compress() {
        let content = "test content";
        let compressed = gzip_compress(content).unwrap();
        assert!(compressed.len() < content.len() + 50); // 压缩后应该不会比原始大太多
        assert!(compressed.len() > 10); // 至少有 gzip header
    }

    #[test]
    fn test_gzip_round_trip() {
        let original = "Hello, 配置历史版本！This is a test content.";
        let compressed = gzip_compress(original).unwrap();

        // 解压缩
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = String::new();
        decoder.read_to_string(&mut decompressed).unwrap();

        assert_eq!(original, decompressed);
    }

    #[test]
    fn test_list_snapshots() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        // 插入测试数据
        conn.execute(
            "INSERT INTO config_history (snapshot_at, file_id, sha256, size_bytes, snapshot_path)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                "2026-06-08T10:00:00Z",
                "config",
                "hash1",
                "1024",
                "/path/1.gz",
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_history (snapshot_at, file_id, sha256, size_bytes, snapshot_path)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                "2026-06-08T11:00:00Z",
                "profiles",
                "hash2",
                "2048",
                "/path/2.gz",
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_history (snapshot_at, file_id, sha256, size_bytes, snapshot_path)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                "2026-06-08T12:00:00Z",
                "config",
                "hash3",
                "3072",
                "/path/3.gz",
            ],
        )
        .unwrap();

        // 查询所有快照（应按时间倒序）
        let mut stmt = conn
            .prepare(
                "SELECT id, snapshot_at, file_id FROM config_history ORDER BY snapshot_at DESC",
            )
            .unwrap();
        let rows: Vec<(i64, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].1, "2026-06-08T12:00:00Z"); // 最新的在前
        assert_eq!(rows[2].1, "2026-06-08T10:00:00Z"); // 最老的在后

        // 查询指定文件类型
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM config_history WHERE file_id = 'config'")
            .unwrap();
        let count: i64 = stmt.query_row([], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn restore_target_requires_a_scoped_environment_and_uses_the_recorded_path() {
        assert!(
            resolve_snapshot_restore_target("legacy-unassigned", "~/.kimi-code/config.toml")
                .is_err()
        );
        assert!(resolve_snapshot_restore_target("work", "").is_err());

        let resolved = resolve_snapshot_restore_target("work", "/tmp/kimi-work/config.toml")
            .expect("scoped snapshots should restore to their recorded path");
        assert_eq!(resolved, PathBuf::from("/tmp/kimi-work/config.toml"));
    }

    #[test]
    fn backfills_existing_snapshot_targets_from_the_environment_registry() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE panel_settings (
              id INTEGER PRIMARY KEY,
              kimi_code_environments TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO panel_settings (id, kimi_code_environments) VALUES (1, ?1)",
            [r#"[{"id":"work","homePath":"/tmp/kimi-work"}]"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_history (
               snapshot_at, kimi_code_environment_id, file_id, sha256,
               size_bytes, snapshot_path, target_path
             ) VALUES ('2026-01-01', 'work', 'config', 'hash', 1, '/tmp/snapshot.gz', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_history (
               snapshot_at, kimi_code_environment_id, file_id, sha256,
               size_bytes, snapshot_path, target_path
             ) VALUES ('2026-01-02', 'work', 'skills', 'skills-hash', 1, '/tmp/skills.gz', '')",
            [],
        )
        .unwrap();

        backfill_history_target_paths(&conn).unwrap();

        let target: String = conn
            .query_row(
                "SELECT target_path FROM config_history WHERE file_id = 'config'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(target, "/tmp/kimi-work/config.toml");
        let skills_target: String = conn
            .query_row(
                "SELECT target_path FROM config_history WHERE file_id = 'skills'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(skills_target, "/tmp/kimi-work/skills");
    }

    #[test]
    fn assigns_legacy_snapshot_to_a_registered_environment_target() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE panel_settings (
              id INTEGER PRIMARY KEY,
              kimi_code_environments TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO panel_settings (id, kimi_code_environments) VALUES (1, ?1)",
            [r#"[{"id":"work","homePath":"/tmp/kimi-work"}]"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO config_history (
               snapshot_at, kimi_code_environment_id, file_id, sha256,
               size_bytes, snapshot_path, target_path
             ) VALUES ('2026-01-01', 'legacy-unassigned', 'mcp', 'legacy-hash', 1, '/tmp/snapshot.gz', '')",
            [],
        )
        .unwrap();
        let snapshot_id = conn.last_insert_rowid();

        assign_legacy_snapshot(&conn, snapshot_id, "work").unwrap();

        let assigned: (String, String) = conn
            .query_row(
                "SELECT kimi_code_environment_id, target_path FROM config_history WHERE id = ?1",
                [snapshot_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(assigned.0, "work");
        assert_eq!(assigned.1, "/tmp/kimi-work/mcp.json");
        assert!(assign_legacy_snapshot(&conn, snapshot_id, "work").is_err());
    }
}
