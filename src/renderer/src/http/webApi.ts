import type { ApiResponse, WebApi, WebEvent, WebMethod } from "@shared/webApi";

const TOKEN_KEY = "kimi-code-switch-token";
const clientId = crypto.randomUUID();

export class WebApiError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "WebApiError";
  }
}

export function consumeLaunchToken(): string | null {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("token");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    hash.delete("token");
    history.replaceState(null, "", `${location.pathname}${location.search}${hash.size ? `#${hash}` : ""}`);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

async function call<K extends WebMethod>(method: K, input?: Parameters<WebApi[K]>[0]): Promise<Awaited<ReturnType<WebApi[K]>>> {
  const token = consumeLaunchToken();
  if (!token) throw new WebApiError("AUTH_REQUIRED", "请运行 kimi-code-switch open，从本机服务重新打开此页面。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, "x-client-id": clientId },
      body: JSON.stringify({ method, input }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new WebApiError("AUTH_REQUIRED", "本地服务凭证已失效，请运行 kimi-code-switch open 重新打开。");
    }
    const payload = await response.json() as ApiResponse<Awaited<ReturnType<WebApi[K]>>>;
    if (!payload.ok) throw new WebApiError(payload.error.code, payload.error.message, payload.error.details);
    return payload.result;
  } catch (error) {
    if (error instanceof WebApiError) throw error;
    throw new WebApiError("CONNECTION_LOST", "无法连接本地服务。若刚提交过修改，请重连后查询操作结果再重试。", error instanceof Error ? error.name : undefined);
  } finally {
    clearTimeout(timer);
  }
}

export function createWebApi(): WebApi {
  return {
    bootstrap: () => call("bootstrap"),
    readResource: (input) => call("readResource", input),
    planChange: (input) => call("planChange", input),
    applyChange: (input) => call("applyChange", input),
    getOperation: (input) => call("getOperation", input),
    savePreferences: (input) => call("savePreferences", input),
    addTarget: (input) => call("addTarget", input),
    updateTarget: (input) => call("updateTarget", input),
    forgetTarget: (input) => call("forgetTarget", input),
    listPresets: (input) => call("listPresets", input),
    savePreset: (input) => call("savePreset", input),
    deletePreset: (input) => call("deletePreset", input),
    planPreset: (input) => call("planPreset", input),
    scanSkills: (input) => call("scanSkills", input),
    listPlugins: (input) => call("listPlugins", input),
    diagnose: (input) => call("diagnose", input),
    listBackups: (input) => call("listBackups", input),
    createBackup: (input) => call("createBackup", input),
    exportBackup: (input) => call("exportBackup", input),
    planRestore: (input) => call("planRestore", input),
    importBackup: (input) => call("importBackup", input),
    listHistory: (input) => call("listHistory", input),
    planHistoryRestore: (input) => call("planHistoryRestore", input),
    listRecoveryCases: () => call("listRecoveryCases"),
    exportRecoveryJournal: (input) => call("exportRecoveryJournal", input),
    resolveRecovery: (input) => call("resolveRecovery", input),
    previewMigration: () => call("previewMigration"),
    applyMigration: (input) => call("applyMigration", input),
    openKimi: (input) => call("openKimi", input),
    login: (input) => call("login", input),
    testMcp: (input) => call("testMcp", input),
    listMcpTools: (input) => call("listMcpTools", input),
    callMcpTool: (input) => call("callMcpTool", input),
  };
}

/** Event data is advisory; authoritative configuration is always re-read. */
export function subscribeWebEvents(onEvent: (event: WebEvent) => void, onConnectionChange?: (connected: boolean) => void): () => void {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = async (): Promise<void> => {
    const token = consumeLaunchToken();
    if (!token || controller.signal.aborted) return;
    try {
      const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}`, "x-client-id": clientId }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("Event stream unavailable");
      onConnectionChange?.(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const event: unknown = JSON.parse(line.slice(6));
            if (typeof event === "object" && event !== null && "type" in event && event.type !== "heartbeat") onEvent(event as WebEvent);
          }
        }
      }
    } catch { /* A disconnected event stream is retried without resubmitting work. */ }
    onConnectionChange?.(false);
    if (!controller.signal.aborted) retry = setTimeout(() => { void connect(); }, 2000);
  };
  void connect();
  return () => { controller.abort(); if (retry) clearTimeout(retry); };
}
