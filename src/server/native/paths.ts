// 服务端共享路径工具：`~/` 展开与受管根常量。
// 语义对齐 src-tauri/src/fs_access.rs 的 resolve_home / get_kimi_code_home；
// 三个移植组（fs / system / usage+stores）共用的路径基础件放在这里，避免各自实现产生分歧。
import { homedir } from "node:os";
import { join } from "node:path";

/** 展开前导 `~/`（仅当以 `~/` 开头）；单独 `~` 也展开为 home 目录。 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** KIMI_CODE_HOME 环境变量；未设置时返回 `~/.kimi-code`（保留 `~` 前缀，与 Rust 一致，调用方自行展开）。 */
export function getKimiCodeHome(): string {
  const value = process.env.KIMI_CODE_HOME;
  return value && value.trim().length > 0 ? value : "~/.kimi-code";
}

/** 面板数据目录 `~/.kimi-code-switch-gui`（server.json / SQLite / access-grants.json 所在）。 */
export function getAppDataDir(): string {
  return join(homedir(), ".kimi-code-switch-gui");
}
