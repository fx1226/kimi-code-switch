import { describe, expect, it } from "vitest";
import parseToml from "@iarna/toml/parse-string.js";

import { applyDocumentPatch, DocumentPatchError, type DocumentEdit } from "./documentPatch";

function expectPatchError(run: () => unknown, code: DocumentPatchError["code"]): void {
  try {
    run();
    throw new Error("Expected a DocumentPatchError.");
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentPatchError);
    expect((error as DocumentPatchError).code).toBe(code);
  }
}

describe("applyDocumentPatch TOML", () => {
  it("changes only the requested value, retaining comments, unknown fields and CRLF", () => {
    const source = '# owned by the CLI\r\ntheme  =  \'dark\'  # appearance\r\nfuture = {enabled = true}\r\n[editor]\r\ncommand = "vim"\r\n';
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["theme"], value: "light" }])).toEqual({
      content: source.replace("'dark'", '"light"'),
      changed: true,
    });
  });

  it("keeps semantic no-ops byte-identical and never materializes missing defaults", () => {
    const source = "theme = 'dark' # untouched\r\n";
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["theme"], value: "dark" }])).toEqual({ content: source, changed: false });
    expect(applyDocumentPatch("toml", source, [{ op: "delete", path: ["enabled"] }])).toEqual({ content: source, changed: false });
    expect(applyDocumentPatch("toml", source, [])).toEqual({ content: source, changed: false });
  });

  it("patches nested and quoted keys without splitting literal dots", () => {
    const source = '[providers."foo.bar"]\nbase_url = "https://old/#literal" # url\nfuture = 7\n';
    const result = applyDocumentPatch("toml", source, [{ op: "set", path: ["providers", "foo.bar", "base_url"], value: "https://new/#safe" }]);
    expect(result.content).toBe(source.replace("https://old/#literal", "https://new/#safe"));
  });

  it("locates multiline strings, escaped quotes, hashes and table-looking string content", () => {
    const source = 'note = """first \\"quote\\"\n# not a comment\n[editor]\nkey = 3\n""" # note\ntheme = "dark"\n';
    const result = applyDocumentPatch("toml", source, [{ op: "set", path: ["theme"], value: "light" }]);
    expect(result.content).toBe(source.replace('theme = "dark"', 'theme = "light"'));
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["note"], value: "short#note" }]).content)
      .toBe('note = "short#note" # note\ntheme = "dark"\n');
  });

  it.each(['"""hello""""', '"""hello"""""', "'''hello''''", "'''hello'''''"])("refuses quote-run syntax unsupported by the current TOML parser: %s", (value) => {
    const source = `note = ${value}\ntheme = "dark"\n`;
    expectPatchError(() => applyDocumentPatch("toml", source, [{ op: "set", path: ["theme"], value: "light" }]), "INVALID_DOCUMENT");
  });

  it("replaces arrays as a whole while preserving unrelated multiline data", () => {
    const source = 'models = [\n  "a",\n  "b",\n] # choices\nfuture = "#not comment"\n';
    const result = applyDocumentPatch("toml", source, [{ op: "set", path: ["models"], value: ["c", "d"] }]);
    expect(result.content).toBe('models = ["c", "d"] # choices\nfuture = "#not comment"\n');
  });

  it("refuses to replace annotated array items without dropping their comments", () => {
    const source = 'models = [\r\n  "a", # first\r\n  # before second\r\n  "b",\r\n] # choices\r\nfuture = true\r\n';
    expectPatchError(() => applyDocumentPatch("toml", source, [{ op: "set", path: ["models"], value: ["c", "d"] }]), "UNSUPPORTED_STRUCTURE");
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["models"], value: ["a", "b"] }])).toEqual({ content: source, changed: false });
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["future"], value: false }]).content).toBe(source.replace("future = true", "future = false"));
  });

  it("deletes assignments but retains surrounding and inline comments and the empty table", () => {
    const source = '[editor]\r\n# user explanation\r\ncommand = "vim" # keep this note\r\n# future setting\r\n';
    const result = applyDocumentPatch("toml", source, [{ op: "delete", path: ["editor", "command"] }]);
    expect(result.content).toBe('[editor]\r\n# user explanation\r\n# keep this note\r\n# future setting\r\n');
  });

  it("retains comments inside a deleted multiline array as standalone comments", () => {
    const source = 'choices = [\n  "a", # note a\n  "b", # note b\n] # note choices\nfuture = true\n';
    const result = applyDocumentPatch("toml", source, [{ op: "delete", path: ["choices"] }]);
    expect(result.content).toBe('# note a\n# note b\n# note choices\nfuture = true\n');
  });

  it("adds root fields before table scope and table fields inside the correct table", () => {
    const source = '# leading\n[editor]\ncommand = "vim"\n\n[future]\nkeep = true\n';
    const result = applyDocumentPatch("toml", source, [
      { op: "set", path: ["theme"], value: "dark" },
      { op: "set", path: ["editor", "args"], value: ["--wait"] },
    ]);
    expect(parseToml(result.content)).toEqual({ theme: "dark", editor: { command: "vim", args: ["--wait"] }, future: { keep: true } });
    expect(result.content).toContain('theme = "dark"\n# leading\n[editor]');
    expect(result.content).toContain('args = ["--wait"]\n\n[future]');
  });

  it("extends dotted-key tables without redefining the table", () => {
    const source = 'editor.command = "vim" # keep\n';
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["editor", "args"], value: ["--wait"] }]).content)
      .toBe(source + 'editor.args = ["--wait"]\n');
  });

  it("extends an implicitly defined parent without changing its child table", () => {
    const source = '[editor.future]\nkeep = true\n';
    const result = applyDocumentPatch("toml", source, [{ op: "set", path: ["editor", "command"], value: "vim" }]);
    expect(result.content).toBe('editor.command = "vim"\n' + source);
  });

  it("handles TOML prototype-named tables as ordinary own keys", () => {
    const source = '[__proto__]\nenabled = false\n';
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["__proto__", "enabled"], value: true }]).content)
      .toBe(source.replace("false", "true"));
    expect(Object.prototype).not.toHaveProperty("enabled");
  });

  it("creates a missing nested table and inherits CRLF", () => {
    const source = 'theme = "dark"\r\n';
    const result = applyDocumentPatch("toml", source, [{ op: "set", path: ["providers", "foo.bar", "type"], value: "openai" }]);
    expect(result.content).toBe(source + '\r\n[providers."foo.bar"]\r\ntype = "openai"\r\n');
  });

  it("preserves missing final newline for value edits and adds only required delimiters for insertion", () => {
    expect(applyDocumentPatch("toml", 'theme="dark"', [{ op: "set", path: ["theme"], value: "light" }]).content).toBe('theme="light"');
    expect(applyDocumentPatch("toml", 'theme="dark"', [{ op: "set", path: ["enabled"], value: true }]).content).toBe('theme="dark"\nenabled = true\n');
  });

  it("preserves unrelated arrays of tables, dates, large integers and NaN literals", () => {
    const source = 'date = 1979-05-27\nlarge = 9223372036854775807\nratio = nan\nzero = -0.0\ntheme = "dark"\n[[providers]]\nname="a"\n[[providers]]\nname="b"\n';
    expect(applyDocumentPatch("toml", source, [{ op: "set", path: ["theme"], value: "light" }]).content)
      .toBe(source.replace('theme = "dark"', 'theme = "light"'));
  });

  it("refuses inline-table children and whole-table replacement without rewriting anything", () => {
    expectPatchError(() => applyDocumentPatch("toml", 'editor = { command = "vim", future = true }\n', [
      { op: "set", path: ["editor", "command"], value: "nano" },
    ]), "UNSUPPORTED_STRUCTURE");
    expect(applyDocumentPatch("toml", '[editor]\ncommand = "vim"\n', [{ op: "delete", path: ["editor"] }]).content).toBe("");
    expectPatchError(() => applyDocumentPatch("toml", '[editor]\ncommand = "vim"\n', [{ op: "set", path: ["editor"], value: {} }]), "UNSUPPORTED_STRUCTURE");
  });

  it("creates a normal provider table that remains editable by individual fields", () => {
    const source = '# keep\ndefault_model = "builtin"\n';
    const added = applyDocumentPatch("toml", source, [{ op: "set", path: ["providers", "new provider"], value: { type: "openai", api_key: "test", headers: { label: "ok" } } }]);
    expect(added.content.startsWith(source)).toBe(true);
    expect(added.content).toContain('[providers."new provider"]');
    const edited = applyDocumentPatch("toml", added.content, [{ op: "set", path: ["providers", "new provider", "type"], value: "anthropic" }]);
    expect(edited.content).toBe(added.content.replace('type = "openai"', 'type = "anthropic"'));
  });

  it("deletes a table subtree while retaining adjacent tables and comments", () => {
    const source = '# keep\n[providers.one] # removed table note\ntype = "openai" # type note\n[providers.one.headers]\nlabel = "one"\n\n[providers.two]\ntype = "anthropic"\n';
    const deleted = applyDocumentPatch("toml", source, [{ op: "delete", path: ["providers", "one"] }]);
    expect(deleted.content).toContain('# removed table note');
    expect(deleted.content).toContain('# type note');
    expect(deleted.content).toContain('[providers.two]\ntype = "anthropic"\n');
    expect(deleted.content).not.toContain('[providers.one');
  });

  it("allows explicit whole inline-table replacement", () => {
    const result = applyDocumentPatch("toml", 'editor = { command = "vim" } # editor\n', [{ op: "set", path: ["editor"], value: { command: "nano", args: ["--wait"] } }]);
    expect(result.content).toBe('editor = { command = "nano", args = ["--wait"] } # editor\n');
  });

  it.each(['theme = "a"\ntheme = "b"\n', 'theme = "unterminated', '[editor\ncommand = "vim"'])('rejects invalid or duplicate TOML before changing it: %s', (source) => {
    expectPatchError(() => applyDocumentPatch("toml", source, [{ op: "set", path: ["theme"], value: "light" }]), "INVALID_DOCUMENT");
  });
});

describe("applyDocumentPatch JSON", () => {
  it("preserves unknown top-level fields, unsafe integer literals, whitespace and CRLF", () => {
    const source = '{\r\n\t"future": 9007199254740993,\r\n\t"mcpServers": {"a": {"enabled": true, "future": 3}}\r\n}\r\n';
    const result = applyDocumentPatch("json", source, [{ op: "set", path: ["mcpServers", "a", "enabled"], value: false }]);
    expect(result.content).toBe(source.replace('"enabled": true', '"enabled": false'));
  });

  it("keeps equal values in their original spelling", () => {
    const source = '{ "label" : "\\u0061", "n": 1e0 }';
    expect(applyDocumentPatch("json", source, [{ op: "set", path: ["label"], value: "a" }, { op: "set", path: ["n"], value: 1 }]))
      .toEqual({ content: source, changed: false });
  });

  it("retains the semantics of negative zero in explicitly set values", () => {
    const result = applyDocumentPatch("json", '{"values":[]}', [{ op: "set", path: ["values"], value: [-0, { n: -0 }] }]);
    expect(result.content).toBe('{"values":[-0,{"n":-0}]}');
    expect(Object.is(JSON.parse(result.content).values[0], -0)).toBe(true);
  });

  it.each([
    ["first", '{"middle":2,"last":3}'],
    ["middle", '{"first":1,"last":3}'],
    ["last", '{"first":1,"middle":2}'],
  ])("deletes the %s member with only the required comma", (key, expected) => {
    expect(applyDocumentPatch("json", '{"first":1,"middle":2,"last":3}', [{ op: "delete", path: [key] }]).content).toBe(expected);
  });

  it("deletes the only member without removing surrounding whitespace", () => {
    expect(applyDocumentPatch("json", '{\n  "only": {"a":1}\n}\n', [{ op: "delete", path: ["only"] }]).content).toBe('{\n  \n}\n');
  });

  it("inserts missing nested objects without touching siblings", () => {
    const source = '{"mcpServers":{},"future":1}';
    const result = applyDocumentPatch("json", source, [{ op: "set", path: ["mcpServers", "a", "command"], value: "test" }]);
    expect(result.content).toBe('{"mcpServers":{"a": {"command":"test"}},"future":1}');
  });

  it("uses the existing newline and indentation for a new member", () => {
    const source = '{\r\n\t"future": 1\r\n}\r\n';
    expect(applyDocumentPatch("json", source, [{ op: "set", path: ["enabled"], value: true }]).content)
      .toBe('{\r\n\t"future": 1,\r\n\t"enabled": true\r\n}\r\n');
  });

  it("handles escaped string values and keys containing literal dots", () => {
    const source = '{"a.b":{"quote\\\"key": "braces } ] \\\" #"},"future":true}';
    const result = applyDocumentPatch("json", source, [{ op: "set", path: ["a.b", 'quote"key'], value: "new" }]);
    expect(JSON.parse(result.content)).toEqual({ "a.b": { 'quote"key': "new" }, future: true });
    expect(result.content.endsWith(',"future":true}')).toBe(true);
  });

  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"a":1,"a":2}}', '{"array":[{"a":1,"a":2}]}'])
    ("rejects duplicate decoded JSON keys anywhere in the document: %s", (source) => {
      expectPatchError(() => applyDocumentPatch("json", source, [{ op: "set", path: ["enabled"], value: true }]), "INVALID_DOCUMENT");
    });

  it.each(["", " \t\r\n\n"])('initializes a blank JSON document only when an edit changes it: %j', (source) => {
    expect(applyDocumentPatch("json", source, [])).toEqual({ content: source, changed: false });
    expect(applyDocumentPatch("json", source, [{ op: "delete", path: ["mcpServers", "missing"] }])).toEqual({ content: source, changed: false });
    const result = applyDocumentPatch("json", source, [{ op: "set", path: ["mcpServers", "demo"], value: { command: "demo" } }]);
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ mcpServers: { demo: { command: "demo" } } });
    expect(result.content.startsWith(source)).toBe(true);
  });

  it.each(["{", "[]", "null", '{"a":1,}'])('rejects invalid/nonobject existing JSON: %s', (source) => {
    expectPatchError(() => applyDocumentPatch("json", source, []), "INVALID_DOCUMENT");
  });

  it("treats prototype names as own keys without polluting prototypes", () => {
    const source = '{"__proto__":{"enabled":false},"constructor":{}}';
    const result = applyDocumentPatch("json", source, [
      { op: "set", path: ["__proto__", "enabled"], value: true },
      { op: "set", path: ["constructor", "prototype", "patched"], value: true },
      { op: "set", path: ["toString"], value: "literal" },
    ]);
    expect(JSON.parse(result.content)).toEqual(JSON.parse('{"__proto__":{"enabled":true},"constructor":{"prototype":{"patched":true}},"toString":"literal"}'));
    expect(Object.prototype).not.toHaveProperty("patched");
  });
});

describe("applyDocumentPatch shared guards", () => {
  it.each(["toml", "json"] as const)("does not create a missing %s resource for a no-op", (format) => {
    expect(applyDocumentPatch(format, null, [])).toEqual({ content: "", changed: false });
    expect(applyDocumentPatch(format, null, [{ op: "delete", path: ["a", "b"] }])).toEqual({ content: "", changed: false });
    expect(applyDocumentPatch(format, null, [{ op: "set", path: ["enabled"], value: true }]).changed).toBe(true);
  });

  it.each(["toml", "json"] as const)("rejects repeated and ancestor paths in %s batches", (format) => {
    expectPatchError(() => applyDocumentPatch(format, null, [{ op: "set", path: ["a"], value: 1 }, { op: "delete", path: ["a"] }]), "AMBIGUOUS_EDIT");
    expectPatchError(() => applyDocumentPatch(format, null, [{ op: "set", path: ["a"], value: {} }, { op: "set", path: ["a", "b"], value: 1 }]), "AMBIGUOUS_EDIT");
  });

  it.each([undefined, NaN, Infinity, 9007199254740992, 1n, () => 1, Symbol("a"), new Date()])("rejects unrepresentable set values %s", (value) => {
    expectPatchError(() => applyDocumentPatch("json", null, [{ op: "set", path: ["a"], value }]), "UNREPRESENTABLE_VALUE");
  });

  it("rejects cyclic values, sparse arrays and accessor properties", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, new Array(2), { get bad() { throw new Error("Must not execute"); } }]) {
      expectPatchError(() => applyDocumentPatch("json", null, [{ op: "set", path: ["a"], value }]), "UNREPRESENTABLE_VALUE");
    }
  });

  it("does not execute array getters or drop named array properties", () => {
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("Must not execute"); } });
    const named = Object.assign([1], { extra: true });
    const symbol = Object.assign([1], { [Symbol("extra")]: true });
    for (const value of [accessor, named, symbol]) {
      expectPatchError(() => applyDocumentPatch("json", null, [{ op: "set", path: ["a"], value }]), "UNREPRESENTABLE_VALUE");
    }
  });

  it("never calls custom toJSON serialization hooks", () => {
    let called = false;
    const value = { enabled: true };
    Object.defineProperty(value, "toJSON", { value() { called = true; throw new Error("Must not execute"); } });
    const result = applyDocumentPatch("json", null, [{ op: "set", path: ["a"], value }]);
    expect(JSON.parse(result.content)).toEqual({ a: { enabled: true } });
    expect(called).toBe(false);
  });

  it("rejects TOML null and array-index paths in both formats", () => {
    expectPatchError(() => applyDocumentPatch("toml", null, [{ op: "set", path: ["a"], value: null }]), "UNREPRESENTABLE_VALUE");
    expectPatchError(() => applyDocumentPatch("toml", 'a = ["x"]\n', [{ op: "set", path: ["a", "0"], value: "y" }]), "UNSUPPORTED_STRUCTURE");
    expectPatchError(() => applyDocumentPatch("json", '{"a":["x"]}', [{ op: "set", path: ["a", "0"], value: "y" }]), "UNSUPPORTED_STRUCTURE");
  });

  it("rejects malformed edit inputs and does not disclose document values in diagnostics", () => {
    expectPatchError(() => applyDocumentPatch("json", null, [{ op: "set", path: [], value: true }]), "INVALID_EDIT");
    expectPatchError(() => applyDocumentPatch("json", null, [{ op: "rename", path: ["a"] } as unknown as DocumentEdit]), "INVALID_EDIT");
    try { applyDocumentPatch("toml", 'token = "secret-token', []); }
    catch (error) { expect(String(error)).not.toContain("secret-token"); }
  });
});
