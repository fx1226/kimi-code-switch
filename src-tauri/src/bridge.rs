//! ChatGPT 订阅桥接的 Rust 宿主。
//!
//! 职责（薄壳，业务仍在桥接进程与 shared TS）：
//! - spawn/停止桥接进程：生产为 sidecar（resource_dir/bridge），开发为 `node dist-bridge/bridge.mjs`。
//! - JSONL 控制协议客户端（host ↔ bridge，stdin/stdout）。
//! - OAuth token 经系统凭据存储（keyring）持久化；桥接进程不持久化，刷新后由宿主写回。
//! - 受限连通性探针：仅允许 127.0.0.1 且调用方显式指定端口，不全局放开 SSRF。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const KEYRING_SERVICE: &str = "kimi-code-switch-gui";
const KEYRING_USER: &str = "chatgpt-oauth";

// ─────────────────────────── 消息类型 ───────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AuthState {
    pub status: String, // signed-out | signed-in
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Catalog {
    pub models: Vec<CatalogModel>,
    pub live: bool,
    pub fetched_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CatalogModel {
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_levels: Option<Vec<Effort>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Effort {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BridgeStatus {
    pub port: u32,
    pub auth: AuthState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog: Option<Catalog>,
    pub ok: bool,
}

// ─────────────────────────── 凭据存储 ───────────────────────────

pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<TokenSet>, String>;
    fn save(&self, tokens: &TokenSet) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// keyring 后端；后端不可用/用户拒绝时返回明确错误，绝不回退明文文件。
pub struct KeyringTokenStore;

impl TokenStore for KeyringTokenStore {
    fn load(&self) -> Result<Option<TokenSet>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring: {e}"))?;
        match entry.get_password() {
            Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("token payload invalid: {e}")),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("credential store unavailable: {e}")),
        }
    }
    fn save(&self, tokens: &TokenSet) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring: {e}"))?;
        let raw = serde_json::to_string(tokens).map_err(|e| format!("serialize: {e}"))?;
        entry.set_password(&raw).map_err(|e| format!("credential store unavailable: {e}"))
    }
    fn clear(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("credential store unavailable: {e}")),
        }
    }
}

/// 内存存储（测试用）。
#[allow(dead_code)]
pub struct MemoryTokenStore(pub Mutex<Option<TokenSet>>);

impl TokenStore for MemoryTokenStore {
    fn load(&self) -> Result<Option<TokenSet>, String> {
        let guard = self.0.blocking_lock();
        Ok(guard.clone())
    }
    fn save(&self, tokens: &TokenSet) -> Result<(), String> {
        let mut guard = self.0.blocking_lock();
        *guard = Some(tokens.clone());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        let mut guard = self.0.blocking_lock();
        *guard = None;
        Ok(())
    }
}

// ─────────────────────────── 桥接进程句柄 ───────────────────────────

pub struct BridgeHandle {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    login_tx: Mutex<Option<oneshot::Sender<Value>>>,
    login_rx: Mutex<Option<oneshot::Receiver<Value>>>,
    next_id: AtomicU64,
    port: u32,
    secret: String,
    token_store: Arc<dyn TokenStore>,
}

impl BridgeHandle {
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn send_raw(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let mut line = value.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write to bridge: {e}"))?;
        stdin.flush().await.map_err(|e| format!("flush bridge: {e}"))
    }

    /// 发送带 id 的请求并等待对应响应（超时返回错误）。
    async fn request(&self, kind: &str, payload: Value) -> Result<Value, String> {
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        let mut object = serde_json::Map::new();
        object.insert("id".to_string(), json!(id));
        object.insert("type".to_string(), json!(kind));
        if let Value::Object(map) = payload {
            for (key, value) in map {
                object.insert(key, value);
            }
        }
        self.send_raw(Value::Object(object)).await?;
        timeout(CONTROL_TIMEOUT, rx)
            .await
            .map_err(|_| format!("bridge {kind} timed out"))?
            .map_err(|_| "bridge process exited".to_string())
    }

    /// 创建登录结果通道并保存两端（唯一登录流程）。rx 由 bridge_wait_login 消费。
    async fn new_login_channel(&self) -> Result<(), String> {
        let mut tx_slot = self.login_tx.lock().await;
        let mut rx_slot = self.login_rx.lock().await;
        if tx_slot.is_some() || rx_slot.is_some() {
            return Err("an OAuth login is already in progress".to_string());
        }
        let (tx, rx) = oneshot::channel();
        *tx_slot = Some(tx);
        *rx_slot = Some(rx);
        Ok(())
    }
}

fn parse_bridge_error(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "bridge returned an unknown error".to_string())
}

#[derive(Deserialize)]
struct LoginUrlResponse {
    url: String,
}

fn start_reader_loop(
    handle: Arc<BridgeHandle>,
    stdout: ChildStdout,
) -> tokio::task::JoinHandle<()> {
    let handle_clone = handle.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                _ => break,
            };
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
            let id = value.get("id").and_then(Value::as_u64);
            if let Some(id) = id {
                let tx = handle_clone.pending.lock().await.remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(value);
                    continue;
                }
            }
            match kind {
                "login-result" => {
                    let tx = handle_clone.login_tx.lock().await.take();
                    if let Some(tx) = tx {
                        let _ = tx.send(value);
                    }
                }
                "tokens" => {
                    if let Some(tokens) = value.get("tokens") {
                        if let Ok(tokens) = serde_json::from_value::<TokenSet>(tokens.clone()) {
                            let _ = handle_clone.token_store.save(&tokens);
                        }
                    }
                }
                "error" => {
                    eprintln!("[bridge] {}", parse_bridge_error(&value));
                }
                _ => {}
            }
        }
    })
}

/// 确定桥接启动命令。
/// - dev（debug）：优先 `node <repo>/dist-bridge/bridge.mjs`，即时反映 JS 改动；
///   缺失时回退 resource sidecar。
/// - release：使用 resource_dir/bridge sidecar（最终用户无需 Node）。
fn bridge_command(app: &AppHandle) -> Result<(String, Vec<String>), String> {
    let resource_bridge = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("bridge"))
        .ok()
        .filter(|path| path.exists());
    #[cfg(debug_assertions)]
    {
        let bridge_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist-bridge")
            .join("bridge.mjs");
        if bridge_js.exists() {
            return Ok(("node".to_string(), vec![bridge_js.to_string_lossy().to_string(), "stdio".to_string()]));
        }
    }
    if let Some(path) = resource_bridge {
        return Ok((path.to_string_lossy().to_string(), vec!["stdio".to_string()]));
    }
    Err("bridge bundle missing: run `npm run build:bridge` (dev) or build a release bundle".to_string())
}

/// 桥接进程实例配置（stdio start 请求体）。
/// 键名必须与 bridge TS `BridgeInstanceConfig` 的 camelCase 字段逐一对应，
/// 否则 bridge 读到 undefined，上游 URL/模型地址失效。
fn bridge_instance_config(port: u32, secret: &str, state_dir: &str) -> Value {
    json!({
        "port": port,
        "secret": secret,
        "stateDir": state_dir,
        "logPath": format!("{state_dir}/bridge.log"),
        "upstreamBase": "https://chatgpt.com/backend-api",
        "upstreamResponses": "https://chatgpt.com/backend-api/codex/responses",
        "tokenEndpoint": "https://auth.openai.com/oauth/token",
        "issuer": "https://auth.openai.com",
        "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
        "modelsEndpoint": "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    })
}

/// 完整启动：spawn 进程 → 发送 start → 等待 ready。
async fn start_bridge(
    app: &AppHandle,
    port: u32,
    secret: String,
    state_dir: String,
) -> Result<Arc<BridgeHandle>, String> {
    let (program, args) = bridge_command(app)?;
    let mut command = Command::new(&program);
    command
        .args(&args)
        // Node 默认不走 HTTP_PROXY/HTTPS_PROXY；启用内建代理支持（Node >= 24 / >= 22.21）。
        // 否则在被地区限制的网络里，auth.openai.com / chatgpt.com 会返回 403。
        .env("NODE_USE_ENV_PROXY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().map_err(|e| format!("spawn bridge: {e}"))?;
    let stdin = child.stdin.take().ok_or("bridge stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("bridge stdout unavailable")?;

    let handle = Arc::new(BridgeHandle {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        login_tx: Mutex::new(None),
        login_rx: Mutex::new(None),
        next_id: AtomicU64::new(1),
        port,
        secret,
        token_store: Arc::new(KeyringTokenStore),
    });
    let _reader = start_reader_loop(handle.clone(), stdout);

    let initial_auth = handle.token_store.load().unwrap_or(None);
    let config = bridge_instance_config(handle.port, &handle.secret, &state_dir);
    let start_payload = json!({
        "config": config,
        "auth": initial_auth,
    });
    let ready = match handle.request("start", start_payload).await {
        Ok(ready) => ready,
        Err(error) => {
            // 启动失败时必须回收子进程，避免遗留监听端口的孤儿。
            let mut child = handle.child.lock().await;
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    if ready.get("type").and_then(Value::as_str) != Some("ready") {
        let mut child = handle.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(parse_bridge_error(&ready));
    }
    Ok(handle)
}

// ─────────────────────────── 宿主状态 ───────────────────────────

pub struct BridgeState {
    pub host: tokio::sync::Mutex<Option<Arc<BridgeHandle>>>,
}

impl Default for BridgeState {
    fn default() -> Self {
        BridgeState {
            host: tokio::sync::Mutex::new(None),
        }
    }
}

fn default_state_dir() -> String {
    // 与面板数据同目录：~/.kimi-code-switch-gui/chatgpt-bridge
    format!("~/.kimi-code-switch-gui/chatgpt-bridge")
}

// ─────────────────────────── Tauri 命令 ───────────────────────────

#[tauri::command]
pub async fn bridge_start(
    app: AppHandle,
    state: State<'_, BridgeState>,
    port: u32,
    secret: String,
    state_dir: Option<String>,
) -> Result<Value, String> {
    let state_dir = state_dir.unwrap_or_else(default_state_dir);
    let mut host_guard = state.host.lock().await;
    if host_guard.is_some() {
        // 已运行：直接返回当前状态。
        let status = bridge_status_inner(host_guard.as_ref().unwrap()).await?;
        return Ok(json!(status));
    }
    let handle = start_bridge(&app, port, secret, state_dir).await?;
    *host_guard = Some(handle);
    let status = bridge_status_inner(host_guard.as_ref().unwrap()).await?;
    Ok(json!(status))
}

#[tauri::command]
pub async fn bridge_stop(state: State<'_, BridgeState>) -> Result<(), String> {
    let handle = {
        let mut guard = state.host.lock().await;
        guard.take()
    };
    if let Some(handle) = handle {
        let _ = handle.request("shutdown", json!({})).await;
        let mut child = handle.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn bridge_status(state: State<'_, BridgeState>) -> Result<Value, String> {
    let host_guard = state.host.lock().await;
    match host_guard.as_ref() {
        Some(handle) => bridge_status_inner(handle).await,
        None => Ok(json!({
            "running": false,
            "port": 0,
            "auth": { "status": "signed-out" },
            "catalog": null,
            "ok": false
        })),
    }
}

async fn bridge_status_inner(handle: &Arc<BridgeHandle>) -> Result<Value, String> {
    let response = handle.request("status", json!({})).await?;
    if response.get("type").and_then(Value::as_str) != Some("status") {
        return Err(parse_bridge_error(&response));
    }
    let status: BridgeStatus = serde_json::from_value(response.clone())
        .map_err(|e| format!("bad status payload: {e}"))?;
    Ok(json!({
        "running": true,
        "port": status.port,
        "auth": status.auth,
        "catalog": status.catalog,
        "ok": status.ok,
    }))
}

#[tauri::command]
pub async fn bridge_login(
    state: State<'_, BridgeState>,
    redirect_port: u16,
) -> Result<Value, String> {
    let host_guard = state.host.lock().await;
    let handle = host_guard.as_ref().ok_or("bridge is not running")?;
    handle.new_login_channel().await?;
    let response = handle.request("login", json!({ "redirectPort": redirect_port })).await?;
    if response.get("type").and_then(Value::as_str) != Some("login-url") {
        return Err(parse_bridge_error(&response));
    }
    let url_response: LoginUrlResponse =
        serde_json::from_value(response).map_err(|e| format!("bad login-url payload: {e}"))?;
    Ok(json!({ "url": url_response.url, "wait": true }))
}

#[tauri::command]
pub async fn bridge_wait_login(state: State<'_, BridgeState>) -> Result<Value, String> {
    let host_guard = state.host.lock().await;
    let handle = host_guard.as_ref().ok_or("bridge is not running")?;
    let rx = {
        let mut slot = handle.login_rx.lock().await;
        slot.take().ok_or("no login flow in progress")?
    };
    let result = timeout(Duration::from_secs(600), rx)
        .await
        .map_err(|_| "login timed out".to_string())?
        .map_err(|_| "bridge process exited".to_string())?;
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        let message = result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("login failed")
            .to_string();
        return Err(message);
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn bridge_logout(state: State<'_, BridgeState>) -> Result<(), String> {
    let host_guard = state.host.lock().await;
    if let Some(handle) = host_guard.as_ref() {
        let _ = handle.request("logout", json!({})).await;
    }
    let _ = KeyringTokenStore.clear();
    Ok(())
}

#[tauri::command]
pub async fn bridge_refresh_models(state: State<'_, BridgeState>) -> Result<Value, String> {
    let host_guard = state.host.lock().await;
    let handle = host_guard.as_ref().ok_or("bridge is not running")?;
    let response = handle.request("refresh-models", json!({})).await?;
    if response.get("type").and_then(Value::as_str) != Some("models") {
        return Err(parse_bridge_error(&response));
    }
    let catalog: Catalog = serde_json::from_value(
        response.get("catalog").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| format!("bad models payload: {e}"))?;
    Ok(json!(catalog))
}

// ─────────────────────────── 受限连通性探针 ───────────────────────────

/// 只允许 127.0.0.1 且调用方显式指定的端口；GET /v1/models 验证桥接可达与本地鉴权。
#[tauri::command]
pub async fn bridge_probe_connectivity(
    port: u16,
    secret: String,
) -> Result<Value, String> {
    if port == 0 {
        return Err("invalid port".to_string());
    }
    let url = format!("http://127.0.0.1:{port}/v1/models");
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client build: {e}"))?;
    let response = client
        .get(&url)
        .bearer_auth(&secret)
        .send()
        .await
        .map_err(|e| format!("bridge unreachable: {e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let authorized = status == 200;
    Ok(json!({
        "reachable": true,
        "authorized": authorized,
        "status": status,
        "models": if authorized { serde_json::from_str::<Value>(&body).ok() } else { None },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyring_names_are_fixed() {
        assert_eq!(KEYRING_SERVICE, "kimi-code-switch-gui");
        assert_eq!(KEYRING_USER, "chatgpt-oauth");
    }

    /// 配置键名必须与 bridge TS `BridgeInstanceConfig` 一致（camelCase），
    /// 否则 bridge 读到 undefined，上游请求会以 “Failed to parse URL” 失败。
    #[test]
    fn bridge_instance_config_uses_camel_case_contract_keys() {
        let config = bridge_instance_config(8317, "s", "/tmp/state");
        for key in [
            "port",
            "secret",
            "stateDir",
            "logPath",
            "upstreamBase",
            "upstreamResponses",
            "tokenEndpoint",
            "issuer",
            "clientId",
            "modelsEndpoint",
        ] {
            assert!(config.get(key).is_some(), "missing config key: {key}");
        }
        assert_eq!(config["upstreamResponses"], "https://chatgpt.com/backend-api/codex/responses");
        assert_eq!(config["clientId"], "app_EMoamEEZ73f0CkXaXp7hrann");
    }

    #[tokio::test]
    async fn probe_rejects_port_zero() {
        let result = bridge_probe_connectivity(0, "x".to_string()).await;
        assert!(result.is_err());
    }

    #[test]
    fn memory_token_store_roundtrips() {
        let store = MemoryTokenStore(Mutex::new(None));
        let tokens = TokenSet {
            access_token: "at".to_string(),
            refresh_token: Some("rt".to_string()),
            id_token: None,
            expires_in: Some(3600),
            account_id: Some("acct".to_string()),
            issued_at: None,
        };
        store.save(&tokens).unwrap();
        assert_eq!(store.load().unwrap().unwrap().access_token, "at");
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }
}
