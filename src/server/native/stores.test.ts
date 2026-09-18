import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { usageCommands } from "./usage";
import { captureSnapshot, cleanupOldSnapshots, parseToml, restoreSnapshot, setNativeTestDirs, storesCommands } from "./stores";

// Retired history writers are tested directly and are deliberately absent from
// the production command registry. New writes/restores use the configuration kernel.
function captureLegacySnapshot(args: { fileId: string; filePath: string; description: string; kimiCodeEnvironmentId: string }): number | null {
  return captureSnapshot(args.fileId, args.filePath, args.description, args.kimiCodeEnvironmentId);
}

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

  setNativeTestDirs({ historyDir });
  usageCommands.usage_open({ dbPath, schemaSql: "SELECT 1" });
  storesCommands.init_panel_settings_store({});
  storesCommands.init_config_history({});
});

afterEach(() => {
  try {
    usageCommands.usage_close({});
  } catch {
    // ignore
  }
  setNativeTestDirs({ historyDir: null });
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
    const id = captureLegacySnapshot({
      fileId: "config",
      filePath: targetPath,
      description: "first",
      kimiCodeEnvironmentId: "default",
    }) as number;
    expect(id).toBeGreaterThan(0);

    // dedupe: same content returns null
    const dedupe = captureLegacySnapshot({
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
    restoreSnapshot(id);
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
    const deleted = cleanupOldSnapshots();
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
    const id = captureLegacySnapshot({
      fileId: "panel",
      filePath: "",
      description: "panel",
      kimiCodeEnvironmentId: "default",
    }) as number;
    expect(id).toBeGreaterThan(0);
    const content = storesCommands.get_snapshot_content({ snapshotId: id }) as string;
    expect(JSON.parse(content).theme).toBe("dark");
  });

  it("restores a config snapshot with private permissions and no temp leftovers", () => {
    registerEnvironment(envHome);
    const targetPath = join(envHome, "config.toml");
    writeFileSync(targetPath, "version-A");
    const id = captureLegacySnapshot({
      fileId: "config",
      filePath: targetPath,
      description: "secrets",
      kimiCodeEnvironmentId: "default",
    }) as number;
    expect(id).toBeGreaterThan(0);

    // 删除目标再恢复：原子写以全新文件落盘，必须带私有权限（provider secrets）；
    // 临时文件落在目标同目录而非 tmpdir，避免跨设备 rename（EXDEV），且回收干净。
    rmSync(targetPath, { force: true });
    restoreSnapshot(id);
    expect(readFileSync(targetPath, "utf8")).toBe("version-A");
    if (process.platform !== "win32") {
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);
    }
    const leftovers = readdirSync(envHome).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
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

describe("retired native capabilities", () => {
  it("has no account credential rotation, desktop or bridge mutation commands", () => {
    for (const command of ["activate_official_account", "capture_current_official_account", "prepare_official_account_login", "delete_official_account", "bridge_start", "set_tray", "show_main_window", "sync_window_toggle_shortcut"]) {
      expect(storesCommands[command]).toBeUndefined();
    }
  });
});
