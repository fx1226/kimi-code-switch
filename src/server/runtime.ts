// 服务端进程运行时垫片：必须是进程入口最先 import 的模块（main.ts 第一行），
// 之后才能加载 renderer 适配层（kimiSwitch 链）——后者在函数体内调用
// window.dispatchEvent / window.setTimeout，Node 进程没有这些全局。
// 构建时 esbuild define 会把 SERVER_VERSION 替换为 package.json 的版本号。
declare const SERVER_VERSION: string | undefined;

/** 服务端 window shim 的最小形状（Node 构建没有 DOM lib，完整 Window 类型不可用）。 */
export interface ServerWindow extends EventTarget {
  setTimeout(callback: (...args: never[]) => void, timeoutMs?: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  kimiSwitch?: unknown;
}

declare global {
  // renderer 适配层在 tsconfig.node.json 程序里引用 window 时使用这个类型；
  // web 程序（tsconfig.web.json）不受影响，仍使用 DOM 的 Window。
  var window: ServerWindow;
  // Node 程序没有 DOM lib，renderer 适配层（如 webdav.ts）引用的这两个 DOM
  // 类型在服务端对应 Node webcrypto 的同名类型。
  type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
  type BufferSource = ArrayBufferView | ArrayBuffer;
}

/** window.dispatchEvent 的拦截器：SSE 层注册后把 CustomEvent 转发为 window-event 帧。 */
export type WindowEventSink = (event: Event) => void;

const windowEventSinks = new Set<WindowEventSink>();

class ServerWindowTarget extends EventTarget {
  setTimeout(callback: (...args: never[]) => void, timeoutMs?: number): NodeJS.Timeout {
    return setTimeout(callback, timeoutMs);
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    clearTimeout(handle);
  }

  dispatchEvent(event: Event): boolean {
    for (const sink of windowEventSinks) {
      sink(event);
    }
    return super.dispatchEvent(event);
  }
}

if (globalThis.window === undefined) {
  globalThis.window = new ServerWindowTarget();
}

/** 注册 window.dispatchEvent 拦截器，返回取消注册函数。 */
export function addWindowEventSink(sink: WindowEventSink): () => void {
  windowEventSinks.add(sink);
  return () => {
    windowEventSinks.delete(sink);
  };
}

// vitest 等未经 esbuild define 的运行环境里 SERVER_VERSION 为空，回退到 dev 版本号。
export const serverVersion: string = typeof SERVER_VERSION === "undefined" ? "0.0.0-dev" : SERVER_VERSION;
