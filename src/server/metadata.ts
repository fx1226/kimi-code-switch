import { randomUUID } from "node:crypto";
import { existsSync, statSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PanelSettings, Profile } from "@shared/types";
import type { Preferences, Target } from "@shared/webApi";
import { createDefaultPanelSettings } from "@shared/configStore";
import { getAppPaths, expandHome } from "./native/paths";
import { grantSelectedTargetDirectory, registerDurableGrant, resolveFinalTarget, saveDurableGrantTo } from "./native/fs";
import { invokeCommand } from "./native";
import { isDbOpen } from "./native/usage";
import { getPanelSettings, initPanelSettingsStore, savePanelSettings } from "./services/panelSettingsStore";
import { findLegacyProcessBlocker, hasPendingLegacyMigration, previewLegacyMigration } from "./migration/legacy";

let writes: Promise<unknown> = Promise.resolve();
async function openStore(): Promise<void> {
  if (!isDbOpen()) await invokeCommand("usage_open", { dbPath: getAppPaths().databasePath, schemaSql: "" });
  await initPanelSettingsStore();
}
function defaultSettings(): PanelSettings {
  const settings = createDefaultPanelSettings();
  settings.kimi_code_environments = [{ id: "default", name: "默认目录", homePath: getAppPaths().kimiHome, kind: "default" }];
  settings.active_kimi_code_environment_id = "default";
  settings.config_path = join(getAppPaths().kimiHome, "config.toml");
  return settings;
}
const THEMES = ["auto", "dark", "light"] as const;
const LOCALES = ["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"] as const;
function preferences(settings: PanelSettings): Preferences {
  return { theme: settings.theme, locale: settings.locale, activeTargetId: settings.active_kimi_code_environment_id! };
}
/** Normalize the effective view only; readMetadata never persists defaults. */
function normalizeSettings(stored: PanelSettings | null): PanelSettings {
  const defaults = defaultSettings();
  const settings = { ...defaults, ...stored };
  settings.theme = THEMES.includes(settings.theme) ? settings.theme : defaults.theme;
  settings.locale = LOCALES.includes(settings.locale) ? settings.locale : defaults.locale;
  const entries = settings.kimi_code_environments?.length ? settings.kimi_code_environments : defaults.kimi_code_environments!;
  settings.kimi_code_environments = entries.map((target) => {
    const isDefault = target.id === "default" || target.kind === "default";
    // A persisted explicit home is a reference, including legacy .env/default.
    // Only an absent home or the official default location follows the process
    // environment; changing KIMI_CODE_HOME must not redirect migrated targets.
    const followsEnvironment = isDefault && (!target.homePath?.trim()
      || resolve(expandHome(target.homePath)) === resolve(expandHome("~/.kimi-code")));
    return {
      ...target,
      homePath: followsEnvironment ? getAppPaths().kimiHome : expandHome(target.homePath),
      ...(target.workingDirectory ? { workingDirectory: expandHome(target.workingDirectory) } : {}),
    };
  });
  const active = settings.kimi_code_environments.find((target) => target.id === settings.active_kimi_code_environment_id)
    ?? settings.kimi_code_environments[0];
  settings.active_kimi_code_environment_id = active.id;
  settings.config_path = join(active.homePath, "config.toml");
  return settings;
}
export async function readMetadata(): Promise<{ settings: PanelSettings; targets: Target[]; preferences: Preferences }> {
  let stored: PanelSettings | null = null;
  // Until migration finishes, app.db is a hash-verified copy that must stay
  // byte-for-byte intact. Bootstrap can use a default view without opening it.
  if (!hasPendingLegacyMigration() && existsSync(getAppPaths().databasePath)) { await openStore(); stored = await getPanelSettings(); }
  const settings = normalizeSettings(stored);
  const targets: Target[] = (settings.kimi_code_environments?.length ? settings.kimi_code_environments : defaultSettings().kimi_code_environments!).map((target) => ({
    id: target.id, name: target.name, homePath: expandHome(target.homePath), kind: target.kind ?? "external",
    ...(target.workingDirectory ? { workingDirectory: expandHome(target.workingDirectory) } : {}),
  }));
  return { settings, targets, preferences: preferences(settings) };
}
export async function getTarget(id: string): Promise<Target> {
  const target = (await readMetadata()).targets.find((entry) => entry.id === id);
  if (!target) throw new Error("所选 Kimi 数据目录不存在，请重新选择。");
  return target;
}
async function update<T>(change: (settings: PanelSettings) => T | Promise<T>): Promise<T> {
  const task = writes.catch(() => undefined).then(async () => {
    const blocker = findLegacyProcessBlocker();
    if (blocker) throw new Error(blocker);
    const migration = previewLegacyMigration();
    if (migration.status === "available" || migration.status === "blocked") throw new Error("请先完成旧版私有数据迁移，再保存本工具设置。");
    const settings = structuredClone((await readMetadata()).settings);
    const before = JSON.stringify(settings);
    const result = await change(settings);
    if (JSON.stringify(settings) === before) return result;
    await openStore(); await savePanelSettings(settings);
    await invokeCommand("reconcile_durable_grants");
    return result;
  });
  writes = task;
  return task;
}
export async function savePreferences(input: Partial<Preferences>): Promise<Preferences> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("偏好设置格式无效。");
  const patch = structuredClone(input);
  if (patch.theme !== undefined && !THEMES.includes(patch.theme)) throw new Error("未知的界面主题。");
  if (patch.locale !== undefined && !LOCALES.includes(patch.locale)) throw new Error("未知的界面语言。");
  return update((settings) => {
    if (patch.theme !== undefined) settings.theme = patch.theme;
    if (patch.locale !== undefined) settings.locale = patch.locale;
    if (patch.activeTargetId !== undefined) {
      const target = settings.kimi_code_environments?.find((entry) => entry.id === patch.activeTargetId);
      if (!target) throw new Error("未知的数据目录。");
      settings.active_kimi_code_environment_id = target.id;
      settings.config_path = join(expandHome(target.homePath), "config.toml");
    }
    return preferences(settings);
  });
}
function checkedPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("目录路径不能为空。");
  const path = expandHome(value);
  if (!isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("目录必须是无上级跳转的绝对路径。");
  return path;
}
function within(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
interface WorkingDirectorySelection {
  cwd?: string;
  grants?: { root: string; kind: "File" | "DirectoryTree" }[];
}
function checkedWorkingDirectory(value: string | undefined): WorkingDirectorySelection {
  if (value === undefined || value === "") return {};
  const expanded = checkedPath(value);
  if (!existsSync(expanded) || !statSync(expanded).isDirectory()) throw new Error("项目工作目录不存在或不是文件夹。");
  const cwd = realpathSync(expanded);
  let root = cwd;
  while (!existsSync(join(root, ".git"))) {
    const parent = dirname(root);
    if (parent === root) { root = cwd; break; }
    root = parent;
  }
  const grants: NonNullable<WorkingDirectorySelection["grants"]> = [
    { root: join(root, ".kimi-code"), kind: "DirectoryTree" },
    { root: join(root, ".mcp.json"), kind: "File" },
    ...(cwd === root ? [] : [{ root: join(cwd, ".kimi-code"), kind: "DirectoryTree" as const }]),
  ];
  for (const grant of grants) {
    if (resolveFinalTarget(grant.root) !== grant.root) throw new Error("项目配置路径不能通过符号链接跳转到其他位置。");
  }
  return { cwd, grants };
}
async function grantWorkingDirectory(working: WorkingDirectorySelection): Promise<void> {
  if (!working.grants?.length) return;
  await invokeCommand("ensure_private_dir", { path: getAppPaths().dataDir });
  // Selection authorizes only native project configuration locations, never
  // the entire workspace. Persist the same narrow grants across restarts.
  for (const grant of working.grants) {
    const record = { ...grant, source: "managed-root" as const, createdAt: new Date().toISOString() };
    saveDurableGrantTo(getAppPaths().accessGrantsPath, record);
    registerDurableGrant(record.root, record.kind, record.source, record.createdAt);
  }
}
export async function addTarget(input: { name: string; homePath: string; workingDirectory?: string; copyFromTargetId?: string }): Promise<Target> {
  return update(async (settings) => {
    if (typeof input.name !== "string" || !input.name.trim()) throw new Error("数据目录名称不能为空。");
    const home = checkedPath(input.homePath);
    if (input.copyFromTargetId) throw new Error("请使用备份预览恢复将原生配置复制到新目录；不会复制登录身份或会话。");
    const working = checkedWorkingDirectory(input.workingDirectory);
    const managed = join(resolveFinalTarget(getAppPaths().dataDir), "environments");
    if (!existsSync(home)) {
      if (!within(managed, resolveFinalTarget(home))) throw new Error("外部目录必须已存在；新建目录应位于本工具 environments 下。");
      await invokeCommand("ensure_dir", { path: home });
    }
    if (!statSync(home).isDirectory()) throw new Error("数据目录不是文件夹。");
    const canonical = realpathSync(home);
    const entries = settings.kimi_code_environments ?? [];
    if (entries.some((entry) => { try { return realpathSync(expandHome(entry.homePath)) === canonical; } catch { return expandHome(entry.homePath) === canonical; } })) throw new Error("此数据目录已经添加。");
    grantSelectedTargetDirectory(canonical);
    await grantWorkingDirectory(working);
    const target: Target = { id: randomUUID(), name: input.name.trim(), homePath: canonical, kind: within(managed, canonical) ? "managed" : "external", ...(working.cwd ? { workingDirectory: working.cwd } : {}) };
    entries.push(target); settings.kimi_code_environments = entries;
    return target;
  });
}
export async function updateTarget(input: { targetId: string; name?: string; workingDirectory?: string | null }): Promise<Target> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("数据目录设置格式无效。");
  if ("homePath" in input) throw new Error("已添加的数据目录路径不能修改；请添加新的目录引用。");
  const patch = structuredClone(input);
  if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) throw new Error("数据目录名称不能为空。");
  return update(async (settings) => {
    const target = settings.kimi_code_environments?.find((entry) => entry.id === patch.targetId);
    if (!target) throw new Error("数据目录不存在。");
    const working = patch.workingDirectory === undefined ? undefined : checkedWorkingDirectory(patch.workingDirectory ?? undefined);
    if (working && working.cwd !== target.workingDirectory) {
      await grantWorkingDirectory(working);
      if (working.cwd) target.workingDirectory = working.cwd;
      else delete target.workingDirectory;
    }
    if (patch.name !== undefined) target.name = patch.name.trim();
    return { id: target.id, name: target.name, homePath: target.homePath, kind: target.kind ?? "external", ...(target.workingDirectory ? { workingDirectory: target.workingDirectory } : {}) };
  });
}
export async function forgetTarget({ targetId }: { targetId: string }): Promise<void> {
  await update((settings) => {
    const entries = settings.kimi_code_environments ?? [];
    if (entries.length <= 1) throw new Error("至少保留一个数据目录。");
    const next = entries.filter((entry) => entry.id !== targetId);
    if (next.length === entries.length) throw new Error("数据目录不存在。");
    settings.kimi_code_environments = next;
    if (settings.active_kimi_code_environment_id === targetId) { settings.active_kimi_code_environment_id = next[0].id; settings.config_path = join(expandHome(next[0].homePath), "config.toml"); }
  });
}
function presetStore(settings: PanelSettings, targetId: string): Record<string, Profile> {
  const target = settings.kimi_code_environments?.find((entry) => entry.id === targetId);
  if (!target) throw new Error("数据目录不存在。");
  return target.profiles ?? (target.id === "default" ? settings.profiles : {}) ?? {};
}
export async function listPresets({ targetId }: { targetId: string }): Promise<Profile[]> {
  return Object.values(presetStore((await readMetadata()).settings, targetId));
}
export async function savePreset({ targetId, preset }: { targetId: string; preset: Profile }): Promise<void> {
  await update((settings) => {
    const target = settings.kimi_code_environments?.find((entry) => entry.id === targetId);
    if (!target) throw new Error("数据目录不存在。");
    target.profiles = { ...presetStore(settings, targetId), [preset.name]: structuredClone(preset) };
  });
}
export async function deletePreset({ targetId, name }: { targetId: string; name: string }): Promise<void> {
  await update((settings) => {
    const target = settings.kimi_code_environments?.find((entry) => entry.id === targetId);
    if (!target) throw new Error("数据目录不存在。");
    target.profiles = { ...presetStore(settings, targetId) }; delete target.profiles[name];
  });
}
