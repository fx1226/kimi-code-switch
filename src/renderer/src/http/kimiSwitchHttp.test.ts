import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installKimiSwitchHttp,
  teardownKimiSwitchHttpForTests,
} from "./kimiSwitchHttp";

interface RecordedCall {
  body: { method: string; args: unknown[] };
  headers: Record<string, string>;
  settle: (response: Response) => void;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

let recordedCalls: RecordedCall[] = [];
let callResponder: ((call: RecordedCall) => Response | null) | null = null;
let ssePush: ((chunk: string) => void) | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : String(input);
  if (url === "/api/events") {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ssePush = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    return { ok: true, status: 200, body: stream } as unknown as Response;
  }
  if (url === "/api/call") {
    const body = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return new Promise<Response>((resolve) => {
      const call: RecordedCall = { body, headers, settle: resolve };
      recordedCalls.push(call);
      const response = callResponder?.(call) ?? null;
      if (response) resolve(response);
    });
  }
  return jsonResponse({ ok: false, error: "not found" }, 404);
});

beforeEach(() => {
  recordedCalls = [];
  callResponder = null;
  ssePush = null;
  sessionStorage.clear();
  window.location.hash = "";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  teardownKimiSwitchHttpForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kimiSwitchHttp", () => {
  it("extracts the token from the location hash, stores it, and clears the hash", () => {
    window.location.hash = "#token=abc-123";

    installKimiSwitchHttp();

    expect(sessionStorage.getItem("kimi-switch-gui:server-token")).toBe("abc-123");
    expect(window.location.hash).toBe("");
  });

  it("forwards regular methods to POST /api/call with bearer authorization", async () => {
    window.location.hash = "#token=secure-token";
    callResponder = () => jsonResponse({ ok: true, result: { installed: true } });

    installKimiSwitchHttp();
    const result = await window.kimiSwitch.getCliVersion({ checkLatest: false });

    expect(result).toEqual({ installed: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/call", expect.objectContaining({ method: "POST" }));
    const call = recordedCalls.at(-1);
    expect(call?.body).toEqual({ method: "getCliVersion", args: [{ checkLatest: false }] });
    expect(call?.headers["Authorization"]).toBe("Bearer secure-token");
    expect(call?.headers["Content-Type"]).toBe("application/json");
  });

  it("throws the business error from an ok:false payload and on HTTP failures", async () => {
    installKimiSwitchHttp();

    callResponder = () => jsonResponse({ ok: false, error: "boom" });
    await expect(window.kimiSwitch.loadState()).rejects.toThrow("boom");

    callResponder = () => jsonResponse({ ok: true, result: null }, 401);
    await expect(window.kimiSwitch.loadState()).rejects.toThrow(/HTTP 401/);
  });

  it("saves files through a Blob download using the defaultPath basename", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      installKimiSwitchHttp();
      const result = await window.kimiSwitch.saveFile("hello world", {
        defaultPath: "/tmp/exports/kimi-full-backup.json",
      });

      expect(result).toEqual({ canceled: false, filePath: "/tmp/exports/kimi-full-backup.json" });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]![0];
      expect(blob.size).toBe("hello world".length);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect((clickSpy.mock.instances[0] ?? document.createElement("a")) as HTMLAnchorElement).toHaveProperty(
        "download",
        "kimi-full-backup.json",
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("pickFile reads the selected file in the browser and returns its content", async () => {
    const file = { name: "kimi-full-backup.json", text: async () => '{"hello":1}' } as unknown as File;
    const picker = vi.fn(async () => [{ getFile: async () => file }]);
    (window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = picker;

    try {
      installKimiSwitchHttp();
      const result = await window.kimiSwitch.pickFile({ filters: [{ name: "JSON", extensions: ["json"] }] });

      expect(result).toEqual({
        canceled: false,
        filePath: "",
        fileName: "kimi-full-backup.json",
        content: '{"hello":1}',
      });
      expect(picker).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }));
    } finally {
      delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    }
  });

  it("replaces onEvent callbacks with __onEvent markers and routes call-event frames back", async () => {
    installKimiSwitchHttp();

    const onEvent = vi.fn();
    const promise = window.kimiSwitch.startKimiCodeOAuthLogin(onEvent);

    await vi.waitFor(() => {
      expect(recordedCalls.some((call) => call.body.method === "startKimiCodeOAuthLogin")).toBe(true);
    });
    const call = recordedCalls.find((record) => record.body.method === "startKimiCodeOAuthLogin")!;
    expect(call.body.args[0]).toEqual({ __onEvent: true, callId: expect.any(String) });
    const callId = (call.body.args[0] as { callId: string }).callId;

    ssePush?.(`data: {"type":"call-event","callId":"${callId}","event":{"kind":"start","target":"kimi-code"}}\n\n`);
    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith({ kind: "start", target: "kimi-code" });
    });

    call.settle(jsonResponse({ ok: true, result: { ok: true, stdout: "done", stderr: "" } }));
    await expect(promise).resolves.toEqual({ ok: true, stdout: "done", stderr: "" });
  });

  it("re-dispatches forwarded window-event frames as local CustomEvents", async () => {
    installKimiSwitchHttp();

    const listener = vi.fn();
    window.addEventListener("kimi-target-detection", listener);
    try {
      ssePush?.('data: {"type":"window-event","name":"kimi-target-detection","detail":{"status":"detected"}}\n\n');
      await vi.waitFor(() => {
        expect(listener).toHaveBeenCalledTimes(1);
      });
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event).toBeInstanceOf(CustomEvent);
      expect(event.detail).toEqual({ status: "detected" });
    } finally {
      window.removeEventListener("kimi-target-detection", listener);
    }
  });

  it("keeps the openExternal protocol whitelist and opens https links", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    installKimiSwitchHttp();

    await expect(window.kimiSwitch.openExternal("http://insecure.example")).rejects.toThrow(/HTTPS/);
    await expect(window.kimiSwitch.openExternal("https://example.test")).resolves.toEqual({ ok: true });
    expect(openSpy).toHaveBeenCalledWith("https://example.test", "_blank", "noopener,noreferrer");
  });

  it("picks the backup directory through window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    installKimiSwitchHttp();

    promptSpy.mockReturnValue("/backups/kimi");
    await expect(window.kimiSwitch.pickBackupDirectory("选择目录", "/default"))
      .resolves.toEqual({ canceled: false, path: "/backups/kimi" });
    expect(promptSpy).toHaveBeenCalledWith("选择目录", "/default");

    promptSpy.mockReturnValue("   ");
    await expect(window.kimiSwitch.pickBackupDirectory("选择目录")).resolves.toEqual({ canceled: true });

    promptSpy.mockReturnValue(null);
    await expect(window.kimiSwitch.pickBackupDirectory("选择目录")).resolves.toEqual({ canceled: true });
  });

  it("readFile fails locally for empty paths without hitting the server", async () => {
    installKimiSwitchHttp();

    await expect(window.kimiSwitch.readFile(" ")).resolves.toEqual({ ok: false, error: expect.any(String) });
    expect(recordedCalls.some((call) => call.body.method === "readFile")).toBe(false);
  });

  it("prevents beforeunload only while unsaved changes are flagged", () => {
    installKimiSwitchHttp();

    window.dispatchEvent(new CustomEvent("kimi-unsaved-changed", { detail: true }));
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    window.dispatchEvent(new CustomEvent("kimi-unsaved-changed", { detail: false }));
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
});
