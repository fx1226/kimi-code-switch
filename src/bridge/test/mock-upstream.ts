/**
 * 测试 helper：本地模拟 ChatGPT Codex 后端与 OAuth token 端点。
 * 只操作 loopback 临时端口；不访问真实 OpenAI。
 */
import { createServer, type Server } from "node:http";

export interface MockUpstreamBehavior {
  /** /codex/responses 的行为：默认流式返回一个简单完成的响应。 */
  responses?: (body: Record<string, unknown>) => Promise<Response | { status: number; body: unknown }>;
  /** 是否让 refresh token 失效（模拟 refresh 失败）。 */
  failRefresh?: boolean;
  refreshCount?: number;
}

function sse(...events: unknown[]): Response {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(frames, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** 供测试 handler 直接返回的 SSE 响应。 */
export function mockSseResponse(...events: unknown[]): Response {
  return sse(...events);
}

function completedResponse(model: string): unknown[] {
  const messageItem = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hello" }],
  };
  return [
    { type: "response.created", response: { id: "resp_mock", model, output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "hello" },
    { type: "response.output_item.done", output_index: 0, item: messageItem },
    {
      type: "response.completed",
      response: {
        id: "resp_mock",
        model,
        status: "completed",
        output: [messageItem],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
}

export interface MockUpstream {
  baseUrl: string;
  responsesUrl: string;
  tokenUrl: string;
  modelsUrl: string;
  responsesRequests: Array<{ body: unknown; headers: Record<string, string | string[] | undefined> }>;
  tokenRequests: Array<{ grant_type: string; refresh_token?: string }>;
  close(): Promise<void>;
  setResponses(handler: MockUpstreamBehavior["responses"]): void;
}

export async function createMockUpstream(behavior: MockUpstreamBehavior = {}): Promise<MockUpstream> {
  const responsesRequests: MockUpstream["responsesRequests"] = [];
  const tokenRequests: MockUpstream["tokenRequests"] = [];
  let responsesHandler = behavior.responses;
  let failRefresh = behavior.failRefresh ?? false;
  let refreshCount = behavior.refreshCount ?? 0;
  let refreshCalls = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");

      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const params = new URLSearchParams(raw);
        tokenRequests.push({
          grant_type: params.get("grant_type") ?? "",
          refresh_token: params.get("refresh_token") ?? undefined,
        });
        if (params.get("grant_type") === "refresh_token") refreshCalls += 1;
        if (params.get("grant_type") === "refresh_token" && (failRefresh || (refreshCount > 0 && refreshCalls > refreshCount))) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }));
          return;
        }
        const token = params.get("grant_type") === "refresh_token" ? "refreshed-access-token" : "access-token-1";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: token,
            refresh_token: "refresh-token-1",
            id_token:
              "eyJhbGciOiJub25lIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEyMyJ9.",
            expires_in: 3600,
          }),
        );
        return;
      }

      if (url.pathname === "/codex/responses" && req.method === "POST") {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad json" } }));
          return;
        }
        responsesRequests.push({
          body,
          headers: {
            authorization: req.headers.authorization,
            "chatgpt-account-id": req.headers["chatgpt-account-id"],
          },
        });
        if (responsesHandler) {
          const result = await responsesHandler(body);
          if (result instanceof Response) {
            res.writeHead(result.status, {
              "content-type": result.headers.get("content-type") ?? "application/json",
            });
            res.end(await result.text());
            return;
          }
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.body));
          return;
        }
        const stream = sse(...completedResponse(String(body.model ?? "gpt-mock")));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(await stream.text());
        return;
      }

      if (url.pathname === "/codex/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                slug: "gpt-mock-pro",
                display_name: "GPT Mock Pro",
                context_window: 128000,
                input_modalities: ["text", "image"],
                supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
                visibility: "list",
                supported_in_api: true,
                available_in_plans: ["pro"],
              },
              {
                slug: "gpt-mock-lite",
                display_name: "GPT Mock Lite",
                context_window: 64000,
                visibility: "list",
                supported_in_api: true,
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    responsesUrl: `http://127.0.0.1:${port}/codex/responses`,
    tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
    modelsUrl: `http://127.0.0.1:${port}/codex/models`,
    responsesRequests,
    tokenRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setResponses(handler) {
      responsesHandler = handler;
    },
  };
}
