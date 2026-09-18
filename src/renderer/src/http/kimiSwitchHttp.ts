// window.kimiSwitch 的 HTTP 适配器（Node 本地服务 + 浏览器前端形态）。
// 常规方法经 POST /api/call 转发到本地服务（服务端进程内运行 kimiSwitchTauri）；
// 文件选择/保存/外链等浏览器原生能力在客户端完成后返回，或把读到的内容随参数转发。
// 服务端进程内 window.dispatchEvent 的 CustomEvent 经 /api/events（SSE）转发回来，
// 在本地重建同名事件，现有 kimi-target-detection 等监听无感知。
import type { kimiSwitchTauri } from "../tauri/kimiSwitch";
import type { KimiOAuthLoginEvent } from "../tauri/cli";
import { createSseClient, type SseClient, type SseServerFrame } from "./sseClient";

type TauriApi = typeof kimiSwitchTauri;
type OAuthLoginResult = Awaited<ReturnType<TauriApi["startKimiOAuthLogin"]>>;

const TOKEN_STORAGE_KEY = "kimi-switch-gui:server-token";
const ON_EVENT_MARKER = "__onEvent";

let authToken: string | null = null;
let eventClient: SseClient | null = null;
let installed = false;
let detachUnloadGuard: (() => void) | null = null;
const callEventHandlers = new Map<string, (event: unknown) => void>();

export function readTokenFromLocation(): string | null {
  const match = window.location.hash.match(/(?:^#|&)token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function initTokenFromLocation(): void {
  const fromHash = readTokenFromLocation();
  if (fromHash !== null) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash);
    // token 不留在地址栏/历史记录中，避免被复制或随书签泄漏。
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  authToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? fromHash;
}

async function remoteCall<T = unknown>(method: string, args: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ method, args }),
    });
  } catch {
    throw new Error(`Local server is unreachable (${method}).`);
  }
  if (!response.ok) {
    throw new Error(`Local server rejected ${method} (HTTP ${response.status}).`);
  }
  let payload: { ok?: boolean; result?: unknown; error?: string };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new Error(`Local server returned an invalid response (${method}).`);
  }
  if (payload.ok !== true) {
    throw new Error(payload.error ?? `Local server call failed (${method}).`);
  }
  return payload.result as T;
}

function createCallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `call-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * 带 onEvent 回调的调用：把回调位置替换为 {__onEvent:true,callId} 标记对象，
 * 服务端深层扫描后替换为向该 callId 的 SSE 流发 call-event 帧的事件发射器；
 * 客户端先确保 SSE 订阅就绪再发调用，避免服务端事件早于订阅丢失。
 */
function callWithCallEvents<T, TEvent>(
  method: string,
  args: unknown[],
  callbackIndex: number,
  onEvent?: (event: TEvent) => void,
): Promise<T> {
  if (!onEvent) return remoteCall<T>(method, args);
  const callId = createCallId();
  const markedArgs = args.map((arg, index) => (index === callbackIndex ? { [ON_EVENT_MARKER]: true, callId } : arg));
  callEventHandlers.set(callId, onEvent as unknown as (event: unknown) => void);
  return (async () => {
    try {
      if (!eventClient) throw new Error("Event stream is not available.");
      await eventClient.ready();
      return await remoteCall<T>(method, markedArgs);
    } finally {
      callEventHandlers.delete(callId);
    }
  })();
}

const handleServerFrame = (frame: SseServerFrame): void => {
  if (frame.type === "window-event") {
    window.dispatchEvent(new CustomEvent(frame.name, { detail: frame.detail }));
    return;
  }
  if (frame.type === "call-event") {
    callEventHandlers.get(frame.callId)?.(frame.event);
  }
};

// ── 浏览器原生文件/对话框替代 ──

const EXTENSION_MIME_TYPES: Record<string, string> = {
  json: "application/json",
  txt: "text/plain",
  key: "text/plain",
  md: "text/markdown",
};

type BrowserFilePickerOptions = { title?: string; filters?: Array<{ name: string; extensions: string[] }> };

function buildPickerTypes(filters?: Array<{ name: string; extensions: string[] }>):
  Array<{ description?: string; accept: Record<string, string[]> }> | undefined {
  if (!filters?.length) return undefined;
  const accept: Record<string, string[]> = {};
  for (const filter of filters) {
    for (const extension of filter.extensions) {
      const mime = EXTENSION_MIME_TYPES[extension] ?? "application/octet-stream";
      accept[mime] = [...(accept[mime] ?? []), `.${extension}`];
    }
  }
  return [{ accept }];
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function pickFileWithHiddenInput(filters?: Array<{ name: string; extensions: string[] }>): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    const accept = filters?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`)).join(",");
    if (accept) input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);
    const finish = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    input.click();
  });
}

async function pickBrowserFile(options?: BrowserFilePickerOptions): Promise<File | null> {
  const picker = (window as Window & {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<Array<{ getFile: () => Promise<File> }>>;
  }).showOpenFilePicker;
  if (typeof picker === "function") {
    try {
      const [handle] = await picker.call(window, {
        multiple: false,
        types: buildPickerTypes(options?.filters),
      });
      return await handle.getFile();
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
  }
  return pickFileWithHiddenInput(options?.filters);
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
}

const browserNativeOverrides: Pick<
  TauriApi,
  | "pickFile"
  | "saveFile"
  | "readFile"
  | "openExternal"
  | "pickBackupDirectory"
  | "startKimiOAuthLogin"
  | "startKimiCodeOAuthLogin"
  | "importBackupEncryptionKey"
> = {
  pickFile: async (options) => {
    const file = await pickBrowserFile(options);
    if (!file) return { canceled: true };
    // 浏览器拿不到绝对路径；直接带回文件内容，调用方可跳过 readFile。
    return { canceled: false, filePath: "", fileName: file.name, content: await file.text() };
  },
  saveFile: async (content, options) => {
    const defaultPath = options?.defaultPath;
    const fileName = basename(defaultPath ?? "") || "download";
    const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    }, 0);
    return { canceled: false, filePath: defaultPath ?? fileName };
  },
  readFile: async (filePath) => {
    // 浏览器形态优先由 pickFile 直接带回 content；readFile 仅兜底，路径为空直接失败。
    if (!filePath.trim()) {
      return { ok: false, error: "No file path is available in the browser runtime." };
    }
    return remoteCall<Awaited<ReturnType<TauriApi["readFile"]>>>("readFile", [filePath]);
  },
  openExternal: async (url) => {
    // 与 kimiSwitchTauri 保持同一套协议白名单。
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
      throw new Error("Only HTTPS and mailto URLs can be opened.");
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return { ok: true };
  },
  pickBackupDirectory: async (title, defaultPath) => {
    const picked = window.prompt(title, defaultPath ?? "");
    const path = picked?.trim() ?? "";
    return path ? { canceled: false, path } : { canceled: true };
  },
  startKimiOAuthLogin: (target, onEvent, options) =>
    callWithCallEvents<OAuthLoginResult, KimiOAuthLoginEvent>("startKimiOAuthLogin", [target, onEvent, options], 1, onEvent),
  startKimiCodeOAuthLogin: (onEvent) =>
    callWithCallEvents<OAuthLoginResult, KimiOAuthLoginEvent>("startKimiCodeOAuthLogin", [onEvent], 0, onEvent),
  importBackupEncryptionKey: async (provided) => {
    let content = provided;
    if (content === undefined) {
      // 浏览器端先选文件读出内容，再以 content 参数让服务端导入（服务端跳过原生对话框）。
      const file = await pickBrowserFile({ filters: [{ name: "Recovery key", extensions: ["txt", "key"] }] });
      if (!file) return { canceled: true };
      content = await file.text();
    }
    return remoteCall<Awaited<ReturnType<TauriApi["importBackupEncryptionKey"]>>>("importBackupEncryptionKey", [content]);
  },
};

/**
 * 未知方法统一经 POST /api/call 转发；browserNativeOverrides 里的方法在客户端完成。
 * 用 Proxy 保持与 kimiSwitchTauri 的全量 API 面对齐，新增方法无需在这里登记。
 */
export function createKimiSwitchHttp(): TauriApi {
  return new Proxy(browserNativeOverrides, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      // then 必须返回 undefined，避免对象被当作 thenable 被 await 吞掉。
      if (property === "then") return undefined;
      if (typeof property === "string") {
        const method = property;
        return (...args: unknown[]) => remoteCall(method, args) as never;
      }
      return undefined;
    },
  }) as TauriApi;
}

// 浏览器形态没有 Tauri 的 onCloseRequested；用 beforeunload + 脏状态同步判定。
// 脏状态由 useUnsavedChangesGuard 通过 kimi-unsaved-changed 事件广播。
function installBeforeUnloadGuard(): () => void {
  let unsaved = false;
  const handleUnsavedChanged = (event: Event): void => {
    unsaved = Boolean((event as CustomEvent<boolean>).detail);
  };
  const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("kimi-unsaved-changed", handleUnsavedChanged);
  window.addEventListener("beforeunload", handleBeforeUnload);
  return () => {
    window.removeEventListener("kimi-unsaved-changed", handleUnsavedChanged);
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}

export function installKimiSwitchHttp(): void {
  if (installed) return;
  installed = true;
  initTokenFromLocation();
  eventClient = createSseClient({
    url: "/api/events",
    getAuthorization: () => (authToken ? `Bearer ${authToken}` : ""),
    onFrame: handleServerFrame,
  });
  eventClient.start();
  window.kimiSwitch = createKimiSwitchHttp();
  detachUnloadGuard = installBeforeUnloadGuard();
}

/** 仅供测试还原全局副作用，业务代码不要调用。 */
export function teardownKimiSwitchHttpForTests(): void {
  eventClient?.stop();
  eventClient = null;
  detachUnloadGuard?.();
  detachUnloadGuard = null;
  callEventHandlers.clear();
  Reflect.deleteProperty(window, "kimiSwitch");
  installed = false;
}
