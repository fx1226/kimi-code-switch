// @tauri-apps/plugin-opener 的 Node shim：浏览器形态由前端自己开链接。
// 顶层 import 不抛错；调用 openUrl 时才报 unsupported。
export function openUrl(): Promise<never> {
  return Promise.reject(new Error("openUrl is unsupported in server runtime"));
}
