import { sanitizeConfigForEnvironmentClone, sanitizeMcpForEnvironmentClone } from "./environmentClone";

describe("environment clone sanitization", () => {
  it("removes static and OAuth provider credentials while preserving routing", () => {
    const cloned = sanitizeConfigForEnvironmentClone(`
[providers.gateway]
type = "openai"
base_url = "https://api.example.test/v1"
api_key = "secret"
[providers.gateway.env]
OPENAI_API_KEY = "fallback-secret"
[providers.gateway.oauth]
storage = "file"
key = "oauth/key"
[models."gateway/model"]
provider = "gateway"
model = "model"
max_context_size = 1000
`);

    expect(cloned).toContain('base_url = "https://api.example.test/v1"');
    expect(cloned).not.toContain("secret");
    expect(cloned).not.toContain("[providers.gateway.env]");
    expect(cloned).not.toContain("[providers.gateway.oauth]");
  });

  it("removes MCP headers, env and bearer-token references", () => {
    const cloned = sanitizeMcpForEnvironmentClone(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.test",
          headers: { Authorization: "Bearer secret" },
          bearerTokenEnvVar: "MCP_TOKEN",
        },
        local: { command: "npx", env: { TOKEN: "secret" } },
      },
    }));

    expect(cloned).toContain("https://mcp.example.test");
    expect(cloned).toContain('"command": "npx"');
    expect(cloned).not.toContain("secret");
    expect(cloned).not.toContain("bearerTokenEnvVar");
  });
});
