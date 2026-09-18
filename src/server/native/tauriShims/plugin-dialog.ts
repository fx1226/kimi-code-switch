// @tauri-apps/plugin-dialog 的 Node shim：服务端没有原生对话框。
// 顶层 import 不抛错；调用 open/save 时才报 unsupported。
export function open(): Promise<never> {
  return Promise.reject(new Error("dialog open is unsupported in server runtime"));
}

export function save(): Promise<never> {
  return Promise.reject(new Error("dialog save is unsupported in server runtime"));
}
