// @tauri-apps/api/window 的 Node shim：服务端没有窗口。
// 顶层 import 不抛错；只有调用 getCurrentWindow 时才报 unsupported。
export function getCurrentWindow(): never {
  throw new Error("getCurrentWindow is unsupported in server runtime");
}
