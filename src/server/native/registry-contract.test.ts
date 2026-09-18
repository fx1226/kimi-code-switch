import { describe, expect, it } from "vitest";
import { commandRegistry, invokeCommand } from "./index";

describe("Web native capabilities", () => {
  it("retains file safety, local configuration history and private settings primitives", () => {
    for (const command of ["read_text", "write_text_cas", "reconcile_durable_grants", "replace_portable_directory", "usage_open", "init_config_history", "get_panel_settings", "save_panel_settings", "exec_command", "http_request"]) {
      expect(typeof commandRegistry[command], command).toBe("function");
    }
  });
  it("does not register retired desktop, subscription or credential-copy capabilities", () => {
    expect(Object.keys(commandRegistry).filter((name) => /^(bridge_|.*official_account|set_tray$|show_main_window$|set_dock_icon_visibility$|sync_window_toggle_shortcut$|save_file_with_dialog$|pick_backup_directory$)/.test(name))).toEqual([]);
  });
  it("does not register retired native writers or credential login protocols", () => {
    for (const command of ["capture_snapshot", "restore_snapshot", "cleanup_old_snapshots", "assign_legacy_snapshot_environment", "migrate_panel_settings_from_toml", "migrate_legacy_database", "get_google_adc_access_token", "run_kimi_provider_command", "start_kimi_oauth_login", "file_stat", "read_file_slice"]) {
      expect(Object.hasOwn(commandRegistry, command), command).toBe(false);
    }
  });
  it("rejects unknown commands without invoking inherited object methods", async () => {
    await expect(invokeCommand("not_a_capability")).rejects.toThrow(/unsupported command/);
    await expect(invokeCommand("toString")).rejects.toThrow(/unsupported command/);
  });
});
