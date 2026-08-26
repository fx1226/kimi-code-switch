import { buildMcpConfigDocument, parseMcpConfig, parseMcpConfigStrict } from "./mcpStore";

describe("mcpStore", () => {
  it("parses legacy http transport as streamable-http", () => {
    const config = parseMcpConfig(`{
      "mcpServers": {
        "context7": {
          "transport": "http",
          "url": "https://mcp.context7.com/mcp",
          "headers": {
            "CONTEXT7_API_KEY": "ctx-test"
          }
        }
      }
    }`);

    expect(config.mcpServers.context7.transport).toBe("streamable-http");
    expect(config.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("keeps legacy sse imports visible in the GUI state", () => {
    const config = parseMcpConfig(`{
      "mcpServers": {
        "linear": {
          "url": "https://example.test/sse",
          "auth": "oauth"
        }
      }
    }`);

    expect(config.mcpServers.linear.transport).toBe("sse");
    expect(config.mcpServers.linear.headers).toEqual({});
    // auth 标记经 extra 保留，写回时不再丢弃
    expect(config.mcpServers.linear.extra?.auth).toBe("oauth");
    expect(buildMcpConfigDocument(config)).toContain('"auth": "oauth"');
  });

  it("accepts type as an alias of transport for imported configs", () => {
    const config = parseMcpConfigStrict(`{
      "mcpServers": {
        "amap-maps": {
          "type": "sse",
          "url": "https://mcp.api-inference.modelscope.net/7b4a1ee2962f46/sse"
        }
      }
    }`);

    expect(config.mcpServers["amap-maps"].transport).toBe("sse");
    expect(config.mcpServers["amap-maps"].url).toBe(
      "https://mcp.api-inference.modelscope.net/7b4a1ee2962f46/sse",
    );
  });

  it("serializes stdio and streamable-http servers and keeps legacy SSE servers", () => {
    const document = buildMcpConfigDocument({
      mcpServers: {
        context7: {
          enabled: true,
          transport: "streamable-http",
          url: "https://mcp.context7.com/mcp",
          headers: {
            CONTEXT7_API_KEY: "ctx-test",
          },
          command: "",
          args: [],
          env: {},
        },
        linear: {
          enabled: true,
          transport: "sse",
          url: "https://example.test/sse",
          headers: {},
          command: "",
          args: [],
          env: {},
        },
        chrome_devtools: {
          enabled: true,
          transport: "stdio",
          url: "",
          headers: {},
          command: "npx",
          args: ["chrome-devtools-mcp@latest"],
          env: {
            DEBUG: "1",
          },
        },
      },
    });

    expect(document).toContain('"context7"');
    expect(document).toContain('"url": "https://mcp.context7.com/mcp"');
    expect(document).toContain('"chrome_devtools"');
    expect(document).toContain('"command": "npx"');
    // 0.38.0：sse legacy 服务器原样写回（保留 transport:"sse"）
    expect(document).toContain('"linear"');
    expect(document).toContain('"transport": "sse"');
    // 默认传输（stdio / 推断 streamable-http）不显式写 transport，保持稳定输出
    expect(document).not.toContain('"transport": "stdio"');
  });

  it("keeps streamable-http servers whose URL path contains /sse", () => {
    const document = buildMcpConfigDocument({
      mcpServers: {
        modelscope: {
          enabled: true,
          transport: "streamable-http",
          url: "https://mcp.example.test/abc/sse",
          headers: {},
          command: "",
          args: [],
          env: {},
        },
      },
    });

    // 显式 streamable-http 即便 URL 含 /sse 也不应被当作 SSE 过滤掉
    expect(document).toContain('"modelscope"');
    expect(document).toContain('"url": "https://mcp.example.test/abc/sse"');
  });

  it("preserves enabled and explicit extra fields without nesting them into extra", () => {
    const config = parseMcpConfigStrict(`{
      "mcpServers": {
        "context7": {
          "transport": "streamable-http",
          "url": "https://mcp.context7.com/mcp",
          "enabled": false,
          "extra": {
            "oauth": {
              "audience": "ctx"
            }
          }
        }
      }
    }`);

    expect(config.mcpServers.context7.enabled).toBe(false);
    expect(config.mcpServers.context7.extra).toEqual({
      oauth: {
        audience: "ctx",
      },
    });
  });

  it("preserves Kimi Code 0.38.0 MCP runtime fields across parse and serialize", () => {
    const config = parseMcpConfigStrict(`{
      "mcpServers": {
        "context7": {
          "command": "npx",
          "args": ["-y", "@upstash/context7-mcp"],
          "cwd": "/tmp/context7",
          "bearerTokenEnvVar": "CONTEXT7_TOKEN",
          "startupTimeoutMs": 15000,
          "toolTimeoutMs": 60000,
          "enabledTools": ["resolve-library-id", "query-docs"],
          "disabledTools": ["delete-library"]
        }
      }
    }`);

    const serialized = JSON.parse(buildMcpConfigDocument(config)) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(serialized.mcpServers.context7).toMatchObject({
      cwd: "/tmp/context7",
      bearerTokenEnvVar: "CONTEXT7_TOKEN",
      startupTimeoutMs: 15000,
      toolTimeoutMs: 60000,
      enabledTools: ["resolve-library-id", "query-docs"],
      disabledTools: ["delete-library"],
    });
  });

  it("throws on invalid MCP config instead of silently returning empty config", () => {
    expect(() => parseMcpConfig("{not-json}")).toThrow(/Invalid MCP config/);
  });
});
