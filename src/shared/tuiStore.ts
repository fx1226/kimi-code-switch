// tui.toml 支持：Kimi Code 0.38.0 起，TUI 主题与编辑器命令从 config.toml 迁移到
// <activeEnvHome>/tui.toml。此模块负责「从激活 Profile 渲染 tui.toml 文档」与
// 「解析/合并现有 tui.toml」。GUI 只管理 theme 与 [editor].command 两个字段，
// 其余字段（[notifications]/[upgrade]/disable_paste_burst 等）在合并时原样保留，
// 防止「保存全部」时抹掉用户或 CLI 写入的内容。
//
// 0.38.0 tui.toml schema：
//   theme = "auto|dark|light|自定义主题名"     （顶层直接键）
//   disable_paste_burst = true|false
//   [editor] command = "..."                  （空串 = 使用 $VISUAL/$EDITOR）
//   [notifications] enabled / notification_condition("unfocused"|"always")
//   [upgrade] auto_install = true|false
// 文件缺省即默认；kimi doctor 不报 tui.toml 未知键。
import parse from "@iarna/toml/parse-string.js";
import stringify from "@iarna/toml/stringify.js";

import type { Profile } from "./types";

/** tui.toml 中 GUI 管理的字段快照。未设字段为 undefined，序列化时不写入。 */
export interface TuiConfig {
  /** 顶层 theme（auto|dark|light 或自定义主题名）。 */
  theme?: string;
  /** 顶层 disable_paste_burst。 */
  disable_paste_burst?: boolean;
  /** [editor].command（空串 = 使用 $VISUAL/$EDITOR）。 */
  editorCommand?: string;
  /** [notifications].enabled。 */
  notificationsEnabled?: boolean;
  /** [notifications].notification_condition："unfocused" | "always"。 */
  notificationCondition?: "unfocused" | "always";
  /** [upgrade].auto_install。 */
  upgradeAutoInstall?: boolean;
}

/** tui.toml 文件名（位于 <activeEnvHome> 下，默认环境为 ~/.kimi-code）。 */
export const TUI_CONFIG_FILENAME = "tui.toml";

/** 解析时仅接受这两个取值，其它视为未设置。 */
export const TUI_NOTIFICATION_CONDITIONS = ["unfocused", "always"] as const;
export type TuiNotificationCondition = (typeof TUI_NOTIFICATION_CONDITIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 TuiConfig 渲染为 tui.toml 文档，只输出有值字段、未设不写。
 * @iarna stringify 会把子表自动生成 [editor]/[notifications]/[upgrade]，输出本身
 * 已是顶格（外层无缩进），空对象返回空串。
 */
export function buildTuiConfigDocument(tui: TuiConfig): string {
  const raw: Record<string, unknown> = {};
  if (tui.theme !== undefined && tui.theme !== "") {
    raw.theme = tui.theme;
  }
  if (tui.disable_paste_burst !== undefined) {
    raw.disable_paste_burst = tui.disable_paste_burst;
  }
  if (tui.editorCommand !== undefined && tui.editorCommand !== "") {
    raw.editor = { command: tui.editorCommand };
  }
  if (tui.notificationsEnabled !== undefined || tui.notificationCondition !== undefined) {
    const notifications: Record<string, unknown> = {};
    if (tui.notificationsEnabled !== undefined) {
      notifications.enabled = tui.notificationsEnabled;
    }
    if (tui.notificationCondition !== undefined) {
      notifications.notification_condition = tui.notificationCondition;
    }
    raw.notifications = notifications;
  }
  if (tui.upgradeAutoInstall !== undefined) {
    raw.upgrade = { auto_install: tui.upgradeAutoInstall };
  }
  return stringify(raw);
}

/**
 * 解析 tui.toml 文档为 TuiConfig。容错：解析失败返回空对象、不抛；缺失字段为 undefined。
 * 未知键被忽略（不会被纳入返回结构；合并时它们仍会被原样保留）。
 */
export function parseTuiConfigDocument(document: string | null): TuiConfig {
  const raw = parseTuiDocumentRaw(document);
  return raw ? parseTuiConfigRaw(raw) : {};
}

/** 容错解析原始 TOML 文档为顶层记录；解析失败返回 null。空文档返回空记录。 */
function parseTuiDocumentRaw(document: string | null): Record<string, unknown> | null {
  if (!document || typeof document !== "string" || !document.trim()) {
    return {};
  }
  try {
    const raw = parse(document);
    return isRecord(raw) ? raw : {};
  } catch {
    return null;
  }
}

function parseTuiConfigRaw(raw: Record<string, unknown>): TuiConfig {
  const result: TuiConfig = {};
  if (typeof raw.theme === "string" && raw.theme.trim() !== "") {
    result.theme = raw.theme;
  }
  if (typeof raw.disable_paste_burst === "boolean") {
    result.disable_paste_burst = raw.disable_paste_burst;
  }
  const editor = isRecord(raw.editor) ? raw.editor : {};
  if (typeof editor.command === "string" && editor.command !== "") {
    result.editorCommand = editor.command;
  }
  const notifications = isRecord(raw.notifications) ? raw.notifications : {};
  if (typeof notifications.enabled === "boolean") {
    result.notificationsEnabled = notifications.enabled;
  }
  if (
    typeof notifications.notification_condition === "string" &&
    (TUI_NOTIFICATION_CONDITIONS as readonly string[]).includes(notifications.notification_condition)
  ) {
    result.notificationCondition = notifications.notification_condition as TuiNotificationCondition;
  }
  const upgrade = isRecord(raw.upgrade) ? raw.upgrade : {};
  if (typeof upgrade.auto_install === "boolean") {
    result.upgradeAutoInstall = upgrade.auto_install;
  }
  return result;
}

/**
 * 把激活 profile 的 tui 目标（tui_theme -> theme、tui_editor_command -> editorCommand）
 * 渲染为 TuiConfig。两条均未设时返回空对象（此时不应写 tui.toml）。
 */
export function TuiConfigFromProfile(profile: Profile | undefined): TuiConfig {
  if (!profile) {
    return {};
  }
  const result: TuiConfig = {};
  if (typeof profile.tui_theme === "string" && profile.tui_theme.trim() !== "") {
    result.theme = profile.tui_theme;
  }
  if (typeof profile.tui_editor_command === "string" && profile.tui_editor_command.trim() !== "") {
    result.editorCommand = profile.tui_editor_command;
  }
  return result;
}

/** TuiConfig 是否有任何 GUI 管理的字段。 */
export function hasTuiConfigValues(tui: TuiConfig): boolean {
  return tui.theme !== undefined || tui.editorCommand !== undefined;
}

/**
 * 把 GUI 的 TuiConfig 合并进现有 tui.toml 文档：只覆盖 GUI 管理的字段
 * （theme、[editor].command），其余任意顶层键/子表原样保留。
 * tui 中未设置的 GUI 字段会从现有文档删除，供清空字段或切换到未配置 profile 时
 * 清理旧值；GUI 不管理的字段与子表继续保留。
 * 现有文档无法解析时原样返回，禁止用不完整的新文档覆盖并造成数据丢失。
 */
export function mergeTuiConfigDocument(existing: string | null, tui: TuiConfig): string {
  const raw = parseTuiDocumentRaw(existing);
  if (raw === null) {
    return existing ?? "";
  }
  const next: Record<string, unknown> = { ...raw };

  if (tui.theme !== undefined && tui.theme !== "") {
    next.theme = tui.theme;
  } else {
    delete next.theme;
  }

  const existingEditor = isRecord(raw.editor) ? raw.editor : {};
  if (tui.editorCommand !== undefined && tui.editorCommand !== "") {
    next.editor = { ...existingEditor, command: tui.editorCommand };
  } else if (Object.prototype.hasOwnProperty.call(existingEditor, "command")) {
    const { command: _removedCommand, ...remainingEditor } = existingEditor;
    if (Object.keys(remainingEditor).length > 0) {
      next.editor = remainingEditor;
    } else {
      delete next.editor;
    }
  }

  const merged = stringify(next);
  if (merged === stringify(raw)) {
    return existing ?? merged;
  }
  return merged;
}
