import { describe, expect, it } from "vitest";
import { sanitizePublicResult, toPublicError } from "./publicError";

const secret = "plain-value-that-does-not-look-like-a-key";
describe("public diagnostics", () => {
  it("never returns arbitrary exception messages, codes, causes or upstream payloads", () => {
    for (const error of [
      new Error(`Authorization: Bearer ${secret}`),
      { code: secret, message: `api_key=${secret}`, cause: { token: secret } },
      new SyntaxError(`Unexpected token in JSON at '${secret}'`),
      new Error(`MCP JSON-RPC error: ${JSON.stringify({ text: secret })}`),
      secret,
    ]) {
      expect(JSON.stringify(toPublicError(error))).not.toContain(secret);
      expect(toPublicError(error).code).toBe("OPERATION_FAILED");
    }
    expect(toPublicError(new Error(secret), "listMcpTools").code).toBe("MCP_REQUEST_FAILED");
    expect(toPublicError({ get code() { throw new Error(secret); } }).code).toBe("OPERATION_FAILED");
  });

  it("keeps actionable permission, conflict, recovery and version distinctions with static messages", () => {
    for (const code of ["conflict", "recovery-required", "recovery-export-required", "unverified-version", "unknown-plan", "legacy-process-running", "migration-pending", "UNSUPPORTED_STRUCTURE"]) {
      const error = toPublicError(Object.assign(new Error(secret), { code }));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(secret);
    }
    expect(toPublicError(Object.assign(new Error(secret), { code: "EACCES" })).code).toBe("PERMISSION_DENIED");
    expect(toPublicError(new Error(`Path '${secret}' is outside the authorized scope`)).code).toBe("PERMISSION_DENIED");
    expect(toPublicError(new Error("此数据目录已经添加。"))).toEqual({ code: "INVALID_INPUT", message: "此数据目录已经添加。" });
  });

  it("removes parser context from skill and plugin diagnostic channels without altering editable content", () => {
    const result = sanitizePublicResult("scanSkills", {
      paths: [{ reason: `Skill scan failed: ${secret}`, path: "/fixture/skills" }],
      skills: [{ content: secret, diagnostics: [`Invalid YAML frontmatter: ${secret}`, `Unsupported Skill type: ${secret}`] }],
    }) as { paths: Array<{ reason: string }>; skills: Array<{ content: string; diagnostics: string[] }> };
    expect(result.skills[0].content).toBe(secret);
    expect(JSON.stringify([result.paths, result.skills[0].diagnostics])).not.toContain(secret);
    const plugins = sanitizePublicResult("listPlugins", { diagnostics: [{ severity: "error", message: secret }], plugins: [{ diagnostics: [{ severity: "warn", message: secret }] }] });
    expect(JSON.stringify(plugins)).not.toContain(secret);
  });

  it("preserves diagnostic severity and known recovery codes while dropping raw details", () => {
    const result = sanitizePublicResult("getOperation", { status: "conflict", diagnostics: [{ severity: "error", code: "conflict", message: secret, detail: secret }] });
    expect(result).toMatchObject({ status: "conflict", diagnostics: [{ severity: "error", code: "conflict" }] });
    expect(JSON.stringify(result)).not.toContain(secret);
    const diagnosis = sanitizePublicResult("diagnose", { ok: false, issues: [{ severity: "error", message: secret, resource: "config" }] });
    expect(diagnosis).toMatchObject({ ok: false, issues: [{ severity: "error", resource: "config" }] });
    expect(JSON.stringify(diagnosis)).not.toContain(secret);
    expect(sanitizePublicResult("diagnose", { ok: false, issues: [{ severity: "warning", code: "OFFICIAL_EXECUTABLE_CHANGED", message: secret }] })).toMatchObject({ issues: [{ code: "OFFICIAL_EXECUTABLE_CHANGED", message: "官方可执行文件在校验期间发生变化，请重新验证。" }] });
  });

  it("keeps raw native content available only in the authorized resource result", () => {
    const result = sanitizePublicResult("readResource", {
      content: secret, data: { api_key: secret }, diagnostics: [{ severity: "error", message: secret }],
    }) as { content: string; data: { api_key: string }; diagnostics: unknown[] };
    expect(result.content).toBe(secret);
    expect(result.data.api_key).toBe(secret);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
    const preview = sanitizePublicResult("planChange", { redactedPreview: { before: `api_key = "${secret}"`, after: `api_key = "${secret}"` } });
    expect(JSON.stringify(preview)).not.toContain(secret);
  });

  it("does not return MCP diagnostic stdout, stderr, raw JSON-RPC envelopes or tool errors", () => {
    expect(JSON.stringify(sanitizePublicResult("testMcp", { ok: true, stdout: secret, stderr: secret }))).not.toContain(secret);
    expect(sanitizePublicResult("listMcpTools", { tools: [], raw: secret, stderr: secret })).toEqual({ tools: [] });
    expect(JSON.stringify(sanitizePublicResult("callMcpTool", { ok: true, toolName: "test", raw: secret, stderr: secret, result: { isError: true, content: [{ type: "text", text: secret }] } }))).not.toContain(secret);
    expect(sanitizePublicResult("callMcpTool", { ok: true, toolName: "test", raw: secret, stderr: secret, result: { content: [{ type: "text", text: "requested result" }] } })).toEqual({ ok: true, toolName: "test", result: { content: [{ type: "text", text: "requested result" }] } });
  });
});
