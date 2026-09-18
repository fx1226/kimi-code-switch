// 运行形态探测：桌面（Tauri）形态下 WebView 会注入 __TAURI_INTERNALS__。
// 浏览器（本地 Node 服务）形态与纯渲染形态都没有该全局对象。

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
