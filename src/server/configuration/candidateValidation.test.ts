import { describe, expect, it } from "vitest";
import { validateNativeCandidate } from "./candidateValidation";

describe("official 2.0 candidate semantics", () => {
  it("requires new model provider references and changed selections to resolve locally", () => {
    expect(() => validateNativeCandidate("config", null, '[models.new]\nprovider = "absent"\nmodel = "upstream"\n')).toThrow("configured provider");
    expect(() => validateNativeCandidate("config", null, 'default_model = "kimi-code/k3"\n')).toThrow("configured model");
    expect(() => validateNativeCandidate("config", null, 'default_model = "short"\n[providers.custom]\ntype = "openai"\n[models.full]\nprovider = "custom"\nmodel = "upstream"\naliases = ["short"]\n')).not.toThrow();
  });

  it("preserves unmodified dynamic selections and validates only changed supported values", () => {
    expect(() => validateNativeCandidate("config", 'default_model = "external/catalog-alias"\n', 'default_model = "external/catalog-alias"\ntelemetry = false\n')).not.toThrow();
    expect(() => validateNativeCandidate("config", null, '[thinking]\neffort = "provider-specific"\n')).not.toThrow();
    expect(() => validateNativeCandidate("config", null, '[models.custom]\nmax_context_size = 0\n')).toThrow("max_context_size");
    expect(() => validateNativeCandidate("config", null, 'thinking = "wrong"\n')).toThrow("thinking");
    expect(() => validateNativeCandidate("config", null, 'secondary_model = "wrong"\n')).toThrow("secondary_model");
    expect(() => validateNativeCandidate("tui", null, 'markdown = "wrong"\n')).toThrow("markdown");
    expect(() => validateNativeCandidate("project-local", null, 'workspace = "wrong"\n')).toThrow("workspace");
  });

  it("rejects MCP root and changed-server schema errors without deleting unknown keys", () => {
    for (const server of [
      { transport: "stdio", command: "" }, { transport: "stdio", command: "node", args: [1] },
      { command: "node", env: { KEY: 123 } }, { command: "node", enabled: "yes" },
      { command: "node", deferred: 1 }, { command: "node", startupTimeoutMs: 0 },
      { transport: "http", url: "not a URL" }, { url: "https://example.test", headers: { KEY: false } },
      { url: "https://example.test", auth: "password" }, { transport: "streamable-http", url: "https://example.test" },
    ]) expect(() => validateNativeCandidate("mcp", null, JSON.stringify({ mcpServers: { changed: server } }))).toThrow("Invalid MCP server");
    expect(() => validateNativeCandidate("mcp", null, '{"mcpServers":[]}')).toThrow("must be an object");
    expect(() => validateNativeCandidate("mcp", null, JSON.stringify({ extension: { opaque: true }, mcpServers: { ok: { url: "ftp://example.test", unknown: { future: true } } } }))).not.toThrow();
  });

  it("preserves unrelated invalid MCP entries while checking changed servers in all scopes", () => {
    const before = { mcpServers: { broken: { command: 123 }, ok: { command: "node" } }, future: { x: 1 } };
    const after = { ...before, mcpServers: { ...before.mcpServers, ok: { command: "bun" } } };
    for (const resource of ["mcp", "mcp-project", "mcp-local"] as const) {
      expect(() => validateNativeCandidate(resource, JSON.stringify(before), JSON.stringify(after))).not.toThrow();
      expect(() => validateNativeCandidate(resource, JSON.stringify(before), JSON.stringify({ ...before, mcpServers: { ...before.mcpServers, ok: { command: 123 } } }))).toThrow("transport");
    }
  });
});
