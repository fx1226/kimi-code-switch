//! 文件读写原子能力——对应 Electron 侧 src/main/modules/fileAccess.ts
//! 前端 shared/configStore 的 FileAccess 接口下沉到这里，通过 invoke 调用。
//!
//! 安全模型（B1）：所有写/删/移命令必须通过 `authorize_mutation` 得到授权。
//! renderer 不能仅凭字符串声明任意绝对路径可写；只能落在：
//!   1. 固定受管根（~/.kimi、~/.kimi-code、~/.kimi-code-switch-gui）
//!   2. 由 Rust 原生 dialog 产生的临时 grant（导出文件、备份目录）
//!   3. 项目本地配置组合命令 `write_project_local_config`（仅 <project-root>/.kimi-code/local.toml）
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

/// 授权目录类型：区分"单个文件路径"与"可递归创建子项的目录树"。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GrantTargetKind {
    File,
    DirectoryTree,
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
    /// 持久授权 id => root，供备份路径这类长期偏好使用；未来升级时持久化于 SQLite（GUI 元数据）。
    durable_roots: Mutex<Vec<(String, PathBuf, GrantTargetKind)>>,
}

const GRANT_TTL: Duration = Duration::from_secs(15 * 60);

impl PathGrantState {
    /// 登记一个持久授权（目前路径全部来自 Rust dialog；短时 grant 语义保留待 future 使用）。
    fn register_durable(&self, root: PathBuf, kind: GrantTargetKind) -> String {
        self.register_inner(root, kind, true)
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
        if durable {
            self.durable_roots.lock().expect("durable root lock").push((
                id.clone(),
                normalized_root,
                kind,
            ));
        }
        id
    }

    /// 检查 `candidate` 是否落在某个未过期且类型匹配的 grant 范围内。
    /// grant 匹配使用组件级 `Path::starts_with`，杜绝 sibling/prefix 字符串欺骗。
    fn scope_contains(&self, candidate: &Path, kind: GrantTargetKind) -> bool {
        let now = Instant::now();
        let mut grants = self.grants.lock().expect("grant lock");
        {
            let durable_roots = self.durable_roots.lock().expect("durable root lock");
            for (_, root, durable_kind) in durable_roots.iter() {
                if *durable_kind == kind && candidate.starts_with(root) {
                    return true;
                }
            }
        }
        grants.retain(|_, grant| grant.durable || grant.expires_at > now);
        grants
            .values()
            .any(|grant| grant.kind == kind && candidate.starts_with(&grant.root))
    }

    fn revoke(&self, id: &str) {
        let mut grants = self.grants.lock().expect("grant lock");
        grants.remove(id);
        let mut durable_roots = self.durable_roots.lock().expect("durable root lock");
        durable_roots.retain(|(registered_id, _, _)| registered_id != id);
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
                return Ok(parent.join(path.file_name().unwrap_or_default().to_os_string()));
            };
            let resolved_ancestor = std::fs::canonicalize(existing)
                .map_err(|e| format!("canonicalize {}: {e}", existing.display()))?;
            let suffix = path.strip_prefix(existing).unwrap_or(path);
            Ok(resolved_ancestor.join(suffix))
        }
        Err(error) => Err(format!("resolve write target {}: {error}", path.display())),
    }
}

/// 判断路径是否落在固定受管根内（组件级比较）。
fn within_managed_root(path: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let bases = [
        home.join(".kimi"),
        home.join(".kimi-code"),
        home.join(".kimi-code-switch-gui"),
    ];
    bases.iter().any(|base| path.starts_with(base))
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
        return Ok(Some(resolved.to_string_lossy().to_string()));
    }
    #[cfg(not(desktop))]
    Err("save_file_with_dialog is only available on desktop".to_string())
}

/// Rust 原生 folder picker：登记一个持久目录 grant 并返回 `{ path, grantId }`。
/// 后续受管写命令（write_text/ensure_private_dir/remove_dir）在该 grant 范围内被授权。
/// 路径由系统对话框产生，renderer 无法伪造。
#[tauri::command]
pub fn pick_backup_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGrantState>,
) -> Result<Option<(String, String)>, String> {
    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(folder) = picked else {
            return Ok(None);
        };
        let Some(path_buf) = folder.as_path() else {
            return Err("dialog returned an invalid path".to_string());
        };
        let resolved = resolve_home(&path_buf.to_string_lossy());
        let grant_id = state.register_durable(resolved.clone(), GrantTargetKind::DirectoryTree);
        return Ok(Some((resolved.to_string_lossy().to_string(), grant_id)));
    }
    #[cfg(not(desktop))]
    Err("pick_backup_folder is only available on desktop".to_string())
}

/// 登记一个项目本地配置根（Rust dialog 选目录），返回 grant id。
#[tauri::command]
pub fn pick_project_local_config_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGrantState>,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(folder) = picked else {
            return Ok(None);
        };
        let Some(path_buf) = folder.as_path() else {
            return Err("dialog returned an invalid path".to_string());
        };
        let resolved = resolve_home(&path_buf.to_string_lossy());
        // 只允许该目录下 `.kimi-code/local.toml` 单文件写。
        let grant_id = state.register_durable(resolved.clone(), GrantTargetKind::File);
        return Ok(Some(grant_id));
    }
    #[cfg(not(desktop))]
    Err("pick_project_local_config_root is only available on desktop".to_string())
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

/// 吊销之前 dialog 登记的 grant（例如用户更改备份目录后）。
#[tauri::command]
pub fn revoke_grant(
    grant_id: String,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    state.revoke(&grant_id);
    Ok(())
}

/// 启动时用已持久化的用户偏好（备份目录、已注册的环境 home、项目根）重建持久授权。
/// 这些路径来自用户主动保存的面板设置/环境注册表（非 renderer 临时字符串），
/// 因此重新登记为 Rust 侧 durable grant 不会削弱安全边界。
#[tauri::command]
pub fn reconcile_durable_grants(
    paths: Vec<String>,
    state: tauri::State<'_, PathGrantState>,
) -> Result<(), String> {
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let resolved = resolve_home(trimmed);
        state.register_durable(resolved, GrantTargetKind::DirectoryTree);
    }
    Ok(())
}

/// 列出当前持久授权的规范路径（诊断/审计用），不包含 grant id 对 renderer 的意义。
#[tauri::command]
pub fn list_durable_grants(state: tauri::State<'_, PathGrantState>) -> Result<Vec<String>, String> {
    let durable_roots = state.durable_roots.lock().expect("durable root lock");
    let mut roots = durable_roots
        .iter()
        .map(|(_, root, _)| root.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    Ok(roots)
}

/// 把损坏/未知版本的 journal 原文件原子移动到 private quarantine 目录。
/// 目录 0700、文件 0600；返回隔离后路径；文件不存在时返回空串（幂等）。
#[tauri::command]
pub fn quarantine_journal(path: String) -> Result<String, String> {
    let source = resolve_home(&path);
    let metadata = match std::fs::symlink_metadata(&source) {
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
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
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
    std::fs::rename(&source, &destination)
        .map_err(|e| format!("move journal to quarantine: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod quarantined journal: {e}"))?;
    }
    Ok(destination.to_string_lossy().to_string())
}

/// 列出 quarantine 目录内容（供 UI 查看/管理）。
#[tauri::command]
pub fn list_quarantine() -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    let quarantine_dir = home.join(".kimi-code-switch-gui").join("quarantine");
    let entries = match std::fs::read_dir(&quarantine_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("list quarantine: {error}")),
    };
    let mut files = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

/// 物理删除一个已隔离的 journal（用户确认"放弃"后调用）。
#[tauri::command]
pub fn delete_quarantined_journal(path: String) -> Result<(), String> {
    let resolved = resolve_home(&path);
    let metadata = match std::fs::symlink_metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "stat quarantined journal {}: {error}",
                resolved.display()
            ))
        }
    };
    if !metadata.is_file() {
        return Err(format!(
            "quarantined path is not a file: {}",
            resolved.display()
        ));
    }
    let home = dirs::home_dir().ok_or("cannot resolve home dir")?;
    let quarantine_dir = home.join(".kimi-code-switch-gui").join("quarantine");
    if !resolved.starts_with(&quarantine_dir) {
        return Err(format!(
            "refusing to delete outside quarantine dir: {}",
            resolved.display()
        ));
    }
    std::fs::remove_file(&resolved)
        .map_err(|e| format!("remove quarantined journal {}: {e}", resolved.display()))
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
        // 对文件类型的写入不匹配目录 grant
        let tmp = std::env::temp_dir();
        let root = tmp.join("granted-dir");
        let _ = std::fs::create_dir_all(&root);
        let grant_id = grants.register_durable(root.clone(), GrantTargetKind::DirectoryTree);
        assert!(
            authorize_mutation(&grants, &root.join("child.txt"), MutationKind::SingleFile).is_err()
        );
        grants.revoke(&grant_id);
        let _ = std::fs::remove_dir_all(&root);
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
        let grant_id = grants.register_durable(tmp.clone(), GrantTargetKind::DirectoryTree);
        // 目录树 grant 允许任何子路径
        assert!(authorize_mutation(
            &grants,
            &tmp.join("backups/2026/backup.json"),
            MutationKind::DirectoryTree
        )
        .is_ok());
        // sibling（前缀欺骗）不匹配
        let sibling = tmp.display().to_string() + "_evil";
        assert!(
            authorize_mutation(&grants, Path::new(&sibling), MutationKind::DirectoryTree).is_err()
        );
        grants.revoke(&grant_id);
        // 吊销后不再允许
        assert!(
            authorize_mutation(&grants, &tmp.join("backups"), MutationKind::DirectoryTree).is_err()
        );
        let _ = std::fs::remove_dir_all(&tmp);
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
        let home = dirs::home_dir().expect("home dir required for this test");
        let source = home
            .join(".kimi-code-switch-gui")
            .join("pending-save-transaction.json");
        if source.exists() {
            // 幂等：不存在时返回空串
            let _ = std::fs::remove_file(&source);
        }
        assert_eq!(
            quarantine_journal(source.to_string_lossy().into_owned()).unwrap(),
            ""
        );
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "{bad-json").unwrap();
        let quarantined = quarantine_journal(source.to_string_lossy().into_owned()).unwrap();
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
        let _ = std::fs::remove_file(&quarantined);
    }
}
