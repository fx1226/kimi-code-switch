import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { usageCommands } from "./usage";
import { parseToml, setNativeTestDirs, storesCommands } from "./stores";

let tmpDir: string;
let dbPath: string;
let historyDir: string;
let accountsRoot: string;
let credentialsDir: string;
let envHome: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kimi-stores-test-"));
  dbPath = join(tmpDir, "app.db");
  historyDir = join(tmpDir, "history");
  accountsRoot = join(tmpDir, "official-accounts");
  credentialsDir = join(tmpDir, "credentials");
  envHome = join(tmpDir, "env-home");
  mkdirSync(historyDir, { recursive: true });
  mkdirSync(credentialsDir, { recursive: true });
  mkdirSync(envHome, { recursive: true });

  setNativeTestDirs({ historyDir, accountsRoot, credentialsDir });
  usageCommands.usage_open({ dbPath, schemaSql: "SELECT 1" });
  storesCommands.init_panel_settings_store({});
  storesCommands.init_config_history({});
  storesCommands.init_official_accounts_store({});
});

afterEach(() => {
  try {
    usageCommands.usage_close({});
  } catch {
    // ignore
  }
  setNativeTestDirs({ historyDir: null, accountsRoot: null, credentialsDir: null });
  rmSync(tmpDir, { recursive: true, force: true });
});

function registerEnvironment(homePath: string): void {
  storesCommands.save_panel_settings({
    settingsJson: JSON.stringify({
      version: 1,
      config_path: "~/.kimi-code/config.toml",
      active_profile: "default",
      theme: "dark",
      shortcuts: {},
      kimi_code_environments: [{ id: "default", homePath }],
    }),
  });
}

describe("config_history full chain", () => {
  it("captures, lists, reads, restores and cleans up snapshots", () => {
    registerEnvironment(envHome);

    const targetPath = join(envHome, "config.toml");
    writeFileSync(targetPath, "version-A");
    const id = storesCommands.capture_snapshot({
      fileId: "config",
      filePath: targetPath,
      description: "first",
      kimiCodeEnvironmentId: "default",
    }) as number;
    expect(id).toBeGreaterThan(0);

    // dedupe: same content returns null
    const dedupe = storesCommands.capture_snapshot({
      fileId: "config",
      filePath: targetPath,
      description: "dup",
      kimiCodeEnvironmentId: "default",
    });
    expect(dedupe).toBeNull();

    // list
    const snapshots = storesCommands.list_snapshots({
      kimiCodeEnvironmentId: "default",
      fileId: "config",
      limit: 10,
    }) as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(id);
    expect(snapshots[0].sha256).toBeTruthy();
    expect(snapshots[0].description).toBe("first");

    // get content
    expect(storesCommands.get_snapshot_content({ snapshotId: id })).toBe("version-A");

    // modify then restore -> writes snapshot back + creates rollback point
    writeFileSync(targetPath, "version-B");
    storesCommands.restore_snapshot({ snapshotId: id });
    expect(readFileSync(targetPath, "utf8")).toBe("version-A");

    const afterRestore = storesCommands.list_snapshots({
      kimiCodeEnvironmentId: "default",
      fileId: "config",
      limit: 10,
    }) as Array<Record<string, unknown>>;
    expect(afterRestore.length).toBeGreaterThanOrEqual(2);

    // cleanup removes only 30-day-old records
    usageCommands.usage_exec({
      sql: "UPDATE config_history SET snapshot_at = @t WHERE id = @id",
      params: { t: new Date(Date.now() - 40 * 86400000).toISOString(), id },
    });
    const deleted = storesCommands.cleanup_old_snapshots({}) as number;
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = storesCommands.list_snapshots({
      kimiCodeEnvironmentId: "default",
      fileId: "config",
      limit: 10,
    }) as Array<Record<string, unknown>>;
    expect(remaining.every((r) => r.id !== id)).toBe(true);
  });

  it("captures a panel settings snapshot from the sqlite json", () => {
    registerEnvironment(envHome);
    storesCommands.save_panel_settings({
      settingsJson: JSON.stringify({ version: 1, config_path: "~/.kimi-code/config.toml", theme: "dark", shortcuts: {} }),
    });
    const id = storesCommands.capture_snapshot({
      fileId: "panel",
      filePath: "",
      description: "panel",
      kimiCodeEnvironmentId: "default",
    }) as number;
    expect(id).toBeGreaterThan(0);
    const content = storesCommands.get_snapshot_content({ snapshotId: id }) as string;
    expect(JSON.parse(content).theme).toBe("dark");
  });
});

describe("panel_settings roundtrip and toml migration", () => {
  it("saves, gets, exports and imports", () => {
    storesCommands.save_panel_settings({
      settingsJson: JSON.stringify({
        version: 1,
        config_path: "~/.kimi-code/config.toml",
        active_profile: "work",
        theme: "dark",
        locale: "zh-CN",
        tray_icon: true,
        sidebar_collapsed: true,
        last_display_id: 7,
        shortcuts: { toggle: { accelerator: "Cmd+Shift+H" } },
        insights_proxy_port: "auto",
        insights_status: "enabled",
        model_ui_metadata: {
          default: {
            "kimi-k2": { auth_mode: "official-account", official_account_scope: "global" },
          },
        },
        official_account_vault_enabled: true,
        chatgpt_bridge_bindings: {},
      }),
    });

    const json = storesCommands.get_panel_settings({}) as string;
    const settings = JSON.parse(json);
    expect(settings.active_profile).toBe("work");
    expect(settings.theme).toBe("dark");
    expect(settings.tray_icon).toBe(true);
    expect(settings.sidebar_collapsed).toBe(true);
    expect(settings.last_display_id).toBe(7);
    expect(settings.shortcuts.toggle.accelerator).toBe("Cmd+Shift+H");
    expect(settings.insights_proxy_port).toBe("auto");
    expect(settings.insights_status).toBe("enabled");
    expect(settings.model_ui_metadata.default["kimi-k2"].auth_mode).toBe("official-account");
    expect(settings.official_account_vault_enabled).toBe(true);

    // export == get; import overwrites
    const exported = storesCommands.export_panel_settings({}) as string;
    expect(exported).toBe(json);

    storesCommands.import_panel_settings({
      settingsJson: JSON.stringify({
        version: 1,
        config_path: "~/.kimi-code/config.toml",
        theme: "light",
        shortcuts: {},
      }),
    });
    expect(JSON.parse(storesCommands.get_panel_settings({}) as string).theme).toBe("light");
  });

  it("rejects invalid model_ui_metadata secrets", () => {
    expect(() =>
      storesCommands.save_panel_settings({
        settingsJson: JSON.stringify({
          version: 1,
          config_path: "~/.kimi-code/config.toml",
          shortcuts: {},
          model_ui_metadata: { default: { m: { api_key: "secret" } } },
        }),
      }),
    ).toThrow(/not supported/);
  });

  it("parses legacy panel TOML into json shape for migration", () => {
    const parsed = parseToml(`
theme = "dark"
locale = "zh-CN"
tray_icon = true
backup_retention_count = 7
shortcuts = { toggle = { accelerator = "Cmd+Shift+H" } }
[[kimi_code_environments]]
id = "work"
homePath = "~/.kimi-code"
`);
    expect(parsed.theme).toBe("dark");
    expect(parsed.locale).toBe("zh-CN");
    expect(parsed.tray_icon).toBe(true);
    expect(parsed.backup_retention_count).toBe(7);
    expect((parsed.shortcuts as any).toggle.accelerator).toBe("Cmd+Shift+H");
    expect((parsed.kimi_code_environments as any[])[0].homePath).toBe("~/.kimi-code");
  });
});

describe("official_accounts lifecycle", () => {
  it("creates, renames, captures, activates, and deletes accounts", () => {
    // 标准凭据目录放入 kimi-code.json，供 capture/activate 复制
    writeFileSync(join(credentialsDir, "kimi-code.json"), "{}");

    const created = storesCommands.create_official_account({ displayName: "  第一账号  " }) as Record<string, any>;
    expect(created.display_name).toBe("第一账号");
    expect(created.status).toBe("empty");
    expect(created.is_active).toBe(false);

    const renamed = storesCommands.rename_official_account({
      id: created.id,
      displayName: "renamed",
    }) as Record<string, any>;
    expect(renamed.display_name).toBe("renamed");

    // 捕获当前账号 -> active + logged-in，凭据复制进槽位
    const captured = storesCommands.capture_current_official_account({
      displayName: "Current",
    }) as Record<string, any>;
    expect(captured.credentials_present).toBe(true);
    expect(captured.account.status).toBe("logged-in");
    expect(captured.account.is_active).toBe(true);
    expect(captured.active_account_id).toBe(captured.account.id);

    // 状态聚合
    const status = storesCommands.get_official_account_credentials_status({}) as Record<string, any>;
    expect(status.active_account_id).toBe(captured.account.id);
    expect(status.credentials_present).toBe(true);

    // 列表
    const list = storesCommands.list_official_accounts({}) as Record<string, any>[];
    expect(list.find((a) => a.id === captured.account.id)?.is_active).toBe(true);

    // prepare login：清空当前凭据
    storesCommands.prepare_official_account_login({ id: captured.account.id });
    expect(existsSync(join(credentialsDir, "kimi-code.json"))).toBe(false);

    // complete login 重新物化
    writeFileSync(join(credentialsDir, "kimi-code.json"), "{}");
    const completed = storesCommands.complete_official_account_login({
      id: captured.account.id,
      activate: true,
    }) as Record<string, any>;
    expect(completed.credentials_present).toBe(true);

    // activate 已激活账号
    const activated = storesCommands.activate_official_account({
      id: captured.account.id,
    }) as Record<string, any>;
    expect(activated.account.is_active).toBe(true);

    // delete
    storesCommands.delete_official_account({ id: captured.account.id });
    const after = storesCommands.list_official_accounts({}) as Record<string, any>[];
    expect(after.find((a) => a.id === captured.account.id)).toBeUndefined();
  });

  it("rejects unsafe account ids", () => {
    expect(() => storesCommands.rename_official_account({ id: "../bad", displayName: "x" })).toThrow(
      /may only contain/,
    );
  });
});

describe("desktop placeholders", () => {
  it("returns no-side-effect success for tray/window/shortcut commands", () => {
    expect(storesCommands.set_tray({})).toBeUndefined();
    expect(storesCommands.show_main_window({})).toBeUndefined();
    expect(storesCommands.set_dock_icon_visibility({ visible: true })).toBeUndefined();
    expect(storesCommands.sync_window_toggle_shortcut({})).toBeUndefined();
  });

  it("throws explicit not-implemented for bridge commands", () => {
    for (const command of [
      "bridge_start",
      "bridge_stop",
      "bridge_status",
      "bridge_login",
      "bridge_wait_login",
      "bridge_logout",
      "bridge_refresh_models",
      "bridge_probe_connectivity",
    ]) {
      expect(() => (storesCommands[command] as (a: Record<string, unknown>) => unknown)({})).toThrow(
        "ChatGPT subscription bridge is not implemented in the server runtime",
      );
    }
  });
});
