import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceForm, validateResource, type ResourceFormProps } from "./ResourceForms";

afterEach(cleanup);

function renderForm(overrides: Partial<ResourceFormProps> = {}) {
  const onChange = vi.fn();
  const props: ResourceFormProps = {
    kind: "provider", name: "demo", value: { type: "openai", base_url: "https://api.example.test", api_key: "secret-key" },
    onNameChange: vi.fn(), onChange, locale: "en-US", ...overrides,
  };
  return { ...render(<ResourceForm {...props} />), onChange, props };
}

describe("ResourceForm", () => {
  it("masks API keys and keeps environment secrets out of displayed text until explicitly revealed", () => {
    const { getByLabelText, getByRole, queryByDisplayValue } = renderForm({
      value: { type: "openai", api_key: "secret-key", env: { API_KEY: "PRIVATE_VALUE" } },
    });
    const key = getByLabelText("API key (api_key)") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(queryByDisplayValue(/PRIVATE_VALUE/)).toBeNull();
    fireEvent.click(getByRole("button", { name: "Show and edit · API key (api_key)" }));
    expect(key.type).toBe("text");
    fireEvent.click(getByRole("button", { name: "Show and edit · Environment (env)" }));
    expect((getByLabelText("Environment (env)") as HTMLTextAreaElement).value).toContain("PRIVATE_VALUE");
    fireEvent.click(getByRole("button", { name: "Hide · Environment (env)" }));
    expect(queryByDisplayValue(/PRIVATE_VALUE/)).toBeNull();
  });

  it("keeps HTTP headers hidden until explicitly revealed", () => {
    const { getByRole, queryByDisplayValue, getByLabelText } = renderForm({
      kind: "mcp", value: { transport: "http", url: "https://mcp.example.test", headers: { Authorization: "Bearer private-token" } },
    });
    expect(queryByDisplayValue(/private-token/)).toBeNull();
    fireEvent.click(getByRole("button", { name: "Show and edit · Headers (headers)" }));
    expect((getByLabelText("Headers (headers)") as HTMLTextAreaElement).value).toContain("private-token");
  });

  it("merges an edit without dropping unknown native fields or credential references", () => {
    const source = {
      type: "future-provider", base_url: "https://old.example.test", api_key: "",
      oauth: { storage: "file", key: "credential-slot" }, extension: { future: [1, 2] },
    };
    const { getByLabelText, onChange } = renderForm({ value: source });
    fireEvent.change(getByLabelText("Base URL (base_url)"), { target: { value: "https://new.example.test" } });
    expect(onChange).toHaveBeenCalledWith({ ...source, base_url: "https://new.example.test" });
    expect(source.base_url).toBe("https://old.example.test");
  });

  it("switches the official MCP transport without changing unknown fields or inactive transport fields", () => {
    const source = {
      transport: "stdio", type: "stdio", command: "node", args: ["with space.mjs"], env: { TOKEN: "secret" },
      url: "https://mcp.example.test", headers: { "X-Extension": "header" }, future: { protocol: 3 },
    };
    const { getByLabelText, onChange } = renderForm({ kind: "mcp", value: source });
    fireEvent.change(getByLabelText("Transport (transport)"), { target: { value: "http" } });
    expect(onChange).toHaveBeenCalledWith({ ...source, transport: "http" });
    expect(source.transport).toBe("stdio");
  });

  it.each(["http", "sse"])("switches inferred stdio to %s while retaining its command and unknown type", (transport) => {
    const source = { command: "node", args: ["server.mjs"], type: "future-type", url: "https://mcp.example.test" };
    const { getByLabelText, queryByLabelText, onChange, rerender, props } = renderForm({ kind: "mcp", value: source });
    expect((getByLabelText("Transport (transport)") as HTMLSelectElement).value).toBe("stdio");
    expect(getByLabelText("Command (command)")).toBeDefined();
    expect(queryByLabelText("URL (url)")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(getByLabelText("Transport (transport)"), { target: { value: transport } });
    const next = onChange.mock.lastCall![0] as Record<string, unknown>;
    expect(next).toEqual({ ...source, transport });
    rerender(<ResourceForm {...props} value={next} />);
    expect((getByLabelText("Transport (transport)") as HTMLSelectElement).value).toBe(transport);
    expect(getByLabelText("URL (url)")).toBeDefined();
    expect(queryByLabelText("Command (command)")).toBeNull();
    expect(validateResource("mcp", "demo", next)).toEqual([]);
  });

  it("switches an inferred HTTP entry to stdio and requires the command without dropping its URL", () => {
    const source = { url: "https://mcp.example.test", type: "sse", headers: { "X-Extension": "keep" } };
    const { getByLabelText, queryByLabelText, onChange, rerender, props } = renderForm({ kind: "mcp", value: source });
    expect((getByLabelText("Transport (transport)") as HTMLSelectElement).value).toBe("http");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(getByLabelText("Transport (transport)"), { target: { value: "stdio" } });
    const next = onChange.mock.lastCall![0] as Record<string, unknown>;
    expect(next).toEqual({ ...source, transport: "stdio" });
    rerender(<ResourceForm {...props} value={next} />);
    expect(queryByLabelText("URL (url)")).toBeNull();
    expect(getByLabelText("Command (command)").getAttribute("aria-invalid")).toBe("true");
    expect(validateResource("mcp", "demo", next)).toEqual(["command: Required."]);
    fireEvent.change(getByLabelText("Command (command)"), { target: { value: "node" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...next, command: "node" });
    expect(validateResource("mcp", "demo", onChange.mock.lastCall![0])).toEqual([]);
  });

  it("shows explicit transport ahead of command inference and ignores unknown type metadata", () => {
    const source = { transport: "sse", type: "stdio", command: "node", url: "https://mcp.example.test" };
    const { getByLabelText, queryByLabelText, onChange } = renderForm({ kind: "mcp", value: source });
    expect((getByLabelText("Transport (transport)") as HTMLSelectElement).value).toBe("sse");
    expect(queryByLabelText("Command (command)")).toBeNull();
    expect(getByLabelText("URL (url)")).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers only official MCP transports and diagnoses an unsupported explicit transport", () => {
    const { getByLabelText } = renderForm({ kind: "mcp", value: { command: "node" } });
    const select = getByLabelText("Transport (transport)") as HTMLSelectElement;
    expect(Array.from(select.options, ({ value }) => value)).toEqual(["stdio", "http", "sse"]);
    expect(validateResource("mcp", "demo", { transport: "streamable-http", url: "https://mcp.example.test" })).toEqual([
      "transport: Unsupported transport.",
    ]);
  });

  it("retains invalid JSON in the draft and exposes it to validation instead of saving the previous value", () => {
    const source = { provider: "demo", model: "model-id", max_context_size: 32000, capabilities: ["thinking"], future: true };
    let current: Record<string, unknown> = source;
    function Harness(): JSX.Element {
      const [value, setValue] = useState<Record<string, unknown>>(source);
      current = value;
      return <ResourceForm kind="model" name="model" value={value} onChange={setValue} onNameChange={vi.fn()} locale="en-US" />;
    }
    const { getByLabelText } = render(<Harness />);
    const input = getByLabelText("Capabilities (capabilities)") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '["thinking",' } });
    expect(input.value).toBe('["thinking",');
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ").at(-1)!)).not.toBeNull();
    expect(validateResource("model", "model", current)).toEqual(["capabilities: Enter a JSON array containing only strings."]);
    fireEvent.change(input, { target: { value: '["thinking", "future_feature"]' } });
    expect(current.capabilities).toEqual(["thinking", "future_feature"]);
    expect(current.future).toBe(true);
    expect(validateResource("model", "model", current)).toEqual([]);
  });

  it("marks an invalid URL inline and does not leak its value into the error", () => {
    const { getByLabelText, getByRole } = renderForm({ value: { type: "openai", base_url: "invalid-secret-url" } });
    const input = getByLabelText("Base URL (base_url)");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getByRole("alert").textContent).toBe("Enter an absolute http:// or https:// URL.");
    expect(validateResource("provider", "demo", { type: "openai", base_url: "invalid-secret-url" }).join(" ")).not.toContain("invalid-secret-url");
  });

  it("locks existing names and disables all edits while applying", () => {
    const { getByLabelText, getAllByRole } = renderForm({ existing: true, disabled: true });
    expect((getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((getByLabelText("Base URL (base_url)") as HTMLInputElement).disabled).toBe(true);
    expect(getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it.each([
    ["zh-CN", "名称"], ["zh-TW", "名稱"], ["en-US", "Name"],
    ["ja-JP", "名前"], ["de-DE", "Name"], ["es-ES", "Nombre"],
  ])("provides field labels for %s", (locale, name) => {
    expect(renderForm({ locale }).getByLabelText(name)).toBeDefined();
  });
});

describe("validateResource", () => {
  it("allows provider OAuth/env authentication without forcing an API key or endpoint", () => {
    expect(validateResource("provider", "native", { type: "kimi", oauth: { storage: "file", key: "slot" } })).toEqual([]);
    expect(validateResource("provider", "native", { type: "openai", env: { api_key: "OPENAI_API_KEY" } })).toEqual([]);
  });

  it("checks native value types without imposing an enum on future provider types or capabilities", () => {
    expect(validateResource("model", "future", { provider: "native", model: "future", capabilities: ["future_feature"] })).toEqual([]);
    expect(validateResource("model", "broken", { provider: "", model: "", max_context_size: 1.5, capabilities: [false] })).toHaveLength(4);
    expect(validateResource("provider", "", { type: "", api_key: false, env: { API_KEY: 123 } })).toHaveLength(4);
  });

  it("requires the active MCP transport fields and validates arguments and string dictionaries", () => {
    expect(validateResource("mcp", "local", { transport: "stdio", command: "node", args: ["server with spaces.mjs"] })).toEqual([]);
    expect(validateResource("mcp", "remote", { transport: "sse", url: "https://mcp.example.test" })).toEqual([]);
    expect(validateResource("mcp", "local", { transport: "stdio", args: [1], env: { TOKEN: true }, enabled: "true" })).toHaveLength(4);
    expect(validateResource("mcp", "remote", { transport: "http", url: "file:///secret", headers: [] })).toHaveLength(2);
  });

  it("uses official MCP inference and validates only fields consumed by the selected transport", () => {
    expect(validateResource("mcp", "local", { type: "http", command: "", url: "https://mcp.example.test" })).toEqual(["command: Required."]);
    expect(validateResource("mcp", "remote", { type: "stdio", command: false, url: "https://mcp.example.test", args: [false], env: false })).toEqual([]);
    expect(validateResource("mcp", "local", { transport: "stdio", command: "node", headers: false, url: false })).toEqual([]);
    expect(validateResource("mcp", "unknown", { type: "stdio" })).toEqual(["transport: Unsupported transport."]);
  });

  it.each([null, undefined, "", ["stdio"]])("rejects explicit invalid MCP transport %s without falling back to command", (transport) => {
    expect(validateResource("mcp", "local", { transport, command: "node" })).toEqual(["transport: Unsupported transport."]);
  });
});
