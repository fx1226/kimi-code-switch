import { describe, expect, it } from "vitest";
import { capturePreset, draftChanges, draftKey, rebaseDraft, redactSource, type ResourceDraft } from "./drafts";

const draft: ResourceDraft = { key: "a", targetId: "default", kind: "provider", originalName: "one", name: "one", base: { type: "kimi", base_url: "https://old.example", custom: 12 }, value: { type: "kimi", base_url: "https://new.example", custom: 12 }, revision: "r1" };
describe("resource-scoped drafts", () => {
  it("plans only changed fields of the selected resource", () => {
    expect(draftChanges(draft)).toEqual([{ op: "set", path: ["providers", "one", "base_url"], value: "https://new.example" }]);
  });
  it("distinguishes same-named MCP resources by target, file scope, and native path", () => {
    const scopes = [
      ["default", "mcp:/tmp/kimi/mcp.json"],
      ["default", "mcp-local:/tmp/project-a/.kimi-code/mcp.json"],
      ["default", "mcp-local:/tmp/project-b/.kimi-code/mcp.json"],
      ["other", "mcp-local:/tmp/project-a/.kimi-code/mcp.json"],
    ];
    const keys = scopes.map(([target, scope]) => draftKey(target!, "mcp", "shared", scope));
    expect(new Set(keys).size).toBe(4);
    const drafts = Object.fromEntries(keys.map((key, index) => [key, `draft-${index}`]));
    expect(drafts[draftKey("default", "mcp", "shared", "mcp-local:/tmp/project-a/.kimi-code/mcp.json")]).toBe("draft-1");
    expect(drafts[draftKey("default", "mcp", "shared", "mcp-local:/tmp/project-b/.kimi-code/mcp.json")]).toBe("draft-2");
  });
  it("rebases an MCP draft without changing its scope or path or overwriting unrelated external fields", () => {
    const path = "/tmp/project-a/.kimi-code/mcp.json";
    const scope = `mcp-local:${path}`;
    const local: ResourceDraft = {
      key: draftKey("default", "mcp", "shared", scope), targetId: "default", kind: "mcp",
      name: "shared", originalName: "shared", resource: "mcp-local", scope, path, revision: "local-r1",
      base: { type: "stdio", command: "native-command", args: [], future: "old" },
      value: { type: "stdio", command: "unsaved-command", args: [], future: "old" },
    };
    const next = rebaseDraft(local, {
      resource: "mcp-local", path, exists: true, format: "json", revision: "local-r2", content: "{}", diagnostics: [],
      data: { mcpServers: { shared: { type: "stdio", command: "native-command", args: ["external-arg"], future: "external" } } },
    });
    expect(next).toMatchObject({ key: local.key, resource: "mcp-local", scope, path, revision: "local-r2" });
    expect(next.value).toEqual({ type: "stdio", command: "unsaved-command", args: ["external-arg"], future: "external" });
    expect(draftChanges(next)).toEqual([{ op: "set", path: ["mcpServers", "shared", "command"], value: "unsaved-command" }]);
  });
  it("preserves unrelated external edits when the user explicitly reloads", () => {
    const next = rebaseDraft(draft, { resource: "config", path: "config.toml", exists: true, format: "toml", revision: "r2", content: "", diagnostics: [], data: { providers: { one: { type: "kimi", base_url: "https://old.example", custom: 99 } } } });
    expect(next.value).toEqual({ type: "kimi", base_url: "https://new.example", custom: 99 });
    expect(next.revision).toBe("r2");
    expect(draftChanges(next)).toEqual(draftChanges(draft));
  });
  it("does not expose secret lines in a source viewer", () => {
    const source = 'name = "public"\napi_key = "private-key"\n[providers.a.env]\nCREDENTIAL = "private-env"\n[models.a]\nmodel = "public-model"';
    const output = redactSource(source);
    expect(output).not.toContain("private-key");
    expect(output).not.toContain("private-env");
    expect(output).toContain("public-model");
  });
  it("captures only explicit preset fields without filling official defaults", () => {
    const preset = capturePreset("work", { default_model: "model-a", thinking: { effort: "high" } });
    expect(preset.nativeEdits).toEqual([{ op: "set", path: ["default_model"], value: "model-a" }, { op: "set", path: ["thinking", "effort"], value: "high" }]);
    expect(preset.nativeEdits).not.toContainEqual(expect.objectContaining({ path: ["merge_all_available_skills"] }));
  });
  it("hides arbitrary env and header values in JSON source", () => {
    const output = redactSource(JSON.stringify({ mcpServers: { a: { env: { RANDOM: "private" }, headers: { "X-Credential": "private" }, command: "public" } } }));
    expect(output).not.toContain("private"); expect(output).toContain("public");
  });
  it("redacts multiline credentials", () => {
    expect(redactSource('api_key = """start\nhidden\nend"""\nname = "visible"')).not.toMatch(/start|hidden|end/);
  });
  it.each(["env", "headers", "oauth", "credential"])('redacts both multiline string styles inside a %s table', (table) => {
    for (const delimiter of ['"""', "'''"]) {
      const source = `[providers.demo.${table}]\nPRIVATE = ${delimiter}canary-first\n[public.looking]\nvalue = "canary-middle"\ncanary-last${delimiter}\n[models.demo]\nmodel = "visible-model"`;
      const output = redactSource(source);
      expect(output).not.toContain("canary");
      expect(output).not.toContain("public.looking");
      expect(output).toContain("visible-model");
    }
  });
  it("does not end redaction at an escaped triple delimiter or an unterminated string", () => {
    const source = '[providers.demo.env]\nPRIVATE = """canary-first\n\\"""\ncanary-middle\ncanary-last"""\n[models.demo]\nmodel = "visible-model"';
    expect(redactSource(source)).not.toContain("canary");
    expect(redactSource(source)).toContain("visible-model");
    expect(redactSource('[providers.demo.env]\nPRIVATE = """canary-first\ncanary-middle')).not.toContain("canary");
  });
  it.each([
    ["TOML", '[providers.demo]\nbase_url = "https://private-user:private-pass@api.example.test/v1"\ncatalog_url = "https://api.example.test/models?token=query-private"\ndiscovery_url = "https://api.example.test/models?key=key-private"\nmodel = "public-model"'],
    ["JSON", JSON.stringify({ mcpServers: { demo: { url: "https://private-user:private-pass@mcp.example.test/mcp?token=query-private&key=key-private", description: "public-model" } } })],
  ])("redacts URL basic authentication and query credentials in %s source", (_format, source) => {
    const output = redactSource(source);
    expect(output).not.toMatch(/private-user|private-pass|query-private|key-private/);
    expect(output).toContain("public-model");
    expect(output).toContain("REDACTED");
  });
});
