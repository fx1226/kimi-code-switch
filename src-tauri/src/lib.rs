#![recursion_limit = "256"]

//! Kimi Code Switch GUI — Tauri 后端入口（薄 Rust 壳）。
//!
//! 架构：业务逻辑（configStore / configSafety / skillsStore 等约 5300 行 TS）
//! 继续跑在前端 renderer，后端只暴露 I/O 和系统集成的原子能力。

mod config_history;
mod fs_access;
mod legacy_native_config;
mod official_accounts;
mod panel_settings_store;
mod shortcuts;
mod system;
mod tray;
mod usage;
mod bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(shortcuts::ShortcutRuntimeState::default())
        .manage(usage::UsageState::default())
        .manage(tray::TrayState::default())
        .manage(fs_access::PathGrantState::default())
        .manage(bridge::BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            // 文件 I/O
            fs_access::read_text,
            fs_access::get_kimi_code_home,
            fs_access::get_or_create_backup_encryption_secret,
            fs_access::get_backup_encryption_secret_candidates,
            fs_access::import_backup_encryption_secret,
            fs_access::write_text,
            fs_access::write_text_cas,
            fs_access::ensure_dir,
            fs_access::ensure_private_dir,
            fs_access::remove_file,
            fs_access::remove_file_cas,
            fs_access::move_file,
            fs_access::copy_dir,
            fs_access::merge_directory_missing,
            fs_access::repair_native_home_symlink,
            fs_access::path_exists,
            fs_access::resolve_home_path,
            fs_access::real_path,
            fs_access::list_dir,
            fs_access::list_dir_typed,
            fs_access::export_portable_directory,
            fs_access::replace_portable_directory,
            fs_access::remove_dir,
            fs_access::save_file_with_dialog,
            fs_access::pick_backup_directory,
            fs_access::write_project_local_config,
            fs_access::reconcile_durable_grants,
            fs_access::quarantine_journal,
            fs_access::hostname,
            fs_access::list_subdirs,
            // 系统集成
            system::exec_command,
            system::read_environment_variable,
            system::get_google_adc_access_token,
            system::run_kimi_provider_command,
            system::start_kimi_oauth_login,
            system::write_executable,
            system::file_stat,
            system::resolve_workspace_directory,
            system::read_file_slice,
            system::http_request,
            system::run_mcp_stdio_session,
            // 用量洞察 SQLite
            usage::usage_open,
            usage::usage_query,
            usage::usage_exec,
            usage::usage_exec_batch,
            usage::usage_exec_script,
            usage::usage_close,
            usage::migrate_legacy_database,
            legacy_native_config::export_legacy_native_config,
            legacy_native_config::clear_recovered_legacy_native_config,
            // 配置历史
            config_history::init_config_history,
            config_history::capture_snapshot,
            config_history::list_snapshots,
            config_history::assign_legacy_snapshot_environment,
            config_history::get_snapshot_content,
            config_history::restore_snapshot,
            config_history::cleanup_old_snapshots,
            // 面板设置存储
            panel_settings_store::init_panel_settings_store,
            panel_settings_store::get_panel_settings,
            panel_settings_store::save_panel_settings,
            panel_settings_store::export_panel_settings,
            panel_settings_store::import_panel_settings,
            panel_settings_store::migrate_panel_settings_from_toml,
            // Kimi 官方账号槽位
            official_accounts::init_official_accounts_store,
            official_accounts::list_official_accounts,
            official_accounts::get_official_account_credentials_status,
            official_accounts::create_official_account,
            official_accounts::rename_official_account,
            official_accounts::capture_current_official_account,
            official_accounts::prepare_official_account_login,
            official_accounts::complete_official_account_login,
            official_accounts::activate_official_account,
            official_accounts::delete_official_account,
            // ChatGPT 订阅桥接宿主
            bridge::bridge_start,
            bridge::bridge_stop,
            bridge::bridge_status,
            bridge::bridge_login,
            bridge::bridge_wait_login,
            bridge::bridge_logout,
            bridge::bridge_refresh_models,
            bridge::bridge_probe_connectivity,
            // 托盘
            tray::set_tray,
            tray::show_main_window,
            tray::set_dock_icon_visibility,
            // 全局快捷键
            shortcuts::sync_window_toggle_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
