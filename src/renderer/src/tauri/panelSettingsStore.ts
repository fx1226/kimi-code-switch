/**
 * 面板设置 SQLite 存储适配器。
 *
 * 替代原有的 config.panel.toml 文件存储，使用 SQLite JSON 列。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  LEGACY_GUI_PANEL_SETTINGS_PATH,
  LEGACY_KIMI_CODE_PANEL_SETTINGS_PATH,
  LEGACY_PANEL_SETTINGS_PATH,
} from "@shared/configStore";
import type { PanelSettings } from "@shared/types";

const LEGACY_PANEL_SETTINGS_PATHS = [
  LEGACY_GUI_PANEL_SETTINGS_PATH,
  LEGACY_KIMI_CODE_PANEL_SETTINGS_PATH,
  LEGACY_PANEL_SETTINGS_PATH,
] as const;

async function migrateLegacyPanelSettingsBeforeFirstWrite(): Promise<void> {
  const { pathExists } = await import("./fileAccess");
  for (const tomlPath of LEGACY_PANEL_SETTINGS_PATHS) {
    if (await pathExists(tomlPath)) {
      await invoke("migrate_panel_settings_from_toml", { tomlPath });
    }
  }
}

/**
 * 初始化面板设置表。
 */
export async function initPanelSettingsStore(): Promise<void> {
  try {
    await invoke("init_panel_settings_store");
    // Must run before loadState can create an initial row. Otherwise an old
    // panel TOML is merely renamed after defaults overwrite its contents.
    await migrateLegacyPanelSettingsBeforeFirstWrite();
  } catch (err) {
    console.error("Failed to init panel_settings_store:", err);
    throw err;
  }
}

/**
 * 获取面板设置。
 *
 * @returns PanelSettings 对象，若数据库为空则返回 null
 */
export async function getPanelSettings(): Promise<PanelSettings | null> {
  try {
    const json = await invoke<string | null>("get_panel_settings");
    if (!json) return null;
    return JSON.parse(json) as PanelSettings;
  } catch (err) {
    console.error("Failed to get panel settings:", err);
    return null;
  }
}

/**
 * 保存面板设置。
 *
 * @param settings PanelSettings 对象
 * @returns 成功返回 true，失败时抛出底层 Tauri/SQLite 错误
 */
export async function savePanelSettings(settings: PanelSettings): Promise<boolean> {
  const json = JSON.stringify(settings);
  await invoke("save_panel_settings", { settingsJson: json });
  return true;
}

/**
 * 导出面板设置为 JSON 字符串（用于备份）。
 */
export async function exportPanelSettings(): Promise<string | null> {
  try {
    return await invoke<string>("export_panel_settings");
  } catch (err) {
    console.error("Failed to export panel settings:", err);
    return null;
  }
}

/**
 * 导入面板设置（覆盖现有设置）。
 *
 * @param json PanelSettings JSON 字符串
 * @returns 成功返回 true，失败返回 false
 */
export async function importPanelSettings(json: string): Promise<boolean> {
  try {
    await invoke("import_panel_settings", { settingsJson: json });
    return true;
  } catch (err) {
    console.error("Failed to import panel settings:", err);
    return false;
  }
}

/**
 * 从 TOML 文件迁移到数据库。
 *
 * @param tomlPath TOML 文件路径（如旧版 ~/.kimi/config.panel.toml）
 * @param settings 已解析的 PanelSettings 对象
 * @returns 成功返回 true，失败返回 false
 */
export async function migratePanelSettingsFromToml(
  tomlPath: string,
  settings: PanelSettings
): Promise<boolean> {
  try {
    const json = JSON.stringify(settings);
    await invoke("migrate_panel_settings_from_toml", {
      tomlPath,
      settingsJson: json,
    });
    return true;
  } catch (err) {
    console.error("Failed to migrate panel settings from TOML:", err);
    return false;
  }
}
