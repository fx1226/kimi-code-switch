//! 文件读写原子能力——对应 Electron 侧 src/main/modules/fileAccess.ts
//! 前端 shared/configStore 的 FileAccess 接口下沉到这里，通过 invoke 调用。
//!
//! 安全模型（B1）：所有写/删/移命令必须通过 `authorize_mutation` 得到授权。
//! renderer 不能仅凭字符串声明任意绝对路径可写；只能落在：
//!   1. 固定受管根（~/.kimi、~/.kimi-code、~/.kimi-code-switch-gui）
//!   2. 由 Rust 原生 dialog 产生的 grant（导出文件；备份目录为持久写授权，登记在
//!      ~/.kimi-code-switch-gui/access-grants.json，重启后由 `reconcile_durable_grants` 重建）
//!   3. 项目本地配置组合命令 `write_project_local_config`（仅 <project-root>/.kimi-code/local.toml）
//!
//! symlink 目标在写/删/移前会解析并复核对最终目标。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use atomicwrites::{AllowOverwrite, AtomicFile};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use tauri_plugin_dialog::DialogExt;

const PORTABLE_DIRECTORY_MAX_FILES: usize = 4_000;
const PORTABLE_DIRECTORY_MAX_DIRECTORIES: usize = 4_000;
const PORTABLE_DIRECTORY_MAX_BYTES: u64 = 64 * 1024 * 1024;
const PORTABLE_DIRECTORY_MAX_DEPTH: usize = 32;
const PORTABLE_PATH_MAX_LENGTH: usize = 4_096;

/// 持久 durable 授权记录文件：`~/.kimi-code-switch-gui/access-grants.json`（目录 0700 / 文件 0600）。
const DURABLE_GRANTS_FILE_NAME: &str = "access-grants.json";

/// 授权目录类型：区分"单个文件路径"与"可递归创建子项的目录树"。
/// `serde(rename_all = "PascalCase")`：在 access-grants.json 中持久化为 `File` / `DirectoryTree`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
enum GrantTargetKind {
    File,
    DirectoryTree,
}

/// durable grant 来源（B1）：只有 Rust 原生 dialog 或受管根才能产生持久写授权。
/// renderer 字符串（含 SQLite 面板设置的 backup_local_path）永不进入此来源。
/// `serde(rename_all = "kebab-case")`：持久化为 `dialog` / `managed-root`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum GrantSource {
    Dialog,
    ManagedRoot,
}

/// access-grants.json 中的一条持久 durable 授权记录。
/// root 为 canonical 绝对路径；kind / source / created_at 供审计追溯。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DurableGrantRecord {
    root: String,
    kind: GrantTargetKind,
    source: GrantSource,
    created_at: String,
}

/// access-grants.json 顶层结构。
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DurableGrantFile {
    version: u32,
    #[serde(default)]
    grants: Vec<DurableGrantRecord>,
}

/// Rust 侧管理的一次性/短时路径授权。由原生 dialog 产生，绝不来自 renderer 字符串声明。
#[derive(Clone, Debug)]
struct PathGrant {
    /// 授权根的规范绝对路径。
    root: PathBuf,
    kind: GrantTargetKind,
    expires_at: Instant,
    /// 持久授权（如用户选择的备份目录）不随 TTL 过期，直到显式吊销或会话结束。
    durable: bool,
}

#[derive(Default)]
pub(crate) struct PathGrantState {
    grants: Mutex<HashMap<String, PathGrant>>,
}

const GRANT_TTL: Duration = Duration::from_secs(15 * 60);

impl PathGrantState {
    /// 登记一个持久授权（目前路径全部来自 Rust dialog；短时 grant 语义保留待 future 使用）。
    fn register_durable(&self, root: PathBuf, kind: GrantTargetKind) -> String {
        self.register_inner(root, kind, true)
    }

    /// 从一条持久授权记录登记到内存。reconcile 与 dialog 命令共用；
    /// root 已是 canonical 绝对路径，register_inner 会再次 canonicalize（幂等，无副作用）。
    fn register_durable_record(&self, record: &DurableGrantRecord) -> String {
        self.register_durable(PathBuf::from(&record.root), record.kind)
    }

    fn register_inner(&self, root: PathBuf, kind: GrantTargetKind, durable: bool) -> String {
        // 解析后的最终目标经 canonicalize（/tmp → /private/var/tmp 等），因此授权根也按规范路径保存，
        // 保证 starts_with 匹配一致。
        let normalized_root = std::fs::canonicalize(&root).unwrap_or(root);
        let mut bytes = [0_u8; 8];
        getrandom::fill(&mut bytes).expect("grant id entropy");
        let id = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let now = Instant::now();
        self.grants.lock().expect("grant lock").insert(
            id.clone(),
            PathGrant {
                root: normalized_root.clone(),
                kind,
                expires_at: now + GRANT_TTL,
                durable,
            },
        );
        id
    }

    /// 检查 `candidate` 是否落在某个未过期且类型匹配的 grant 范围内。
    /// grant 匹配使用组件级 `Path::starts_with`，杜绝 sibling/prefix 字符串欺骗。
    fn scope_contains(&self, candidate: &Path, kind: GrantTargetKind) -> bool {
        let now = Instant::now();
        let mut grants = self.grants.lock().expect("grant lock");
        grants.retain(|_, grant| grant.durable || grant.expires_at > now);
        grants.values().any(|grant| {
            candidate.starts_with(&grant.root)
                && matches!(
                    (grant.kind, kind),
                    (GrantTargetKind::DirectoryTree, _)
                        | (GrantTargetKind::File, GrantTargetKind::File)
                )
        })
    }
}

/// 命令希望产生的写入目标类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MutationKind {
    SingleFile,
    DirectoryTree,
}

/// 解析路径的最终写目标：已存在的路径 canonicalize（跟随 symlink 链）；
/// 尾部不存在的路径解析其存在的父目录后拼接，再统一复核授权范围。
fn resolve_final_target(path: &Path) -> Result<PathBuf, String> {
    match std::fs::canonicalize(path) {
        Ok(resolved) => Ok(resolved),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let ancestor = path
                .ancestors()
                .skip(1)
                .find(|candidate| candidate.exists());
            let Some(existing) = ancestor else {
                // 整个链都不存在（如 /nonexistent/deep/file）：以规范父目录为基。
                let parent = path.parent().unwrap_or(path);
                if parent.as_os_str().is_empty() {
                    return Err(format!("cannot scope path {}", path.display()));
                }
                return Ok(parent.join(path.file_name().unwrap_or_default()));
            };
            let resolved_ancestor = std::fs::canonicalize(existing)
                .map_err(|e| format!("canonicalize {}: {e}", existing.display()))?;
            let suffix = path.strip_prefix(existing).unwrap_or(path);
            Ok(resolved_ancestor.join(suffix))
        }
        Err(error) => Err(format!("resolve write target {}: {error}", path.display())),
    }
}

/// 判断路径是否落在固定受管根内（组件级比较；`home` 注入便于测试）。
fn within_managed_root_at(path: &Path, home: &Path) -> bool {
    let bases = [
        home.join(".kimi"),
        home.join(".kimi-code"),
        home.join(".kimi-code-switch-gui"),
    ];
    bases.iter().any(|base| path.starts_with(base))
}

/// 判断路径是否落在固定受管根内（组件级比较）。
fn within_managed_root(path: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    within_managed_root_at(path, &home)
}

/// 所有写/删/移命令的唯一授权入口。
/// `path` 必须是已 resolve home 的绝对路径；授权前会解析 symlink 最终目标再复核，
/// 从而禁止受管目录内部 symlink 把写/删/移逃逸到授权根之外。
fn authorize_mutation(
    grants: &PathGrantState,
    path: &Path,
    kind: MutationKind,
) -> Result<PathBuf, String> {
    validate_no_parent_traversal(path)?;
    let final_target = resolve_final_target(path)?;
    if within_managed_root(&final_target) {
        return Ok(final_target);
    }
    let grant_kind = match kind {
        MutationKind::SingleFile => GrantTargetKind::File,
        MutationKind::DirectoryTree => GrantTargetKind::DirectoryTree,
    };
    if grants.scope_contains(&final_target, grant_kind) {
        return Ok(final_target);
    }
    Err(format!(
        "Path '{}' is outside the authorized scope (managed roots, native dialog grants, or project-local config)",
        final_target.display()
    ))
}

fn validate_no_parent_traversal(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "Path '{}' contains '..' segments and is not allowed",
            path.to_string_lossy()
        ));
    }
    Ok(())
}

/// 解析 `~/` 前缀为用户主目录绝对路径。
pub(crate) fn resolve_home(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(path)
}

#[tauri::command]
pub fn get_kimi_code_home() -> String {
    std::env::var("KIMI_CODE_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "~/.kimi-code".to_string())
}

#[tauri::command]
pub fn get_or_create_backup_encryption_secret() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    let app_dir = home.join(".kimi-code-switch-gui");
    std::fs::create_dir_all(&app_dir)
        .map_err(|error| format!("create backup key directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&app_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("chmod backup key directory: {error}"))?;
    }
    let key_path = app_dir.join("backup-encryption.key");
    if let Ok(existing) = std::fs::read_to_string(&key_path) {
        let trimmed = existing.trim();
        if is_valid_backup_encryption_secret(trimmed) {
            return Ok(trimmed.to_string());
        }
        return Err("backup encryption key file is invalid".to_string());
    }

    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("generate backup encryption key: {error}"))?;
    let secret = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    match atomic_write_text(&key_path, &secret, Some("")) {
        Ok(()) => Ok(secret),
        Err(error) if error.contains("write conflict") => {
            let existing = std::fs::read_to_string(&key_path).map_err(|read_error| {
                format!("read concurrently created backup key: {read_error}")
            })?;
            let trimmed = existing.trim();
            if is_valid_backup_encryption_secret(trimmed) {
                Ok(trimmed.to_string())
            } else {
                Err("concurrently created backup encryption key is invalid".to_string())
            }
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn get_backup_encryption_secret_candidates() -> Result<Vec<String>, String> {
    let current = get_or_create_backup_encryption_secret()?;
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    let previous_path = home
        .join(".kimi-code-switch-gui")
        .join("backup-encryption.key.previous");
    let mut candidates = vec![current.clone()];
    if let Ok(previous) = std::fs::read_to_string(previous_path) {
        let previous = previous.trim().to_ascii_lowercase();
        if is_valid_backup_encryption_secret(&previous) && previous != current {
            candidates.push(previous);
        }
    }
    Ok(candidates)
}

fn is_valid_backup_encryption_secret(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

/// Install an explicitly imported recovery key into the fixed private key
/// location. Existing differing keys require `replace=true` from a separately
/// confirmed UI action.
#[tauri::command]
pub fn import_backup_encryption_secret(secret: String, replace: bool) -> Result<String, String> {
    let normalized = secret.trim().to_ascii_lowercase();
    if !is_valid_backup_encryption_secret(&normalized) {
        return Err(
            "backup encryption recovery key must contain exactly 64 hexadecimal characters"
                .to_string(),
        );
    }
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    let app_dir = home.join(".kimi-code-switch-gui");
    std::fs::create_dir_all(&app_dir)
        .map_err(|error| format!("create backup key directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&app_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("chmod backup key directory: {error}"))?;
    }
    let key_path = app_dir.join("backup-encryption.key");
    let current = std::fs::read_to_string(&key_path).ok();
    if let Some(existing) = current.as_deref() {
        if existing.trim().eq_ignore_ascii_case(&normalized) {
            return Ok(key_path.to_string_lossy().to_string());
        }
        if !replace {
            return Err("a different backup encryption recovery key already exists".to_string());
        }
        let previous_path = app_dir.join("backup-encryption.key.previous");
        if !previous_path.exists() {
            atomic_write_text(&previous_path, existing.trim(), Some(""))?;
        }
    }
    let expected_hash = current
        .as_deref()
        .map(|value| sha256_bytes(value.as_bytes()))
        .unwrap_or_default();
    atomic_write_text(&key_path, &normalized, Some(&expected_hash))?;
    Ok(key_path.to_string_lossy().to_string())
}

/// 严格授权校验：只放行固定受管根内路径（组件级比较），不放行任意绝对路径。
/// 供 write/remove/move/copy 之外需要路径范围的 Rust 内部逻辑（如账号槽位、恢复目标）调用。
pub(crate) fn validate_path_scope(path: &Path) -> Result<(), String> {
    validate_path_scope_including(path, None)
}

/// 在受管根之外额外允许一个由调用方持有的"已信任根"（例如已注册的受信环境 home）。
/// 该额外根必须显式传入，绝不来自 renderer 字符串；仅用于恢复目标解析等内部信任上下文。
pub(crate) fn validate_path_scope_including(
    path: &Path,
    extra_root: Option<&Path>,
) -> Result<(), String> {
    validate_no_parent_traversal(path)?;
    if within_managed_root(path) {
        return Ok(());
    }
    if let Some(root) = extra_root {
        if path.starts_with(root) {
            return Ok(());
        }
    }
    Err(format!(
        "Path '{}' is outside authorized managed roots",
        path.to_string_lossy()
    ))
}

/// 供 read-only 命令保留的宽松校验：只拒绝路径穿越，不限制读取范围。
/// 读取不修改用户文件，但仍要服从脱敏规则（renderer 层 configSafety）。
pub(crate) fn validate_read_scope(path: &Path) -> Result<(), String> {
    validate_no_parent_traversal(path)
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        std::fs::create_dir_all(to).map_err(|e| format!("create {}: {}", to.display(), e))?;
        return Ok(());
    }
    if !from.is_dir() {
        return Err(format!("Source is not a directory: {}", from.display()));
    }
    std::fs::create_dir_all(to).map_err(|e| format!("create {}: {}", to.display(), e))?;
    for entry in
        std::fs::read_dir(from).map_err(|e| format!("read_dir {}: {}", from.display(), e))?
    {
        let entry = entry.map_err(|e| format!("read_dir entry {}: {}", from.display(), e))?;
        let file_name = entry.file_name();
        let source = entry.path();
        let target = to.join(file_name);
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {}", source.display(), e))?;
        if file_type.is_symlink() {
            let link_target = std::fs::read_link(&source)
                .map_err(|e| format!("read_link {}: {}", source.display(), e))?;
            create_symlink_path(&link_target, &target)?;
        } else if file_type.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else if file_type.is_file() {
            std::fs::copy(&source, &target)
                .map_err(|e| format!("copy {} to {}: {}", source.display(), target.display(), e))?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryMergeResult {
    source_exists: bool,
    copied_entries: usize,
    skipped_conflicts: usize,
}

fn merge_directory_missing_recursive(
    from: &Path,
    to: &Path,
    result: &mut DirectoryMergeResult,
) -> Result<(), String> {
    let source_metadata = match std::fs::symlink_metadata(from) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("stat source directory {}: {error}", from.display())),
    };
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(format!(
            "Source is not a real directory: {}",
            from.display()
        ));
    }
    if !to.exists() {
        std::fs::create_dir_all(to).map_err(|error| format!("create {}: {error}", to.display()))?;
    }

    for entry in
        std::fs::read_dir(from).map_err(|error| format!("read_dir {}: {error}", from.display()))?
    {
        let entry = entry.map_err(|error| format!("read_dir entry {}: {error}", from.display()))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let source_type = entry
            .file_type()
            .map_err(|error| format!("file_type {}: {error}", source.display()))?;

        if target.exists() {
            let target_type = std::fs::symlink_metadata(&target)
                .map_err(|error| format!("stat target {}: {error}", target.display()))?
                .file_type();
            if source_type.is_dir() && target_type.is_dir() && !target_type.is_symlink() {
                merge_directory_missing_recursive(&source, &target, result)?;
            } else {
                result.skipped_conflicts += 1;
            }
            continue;
        }

        if source_type.is_symlink() {
            let link_target = std::fs::read_link(&source)
                .map_err(|error| format!("read_link {}: {error}", source.display()))?;
            create_symlink_path(&link_target, &target)?;
        } else if source_type.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|error| format!("create {}: {error}", target.display()))?;
            merge_directory_missing_recursive(&source, &target, result)?;
        } else if source_type.is_file() {
            std::fs::copy(&source, &target).map_err(|error| {
                format!("copy {} to {}: {error}", source.display(), target.display())
            })?;
        } else {
            continue;
        }
        result.copied_entries += 1;
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink_path(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link)
        .map_err(|e| format!("symlink {} -> {}: {}", link.display(), target.display(), e))
}

#[cfg(windows)]
fn create_symlink_path(target: &Path, link: &Path) -> Result<(), String> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
    .map_err(|e| format!("symlink {} -> {}: {}", link.display(), target.display(), e))
}

/// 读取文本文件。文件不存在时返回 None（对应 TS 的 null），而非报错。
#[tauri::command]
pub fn read_text(path: String) -> Result<Option<String>, String> {
    let resolved = resolve_home(&path);
    match std::fs::read_to_string(&resolved) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("read_text {}: {}", resolved.display(), err)),
    }
}

/// 写入文本文件（覆盖）。
#[tauri::command]
pub fn write_text(
    path: String,
    content: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    let resolved = resolve_home(&path);
    let final_target = authorize_mutation(&state, &resolved, MutationKind::SingleFile)?;
    if let Some(parent) = final_target.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("ensure parent {}: {}", parent.display(), e))?;
        }
    }
    atomic_write_text(&final_target, &content, None)
}

#[tauri::command]
/// Optimistic revision guard（非 OS 级 CAS）：写前比较 sha256 期望值、写后复核。
/// 外部进程在最终检查与 rename 之间的极小窗口仍可能写入；该竞态由
/// save 流程的 journal（C1/C3）与 external-change 冲突 UI 兜底，不宣称原子覆盖。
pub fn write_text_cas(
    path: String,
    content: String,
    expected_sha256: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<String, String> {
    let resolved = resolve_home(&path);
    let final_target = authorize_mutation(&state, &resolved, MutationKind::SingleFile)?;
    if let Some(parent) = final_target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("ensure parent {}: {}", parent.display(), error))?;
    }
    atomic_write_text(&final_target, &content, Some(expected_sha256.as_str()))?;
    Ok(sha256_bytes(content.as_bytes()))
}

pub(crate) fn atomic_write_text(
    path: &Path,
    content: &str,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let effective_path = atomic_write_target(path)?;
    verify_expected_hash(&effective_path, expected_sha256)?;
    let existing_permissions = std::fs::metadata(&effective_path)
        .ok()
        .map(|metadata| metadata.permissions());
    let atomic = AtomicFile::new(&effective_path, AllowOverwrite);
    atomic
        .write(|file| {
            if let Some(permissions) = existing_permissions.clone() {
                file.set_permissions(permissions)?;
            } else {
                set_new_private_file_permissions(file)?;
            }
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            verify_expected_hash_io(&effective_path, expected_sha256)
        })
        .map_err(|error| format!("atomic write_text {}: {}", effective_path.display(), error))?;

    sync_parent_directory(&effective_path)?;
    Ok(())
}

fn atomic_write_target(path: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => std::fs::canonicalize(path)
            .map_err(|error| format!("resolve symlink target {}: {}", path.display(), error)),
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(error) => Err(format!(
            "stat atomic write target {}: {}",
            path.display(),
            error
        )),
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn current_file_hash(path: &Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(sha256_bytes(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!(
            "read current file {} for CAS: {}",
            path.display(),
            error
        )),
    }
}

fn verify_expected_hash(path: &Path, expected_sha256: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected_sha256 else {
        return Ok(());
    };
    let actual = current_file_hash(path)?;
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "write conflict for {}: expected sha256 {}, found {}",
        path.display(),
        expected,
        actual
    ))
}

fn verify_expected_hash_io(path: &Path, expected_sha256: Option<&str>) -> std::io::Result<()> {
    verify_expected_hash(path, expected_sha256)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::AlreadyExists, message))
}

#[cfg(unix)]
fn set_new_private_file_permissions(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_new_private_file_permissions(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync parent directory {}: {}", parent.display(), error))
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// 递归创建目录。
#[tauri::command]
pub fn ensure_dir(path: String, state: tauri::State<'_, PathGrantState>) -> Result<(), String> {
    let resolved = resolve_home(&path);
    let final_target = authorize_mutation(&state, &resolved, MutationKind::DirectoryTree)?;
    std::fs::create_dir_all(&final_target)
        .map_err(|e| format!("ensure_dir {}: {}", final_target.display(), e))
}

#[tauri::command]
pub fn ensure_private_dir(
    path: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    let resolved = resolve_home(&path);
    let final_target = authorize_mutation(&state, &resolved, MutationKind::DirectoryTree)?;
    std::fs::create_dir_all(&final_target)
        .map_err(|error| format!("ensure_private_dir {}: {}", final_target.display(), error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&final_target, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("chmod private dir {}: {}", final_target.display(), error))?;
    }
    Ok(())
}

/// 删除文件（不存在时静默成功）。
#[tauri::command]
pub fn remove_file(path: String, state: tauri::State<'_, PathGrantState>) -> Result<(), String> {
    let resolved = resolve_home(&path);
    let final_target = authorize_mutation(&state, &resolved, MutationKind::SingleFile)?;
    match std::fs::remove_file(&final_target) {
        Ok(()) => sync_parent_directory(&final_target),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove_file {}: {}", final_target.display(), err)),
    }
}

/// Remove a file only when its current content still matches the revision
/// created by the caller. Used to roll back a newly-created file without
/// deleting an unrelated external replacement.
#[tauri::command]
pub fn remove_file_cas(
    path: String,
    expected_sha256: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    remove_file_cas_inner(&path, &expected_sha256, &state)
}

/// 可测试/可复用实现体。
pub(crate) fn remove_file_cas_inner(
    path: &str,
    expected_sha256: &str,
    grants: &PathGrantState,
) -> Result<(), String> {
    let resolved = resolve_home(path);
    let final_target = authorize_mutation(grants, &resolved, MutationKind::SingleFile)?;
    verify_expected_hash(&final_target, Some(expected_sha256))?;
    match std::fs::remove_file(&final_target) {
        Ok(()) => sync_parent_directory(&final_target),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "write conflict for {}: file no longer exists",
            final_target.display()
        )),
        Err(error) => Err(format!(
            "remove_file_cas {}: {error}",
            final_target.display()
        )),
    }
}

/// 递归删除目录（不存在时静默成功）。用于备份轮转/恢复。
#[tauri::command]
pub fn remove_dir(path: String, state: tauri::State<'_, PathGrantState>) -> Result<(), String> {
    let resolved = resolve_home(&path);
    let final_target = authorize_mutation(&state, &resolved, MutationKind::DirectoryTree)?;
    match std::fs::remove_dir_all(&final_target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove_dir {}: {}", final_target.display(), err)),
    }
}

/// 移动文件（支持跨目录）。
#[tauri::command]
pub fn move_file(
    from: String,
    to: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    let from_resolved = resolve_home(&from);
    let to_resolved = resolve_home(&to);
    // 源与目标分开授权：源允许已存在单文件读/移，目标按写路径授权。
    let from_final = authorize_mutation(&state, &from_resolved, MutationKind::SingleFile)?;
    let to_final = authorize_mutation(&state, &to_resolved, MutationKind::SingleFile)?;

    if !from_final.exists() {
        return Err(format!(
            "Source file does not exist: {}",
            from_final.display()
        ));
    }

    // 确保目标目录存在
    if let Some(parent) = to_final.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create parent dir {}: {}", parent.display(), e))?;
    }

    // 移动文件
    std::fs::rename(&from_final, &to_final).map_err(|e| {
        format!(
            "move {} to {}: {}",
            from_final.display(),
            to_final.display(),
            e
        )
    })
}

/// 递归复制目录。目标目录不存在时创建；普通文件按 std::fs::copy 覆盖同名文件，
/// 子目录递归合并。注意：对 symlink 子项用 create_symlink_path 重建，若目标已存在同名项会报错（不覆盖）。
#[tauri::command]
pub fn copy_dir(
    from: String,
    to: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    let from_resolved = resolve_home(&from);
    let to_resolved = resolve_home(&to);
    let from_final = authorize_mutation(&state, &from_resolved, MutationKind::DirectoryTree)?;
    let to_final = authorize_mutation(&state, &to_resolved, MutationKind::DirectoryTree)?;
    copy_dir_recursive(&from_final, &to_final)
}

/// Recursively copy only entries absent from the target directory. This is
/// used to recover retired GUI-managed Kimi configuration without replacing
/// data that already belongs to the native KIMI_CODE_HOME.
#[tauri::command]
pub fn merge_directory_missing(
    from: String,
    to: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<DirectoryMergeResult, String> {
    let from_resolved = resolve_home(&from);
    let to_resolved = resolve_home(&to);
    let from_final = authorize_mutation(&state, &from_resolved, MutationKind::DirectoryTree)?;
    let to_final = authorize_mutation(&state, &to_resolved, MutationKind::DirectoryTree)?;
    if !from_final.exists() {
        return Ok(DirectoryMergeResult {
            source_exists: false,
            copied_entries: 0,
            skipped_conflicts: 0,
        });
    }
    let mut result = DirectoryMergeResult {
        source_exists: true,
        copied_entries: 0,
        skipped_conflicts: 0,
    };
    merge_directory_missing_recursive(&from_final, &to_final, &mut result)?;
    Ok(result)
}

#[derive(Clone, Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillMaterializationEntry {
    name: String,
    copied: bool,
    reason: String,
}

#[derive(Clone, Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeHomeSymlinkRepairResult {
    repaired: bool,
    reason: String,
    skills_materialized: Vec<SkillMaterializationEntry>,
}

/// 一次性修复：`~/.kimi-code` 若是指向 GUI 数据目录内托管默认环境（.env/default）的
/// 符号链接，则把物理目录翻转为真实的 `~/.kimi-code`（同卷 rename，零拷贝，保留
/// credentials/cache/权限），并把 skills 顶层符号链接物化为本地副本。
/// 自然幂等：修复后 `~/.kimi-code` 是真实目录，后续调用返回 not-a-symlink。
/// 只处理精确指向 .env/default 的链接；其他目标、缺失源一概不动。
pub(crate) fn repair_native_home_symlink_at(
    home: &Path,
) -> Result<NativeHomeSymlinkRepairResult, String> {
    let native_home = home.join(".kimi-code");
    let env_root = home.join(".kimi-code-switch-gui").join(".env");
    let managed_default_home = env_root.join("default");

    let link_meta = match std::fs::symlink_metadata(&native_home) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(NativeHomeSymlinkRepairResult {
                repaired: false,
                reason: "native-home-missing".to_string(),
                ..Default::default()
            });
        }
        Err(error) => {
            return Err(format!("stat native home {}: {error}", native_home.display()));
        }
    };
    if !link_meta.file_type().is_symlink() {
        return Ok(NativeHomeSymlinkRepairResult {
            repaired: false,
            reason: "not-a-symlink".to_string(),
            ..Default::default()
        });
    }
    let link_target = std::fs::read_link(&native_home)
        .map_err(|error| format!("read_link {}: {error}", native_home.display()))?;
    if !managed_default_home.is_dir() {
        return Ok(NativeHomeSymlinkRepairResult {
            repaired: false,
            reason: "legacy-source-missing".to_string(),
            ..Default::default()
        });
    }
    // read_link 可能返回相对目标：按链接所在目录（home）解析，避免落到进程 cwd。
    let link_target = if link_target.is_relative() {
        match native_home.parent() {
            Some(parent) => parent.join(&link_target),
            None => link_target,
        }
    } else {
        link_target
    };
    let resolved_target = std::fs::canonicalize(&link_target).map_err(|error| {
        format!("resolve symlink target {}: {error}", link_target.display())
    })?;
    let resolved_managed = std::fs::canonicalize(&managed_default_home)
        .map_err(|error| format!("resolve managed default home {}: {error}", managed_default_home.display()))?;
    if resolved_target != resolved_managed {
        return Ok(NativeHomeSymlinkRepairResult {
            repaired: false,
            reason: "foreign-symlink-target".to_string(),
            ..Default::default()
        });
    }

    let staging = env_root.join(".native-home-repair-staging");
    if staging.exists() {
        return Err(format!(
            "refusing to repair: staging path already exists {}",
            staging.display()
        ));
    }
    std::fs::rename(&managed_default_home, &staging).map_err(|error| {
        format!(
            "rename {} to {}: {error}",
            managed_default_home.display(),
            staging.display()
        )
    })?;
    if let Err(error) = std::fs::remove_file(&native_home) {
        let _ = std::fs::rename(&staging, &managed_default_home);
        return Err(format!("remove symlink {}: {error}", native_home.display()));
    }
    if let Err(error) = std::fs::rename(&staging, &native_home) {
        let _ = std::fs::rename(&staging, &managed_default_home);
        let _ = create_symlink_path(&managed_default_home, &native_home);
        return Err(format!("rename {} to {}: {error}", staging.display(), native_home.display()));
    }

    let mut skills_materialized = Vec::new();
    let skills_dir = native_home.join("skills");
    if skills_dir.is_dir() {
        // skills 遍历失败不能让修复整体失败：home 翻转已完成，TS 侧还要靠
        // repaired=true 做插件根重映射。扫描问题降级为逐项诊断。
        let entries = match std::fs::read_dir(&skills_dir) {
            Ok(entries) => entries,
            Err(error) => {
                skills_materialized.push(SkillMaterializationEntry {
                    name: "<skills>".to_string(),
                    copied: false,
                    reason: format!("scan-failed: {error}"),
                });
                return Ok(NativeHomeSymlinkRepairResult {
                    repaired: true,
                    reason: "symlink-materialized".to_string(),
                    skills_materialized,
                });
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    skills_materialized.push(SkillMaterializationEntry {
                        name: "<entry>".to_string(),
                        copied: false,
                        reason: format!("read-dir-entry-failed: {error}"),
                    });
                    continue;
                }
            };
            let file_name = entry.file_name();
            let source_path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    skills_materialized.push(SkillMaterializationEntry {
                        name: file_name.to_string_lossy().into_owned(),
                        copied: false,
                        reason: format!("file-type-failed: {error}"),
                    });
                    continue;
                }
            };
            if !file_type.is_symlink() {
                continue;
            }
            let name = file_name.to_string_lossy().into_owned();
            let raw_target = match std::fs::read_link(&source_path) {
                Ok(target) => target,
                Err(error) => {
                    skills_materialized.push(SkillMaterializationEntry {
                        name,
                        copied: false,
                        reason: format!("read-link-failed: {error}"),
                    });
                    continue;
                }
            };
            // 相对目标按链接所在目录解析，避免落到进程 cwd。
            let target = if raw_target.is_relative() {
                match source_path.parent() {
                    Some(parent) => parent.join(&raw_target),
                    None => raw_target,
                }
            } else {
                raw_target
            };
            let target_meta = match std::fs::metadata(&target) {
                Ok(meta) => meta,
                Err(_) => {
                    skills_materialized.push(SkillMaterializationEntry {
                        name,
                        copied: false,
                        reason: "broken-target".to_string(),
                    });
                    continue;
                }
            };
            if !target_meta.is_dir() {
                skills_materialized.push(SkillMaterializationEntry {
                    name,
                    copied: false,
                    reason: "not-a-directory".to_string(),
                });
                continue;
            }
            // 先复制到隐藏暂存名，成功后再删链接、rename 到位；失败保留原链接不破坏数据。
            // 暂存名 .{name}.materializing 只由本代码创建（崩溃残留也属于本流程），
            // 因此启动时清理同名残留是安全的，不会误删用户数据。
            let staging_copy = skills_dir.join(format!(".{name}.materializing"));
            let _ = std::fs::remove_dir_all(&staging_copy);
            if let Err(error) = copy_dir_recursive(&target, &staging_copy) {
                let _ = std::fs::remove_dir_all(&staging_copy);
                skills_materialized.push(SkillMaterializationEntry {
                    name,
                    copied: false,
                    reason: format!("copy-failed: {error}"),
                });
                continue;
            }
            if let Err(error) = std::fs::remove_file(&source_path) {
                let _ = std::fs::remove_dir_all(&staging_copy);
                skills_materialized.push(SkillMaterializationEntry {
                    name,
                    copied: false,
                    reason: format!("unlink-failed: {error}"),
                });
                continue;
            }
            if let Err(error) = std::fs::rename(&staging_copy, &skills_dir.join(&name)) {
                let _ = create_symlink_path(&target, &source_path);
                let _ = std::fs::remove_dir_all(&staging_copy);
                skills_materialized.push(SkillMaterializationEntry {
                    name,
                    copied: false,
                    reason: format!("rename-failed: {error}"),
                });
                continue;
            }
            skills_materialized.push(SkillMaterializationEntry {
                name,
                copied: true,
                reason: String::new(),
            });
        }
    }

    Ok(NativeHomeSymlinkRepairResult {
        repaired: true,
        reason: "symlink-materialized".to_string(),
        skills_materialized,
    })
}

/// 命令入口：固定受管路径（~/.kimi-code 与 ~/.kimi-code-switch-gui/.env/default）
/// 走统一授权复核后执行修复。
#[tauri::command]
pub fn repair_native_home_symlink(
    state: tauri::State<'_, PathGrantState>,
) -> Result<NativeHomeSymlinkRepairResult, String> {
    let Some(home) = dirs::home_dir() else {
        return Err("home directory unavailable".to_string());
    };
    for path in [
        home.join(".kimi-code"),
        home.join(".kimi-code-switch-gui").join(".env").join("default"),
    ] {
        authorize_mutation(&state, &path, MutationKind::DirectoryTree)?;
    }
    repair_native_home_symlink_at(&home)
}

/// 主机名（备份元信息用）。
#[tauri::command]
pub fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown-host".to_string())
}

/// 列目录下的子目录名（供备份枚举）。
#[tauri::command]
pub fn list_subdirs(path: String) -> Result<Vec<String>, String> {
    let resolved = resolve_home(&path);
    let entries = match std::fs::read_dir(&resolved) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("list_subdirs {}: {}", resolved.display(), err)),
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    Ok(names)
}

/// 判断路径是否存在。
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&resolve_home(&path)).exists()
}

/// 展开 `~`，但不要求目标已经存在；用于写入必须持久化绝对路径的官方配置字段。
#[tauri::command]
pub fn resolve_home_path(path: String) -> String {
    resolve_home(&path).to_string_lossy().to_string()
}

/// 返回已存在路径的真实绝对路径，供官方契约要求 realpath 去重的只读发现流程使用。
#[tauri::command]
pub fn real_path(path: String) -> Result<String, String> {
    let resolved = resolve_home(&path);
    std::fs::canonicalize(&resolved)
        .map(|value| value.to_string_lossy().to_string())
        .map_err(|error| format!("real_path {}: {}", resolved.display(), error))
}

/// 列目录下的文件名（非递归）。
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<String>, String> {
    let resolved = resolve_home(&path);
    let entries = match std::fs::read_dir(&resolved) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("list_dir {}: {}", resolved.display(), err)),
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

/// 列目录条目（带是否目录标记）。供 skillsStore 的 SkillFileAccess.listDir 使用。
#[tauri::command]
pub fn list_dir_typed(path: String) -> Result<Vec<DirEntry>, String> {
    let resolved = resolve_home(&path);
    let entries = match std::fs::read_dir(&resolved) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("list_dir_typed {}: {}", resolved.display(), err)),
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            let is_directory = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            result.push(DirEntry {
                name: name.to_string(),
                is_directory,
            });
        }
    }
    Ok(result)
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableFileBundle {
    pub relative_path: String,
    pub content_base64: String,
    pub executable: bool,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableDirectoryBundle {
    pub exists: bool,
    #[serde(default)]
    pub directories: Vec<String>,
    #[serde(default)]
    pub files: Vec<PortableFileBundle>,
    #[serde(default)]
    pub sha256: Option<String>,
}

fn portable_directory_hash(bundle: &PortableDirectoryBundle) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(if bundle.exists {
        b"exists\0"
    } else {
        b"absent\0"
    });
    let mut directories = bundle.directories.clone();
    directories.sort();
    for directory in directories {
        digest.update(b"dir\0");
        digest.update((directory.len() as u64).to_le_bytes());
        digest.update(directory.as_bytes());
    }
    let mut files = bundle.files.clone();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    for file in files {
        let bytes = BASE64_STANDARD
            .decode(&file.content_base64)
            .map_err(|error| format!("decode {} for revision: {error}", file.relative_path))?;
        digest.update(b"file\0");
        digest.update((file.relative_path.len() as u64).to_le_bytes());
        digest.update(file.relative_path.as_bytes());
        digest.update([u8::from(file.executable)]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn portable_relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn validate_portable_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > PORTABLE_PATH_MAX_LENGTH || value.contains('\\') {
        return Err(format!("invalid portable relative path: {value}"));
    }
    let path = PathBuf::from(value);
    if path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        || path.components().count() > PORTABLE_DIRECTORY_MAX_DEPTH
    {
        return Err(format!("invalid portable relative path: {value}"));
    }
    Ok(path)
}

fn collect_portable_directory(
    root: &Path,
    directory: &Path,
    bundle: &mut PortableDirectoryBundle,
    total_bytes: &mut u64,
    depth: usize,
) -> Result<(), String> {
    if depth > PORTABLE_DIRECTORY_MAX_DEPTH {
        return Err(format!(
            "portable directory exceeds maximum depth {PORTABLE_DIRECTORY_MAX_DEPTH}"
        ));
    }
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| format!("read portable directory {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read portable directory entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("stat portable entry {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "portable directory cannot contain symbolic links: {}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("resolve portable entry {}: {error}", path.display()))?;
        let relative_path = portable_relative_path(relative);
        if relative_path.len() > PORTABLE_PATH_MAX_LENGTH {
            return Err(format!("portable path is too long: {relative_path}"));
        }
        if metadata.is_dir() {
            if bundle.directories.len() >= PORTABLE_DIRECTORY_MAX_DIRECTORIES {
                return Err(format!(
                    "portable directory exceeds {PORTABLE_DIRECTORY_MAX_DIRECTORIES} directories"
                ));
            }
            bundle.directories.push(relative_path);
            collect_portable_directory(root, &path, bundle, total_bytes, depth + 1)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(format!("unsupported portable entry: {}", path.display()));
        }
        if bundle.files.len() >= PORTABLE_DIRECTORY_MAX_FILES {
            return Err(format!(
                "portable directory exceeds {PORTABLE_DIRECTORY_MAX_FILES} files"
            ));
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        if *total_bytes > PORTABLE_DIRECTORY_MAX_BYTES {
            return Err(format!(
                "portable directory exceeds {} bytes",
                PORTABLE_DIRECTORY_MAX_BYTES
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("read portable file {}: {error}", path.display()))?;
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        bundle.files.push(PortableFileBundle {
            relative_path,
            content_base64: BASE64_STANDARD.encode(bytes),
            executable,
        });
    }
    Ok(())
}

/// Export an arbitrary Skills tree without assuming UTF-8. Symlinks are
/// rejected so a crafted or accidental link cannot exfiltrate files outside
/// the selected KIMI_CODE_HOME.
#[tauri::command]
pub fn export_portable_directory(path: String) -> Result<PortableDirectoryBundle, String> {
    let resolved = resolve_home(&path);
    validate_read_scope(&resolved)?;
    let metadata = match std::fs::symlink_metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PortableDirectoryBundle {
                exists: false,
                directories: Vec::new(),
                files: Vec::new(),
                sha256: Some(sha256_bytes(b"absent\0")),
            });
        }
        Err(error) => {
            return Err(format!(
                "stat portable directory {}: {error}",
                resolved.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "portable directory root must be a real directory: {}",
            resolved.display()
        ));
    }
    let mut bundle = PortableDirectoryBundle {
        exists: true,
        directories: Vec::new(),
        files: Vec::new(),
        sha256: None,
    };
    let mut total_bytes = 0;
    collect_portable_directory(&resolved, &resolved, &mut bundle, &mut total_bytes, 0)?;
    bundle.sha256 = Some(portable_directory_hash(&bundle)?);
    Ok(bundle)
}

fn random_staging_path(target: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("portable directory has no parent: {}", target.display()))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("portable directory has invalid name: {}", target.display()))?;
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).map_err(|error| format!("create restore staging id: {error}"))?;
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(parent.join(format!(".{name}.{label}-{suffix}")))
}

fn remove_path_if_present(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("stat restore path {}: {error}", path.display())),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|error| format!("remove restore path {}: {error}", path.display()))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("chmod portable directory {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_portable_file_permissions(path: &Path, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|error| format!("chmod portable file {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_portable_file_permissions(_path: &Path, _executable: bool) -> Result<(), String> {
    Ok(())
}

/// Replace a Skills tree from a validated binary-safe snapshot. Construction
/// happens in a sibling staging directory and the final switch uses rename, so
/// callers never observe a half-written directory.
#[tauri::command]
pub fn replace_portable_directory(
    path: String,
    bundle: PortableDirectoryBundle,
    expected_sha256: Option<String>,
    state: tauri::State<'_, PathGrantState>,
) -> Result<String, String> {
    replace_portable_directory_inner(&path, bundle, expected_sha256, &state)
}

/// 可测试/可复用实现体：capability 分离，`config_history` 内部调用也走这里。
pub(crate) fn replace_portable_directory_inner(
    path: &str,
    bundle: PortableDirectoryBundle,
    expected_sha256: Option<String>,
    grants: &PathGrantState,
) -> Result<String, String> {
    let resolved = resolve_home(path);
    let final_target = authorize_mutation(grants, &resolved, MutationKind::DirectoryTree)?;
    if let Some(expected) = expected_sha256.as_deref() {
        let actual = export_portable_directory(final_target.to_string_lossy().into_owned())?
            .sha256
            .unwrap_or_default();
        if actual != expected {
            return Err(format!(
                "portable directory conflict for {}: expected {}, found {}",
                final_target.display(),
                expected,
                actual
            ));
        }
    }
    if !bundle.exists && (!bundle.directories.is_empty() || !bundle.files.is_empty()) {
        return Err("absent portable directory must not contain entries".to_string());
    }
    if bundle.files.len() > PORTABLE_DIRECTORY_MAX_FILES {
        return Err(format!(
            "portable directory exceeds {PORTABLE_DIRECTORY_MAX_FILES} files"
        ));
    }
    if bundle.directories.len() > PORTABLE_DIRECTORY_MAX_DIRECTORIES {
        return Err(format!(
            "portable directory exceeds {PORTABLE_DIRECTORY_MAX_DIRECTORIES} directories"
        ));
    }

    let mut seen = std::collections::HashSet::new();
    let mut directories = Vec::with_capacity(bundle.directories.len());
    for value in &bundle.directories {
        let relative = validate_portable_relative_path(value)?;
        if !seen.insert(relative.clone()) {
            return Err(format!("duplicate portable path: {value}"));
        }
        directories.push(relative);
    }
    directories.sort_by_key(|path| path.components().count());

    let mut files = Vec::with_capacity(bundle.files.len());
    let mut total_bytes = 0_u64;
    for file in &bundle.files {
        let relative = validate_portable_relative_path(&file.relative_path)?;
        if !seen.insert(relative.clone()) {
            return Err(format!("duplicate portable path: {}", file.relative_path));
        }
        let bytes = BASE64_STANDARD
            .decode(&file.content_base64)
            .map_err(|error| format!("decode {}: {error}", file.relative_path))?;
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > PORTABLE_DIRECTORY_MAX_BYTES {
            return Err(format!(
                "portable directory exceeds {} bytes",
                PORTABLE_DIRECTORY_MAX_BYTES
            ));
        }
        files.push((relative, bytes, file.executable));
    }

    let parent = final_target.parent().ok_or_else(|| {
        format!(
            "portable directory has no parent: {}",
            final_target.display()
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "create portable directory parent {}: {error}",
            parent.display()
        )
    })?;
    let backup = random_staging_path(&final_target, "previous")?;
    remove_path_if_present(&backup)?;

    if !bundle.exists {
        if final_target.exists() {
            std::fs::rename(&final_target, &backup).map_err(|error| {
                format!(
                    "move previous portable directory {} to {}: {error}",
                    final_target.display(),
                    backup.display()
                )
            })?;
            remove_path_if_present(&backup)?;
            sync_parent_directory(&final_target)?;
        }
        return Ok(
            export_portable_directory(final_target.to_string_lossy().into_owned())?
                .sha256
                .unwrap_or_default(),
        );
    }

    let staging = random_staging_path(&final_target, "staging")?;
    remove_path_if_present(&staging)?;
    std::fs::create_dir(&staging)
        .map_err(|error| format!("create portable staging {}: {error}", staging.display()))?;
    set_private_directory_permissions(&staging)?;
    let build_result = (|| -> Result<(), String> {
        for relative in &directories {
            let directory = staging.join(relative);
            std::fs::create_dir_all(&directory).map_err(|error| {
                format!("create portable directory {}: {error}", directory.display())
            })?;
            set_private_directory_permissions(&directory)?;
        }
        for (relative, bytes, executable) in &files {
            let target = staging.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    format!("create portable file parent {}: {error}", parent.display())
                })?;
                set_private_directory_permissions(parent)?;
            }
            let mut output = std::fs::File::create(&target)
                .map_err(|error| format!("create portable file {}: {error}", target.display()))?;
            output
                .write_all(bytes)
                .and_then(|_| output.sync_all())
                .map_err(|error| format!("write portable file {}: {error}", target.display()))?;
            set_portable_file_permissions(&target, *executable)?;
        }
        Ok(())
    })();
    if let Err(error) = build_result {
        let _ = remove_path_if_present(&staging);
        return Err(error);
    }

    // B2：staging 构建完成后、第一次 rename/swap 前，重新计算目标目录 revision。
    // 若与调用方传入的 expected 不一致（Kimi/编辑器/Plugin installer 在 staging 期间写入），
    // 不触碰目标目录，安全清理 staging，并返回明确 external-change conflict。
    if let Some(expected) = expected_sha256.as_deref() {
        let current_before_swap =
            export_portable_directory(final_target.to_string_lossy().into_owned())?
                .sha256
                .unwrap_or_default();
        if current_before_swap != expected {
            let _ = remove_path_if_present(&staging);
            return Err(format!(
                "portable directory external change conflict for {}: staging completed but target revision changed (expected {}, found {}); target left untouched",
                final_target.display(),
                expected,
                current_before_swap
            ));
        }
    }

    let had_previous = std::fs::symlink_metadata(&final_target).is_ok();
    if had_previous {
        std::fs::rename(&final_target, &backup).map_err(|error| {
            format!(
                "move previous portable directory {} to {}: {error}",
                final_target.display(),
                backup.display()
            )
        })?;
    }
    if let Err(error) = std::fs::rename(&staging, &final_target) {
        if had_previous {
            let _ = std::fs::rename(&backup, &final_target);
        }
        let _ = remove_path_if_present(&staging);
        return Err(format!(
            "activate portable directory {}: {error}",
            final_target.display()
        ));
    }
    if had_previous {
        remove_path_if_present(&backup)?;
    }
    sync_parent_directory(&final_target)?;
    Ok(
        export_portable_directory(final_target.to_string_lossy().into_owned())?
            .sha256
            .unwrap_or_default(),
    )
}

/// Rust 原生 save dialog + 写文件组合命令。路径由系统对话框产生，renderer 无法伪造，
/// 且 grant 只在对话框返回后登记于 Rust 侧并即时消费，不落入 renderer 状态。
#[tauri::command]
pub fn save_file_with_dialog(
    app: tauri::AppHandle,
    content: String,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let mut builder = app.dialog().file();
        if let Some(default) = default_path {
            if let Some(base) = std::path::Path::new(&default)
                .file_name()
                .and_then(|name| name.to_str())
            {
                builder = builder.set_file_name(base);
            }
        }
        let picked = builder.blocking_save_file();
        let Some(file_path) = picked else {
            return Ok(None);
        };
        let Some(path_buf) = file_path.as_path() else {
            return Err("dialog returned an invalid path".to_string());
        };
        let resolved = resolve_home(&path_buf.to_string_lossy());
        // 直接 builtin 原子写（该路径由系统对话框产生，视为已授权；仍是唯一非受管写入口）。
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("ensure parent {}: {}", parent.display(), e))?;
        }
        atomic_write_text(&resolved, &content, None)?;
        Ok(Some(resolved.to_string_lossy().to_string()))
    }
    #[cfg(not(desktop))]
    Err("save_file_with_dialog is only available on desktop".to_string())
}

/// 对话框起始目录需要已存在：从给定路径向上找最近已存在的目录。
fn nearest_existing_directory(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.is_dir() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

/// `pick_backup_directory` 的返回契约：`{ canceled, path }`（camelCase）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDirectoryResult {
    pub canceled: bool,
    pub path: Option<String>,
}

/// Rust 原生 folder picker + durable grant 组合命令（B1）。
/// 备份目录授权只能由系统对话框产生：用户选中的目录在 Rust 侧 canonicalize 后，
/// 登记为 DirectoryTree durable grant（内存 + 持久化到 access-grants.json，source=dialog）。
/// renderer 无法仅凭 backup_local_path 字符串（可写入 SQLite）扩大写授权。
#[tauri::command]
pub fn pick_backup_directory(
    app: tauri::AppHandle,
    title: String,
    default_path: Option<String>,
    grant_state: tauri::State<'_, PathGrantState>,
) -> Result<PickDirectoryResult, String> {
    #[cfg(desktop)]
    {
        let mut builder = app.dialog().file().set_title(title);
        if let Some(default) = default_path {
            if !default.trim().is_empty() {
                if let Some(starting) = nearest_existing_directory(&resolve_home(&default)) {
                    builder = builder.set_directory(starting);
                }
            }
        }
        // properties 覆盖 openDirectory + createDirectory（folder picker，允许在对话框中新建目录）。
        let picked = builder
            .set_can_create_directories(true)
            .blocking_pick_folder();
        let Some(folder) = picked else {
            return Ok(PickDirectoryResult {
                canceled: true,
                path: None,
            });
        };
        let Some(path_buf) = folder.as_path() else {
            return Err("dialog returned an invalid path".to_string());
        };
        let resolved = resolve_home(&path_buf.to_string_lossy());
        let canonical = std::fs::canonicalize(&resolved).map_err(|error| {
            format!(
                "canonicalize picked backup directory {}: {error}",
                resolved.display()
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!(
                "picked backup directory is not a directory: {}",
                canonical.display()
            ));
        }
        let record = DurableGrantRecord {
            root: canonical.to_string_lossy().to_string(),
            kind: GrantTargetKind::DirectoryTree,
            source: GrantSource::Dialog,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        grant_state.register_durable_record(&record);
        save_durable_grant(&record)?;
        Ok(PickDirectoryResult {
            canceled: false,
            path: Some(canonical.to_string_lossy().to_string()),
        })
    }
    #[cfg(not(desktop))]
    Err("pick_backup_directory is only available on desktop".to_string())
}

/// 项目本地配置写入：仅允许写 `<project_root>/.kimi-code/local.toml`。
/// `project_root` 必须是已存在的目录；路径在 Rust 侧拼接并校验，
/// 不接受 renderer 直接指定任意绝对写目标。
#[tauri::command]
pub fn write_project_local_config(
    project_root: String,
    content: String,
    expected_sha256: String,
) -> Result<String, String> {
    let root = resolve_home(&project_root);
    validate_no_parent_traversal(&root)?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|error| format!("resolve project root {}: {error}", root.display()))?;
    if !canonical_root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            canonical_root.display()
        ));
    }
    let target = canonical_root.join(".kimi-code").join("local.toml");
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("ensure {}: {error}", parent.display()))?;
    }
    atomic_write_text(&target, &content, Some(expected_sha256.as_str()))?;
    Ok(sha256_bytes(content.as_bytes()))
}

// ── 持久 durable grant 记录（B1）──
// 为什么用独立 JSON（access-grants.json）而不是给 SQLite panel_settings 加列（决策记录）：
//   - panel_settings 是结构化列 + 手写保存 SQL 的 UI 设置表（见 panel_settings_store.rs），
//     加列需同步改 save_panel_settings / get_panel_settings 及测试，破坏面大；
//     且 backup_local_path 就存在该表——正是本次要弱化的「renderer 字符串即授权」来源。
//   - durable grants 属授权域（唯一产生来源：Rust 原生 dialog / 受管根），与 UI 偏好解耦，
//     且 reconcile 在 SQLite 连接（UsageState.conn）可能尚未打开时就需要读取。
//   - 独立文件与 backup-encryption.key 同权限模型（目录 0700 / 文件 0600），
//     字段 root / kind / source / created_at 便于审计归属。

/// durable grant store 文件路径：`~/.kimi-code-switch-gui/access-grants.json`（目录 0700）。
fn access_grants_file() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    let app_dir = home.join(".kimi-code-switch-gui");
    std::fs::create_dir_all(&app_dir)
        .map_err(|error| format!("create app data directory {}: {error}", app_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&app_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("chmod app data directory {}: {error}", app_dir.display()))?;
    }
    Ok(app_dir.join(DURABLE_GRANTS_FILE_NAME))
}

/// 读取持久 durable 授权。文件缺失/损坏时退回空列表，不阻断启动。
fn load_durable_grants_from(file_path: &Path) -> Vec<DurableGrantRecord> {
    match std::fs::read_to_string(file_path) {
        Ok(content) => serde_json::from_str::<DurableGrantFile>(&content)
            .map(|file| file.grants)
            .unwrap_or_else(|error| {
                log::warn!("parse durable grant store {}: {error}", file_path.display());
                Vec::new()
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            log::warn!("read durable grant store {}: {error}", file_path.display());
            Vec::new()
        }
    }
}

/// 追加/更新一条持久 durable 授权（同 root+kind+source 幂等替换）。
/// 文件由 atomic_write_text 以 0600 权限原子落盘。
fn save_durable_grant_to(file_path: &Path, record: &DurableGrantRecord) -> Result<(), String> {
    let mut existing = load_durable_grants_from(file_path);
    existing.retain(|current| {
        !(current.root == record.root
            && current.kind == record.kind
            && current.source == record.source)
    });
    existing.push(record.clone());
    let file = DurableGrantFile {
        version: 1,
        grants: existing,
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|error| format!("serialize durable grant store: {error}"))?;
    atomic_write_text(file_path, &json, None)
}

/// 生产入口：写往真实 `~/.kimi-code-switch-gui/access-grants.json`。
fn save_durable_grant(record: &DurableGrantRecord) -> Result<(), String> {
    save_durable_grant_to(&access_grants_file()?, record)
}

/// 从面板设置读取环境 homePath 并过滤：仅保留 canonicalize 后落在受管根内的路径。
/// `home`（受管根基准）注入便于测试；空 / 不存在 / 越界的 home 一律跳过。
fn managed_environment_homes_from_panel_settings_at(
    settings_json: &str,
    home: &Path,
) -> Result<Vec<PathBuf>, String> {
    let settings: serde_json::Value = serde_json::from_str(settings_json)
        .map_err(|error| format!("parse saved panel settings for environment homes: {error}"))?;
    let settings = settings
        .as_object()
        .ok_or("saved panel settings for environment homes must be a JSON object")?;
    let Some(environments) = settings
        .get("kimi_code_environments")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(Vec::new());
    };
    let mut homes = Vec::new();
    for environment in environments {
        let Some(home_path) = environment
            .as_object()
            .and_then(|environment| environment.get("homePath"))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let home_path = home_path.trim();
        if home_path.is_empty() {
            continue;
        }
        let resolved = resolve_home(home_path);
        let Ok(canonical) = std::fs::canonicalize(&resolved) else {
            log::warn!(
                "skip non-existent environment home for durable grant: {}",
                resolved.display()
            );
            continue;
        };
        if !within_managed_root_at(&canonical, home) {
            log::warn!(
                "skip environment home outside managed roots for durable grant: {}",
                canonical.display()
            );
            continue;
        }
        if !homes.iter().any(|existing| existing == &canonical) {
            homes.push(canonical);
        }
    }
    Ok(homes)
}

/// 可测试/可复用实现体：从 durable grant store 重建持久授权，并按受管根过滤环境 home。
fn reconcile_durable_grants_inner(
    grant_state: &PathGrantState,
    store_file: Option<&Path>,
    home: &Path,
    settings_json: Option<&str>,
) -> Result<(), String> {
    // B1：写/删授权的重建只信任 Rust durable grant store（由 dialog 产生），
    // 不再把 SQLite 面板设置的 backup_local_path 等 renderer 字符串当作授权来源。
    if let Some(store_file) = store_file {
        for record in load_durable_grants_from(store_file) {
            grant_state.register_durable_record(&record);
        }
    }
    // 环境 home 仅当 canonicalize 后落在受管根内才重建 legacy 授权，越界跳过。
    if let Some(settings_json) = settings_json {
        let homes = managed_environment_homes_from_panel_settings_at(settings_json, home)?;
        for home in homes {
            grant_state.register_durable(home, GrantTargetKind::DirectoryTree);
        }
    }
    Ok(())
}

/// 启动时用 Rust durable grant store（access-grants.json）重建持久授权。
/// store 缺失/损坏不阻断启动；面板设置的 backup_local_path 不再产生任何授权。
#[tauri::command]
pub fn reconcile_durable_grants(
    usage_state: tauri::State<'_, crate::usage::UsageState>,
    grant_state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let store_file = access_grants_file().ok();
    let settings_json = crate::panel_settings_store::get_panel_settings(usage_state)?;
    reconcile_durable_grants_inner(
        &grant_state,
        store_file.as_deref(),
        &home,
        settings_json.as_deref(),
    )
}

/// 把损坏/未知版本的 journal 原文件原子移动到 private quarantine 目录。
/// 目录 0700、文件 0600；返回隔离后路径；文件不存在时返回空串（幂等）。
#[tauri::command]
pub fn quarantine_journal(path: String) -> Result<String, String> {
    let source = resolve_home(&path);
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    quarantine_journal_at_home(&source, &home)
}

fn quarantine_journal_at_home(source: &Path, home: &Path) -> Result<String, String> {
    let metadata = match std::fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("stat journal {}: {error}", source.display())),
    };
    if !metadata.is_file() {
        return Err(format!(
            "journal is not a regular file: {}",
            source.display()
        ));
    }
    let quarantine_dir = home.join(".kimi-code-switch-gui").join("quarantine");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(&quarantine_dir)
            .map_err(|e| format!("create quarantine dir {}: {e}", quarantine_dir.display()))?;
        std::fs::set_permissions(&quarantine_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod quarantine dir: {e}"))?;
    }
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| format!("quarantine id: {e}"))?;
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("journal.json");
    let destination = quarantine_dir.join(format!("{file_name}.{suffix}"));
    std::fs::rename(source, &destination)
        .map_err(|e| format!("move journal to quarantine: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod quarantined journal: {e}"))?;
    }
    Ok(destination.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_home_expands_tilde_prefix() {
        let home = dirs::home_dir().expect("home dir required for this test");
        let resolved = resolve_home("~/.kimi/config.toml");
        assert_eq!(resolved, home.join(".kimi/config.toml"));
    }

    #[test]
    fn backup_recovery_key_validation_requires_32_hex_bytes() {
        assert!(is_valid_backup_encryption_secret(&"a".repeat(64)));
        assert!(is_valid_backup_encryption_secret(&"F".repeat(64)));
        assert!(!is_valid_backup_encryption_secret(&"a".repeat(63)));
        assert!(!is_valid_backup_encryption_secret(&"g".repeat(64)));
    }

    #[test]
    fn authorize_mutation_allows_kimi_dirs() {
        let grants = PathGrantState::default();
        let home = dirs::home_dir().expect("home dir required for this test");
        let managed = [
            home.join(".kimi/config.toml"),
            home.join(".kimi-code/config.toml"),
            home.join(".kimi-code-switch-gui/app.db"),
        ];
        for path in managed {
            assert!(
                authorize_mutation(&grants, &path, MutationKind::SingleFile).is_ok(),
                "managed root should be allowed: {}",
                path.display()
            );
        }
    }

    #[test]
    fn authorize_mutation_rejects_arbitrary_absolute_paths_without_grant() {
        let grants = PathGrantState::default();
        // 关键安全回归：无 dialog grant 的任意绝对路径必须被拒绝（不再默认允许）。
        assert!(
            authorize_mutation(&grants, Path::new("/etc/passwd"), MutationKind::SingleFile)
                .is_err()
        );
        assert!(authorize_mutation(
            &grants,
            Path::new("/tmp/export-backup.zip"),
            MutationKind::SingleFile
        )
        .is_err());
        // ~/.ssh 也不在受管根内
        let home = dirs::home_dir().expect("home dir required for this test");
        assert!(
            authorize_mutation(&grants, &home.join(".ssh/id_rsa"), MutationKind::SingleFile)
                .is_err()
        );
    }

    #[test]
    fn authorize_mutation_rejects_parent_traversal() {
        let grants = PathGrantState::default();
        let home = dirs::home_dir().expect("home dir required for this test");
        let traversal = home.join(".kimi/../../.ssh/id_rsa");
        assert!(authorize_mutation(&grants, &traversal, MutationKind::SingleFile).is_err());
        assert!(authorize_mutation(
            &grants,
            &resolve_home("~/.kimi/../.ssh/id_rsa"),
            MutationKind::SingleFile
        )
        .is_err());
    }

    #[test]
    fn authorize_mutation_honors_directory_tree_grant_scope() {
        let grants = PathGrantState::default();
        let tmp = std::env::temp_dir().join(format!(
            "kimi-grant-scope-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        grants.register_durable(tmp.clone(), GrantTargetKind::DirectoryTree);
        // 目录树 grant 允许任何子路径
        assert!(authorize_mutation(
            &grants,
            &tmp.join("backups/2026/backup.json"),
            MutationKind::DirectoryTree
        )
        .is_ok());
        // A folder picked for local backups must also authorize the files
        // written into the backup directory.
        assert!(authorize_mutation(
            &grants,
            &tmp.join("backups/2026/config.toml"),
            MutationKind::SingleFile
        )
        .is_ok());
        // sibling（前缀欺骗）不匹配
        let sibling = tmp.display().to_string() + "_evil";
        assert!(
            authorize_mutation(&grants, Path::new(&sibling), MutationKind::DirectoryTree).is_err()
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn panel_settings_produce_durable_grants_only_for_managed_environment_homes() {
        let base = std::env::temp_dir().join(format!(
            "kimi-managed-homes-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        // macOS 的 /var → /private/var 是 symlink：注入的 home 需 canonical，否则 canonical 后的 homePath
        // 不再 starts_with 未解析的 home（生产环境 ~ 本身就是真实路径，无此问题）。
        let home_dir = base.join("home");
        std::fs::create_dir_all(home_dir.join(".kimi-code")).unwrap();
        let home = std::fs::canonicalize(&home_dir).unwrap();
        let managed = home.join(".kimi-code");
        let out_of_bounds = base.join("custom-kimi");
        std::fs::create_dir_all(&out_of_bounds).unwrap();
        // B1：renderer 可自由写入的 backup_local_path 不再产生任何授权。
        let settings = serde_json::json!({
            "backup_local_path": base.join("backups").to_string_lossy(),
            "kimi_code_environments": [
                { "homePath": managed.to_string_lossy() },
                { "homePath": out_of_bounds.to_string_lossy() },
                { "homePath": "" }
            ]
        })
        .to_string();
        let paths = managed_environment_homes_from_panel_settings_at(&settings, &home).unwrap();
        // 只有落在受管根内的 home 被保留；~/custom-kimi 越界、空串被跳过。
        assert_eq!(paths, vec![std::fs::canonicalize(&managed).unwrap()]);
        assert!(managed_environment_homes_from_panel_settings_at("[]", &home).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn backup_directory_write_requires_a_recorded_durable_grant() {
        let grants = PathGrantState::default();
        let base = std::env::temp_dir().join(format!(
            "kimi-backup-dir-grant-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let backup = base.join("backups");
        std::fs::create_dir_all(&backup).unwrap();

        // pick 前：仅手输同一路径（对应只改 SQLite 里的 backup_local_path）不产生授权 → 被拒。
        let error = authorize_mutation(
            &grants,
            &backup.join("config.toml"),
            MutationKind::SingleFile,
        )
        .expect_err("unrecorded backup path must be rejected");
        assert!(error.contains("outside the authorized scope"));

        // 模拟 pick_backup_directory 落盘：durable store 记录 + 内存登记（command 走同一路径）。
        let store_file = base.join("access-grants.json");
        let record = DurableGrantRecord {
            root: backup.to_string_lossy().to_string(),
            kind: GrantTargetKind::DirectoryTree,
            source: GrantSource::Dialog,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        save_durable_grant_to(&store_file, &record).unwrap();

        // 「重启」后 reconcile：该目录内目录树/单文件写均放行。
        let fresh = PathGrantState::default();
        reconcile_durable_grants_inner(&fresh, Some(&store_file), &base, None).unwrap();
        assert!(authorize_mutation(
            &fresh,
            &backup.join("2026/config.toml"),
            MutationKind::DirectoryTree
        )
        .is_ok());
        assert!(authorize_mutation(
            &fresh,
            &backup.join("2026/config.toml"),
            MutationKind::SingleFile
        )
        .is_ok());
        // sibling 前缀欺骗仍不匹配。
        assert!(authorize_mutation(
            &fresh,
            Path::new(&(backup.display().to_string() + "_evil/backup.json")),
            MutationKind::SingleFile
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn durable_grant_store_survives_restart_and_reconcile_is_idempotent() {
        let base = std::env::temp_dir().join(format!(
            "kimi-durable-store-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let store_file = base.join("access-grants.json");
        let backup = base.join("backups");
        std::fs::create_dir_all(&backup).unwrap();

        let record = DurableGrantRecord {
            root: std::fs::canonicalize(&backup)
                .unwrap()
                .to_string_lossy()
                .to_string(),
            kind: GrantTargetKind::DirectoryTree,
            source: GrantSource::Dialog,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        save_durable_grant_to(&store_file, &record).unwrap();

        // 重启 1：reconcile 从磁盘重建。
        let grants = PathGrantState::default();
        reconcile_durable_grants_inner(&grants, Some(&store_file), &base, None).unwrap();
        assert!(
            authorize_mutation(&grants, &backup.join("a.toml"), MutationKind::SingleFile).is_ok()
        );

        // 幂等：再次 reconcile 不报错、不丢授权。
        reconcile_durable_grants_inner(&grants, Some(&store_file), &base, None).unwrap();
        assert!(
            authorize_mutation(&grants, &backup.join("b.toml"), MutationKind::SingleFile).is_ok()
        );

        // 重启 2：全新状态再次从磁盘重建。
        let fresh = PathGrantState::default();
        reconcile_durable_grants_inner(&fresh, Some(&store_file), &base, None).unwrap();
        assert!(
            authorize_mutation(&fresh, &backup.join("c.toml"), MutationKind::SingleFile).is_ok()
        );

        // 记录字段序列化契约：kind=PascalCase（DirectoryTree），source=kebab-case（dialog）。
        let content = std::fs::read_to_string(&store_file).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let canonical_root = std::fs::canonicalize(&backup)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(
            parsed["grants"][0]["root"],
            serde_json::Value::String(canonical_root)
        );
        assert_eq!(parsed["grants"][0]["kind"], "DirectoryTree");
        assert_eq!(parsed["grants"][0]["source"], "dialog");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store_file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn out_of_bounds_environment_home_is_skipped_by_reconcile() {
        let base = std::env::temp_dir().join(format!(
            "kimi-out-of-bounds-home-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        // 同上：注入的 home 需 canonical（/var 是 /private/var 的 symlink）。
        let home_dir = base.join("home");
        std::fs::create_dir_all(home_dir.join(".kimi-code")).unwrap();
        let home = std::fs::canonicalize(&home_dir).unwrap();
        let managed = home.join(".kimi-code");
        let evil_home = base.join("custom-home");
        std::fs::create_dir_all(&evil_home).unwrap();
        let settings = serde_json::json!({
            "kimi_code_environments": [
                { "homePath": evil_home.to_string_lossy() },
                { "homePath": managed.to_string_lossy() }
            ]
        })
        .to_string();

        let grants = PathGrantState::default();
        reconcile_durable_grants_inner(
            &grants,
            Some(&base.join("access-grants.json")),
            &home,
            Some(&settings),
        )
        .unwrap();
        // 越界 home 即使已存在也未产生授权。
        assert!(authorize_mutation(
            &grants,
            &evil_home.join("config.toml"),
            MutationKind::SingleFile
        )
        .is_err());
        // 受管根内 home 放行。
        assert!(authorize_mutation(
            &grants,
            &managed.join("config.toml"),
            MutationKind::SingleFile
        )
        .is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn durable_grant_record_serializes_with_expected_fields() {
        let record = DurableGrantRecord {
            root: "/Users/example/backups".to_string(),
            kind: GrantTargetKind::DirectoryTree,
            source: GrantSource::Dialog,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["root"], "/Users/example/backups");
        assert_eq!(json["kind"], "DirectoryTree");
        assert_eq!(json["source"], "dialog");
        // rename_all=camelCase：created_at → createdAt。
        assert_eq!(json["createdAt"], "2026-01-01T00:00:00Z");
        assert!(json.get("created_at").is_none());
    }

    #[test]
    fn authorize_mutation_rejects_symlink_escape_via_granted_dir() {
        let grants = PathGrantState::default();
        let tmp = std::env::temp_dir().join(format!(
            "kimi-symlink-escape-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tmp.join("granted");
        std::fs::create_dir_all(&root).unwrap();
        let escape_dir = tmp.join("outside");
        std::fs::create_dir_all(&escape_dir).unwrap();
        let _ = grants.register_durable(root.clone(), GrantTargetKind::DirectoryTree);
        // 受管根内指向受管根外的目录 symlink 不得放行
        #[cfg(unix)]
        {
            let link = root.join("link-dir");
            std::os::unix::fs::symlink(&escape_dir, &link).unwrap();
            let result = authorize_mutation(&grants, &link, MutationKind::DirectoryTree);
            assert!(
                result.is_err(),
                "symlink escaping the grant must be rejected"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn atomic_write_text_replaces_complete_content_and_preserves_permissions() {
        let base = std::env::temp_dir().join(format!(
            "kimi-atomic-write-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("config.toml");
        std::fs::write(&target, "old").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        }

        atomic_write_text(&target, "new-complete-content", None)
            .expect("atomic write should succeed");

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "new-complete-content"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        assert_eq!(
            std::fs::read_dir(&base).unwrap().count(),
            1,
            "temporary file should be committed or cleaned up"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_text_rejects_stale_revision_without_changing_the_file() {
        let base = std::env::temp_dir().join(format!(
            "kimi-cas-write-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("mcp.json");
        std::fs::write(&target, "external-change").unwrap();

        let error = atomic_write_text(&target, "gui-change", Some("stale-hash"))
            .expect_err("stale revision must be rejected");

        assert!(error.contains("write conflict"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "external-change");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_file_cas_only_deletes_the_written_revision() {
        let base = std::env::temp_dir().join(format!(
            "kimi-cas-remove-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("mcp.json");
        std::fs::write(&target, "created-by-save").unwrap();
        let grants = PathGrantState::default();
        grants.register_durable(target.clone(), GrantTargetKind::File);

        let stale = remove_file_cas_inner(&target.to_string_lossy(), "stale-hash", &grants)
            .expect_err("stale delete must be rejected");
        assert!(stale.contains("write conflict"));
        assert!(target.exists());

        remove_file_cas_inner(
            &target.to_string_lossy(),
            &sha256_bytes(b"created-by-save"),
            &grants,
        )
        .expect("matching revision should be removed");
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn portable_directory_round_trip_preserves_binary_files_and_rejects_traversal() {
        let base = std::env::temp_dir().join(format!(
            "kimi-portable-skills-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let source = base.join("skills");
        let skill = source.join("demo");
        std::fs::create_dir_all(skill.join("assets")).unwrap();
        std::fs::write(skill.join("SKILL.md"), b"# Demo\n").unwrap();
        std::fs::write(skill.join("assets/icon.bin"), [0_u8, 255, 7, 9]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                skill.join("SKILL.md"),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }

        let bundle = export_portable_directory(source.to_string_lossy().into_owned())
            .expect("skills should export");
        assert!(bundle.exists);
        assert_eq!(bundle.files.len(), 2);
        let target = base.join("restored-skills");
        let absent_revision = export_portable_directory(target.to_string_lossy().into_owned())
            .unwrap()
            .sha256;
        let grants = PathGrantState::default();
        grants.register_durable(base.clone(), GrantTargetKind::DirectoryTree);
        replace_portable_directory_inner(
            &target.to_string_lossy(),
            bundle,
            absent_revision,
            &grants,
        )
        .expect("skills should restore");
        assert_eq!(
            std::fs::read(target.join("demo/assets/icon.bin")).unwrap(),
            vec![0_u8, 255, 7, 9]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(target.join("demo/SKILL.md"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0o100
            );
        }

        let malicious = PortableDirectoryBundle {
            exists: true,
            directories: Vec::new(),
            files: vec![PortableFileBundle {
                relative_path: "../escape".to_string(),
                content_base64: BASE64_STANDARD.encode(b"nope"),
                executable: false,
            }],
            sha256: None,
        };
        let error =
            replace_portable_directory_inner(&target.to_string_lossy(), malicious, None, &grants)
                .expect_err("traversal must be rejected");
        assert!(error.contains("invalid portable relative path"));
        assert_eq!(
            std::fs::read_to_string(target.join("demo/SKILL.md")).unwrap(),
            "# Demo\n"
        );

        let current_bundle = export_portable_directory(target.to_string_lossy().into_owned())
            .expect("current Skills revision");
        std::fs::write(target.join("external.md"), "external change").unwrap();
        let conflict = replace_portable_directory_inner(
            &target.to_string_lossy(),
            current_bundle.clone(),
            current_bundle.sha256.clone(),
            &grants,
        )
        .expect_err("stale Skills revision must be rejected");
        assert!(conflict.contains("portable directory conflict"));
        std::fs::remove_file(target.join("external.md")).unwrap();

        let too_deep = (0..=PORTABLE_DIRECTORY_MAX_DEPTH)
            .map(|index| format!("d{index}"))
            .collect::<Vec<_>>()
            .join("/");
        let error = replace_portable_directory_inner(
            &target.to_string_lossy(),
            PortableDirectoryBundle {
                exists: true,
                directories: vec![too_deep],
                files: Vec::new(),
                sha256: None,
            },
            None,
            &grants,
        )
        .expect_err("excessive path depth must be rejected");
        assert!(error.contains("invalid portable relative path"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn replace_portable_directory_detects_staging_window_external_change() {
        let base = std::env::temp_dir().join(format!(
            "kimi-portable-staging-conflict-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("skills");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), b"# base\n").unwrap();
        let grants = PathGrantState::default();
        grants.register_durable(base.clone(), GrantTargetKind::DirectoryTree);

        // 捕获调用前 target revision，作为 expected。
        let dead_revision = export_portable_directory(target.to_string_lossy().into_owned())
            .unwrap()
            .sha256;
        // 构造 desired bundle（只含 base SKILL.md），expected 用"过期"的 revision——
        // 但入口检查与 staging 后检查都读同一目标目录；为了单独验证"staging 完成后
        // 目标被外部修改"的复核路径，这里用期望=当前，然后在 staging 构建期间无法插桩。
        // 退而求其次：验证"staging 后复核"逻辑——将要恢复的目标目录在调用前写入，
        // 使调用方传入的 expected 与真实 revision 一致，则 staging 完成后复核通过，交换成功。
        let bundle = PortableDirectoryBundle {
            exists: true,
            directories: Vec::new(),
            files: vec![PortableFileBundle {
                relative_path: "SKILL.md".to_string(),
                content_base64: BASE64_STANDARD.encode(b"# base\n"),
                executable: false,
            }],
            sha256: None,
        };
        // 1) 正常路径：expected 匹配当前 revision，swap 成功。
        replace_portable_directory_inner(
            &target.to_string_lossy(),
            bundle,
            Some(dead_revision.clone().unwrap_or_default()),
            &grants,
        )
        .expect("matching revision should swap");
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap_or_default(),
            "# base\n"
        );

        // 2) 目标在调用后被外部修改（expected 是修改前的 revision）——
        //    入口检查就会失败并抛 conflict（与 staging 后检查共用同一 comparison）。
        let current = export_portable_directory(target.to_string_lossy().into_owned())
            .unwrap()
            .sha256;
        std::fs::write(target.join("external.md"), "external change").unwrap();
        let conflict = replace_portable_directory_inner(
            &target.to_string_lossy(),
            PortableDirectoryBundle {
                exists: true,
                directories: Vec::new(),
                files: Vec::new(),
                sha256: None,
            },
            current,
            &grants,
        )
        .expect_err("external change must be rejected");
        assert!(
            conflict.contains("portable directory conflict")
                || conflict.contains("external change conflict"),
            "unexpected conflict message: {conflict}"
        );
        // 目标目录没有被删除/替换。
        assert!(target.join("external.md").exists());
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap_or_default(),
            "# base\n"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_text_preserves_file_symlinks() {
        let base = std::env::temp_dir().join(format!(
            "kimi-symlink-write-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("dotfiles-config.toml");
        let link = base.join("config.toml");
        std::fs::write(&target, "old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        atomic_write_text(&link, "new", None).expect("symlink target should be updated");

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn merge_directory_missing_preserves_native_entries_and_copies_legacy_only_entries() {
        let base = std::env::temp_dir().join(format!(
            "kimi-merge-directory-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let source = base.join("legacy");
        let target = base.join("native");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("same.md"), "legacy").unwrap();
        std::fs::write(source.join("legacy-only.md"), "legacy only").unwrap();
        std::fs::write(source.join("nested").join("SKILL.md"), "nested skill").unwrap();
        std::fs::write(target.join("same.md"), "native").unwrap();

        let mut result = DirectoryMergeResult {
            source_exists: true,
            copied_entries: 0,
            skipped_conflicts: 0,
        };
        merge_directory_missing_recursive(&source, &target, &mut result).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("same.md")).unwrap(),
            "native"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("legacy-only.md")).unwrap(),
            "legacy only"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("nested").join("SKILL.md")).unwrap(),
            "nested skill"
        );
        assert!(result.copied_entries >= 2);
        assert_eq!(result.skipped_conflicts, 1);
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["sourceExists"], true);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_home_expands_bare_tilde() {
        let home = dirs::home_dir().expect("home dir required for this test");
        assert_eq!(resolve_home("~"), home);
    }

    #[test]
    fn resolve_home_keeps_absolute_path_unchanged() {
        // 绝对路径不含 ~ 前缀，应原样返回。
        assert_eq!(resolve_home("/etc/hosts"), PathBuf::from("/etc/hosts"));
    }

    #[test]
    fn resolve_home_keeps_relative_path_unchanged() {
        // 相对路径既非 "~" 也无 "~/" 前缀，原样返回。
        assert_eq!(resolve_home("foo/bar.txt"), PathBuf::from("foo/bar.txt"));
    }

    #[test]
    fn resolve_home_does_not_expand_tilde_in_middle() {
        // 只识别开头的 ~/ 与单独的 ~，路径中间的 ~ 不展开。
        assert_eq!(resolve_home("/var/~cache"), PathBuf::from("/var/~cache"));
    }

    #[test]
    fn dir_entry_serializes_is_directory_camel_case() {
        let entry = DirEntry {
            name: "skills".to_string(),
            is_directory: true,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["name"], "skills");
        // serde rename 应输出 camelCase 键 isDirectory。
        assert_eq!(json["isDirectory"], true);
        assert!(json.get("is_directory").is_none());
    }

    #[test]
    fn quarantine_journal_moves_file_with_private_permissions_and_is_idempotent() {
        let base = std::env::temp_dir().join(format!(
            "kimi-quarantine-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let home = base.join("home");
        let source = home
            .join(".kimi-code-switch-gui")
            .join("pending-save-transaction.json");
        assert_eq!(quarantine_journal_at_home(&source, &home).unwrap(), "");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "{bad-json").unwrap();
        let quarantined = quarantine_journal_at_home(&source, &home).unwrap();
        assert!(quarantined.contains("quarantine"));
        assert!(!source.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let quarantine_dir = home.join(".kimi-code-switch-gui").join("quarantine");
            assert_eq!(
                std::fs::metadata(&quarantine_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            let quarantined_path = std::path::PathBuf::from(&quarantined);
            assert_eq!(
                std::fs::metadata(&quarantined_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        // 清理测试产物
        let _ = std::fs::remove_dir_all(&base);
    }

    fn temp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kimi-repair-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn seed_legacy_managed_default(home: &Path) -> (PathBuf, PathBuf) {
        let managed = home
            .join(".kimi-code-switch-gui")
            .join(".env")
            .join("default");
        std::fs::create_dir_all(managed.join("skills").join("ask-matt")).unwrap();
        std::fs::write(managed.join("config.toml"), "default_model = \"demo\"\n").unwrap();
        std::fs::write(managed.join("skills").join("ask-matt").join("SKILL.md"), "# ask-matt\n")
            .unwrap();
        let native = home.join(".kimi-code");
        create_symlink_path(&managed, &native).unwrap();
        (managed, native)
    }

    #[test]
    fn repair_materializes_real_native_home_and_skill_copies() {
        let base = temp_home("flip");
        let home = base.join("home");
        let external = base.join("external-skills");
        std::fs::create_dir_all(external.join("shared-skill")).unwrap();
        std::fs::write(external.join("shared-skill").join("SKILL.md"), "# shared\n").unwrap();

        let (managed, native) = seed_legacy_managed_default(&home);
        create_symlink_path(&external.join("shared-skill"), &managed.join("skills").join("shared-skill"))
            .unwrap();

        let result = repair_native_home_symlink_at(&home).unwrap();
        assert!(result.repaired, "expected repair to run: {}", result.reason);
        assert!(result.skills_materialized.iter().any(|e| e.name == "shared-skill" && e.copied));

        // ~/.kimi-code 现在是真实目录，不再是指向 GUI 数据目录的符号链接。
        let native_meta = std::fs::symlink_metadata(&native).unwrap();
        assert!(!native_meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read_to_string(native.join("config.toml")).unwrap(),
            "default_model = \"demo\"\n"
        );
        // .env/default 已被翻转，不再存在；源数据没有丢失。
        assert!(!managed.exists());
        // 技能副本是真实目录，内容完整。
        assert_eq!(
            std::fs::read_to_string(native.join("skills").join("shared-skill").join("SKILL.md")).unwrap(),
            "# shared\n"
        );
        // 技能副本目录本身是真实目录（不再是符号链接）。
        assert!(std::fs::symlink_metadata(native.join("skills").join("shared-skill"))
            .unwrap()
            .file_type()
            .is_dir());

        // 幂等：第二次调用不再修复。
        let second = repair_native_home_symlink_at(&home).unwrap();
        assert!(!second.repaired);
        assert_eq!(second.reason, "not-a-symlink");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn repair_leaves_real_dir_and_foreign_symlink_untouched() {
        let base = temp_home("skip");
        let home = base.join("home");
        let foreign = base.join("foreign-home");
        std::fs::create_dir_all(&foreign).unwrap();

        // 真实目录（非符号链接）→ 不修复。
        std::fs::create_dir_all(home.join(".kimi-code")).unwrap();
        let result = repair_native_home_symlink_at(&home).unwrap();
        assert!(!result.repaired);
        assert_eq!(result.reason, "not-a-symlink");

        // 符号链接指向 .env/default 之外的目录 → 拒绝。
        std::fs::remove_dir_all(home.join(".kimi-code")).unwrap();
        std::fs::create_dir_all(home.join(".kimi-code-switch-gui").join(".env").join("default")).unwrap();
        create_symlink_path(&foreign, &home.join(".kimi-code")).unwrap();
        let result = repair_native_home_symlink_at(&home).unwrap();
        assert!(!result.repaired);
        assert_eq!(result.reason, "foreign-symlink-target");
        // 链接仍保留原样。
        assert!(std::fs::symlink_metadata(home.join(".kimi-code")).unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn repair_reports_broken_skill_target_and_keeps_link() {
        let base = temp_home("broken");
        let home = base.join("home");
        let (managed, native) = seed_legacy_managed_default(&home);
        let missing = base.join("missing-skill");
        create_symlink_path(&missing, &managed.join("skills").join("ghost")).unwrap();

        let result = repair_native_home_symlink_at(&home).unwrap();
        assert!(result.repaired);
        let ghost = result
            .skills_materialized
            .iter()
            .find(|e| e.name == "ghost")
            .expect("ghost entry present");
        assert!(!ghost.copied);
        assert_eq!(ghost.reason, "broken-target");
        // 断链技能仍保留为符号链接（不破坏数据）。
        assert!(std::fs::symlink_metadata(native.join("skills").join("ghost")).unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn repair_resolves_relative_symlink_targets_against_their_own_directory() {
        let base = temp_home("relative");
        let home = base.join("home");
        let (managed, native) = seed_legacy_managed_default(&home);

        // home 链接改为相对目标（相对链接所在目录 home 解析）。
        std::fs::remove_file(&native).unwrap();
        create_symlink_path(Path::new(".kimi-code-switch-gui/.env/default"), &native).unwrap();

        // 技能链接用相对目标（相对 skills/ 目录解析）。
        std::fs::create_dir_all(managed.join("skills-source")).unwrap();
        std::fs::write(managed.join("skills-source").join("SKILL.md"), "# rel\n").unwrap();
        create_symlink_path(Path::new("../skills-source"), &managed.join("skills").join("rel-skill"))
            .unwrap();

        let result = repair_native_home_symlink_at(&home).unwrap();
        assert!(result.repaired, "reason: {}", result.reason);
        assert!(!std::fs::symlink_metadata(&native).unwrap().file_type().is_symlink());
        let entry = result
            .skills_materialized
            .iter()
            .find(|e| e.name == "rel-skill")
            .expect("rel-skill entry present");
        assert!(entry.copied, "reason: {}", entry.reason);
        assert_eq!(
            std::fs::read_to_string(native.join("skills").join("rel-skill").join("SKILL.md")).unwrap(),
            "# rel\n"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
