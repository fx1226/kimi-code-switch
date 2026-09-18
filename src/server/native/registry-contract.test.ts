// 完整性契约：native 注册表必须覆盖 src-tauri/src/lib.rs 注册的全部命令，
// 否则 renderer 业务编排（kimiSwitch 链）在服务端会撞上 unsupported command。
// 本测试在三个移植组全部落地后才通过；它是 Wave 2 收口的闸门。
import { describe, expect, it } from "vitest";

import { commandRegistry } from "./index";

const EXPECTED_COMMANDS: readonly string[] = [
  // 文件 I/O（fs.ts ← fs_access.rs）
  "read_text",
  "get_kimi_code_home",
  "get_or_create_backup_encryption_secret",
  "get_backup_encryption_secret_candidates",
  "import_backup_encryption_secret",
  "write_text",
  "write_text_cas",
  "ensure_dir",
  "ensure_private_dir",
  "remove_file",
  "remove_file_cas",
  "move_file",
  "copy_dir",
  "merge_directory_missing",
  "repair_native_home_symlink",
  "path_exists",
  "resolve_home_path",
  "real_path",
  "list_dir",
  "list_dir_typed",
  "export_portable_directory",
  "replace_portable_directory",
  "remove_dir",
  "save_file_with_dialog",
  "pick_backup_directory",
  "write_project_local_config",
  "reconcile_durable_grants",
  "quarantine_journal",
  "hostname",
  "list_subdirs",
  // 系统集成（system.ts ← system.rs）
  "exec_command",
  "read_environment_variable",
  "get_google_adc_access_token",
  "run_kimi_provider_command",
  "start_kimi_oauth_login",
  "write_executable",
  "file_stat",
  "resolve_workspace_directory",
  "read_file_slice",
  "http_request",
  "run_mcp_stdio_session",
  // 用量洞察 SQLite（usage.ts ← usage.rs + legacy_native_config.rs）
  "usage_open",
  "usage_query",
  "usage_exec",
  "usage_exec_batch",
  "usage_exec_script",
  "usage_close",
  "migrate_legacy_database",
  "export_legacy_native_config",
  "clear_recovered_legacy_native_config",
  // 配置历史（stores.ts ← config_history.rs）
  "init_config_history",
  "capture_snapshot",
  "list_snapshots",
  "assign_legacy_snapshot_environment",
  "get_snapshot_content",
  "restore_snapshot",
  "cleanup_old_snapshots",
  // 面板设置存储（stores.ts ← panel_settings_store.rs）
  "init_panel_settings_store",
  "get_panel_settings",
  "save_panel_settings",
  "export_panel_settings",
  "import_panel_settings",
  "migrate_panel_settings_from_toml",
  // Kimi 官方账号槽位（stores.ts ← official_accounts.rs）
  "init_official_accounts_store",
  "list_official_accounts",
  "get_official_account_credentials_status",
  "create_official_account",
  "rename_official_account",
  "capture_current_official_account",
  "prepare_official_account_login",
  "complete_official_account_login",
  "activate_official_account",
  "delete_official_account",
  // ChatGPT 订阅桥接宿主（stores.ts ← bridge.rs）
  "bridge_start",
  "bridge_stop",
  "bridge_status",
  "bridge_login",
  "bridge_wait_login",
  "bridge_logout",
  "bridge_refresh_models",
  "bridge_probe_connectivity",
  // 托盘（stores.ts ← tray.rs，桌面专属，服务端为占位实现）
  "set_tray",
  "show_main_window",
  "set_dock_icon_visibility",
  // 全局快捷键（stores.ts ← shortcuts.rs，桌面专属，服务端为占位实现）
  "sync_window_toggle_shortcut",
];

describe("server native command registry completeness", () => {
  it("registers every command from src-tauri/src/lib.rs", () => {
    const missing = EXPECTED_COMMANDS.filter((name) => !(name in commandRegistry));
    expect(missing).toEqual([]);
  });
});
