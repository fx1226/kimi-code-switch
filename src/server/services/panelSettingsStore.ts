/**
 * 面板设置 SQLite 存储适配器。
 *
 * 替代原有的 config.panel.toml 文件存储，使用 SQLite JSON 列。
 */

import { invokeCommand as invoke } from "../native";
import type { PanelSettings } from "@shared/types";

/**
 * 初始化面板设置表。
 */
export async function initPanelSettingsStore(): Promise<void> {
  try {
    await invoke("init_panel_settings_store");
  } catch (err) {
    console.error("Failed to init panel_settings_store.");
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
    throw new Error("Failed to read panel settings.", { cause: err });
  }
}

/**
 * 保存面板设置。
 *
 * @param settings PanelSettings 对象
 * @returns 成功返回 true，失败时抛出底层 SQLite 错误
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
    throw new Error("Failed to export panel settings.", { cause: err });
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
    console.error("Failed to import panel settings.");
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
    console.error("Failed to migrate panel settings from TOML.");
    return false;
  }
}
