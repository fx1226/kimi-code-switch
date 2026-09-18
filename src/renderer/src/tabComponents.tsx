import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Boxes, Check, ChevronDown, ChevronUp, Copy, Eye, EyeOff, FileText, FolderOpen, LoaderCircle,
  MoonStar, PenSquare, Play, Puzzle, RefreshCw, Sparkles, Wrench, X,
} from "lucide-react";

import { createDefaultPanelSettings } from "@shared/configStore";
import { normalizeEntryName } from "@shared/nameRules";
import type { SkillsScanReport } from "@shared/skillsStore";
import type {
  AppState,
  AppearanceMode, AppearanceTheme, ConfigDriftEntry, Locale,
  McpServerConfig, McpTransport, ModelPricing, PermissionMode, Profile, ProfileConnectivityTestResult, UiFontSize,
  OfficialAccount,
} from "@shared/types";
import type { McpToolInfo } from "./tauri/cli";
import { resolveModelPricing } from "@shared/pricing";

import { getApi } from "./appHelpers";
import {
  labelForLocale, MODEL_CAPABILITY_OPTIONS, PERMISSION_MODE_OPTIONS,
  PROVIDER_TYPE_OPTIONS, THINKING_EFFORT_OPTIONS,
} from "./appOptions";
import { DialogShell } from "./dialogs";
import { parseEndpointUrl } from "./endpointUtils";
import { t, translateError } from "./i18n";
import { isDesktopRuntime } from "./runtime";
import {
  ActionFooter, CompactSelect, Field, KeyValueListField, MultiSelectField,
  ReadOnlyField, SelectField, Toggle,
} from "./formControls";

export function createCopyName(sourceName: string, existing: Record<string, unknown>): string {
  return createLocalizedCopyName(sourceName, existing, "Copy");
}

export function createLocalizedCopyName(sourceName: string, existing: Record<string, unknown>, copySuffix: string): string {
  const baseName = `${sourceName} ${copySuffix}`;
  if (!existing[baseName]) {
    return baseName;
  }
  let index = 2;
  while (existing[`${baseName}${index}`]) {
    index += 1;
  }
  return `${baseName}${index}`;
}

export function createDefaultMcpServer(): McpServerConfig {
  return {
    enabled: true,
    transport: "streamable-http",
    url: "",
    headers: {},
    command: "",
    args: [],
    env: {},
  };
}

export function switchMcpTransport(server: McpServerConfig, transport: McpTransport): McpServerConfig {
  if (transport === server.transport) {
    return server;
  }
  return {
    enabled: server.enabled,
    transport,
    url: "",
    headers: {},
    command: "",
    args: [],
    env: {},
    extra: server.extra,
  };
}

export function parseListLines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatListLines(value: string[]): string {
  return value.join("\n");
}

export function isRemoteMcpTransport(transport: McpTransport): boolean {
  return transport !== "stdio";
}

export function parseRecordLines(value: string): Record<string, string> {
  const pairs = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.includes("=") ? line.indexOf("=") : line.indexOf(":");
      if (separatorIndex === -1) {
        return null;
      }
      const key = line.slice(0, separatorIndex).trim();
      const entryValue = line.slice(separatorIndex + 1).trim();
      if (!key) {
        return null;
      }
      return [key, entryValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
  return Object.fromEntries(pairs);
}

export function formatRecordLines(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, entryValue]) => `${key}=${entryValue}`)
    .join("\n");
}

function hasValidRecordLines(value: string): boolean {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => {
      const separatorIndex = line.includes("=") ? line.indexOf("=") : line.indexOf(":");
      return separatorIndex > 0 && Boolean(line.slice(0, separatorIndex).trim());
    });
}

function LineCodeField(props: {
  label: string;
  hint: string;
  fieldKey: string;
  resetKey: string;
  value: string;
  placeholder: string;
  invalidMessage: string;
  rows?: number;
  onValidChange: (value: string) => boolean;
  onValidityChange: (fieldKey: string, isValid: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  const [isInvalid, setIsInvalid] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const lineCount = Math.max(1, draft.split("\n").length);

  useEffect(() => {
    setDraft(props.value);
    setIsInvalid(false);
    setScrollTop(0);
    props.onValidityChange(props.fieldKey, true);
  }, [props.resetKey]);

  return (
    <label className={isInvalid ? "field mcp-code-field is-invalid" : "field mcp-code-field"}>
      <span>{props.label}</span>
      <small>{props.hint}</small>
      <div className="mcp-line-editor">
        <div className="mcp-line-numbers" aria-hidden="true">
          <div style={{ transform: `translateY(-${scrollTop}px)` }}>
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index}>{index + 1}</span>
            ))}
          </div>
        </div>
        <textarea
          rows={props.rows ?? 4}
          spellCheck={false}
          value={draft}
          placeholder={props.placeholder}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onChange={(event) => {
            const nextValue = event.target.value;
            setDraft(nextValue);
            const isValid = props.onValidChange(nextValue);
            setIsInvalid(!isValid);
            props.onValidityChange(props.fieldKey, isValid);
          }}
        />
      </div>
      {isInvalid ? <em role="alert">{props.invalidMessage}</em> : null}
    </label>
  );
}

function formatJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type McpToolArgValues = Record<string, string | boolean>;

type McpToolArgumentField = {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enumValues?: string[];
  defaultValue?: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractMcpToolArgumentFields(inputSchema: unknown): McpToolArgumentField[] {
  const schema = readRecord(inputSchema);
  const properties = readRecord(schema?.properties);
  if (!properties) return [];
  const required = Array.isArray(schema?.required)
    ? new Set(schema.required.filter((item): item is string => typeof item === "string"))
    : new Set<string>();

  return Object.entries(properties).map(([name, value]) => {
    const property = readRecord(value) ?? {};
    const typeValue = property.type;
    const type = Array.isArray(typeValue)
      ? typeValue.filter((item): item is string => typeof item === "string").join(" | ")
      : typeof typeValue === "string"
        ? typeValue
        : "string";
    const enumValues = Array.isArray(property.enum)
      ? property.enum.map((item) => String(item))
      : undefined;
    return {
      name,
      type,
      description: typeof property.description === "string" ? property.description : "",
      required: required.has(name),
      enumValues,
      defaultValue: property.default,
    };
  });
}

function defaultValueForMcpField(field: McpToolArgumentField): string | boolean {
  if (typeof field.defaultValue === "boolean") return field.defaultValue;
  if (field.defaultValue !== undefined && typeof field.defaultValue !== "object") return String(field.defaultValue);
  if (field.type.includes("boolean")) return false;
  if (field.type.includes("object")) return "{}";
  if (field.type.includes("array")) return "[]";
  return "";
}

function buildMcpToolArguments(fields: McpToolArgumentField[], values: McpToolArgValues): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === "" || value === false && !field.required) continue;
    if (field.type.includes("boolean")) {
      args[field.name] = Boolean(value);
      continue;
    }
    if (field.type.includes("number") || field.type.includes("integer")) {
      args[field.name] = Number(value);
      continue;
    }
    if (field.type.includes("object") || field.type.includes("array")) {
      args[field.name] = JSON.parse(String(value));
      continue;
    }
    args[field.name] = String(value);
  }
  return args;
}

function stringifyMcpToolArguments(fields: McpToolArgumentField[], values: McpToolArgValues): string {
  return formatJsonPreview(buildMcpToolArguments(fields, values));
}

const MCP_TOOL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_TOOL_CACHE_PREFIX = "kimi-code-switch:mcp-tools:";

type McpToolCacheEntry = {
  cachedAt: number;
  tools: McpToolInfo[];
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildMcpToolCacheKey(serverName: string, server: McpServerConfig): string {
  const identity = server.transport === "stdio"
    ? {
        name: serverName,
        transport: server.transport,
        command: server.command,
        args: server.args,
      }
    : {
        name: serverName,
        transport: server.transport,
        url: server.url,
      };
  return `${MCP_TOOL_CACHE_PREFIX}${stableStringify(identity)}`;
}

function readMcpToolCache(cacheKey: string): McpToolInfo[] | null {
  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<McpToolCacheEntry>;
    if (!Array.isArray(parsed.tools) || typeof parsed.cachedAt !== "number") return null;
    if (Date.now() - parsed.cachedAt > MCP_TOOL_CACHE_TTL_MS) {
      window.localStorage.removeItem(cacheKey);
      return null;
    }
    return parsed.tools;
  } catch {
    return null;
  }
}

function writeMcpToolCache(cacheKey: string, tools: McpToolInfo[]): void {
  try {
    const entry: McpToolCacheEntry = {
      cachedAt: Date.now(),
      tools,
    };
    window.localStorage.setItem(cacheKey, JSON.stringify(entry));
  } catch {
    // Cache failures should not block MCP tool parsing.
  }
}

function McpToolWorkbench(props: {
  locale: Locale;
  serverName: string;
  server: McpServerConfig;
}): JSX.Element {
  const requestSeqRef = useRef(0);
  const cacheKey = buildMcpToolCacheKey(props.serverName, props.server);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState("");
  const [argValues, setArgValues] = useState<McpToolArgValues>({});
  const [result, setResult] = useState("");
  const [resultJson, setResultJson] = useState("");
  const [isResultCollapsed, setIsResultCollapsed] = useState(false);
  const [isResultCopied, setIsResultCopied] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [isUsingCachedTools, setIsUsingCachedTools] = useState(false);

  useEffect(() => {
    setTools([]);
    setSelectedTool("");
    setArgValues({});
    setResult("");
    setResultJson("");
    setIsResultCollapsed(false);
    setIsResultCopied(false);
    setIsParsing(false);
    setIsCalling(false);
    setIsUsingCachedTools(false);
    requestSeqRef.current += 1;
    const cachedTools = readMcpToolCache(cacheKey);
    if (cachedTools) {
      setTools(cachedTools);
      setSelectedTool(cachedTools[0]?.name ?? "");
      setIsUsingCachedTools(true);
    }
  }, [cacheKey, props.serverName, props.server.transport]);

  const selectedToolInfo = tools.find((tool) => tool.name === selectedTool);
  const argumentFields = extractMcpToolArgumentFields(selectedToolInfo?.inputSchema);

  useEffect(() => {
    const fields = extractMcpToolArgumentFields(selectedToolInfo?.inputSchema);
    setArgValues(Object.fromEntries(fields.map((field) => [field.name, defaultValueForMcpField(field)])));
    setResultJson("");
    setIsResultCollapsed(false);
    setIsResultCopied(false);
    setResult("");
  }, [selectedTool, selectedToolInfo?.inputSchema]);

  const parseTools = async (): Promise<void> => {
    const api = getApi();
    if (!api?.listMcpServerTools) {
      setResult(t(props.locale, "mcpRuntimeOutdated"));
      return;
    }
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setIsParsing(true);
    try {
      const response = await api.listMcpServerTools(props.serverName, props.server);
      if (requestSeqRef.current !== requestSeq) return;
      setTools(response.tools);
      writeMcpToolCache(cacheKey, response.tools);
      setIsUsingCachedTools(false);
      setSelectedTool((current) => current && response.tools.some((tool) => tool.name === current)
        ? current
        : response.tools[0]?.name ?? "");
      setResult(response.tools.length ? "" : t(props.locale, "mcpToolNoTools"));
      setResultJson("");
    } catch (error) {
      if (requestSeqRef.current !== requestSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      setResult(translateError(props.locale, message));
    } finally {
      if (requestSeqRef.current === requestSeq) {
        setIsParsing(false);
      }
    }
  };

  const callTool = async (): Promise<void> => {
    const api = getApi();
    if (!api?.callMcpServerTool) {
      setResult(t(props.locale, "mcpRuntimeOutdated"));
      return;
    }
    if (!selectedTool) {
      setResult(t(props.locale, "mcpToolSelectRequired"));
      return;
    }
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setIsCalling(true);
    try {
      const argsJson = stringifyMcpToolArguments(argumentFields, argValues);
      const response = await api.callMcpServerTool(props.serverName, selectedTool, argsJson, props.server);
      if (requestSeqRef.current !== requestSeq) return;
      setResultJson(formatJsonPreview(response.result));
      setIsResultCollapsed(false);
      setIsResultCopied(false);
      setResult("");
    } catch (error) {
      if (requestSeqRef.current !== requestSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      setResult(translateError(props.locale, message));
      setResultJson("");
    } finally {
      if (requestSeqRef.current === requestSeq) {
        setIsCalling(false);
      }
    }
  };

  const copyResult = (): void => {
    if (!resultJson) return;
    void navigator.clipboard?.writeText(resultJson).then(() => {
      setIsResultCopied(true);
      window.setTimeout(() => setIsResultCopied(false), 1400);
    }).catch(() => setIsResultCopied(false));
  };

  return (
    <section className="mcp-tool-workbench" aria-label={t(props.locale, "mcpToolWorkbenchTitle")}>
      <div className="mcp-tool-workbench-head">
        <div>
          <div className="mcp-tool-workbench-title">
            <Wrench size={15} />
            <span>{t(props.locale, "mcpToolWorkbenchTitle")}</span>
          </div>
          <p>{t(props.locale, "mcpToolWorkbenchHint")}</p>
        </div>
        <button
          className={isParsing ? "action-button compact is-loading" : "action-button compact"}
          type="button"
          disabled={isParsing || isCalling}
          onClick={() => void parseTools()}
        >
          {isParsing ? <LoaderCircle size={15} className="button-spinner" /> : <RefreshCw size={15} />}
          <span>{isParsing
            ? t(props.locale, "mcpToolParsing")
            : t(props.locale, isUsingCachedTools ? "mcpToolReparse" : "mcpToolParse")}</span>
        </button>
      </div>
      <div className="mcp-tool-grid">
        <label className="field mcp-tool-select">
          <span>{t(props.locale, "mcpToolSelect")}</span>
          <CompactSelect
            ariaLabel={t(props.locale, "mcpToolSelect")}
            value={selectedTool}
            disabled={!tools.length}
            options={tools.length
              ? tools.map((tool) => ({ value: tool.name, label: tool.name }))
              : [{ value: "", label: t(props.locale, "mcpToolEmpty") }]}
            onChange={setSelectedTool}
          />
          <small>{selectedToolInfo?.description || t(props.locale, "mcpToolDescriptionFallback")}</small>
        </label>
        <div className="mcp-tool-args-panel">
          <div className="mcp-tool-panel-title">{t(props.locale, "mcpToolArguments")}</div>
          {argumentFields.length ? (
            <div className="mcp-tool-arg-grid">
              {argumentFields.map((field) => (
                <label key={field.name} className="mcp-tool-arg-field">
                  <span>
                    <strong>{field.name}</strong>
                    <em>{field.required ? t(props.locale, "required") : t(props.locale, "optional")}</em>
                    <code>{field.type}</code>
                  </span>
                  {field.enumValues?.length ? (
                    <CompactSelect
                      ariaLabel={field.name}
                      value={String(argValues[field.name] ?? "")}
                      options={[
                        { value: "", label: t(props.locale, "selectPlaceholder") },
                        ...field.enumValues.map((item) => ({ value: item, label: item })),
                      ]}
                      onChange={(value) => setArgValues((current) => ({ ...current, [field.name]: value }))}
                    />
                  ) : field.type.includes("boolean") ? (
                    <Toggle
                      checked={Boolean(argValues[field.name])}
                      onChange={(checked) => setArgValues((current) => ({ ...current, [field.name]: checked }))}
                    />
                  ) : field.type.includes("object") || field.type.includes("array") ? (
                    <textarea
                      rows={3}
                      spellCheck={false}
                      value={String(argValues[field.name] ?? "")}
                      onChange={(event) => setArgValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    />
                  ) : (
                    <input
                      inputMode={field.type.includes("number") || field.type.includes("integer") ? "decimal" : "text"}
                      value={String(argValues[field.name] ?? "")}
                      onChange={(event) => setArgValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    />
                  )}
                  {field.description ? <small>{field.description}</small> : null}
                </label>
              ))}
            </div>
          ) : (
            <div className="mcp-tool-empty-args">{selectedTool ? t(props.locale, "mcpToolNoArguments") : t(props.locale, "mcpToolEmpty")}</div>
          )}
        </div>
      </div>
      {selectedToolInfo?.inputSchema ? (
        <details className="mcp-tool-schema">
          <summary>{t(props.locale, "mcpToolSchema")}</summary>
          <pre>{formatJsonPreview(selectedToolInfo.inputSchema)}</pre>
        </details>
      ) : null}
      <div className="mcp-tool-actions">
        <button
          className={isCalling ? "action-button compact is-loading" : "action-button compact"}
          type="button"
          disabled={isParsing || isCalling || !selectedTool}
          onClick={() => void callTool()}
        >
          {isCalling ? <LoaderCircle size={15} className="button-spinner" /> : <Play size={15} />}
          <span>{isCalling ? t(props.locale, "mcpToolTesting") : t(props.locale, "mcpToolTest")}</span>
        </button>
      </div>
      {result ? (
        <pre className="mcp-tool-result">{result}</pre>
      ) : null}
      {resultJson ? (
        <div className={isResultCollapsed ? "mcp-tool-result-view is-collapsed" : "mcp-tool-result-view"}>
          <div className="mcp-tool-result-toolbar">
            <div className="mcp-tool-panel-title">{t(props.locale, "mcpToolResult")}</div>
            <div>
              <button
                className="mcp-tool-result-icon-button"
                type="button"
                aria-label={isResultCopied ? t(props.locale, "copied") : t(props.locale, "copyContent")}
                title={isResultCopied ? t(props.locale, "copied") : t(props.locale, "copyContent")}
                onClick={copyResult}
              >
                {isResultCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                className="mcp-tool-result-icon-button"
                type="button"
                aria-label={isResultCollapsed ? t(props.locale, "expand") : t(props.locale, "collapse")}
                title={isResultCollapsed ? t(props.locale, "expand") : t(props.locale, "collapse")}
                onClick={() => setIsResultCollapsed((current) => !current)}
              >
                {isResultCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              </button>
            </div>
          </div>
          {isResultCollapsed ? null : (
            <textarea className="mcp-tool-result-json" readOnly spellCheck={false} rows={10} value={resultJson} />
          )}
        </div>
      ) : null}
    </section>
  );
}

export function McpTransportRadioGroup(props: {
  locale: Locale;
  value: McpTransport;
  readOnly: boolean;
  onChange: (value: McpTransport) => void;
}): JSX.Element {
  const transportValue = props.value === "stdio" ? "stdio" : "streamable-http";
  const options: Array<{ value: McpTransport; label: string; description: string }> = [
    {
      value: "stdio",
      label: "stdio",
      description: t(props.locale, "mcpTransportStdioDescription"),
    },
    {
      value: "streamable-http",
      label: "http",
      description: t(props.locale, "mcpTransportHttpDescription"),
    },
  ];
  const selectOptionAt = (index: number): void => {
    if (props.readOnly) return;
    const next = options[index];
    if (next) props.onChange(next.value);
  };
  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (props.readOnly) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % options.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index + options.length - 1) % options.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectOptionAt(nextIndex);
    window.requestAnimationFrame(() => {
      document.getElementById(`mcp-transport-${options[nextIndex!]?.value}`)?.focus();
    });
  };

  return (
    <fieldset className="mcp-transport-field">
      <legend id="mcp-transport-label">{t(props.locale, "mcpTransportType")}</legend>
      <div className="mcp-transport-options" role="radiogroup" aria-labelledby="mcp-transport-label">
        {options.map((option, index) => (
          <button
            key={option.value}
            id={`mcp-transport-${option.value}`}
            className={[
              "mcp-transport-option",
              transportValue === option.value ? "is-active" : "",
              props.readOnly ? "is-readonly" : "",
            ].filter(Boolean).join(" ")}
            type="button"
            role="radio"
            aria-checked={transportValue === option.value}
            tabIndex={transportValue === option.value ? 0 : -1}
            disabled={props.readOnly}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
            onClick={() => {
              if (!props.readOnly) {
                props.onChange(option.value);
              }
            }}
          >
            <span className="mcp-transport-radio-dot" aria-hidden="true" />
            <span className="mcp-transport-copy">
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          </button>
        ))}
      </div>
      {props.readOnly ? <p className="mcp-transport-readonly-hint">{t(props.locale, "mcpTransportReadonlyHint")}</p> : null}
    </fieldset>
  );
}

export function ProviderForm(props: {
  locale: Locale;
  name: string;
  nameEditable: boolean;
  value: {
    type: string;
    base_url: string;
    api_key: string;
    env?: Record<string, string>;
    custom_headers?: Record<string, string>;
  };
  onChange: (name: string, patch: { type?: string; base_url?: string; api_key?: string; env?: Record<string, string>; custom_headers?: Record<string, string> }) => void;
  onSave: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [endpointCheckState, setEndpointCheckState] = useState<"idle" | "checking" | "ok" | "failed">("idle");
  const [endpointCheckMessage, setEndpointCheckMessage] = useState("");
  const providerTypeOptions = ensureEnumOptions(
    PROVIDER_TYPE_OPTIONS.map((option) => ({
      value: option.value,
      label: labelForLocale(option.label, props.locale),
    })),
    props.value.type,
    props.locale,
  );
  const endpointValue = props.value.base_url.trim();
  const endpointUrl = endpointValue.length > 0 ? parseEndpointUrl(endpointValue) : null;
  const hasEndpointFormatError = endpointValue.length > 0 && endpointUrl === null;
  const endpointFeedbackId = `provider-endpoint-feedback-${props.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const updateEndpoint = (value: string): void => {
    props.onChange(props.name, { base_url: value });
    setEndpointCheckState("idle");
    setEndpointCheckMessage("");
  };

  const testEndpoint = async (): Promise<void> => {
    if (endpointUrl === null || endpointCheckState === "checking") return;
    const api = getApi();
    if (!api?.testEndpointReachability) {
      setEndpointCheckState("failed");
      setEndpointCheckMessage(t(props.locale, "endpointHealthUnavailable"));
      return;
    }
    setEndpointCheckState("checking");
    setEndpointCheckMessage("");
    try {
      const result = await api.testEndpointReachability(endpointUrl.toString());
      if (result.ok) {
        setEndpointCheckState("ok");
        setEndpointCheckMessage(t(props.locale, "endpointHealthOk").replace("{status}", String(result.status)));
      } else {
        setEndpointCheckState("failed");
        setEndpointCheckMessage(t(props.locale, "endpointHealthFail").replace("{message}", result.message));
      }
    } catch (err) {
      setEndpointCheckState("failed");
      setEndpointCheckMessage(
        t(props.locale, "endpointHealthFail").replace("{message}", err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const EndpointStatusIcon = endpointCheckState === "checking"
    ? LoaderCircle
    : endpointCheckState === "ok"
      ? Check
      : endpointCheckState === "failed"
        ? X
        : Play;

  return (
    <section className="glass-panel form-panel">
      <div className="section-title">{t(props.locale, "providerEditor")}</div>
      {props.nameEditable ? (
        <Field label={t(props.locale, "formName")} value={props.name} onChange={(value) => props.onChange(value, {})} />
      ) : (
        <ReadOnlyField label={t(props.locale, "formName")} value={props.name} />
      )}
      <SelectField
        label={t(props.locale, "formType")}
        value={props.value.type}
        onChange={(value) => props.onChange(props.name, { type: value })}
        options={providerTypeOptions}
        popoverClassName="field-select-popover-full"
      />
      <label className="field">
        <span>{t(props.locale, "formBaseUrl")}</span>
        <div className="endpoint-field-input">
          <input
            value={props.value.base_url}
            onChange={(event) => updateEndpoint(event.target.value)}
            aria-invalid={hasEndpointFormatError}
            aria-describedby={hasEndpointFormatError || endpointCheckState !== "idle" || endpointCheckMessage ? endpointFeedbackId : undefined}
          />
          <button
            className={`endpoint-health-button is-${endpointCheckState}`}
            type="button"
            onClick={() => void testEndpoint()}
            disabled={endpointUrl === null || endpointCheckState === "checking"}
            title={t(props.locale, endpointCheckState === "checking" ? "endpointHealthChecking" : "endpointHealthCheck")}
            aria-label={t(props.locale, endpointCheckState === "checking" ? "endpointHealthChecking" : "endpointHealthCheck")}
          >
            <EndpointStatusIcon size={16} className={endpointCheckState === "checking" ? "button-spinner" : undefined} />
          </button>
        </div>
        {hasEndpointFormatError ? (
          <span id={endpointFeedbackId} className="field-error">{t(props.locale, "endpointInvalidUrl")}</span>
        ) : endpointCheckState !== "idle" || endpointCheckMessage ? (
          <span id={endpointFeedbackId} className={`field-status is-${endpointCheckState}`}>
            {endpointCheckState === "checking" ? t(props.locale, "endpointHealthChecking") : endpointCheckMessage}
          </span>
        ) : null}
      </label>
      <SecretField
        label={t(props.locale, "formApiKey")}
        value={props.value.api_key}
        visible={isApiKeyVisible}
        onToggleVisible={() => setIsApiKeyVisible((current) => !current)}
        onChange={(value) => props.onChange(props.name, { api_key: value })}
        showLabel={t(props.locale, "showSecret")}
        hideLabel={t(props.locale, "hideSecret")}
      />
      <ProviderAdvancedSection locale={props.locale} name={props.name} value={props.value} onChange={props.onChange} />
      <ActionFooter
        onSave={() => {
          if (hasEndpointFormatError) {
            setEndpointCheckState("failed");
            setEndpointCheckMessage(t(props.locale, "endpointInvalidUrl"));
            return;
          }
          props.onSave();
        }}
        onDelete={props.onDelete}
        saveLabel={t(props.locale, "saveProvider")}
        deleteLabel={t(props.locale, "delete")}
      />
    </section>
  );
}

function ProviderAdvancedSection(props: {
  locale: Locale;
  name: string;
  value: { env?: Record<string, string>; custom_headers?: Record<string, string> };
  onChange: (name: string, patch: { env?: Record<string, string>; custom_headers?: Record<string, string> }) => void;
}): JSX.Element {
  const updateEnv = (next: Record<string, string>): void => {
    props.onChange(props.name, { env: next });
  };
  const updateHeaders = (next: Record<string, string>): void => {
    props.onChange(props.name, { custom_headers: next });
  };
  return (
    <AdvancedCollapse label={t(props.locale, "providerAdvanced")}>
      <KeyValueListField
        locale={props.locale}
        label={t(props.locale, "formEnv")}
        value={props.value.env ?? {}}
        addLabel={t(props.locale, "addEnv")}
        keyPlaceholder={t(props.locale, "variableNamePlaceholder")}
        valuePlaceholder={t(props.locale, "variableValuePlaceholder")}
        onChange={updateEnv}
      />
      <p className="form-hint">{t(props.locale, "providerEnvHint")}</p>
      <KeyValueListField
        locale={props.locale}
        label={t(props.locale, "formHeaders")}
        value={props.value.custom_headers ?? {}}
        addLabel={t(props.locale, "addHeader")}
        keyPlaceholder={t(props.locale, "headerNamePlaceholder")}
        valuePlaceholder={t(props.locale, "headerValuePlaceholder")}
        onChange={updateHeaders}
      />
      <p className="form-hint">{t(props.locale, "providerHeadersHint")}</p>
    </AdvancedCollapse>
  );
}

export function SecretField(props: {
  label: string;
  value: string;
  visible: boolean;
  onToggleVisible: () => void;
  onChange: (value: string) => void;
  showLabel?: string;
  hideLabel?: string;
}): JSX.Element {
  const Icon = props.visible ? EyeOff : Eye;
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className="secret-field">
        <input
          type={props.visible ? "text" : "password"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button
          className="secret-toggle"
          type="button"
          aria-label={props.visible ? (props.hideLabel ?? "Hide secret") : (props.showLabel ?? "Show secret")}
          onClick={props.onToggleVisible}
        >
          <Icon size={16} />
        </button>
      </div>
    </label>
  );
}

export function ModelForm(props: {
  locale: Locale;
  providers: string[];
  officialAccounts: OfficialAccount[];
  activeOfficialAccountId?: string;
  name: string;
  value: {
    provider: string;
    model: string;
    max_context_size: number;
    capabilities: string[];
    auth_mode?: "api-key" | "official-account";
    official_account_scope?: "global";
    pricing?: ModelPricing;
    max_output_size?: number;
    display_name?: string;
    support_efforts?: string[];
    default_effort?: string;
    reasoning_key?: string;
    adaptive_thinking?: boolean;
    overrides?: Record<string, unknown>;
  };
  onChange: (
    name: string,
    patch: Partial<{
      provider: string;
      model: string;
      max_context_size: number;
      capabilities: string[];
      auth_mode?: "api-key" | "official-account";
      official_account_scope?: "global";
      pricing?: ModelPricing;
      max_output_size?: number;
      display_name?: string;
      support_efforts?: string[];
      default_effort?: string;
      reasoning_key?: string;
      adaptive_thinking?: boolean;
      overrides?: Record<string, unknown>;
    }>,
  ) => void;
  onSave: () => void;
  onDelete: () => void;
}): JSX.Element {
  const capabilityOptions = ensureEnumOptions(
    MODEL_CAPABILITY_OPTIONS.map((option) => ({
      value: option.value,
      label: labelForLocale(option.label, props.locale),
    })),
    props.value.capabilities,
    props.locale,
  );

  const handlePricingChange = (field: keyof ModelPricing, raw: string): void => {
    props.onChange(props.name, {
      pricing: nextPricingFromInput(props.value.pricing, field, raw),
    });
  };
  const authMode = props.value.auth_mode ?? "api-key";
  const activeOfficialAccount = props.officialAccounts.find((account) => account.id === props.activeOfficialAccountId);

  return (
    <section className="glass-panel form-panel">
      <div className="section-title">{t(props.locale, "modelEditor")}</div>
      <ReadOnlyField label={t(props.locale, "formName")} value={props.name} />
      <SelectField
        label={t(props.locale, "modelAuthMode")}
        value={authMode}
        onChange={(value) => props.onChange(props.name, {
          auth_mode: value === "official-account" ? "official-account" : "api-key",
          official_account_scope: value === "official-account" ? "global" : undefined,
        })}
        options={[
          { value: "api-key", label: t(props.locale, "modelAuthModeApiKey") },
          { value: "official-account", label: t(props.locale, "modelAuthModeOfficialAccount") },
        ]}
      />
      {authMode === "official-account" ? (
        <div className="form-note">
          <strong>{t(props.locale, "modelOfficialAccountCurrent")}</strong>
          <span>{activeOfficialAccount?.display_name || t(props.locale, "modelOfficialAccountMissing")}</span>
        </div>
      ) : null}
      <SelectField
        label={t(props.locale, "formProvider")}
        value={props.value.provider}
        onChange={(value) => props.onChange(props.name, { provider: value })}
        options={props.providers.map((provider) => ({ value: provider, label: provider }))}
      />
      <Field
        label={t(props.locale, "formModel")}
        value={props.value.model}
        onChange={(value) => props.onChange(props.name, { model: normalizeEntryName(value) })}
      />
      <Field
        label={t(props.locale, "formContextSize")}
        value={String(props.value.max_context_size)}
        onChange={(value) => props.onChange(props.name, { max_context_size: Number(value) || 0 })}
      />
      <MultiSelectField
        label={t(props.locale, "formCapabilities")}
        value={props.value.capabilities}
        onChange={(value) => props.onChange(props.name, { capabilities: value })}
        options={capabilityOptions}
        emptyLabel={t(props.locale, "formCapabilitiesEmpty")}
        popoverClassName="field-select-popover-full"
      />
      <Field
        label={t(props.locale, "formDisplayName")}
        value={props.value.display_name || ""}
        onChange={(value) => props.onChange(props.name, { display_name: value || undefined })}
      />
      <Field
        label={t(props.locale, "formMaxOutputSize")}
        inputMode="numeric"
        value={props.value.max_output_size !== undefined ? String(props.value.max_output_size) : ""}
        onChange={(value) => props.onChange(props.name, { max_output_size: value ? Number(value) || undefined : undefined })}
      />
      <ModelAdvancedSection
        locale={props.locale}
        name={props.name}
        value={props.value}
        onChange={props.onChange}
      />
      <AdvancedCollapse label={t(props.locale, "costEstimate")}>
        <ModelPricingEditor
          locale={props.locale}
          model={props.value.model}
          pricing={props.value.pricing}
          onChange={handlePricingChange}
        />
      </AdvancedCollapse>
      <ActionFooter
        onSave={props.onSave}
        onDelete={props.onDelete}
        saveLabel={t(props.locale, "saveModel")}
        deleteLabel={t(props.locale, "delete")}
      />
    </section>
  );
}

function ModelAdvancedSection(props: {
  locale: Locale;
  name: string;
  value: {
    support_efforts?: string[];
    default_effort?: string;
    reasoning_key?: string;
    adaptive_thinking?: boolean;
    overrides?: Record<string, unknown>;
  };
  onChange: (
    name: string,
    patch: Partial<{
      support_efforts?: string[];
      default_effort?: string;
      reasoning_key?: string;
      adaptive_thinking?: boolean;
      overrides?: Record<string, unknown>;
    }>,
  ) => void;
}): JSX.Element {
  const effortOptions = THINKING_EFFORT_OPTIONS.map((option) => ({
    value: option.value,
    label: labelForLocale(option.label, props.locale),
  }));
  return (
    <AdvancedCollapse label={t(props.locale, "modelAdvanced")}>
      <MultiSelectField
        label={t(props.locale, "formSupportEfforts")}
        value={props.value.support_efforts ?? []}
        onChange={(value) => props.onChange(props.name, { support_efforts: value.length ? value : undefined })}
        options={effortOptions}
        emptyLabel={t(props.locale, "formSupportEffortsEmpty")}
        popoverClassName="field-select-popover-full"
      />
      <SelectField
        label={t(props.locale, "formDefaultEffort")}
        value={props.value.default_effort || ""}
        onChange={(value) => props.onChange(props.name, { default_effort: value || undefined })}
        options={[
          { value: "", label: t(props.locale, "formEffortDefault") },
          ...effortOptions,
        ]}
        popoverClassName="field-select-popover-full"
      />
      <Field
        label={t(props.locale, "formReasoningKey")}
        value={props.value.reasoning_key || ""}
        onChange={(value) => props.onChange(props.name, { reasoning_key: value || undefined })}
      />
      <Toggle
        label={t(props.locale, "formAdaptiveThinking")}
        checked={props.value.adaptive_thinking === true}
        onChange={(checked) => props.onChange(props.name, { adaptive_thinking: checked })}
      />
      <JsonAdvancedField
        label={t(props.locale, "formOverrides")}
        hint={t(props.locale, "modelOverridesHint")}
        locale={props.locale}
        value={props.value.overrides}
        placeholder={'{\n  "temperature": 1\n}'}
        onCommit={(next) => props.onChange(props.name, { overrides: next })}
      />
    </AdvancedCollapse>
  );
}

function AdvancedCollapse(props: { label: string; children: ReactNode }): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <details
      className="advanced-collapse"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronDown size={14} className={isOpen ? "advanced-collapse-icon is-open" : "advanced-collapse-icon"} />
        <span>{props.label}</span>
      </summary>
      <div className="advanced-collapse-body">{props.children}</div>
    </details>
  );
}

function JsonAdvancedField(props: {
  label: string;
  hint: string;
  locale: Locale;
  value?: Record<string, unknown>;
  placeholder?: string;
  onCommit: (next: Record<string, unknown> | undefined) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => props.value ? JSON.stringify(props.value, null, 2) : "");
  const serialized = props.value ? JSON.stringify(props.value, null, 2) : "";

  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  const parsed = ((): { ok: true; value: Record<string, unknown> } | { ok: false } => {
    const trimmed = draft.trim();
    if (!trimmed) {
      return { ok: true, value: {} };
    }
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false };
      }
      return { ok: true, value: value as Record<string, unknown> };
    } catch {
      return { ok: false };
    }
  })();

  return (
    <label className={parsed.ok ? "field json-field" : "field json-field is-invalid"}>
      <span>{props.label}</span>
      <small>{props.hint}</small>
      <textarea
        rows={5}
        value={draft}
        placeholder={props.placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (parsed.ok) {
            const hasEntries = Object.keys(parsed.value).length > 0;
            props.onCommit(hasEntries ? parsed.value : undefined);
          }
        }}
      />
      {!parsed.ok ? <span className="field-error">{t(props.locale, "jsonInvalid")}</span> : null}
    </label>
  );
}

const PRICING_FIELDS: ReadonlyArray<{ field: keyof ModelPricing; labelKey: string }> = [
  { field: "input_per_mtok", labelKey: "pricingInput" },
  { field: "output_per_mtok", labelKey: "pricingOutput" },
  { field: "cache_read_per_mtok", labelKey: "pricingCacheRead" },
  { field: "cache_creation_per_mtok", labelKey: "pricingCacheCreation" },
];

/**
 * Builds the next `pricing` value when a single per-1M-token rate input changes.
 * Empty / invalid input clears that field; when every field ends up empty the
 * whole `pricing` object is dropped (returns `undefined`) so the model falls
 * back to the built-in default table.
 */
export function nextPricingFromInput(
  current: ModelPricing | undefined,
  field: keyof ModelPricing,
  raw: string,
): ModelPricing | undefined {
  const trimmed = raw.trim();
  const parsed = trimmed === "" ? undefined : Number(trimmed);
  const value = parsed !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;

  const draft: Partial<ModelPricing> = {
    input_per_mtok: current?.input_per_mtok,
    output_per_mtok: current?.output_per_mtok,
    cache_read_per_mtok: current?.cache_read_per_mtok,
    cache_creation_per_mtok: current?.cache_creation_per_mtok,
  };
  if (value === undefined) {
    delete draft[field];
  } else {
    draft[field] = value;
  }

  const hasAny = Object.values(draft).some((v) => v !== undefined);
  if (!hasAny) return undefined;
  // ModelPricing requires input/output; default missing required rates to 0 so
  // the partial override is still a valid object until the user fills them in.
  return {
    input_per_mtok: draft.input_per_mtok ?? 0,
    output_per_mtok: draft.output_per_mtok ?? 0,
    ...(draft.cache_read_per_mtok !== undefined ? { cache_read_per_mtok: draft.cache_read_per_mtok } : {}),
    ...(draft.cache_creation_per_mtok !== undefined ? { cache_creation_per_mtok: draft.cache_creation_per_mtok } : {}),
  };
}

function ModelPricingEditor(props: {
  locale: Locale;
  model: string;
  pricing?: ModelPricing;
  onChange: (field: keyof ModelPricing, raw: string) => void;
}): JSX.Element {
  // Resolve the effective default (built-in table) so blank inputs can hint the
  // fallback rate the cost estimate will actually use.
  const defaults = resolveModelPricing({ model: props.model });
  return (
    <div className="model-pricing-editor">
      <div className="model-pricing-head">{t(props.locale, "pricingTitle")}</div>
      <div className="model-pricing-grid">
        {PRICING_FIELDS.map(({ field, labelKey }) => {
          const overridden = props.pricing?.[field];
          const fallback = defaults?.[field];
          const placeholder =
            fallback !== undefined
              ? formatMessage(t(props.locale, "pricingDefaultPlaceholder"), { value: fallback })
              : "";
          return (
            <label key={field} className="model-pricing-field">
              <span>{t(props.locale, labelKey)}</span>
              <div className="pricing-input">
                <span className="pricing-affix">$</span>
                <input
                  inputMode="decimal"
                  value={overridden !== undefined ? String(overridden) : ""}
                  placeholder={placeholder}
                  onChange={(event) => props.onChange(field, event.target.value)}
                />
                <span className="pricing-affix pricing-affix-suffix">/1M</span>
              </div>
            </label>
          );
        })}
      </div>
      <p className="model-pricing-hint">{t(props.locale, "pricingHint")}</p>
    </div>
  );
}

export function McpServerForm(props: {
  locale: Locale;
  name: string;
  nameEditable: boolean;
  value: McpServerConfig;
  isTesting: boolean;
  onRunAction: (action: "test" | "auth" | "reset-auth", name: string) => Promise<void>;
  onChange: (name: string, value: McpServerConfig) => void;
  onSave: () => void;
  onDelete: () => void;
}): JSX.Element {
  const isRemoteTransport = isRemoteMcpTransport(props.value.transport);
  const [invalidLineFields, setInvalidLineFields] = useState<Set<string>>(() => new Set());
  const extra = props.value.extra ?? {};

  const updateExtra = (key: string, value: unknown): void => {
    const next = { ...extra };
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    } else {
      next[key] = value;
    }
    props.onChange(props.name, {
      ...props.value,
      extra: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  useEffect(() => {
    setInvalidLineFields(new Set());
  }, [props.name, props.value.transport]);

  const updateLineFieldValidity = (fieldKey: string, isValid: boolean): void => {
    setInvalidLineFields((current) => {
      const next = new Set(current);
      if (isValid) {
        next.delete(fieldKey);
      } else {
        next.add(fieldKey);
      }
      return next;
    });
  };

  return (
    <section className="glass-panel form-panel mcp-wizard-panel">
      <div className="mcp-wizard-header">
        <div>
          <div className="section-title">{t(props.locale, "mcpEditor")}</div>
        </div>
      </div>
      <McpTransportRadioGroup
        locale={props.locale}
        value={props.value.transport}
        readOnly={!props.nameEditable}
        onChange={(next) => props.onChange(props.name, switchMcpTransport(props.value, next))}
      />
      {props.nameEditable ? (
        <Field label={t(props.locale, "mcpServerTitle")} value={props.name} onChange={(next) => props.onChange(next, { ...props.value })} />
      ) : (
        <ReadOnlyField label={t(props.locale, "mcpServerTitle")} value={props.name} />
      )}
      {props.value.transport === "sse" || /\/sse([/?#]|$)/.test(props.value.url.trim()) ? (
        <p className="form-hint form-hint-warning">{t(props.locale, "mcpSseUnsupportedHint")}</p>
      ) : null}
      {isRemoteTransport ? (
        <>
          <Field
            label={t(props.locale, "formUrl")}
            value={props.value.url}
            onChange={(next) => props.onChange(props.name, { ...props.value, url: next })}
          />
          <LineCodeField
            label={t(props.locale, "mcpHeadersOptional")}
            hint={t(props.locale, "mcpHeadersLineHint")}
            fieldKey="headers"
            resetKey={`${props.name}:${props.value.transport}:headers`}
            value={formatRecordLines(props.value.headers)}
            placeholder={t(props.locale, "mcpHeadersLinePlaceholder")}
            invalidMessage={t(props.locale, "mcpKeyValueLineInvalid")}
            rows={4}
            onValidityChange={updateLineFieldValidity}
            onValidChange={(next) => {
              if (!hasValidRecordLines(next)) {
                return false;
              }
              props.onChange(props.name, { ...props.value, headers: parseRecordLines(next) });
              return true;
            }}
          />
        </>
      ) : (
        <>
          <Field
            label={t(props.locale, "formCommand")}
            value={props.value.command}
            onChange={(next) => props.onChange(props.name, { ...props.value, command: next })}
          />
          <LineCodeField
            label={t(props.locale, "formArgs")}
            hint={t(props.locale, "mcpArgsLineHint")}
            fieldKey="args"
            resetKey={`${props.name}:${props.value.transport}:args`}
            value={formatListLines(props.value.args)}
            placeholder={t(props.locale, "mcpArgsLinePlaceholder")}
            invalidMessage={t(props.locale, "mcpLineListInvalid")}
            rows={4}
            onValidityChange={updateLineFieldValidity}
            onValidChange={(next) => {
              props.onChange(props.name, { ...props.value, args: parseListLines(next) });
              return true;
            }}
          />
          <LineCodeField
            label={t(props.locale, "formEnv")}
            hint={t(props.locale, "mcpEnvLineHint")}
            fieldKey="env"
            resetKey={`${props.name}:${props.value.transport}:env`}
            value={formatRecordLines(props.value.env)}
            placeholder={t(props.locale, "mcpEnvLinePlaceholder")}
            invalidMessage={t(props.locale, "mcpKeyValueLineInvalid")}
            rows={4}
            onValidityChange={updateLineFieldValidity}
            onValidChange={(next) => {
              if (!hasValidRecordLines(next)) {
                return false;
              }
              props.onChange(props.name, { ...props.value, env: parseRecordLines(next) });
              return true;
            }}
          />
        </>
      )}
      <AdvancedCollapse label={t(props.locale, "mcpAdvancedRuntimeTitle")}>
        <div className="settings-inline-fields">
          <Field
            label={t(props.locale, "mcpStartupTimeoutMs")}
            value={typeof extra.startupTimeoutMs === "number" ? String(extra.startupTimeoutMs) : ""}
            inputMode="numeric"
            onChange={(value) => {
              const parsed = Number.parseInt(value, 10);
              updateExtra("startupTimeoutMs", Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
            }}
          />
          <Field
            label={t(props.locale, "mcpToolTimeoutMs")}
            value={typeof extra.toolTimeoutMs === "number" ? String(extra.toolTimeoutMs) : ""}
            inputMode="numeric"
            onChange={(value) => {
              const parsed = Number.parseInt(value, 10);
              updateExtra("toolTimeoutMs", Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
            }}
          />
        </div>
        {isRemoteTransport ? (
          <>
            <Field
              label={t(props.locale, "mcpBearerTokenEnvVar")}
              value={typeof extra.bearerTokenEnvVar === "string" ? extra.bearerTokenEnvVar : ""}
              onChange={(value) => updateExtra("bearerTokenEnvVar", value.trim())}
            />
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={extra.auth === "oauth"}
                onChange={(event) => updateExtra("auth", event.target.checked ? "oauth" : undefined)}
              />
              <span>{t(props.locale, "mcpOauthRequired")}</span>
            </label>
          </>
        ) : (
          <Field
            label={t(props.locale, "mcpCwd")}
            value={typeof extra.cwd === "string" ? extra.cwd : ""}
            onChange={(value) => updateExtra("cwd", value.trim())}
          />
        )}
        <LineCodeField
          label={t(props.locale, "mcpEnabledTools")}
          hint={t(props.locale, "mcpToolsListHint")}
          fieldKey="enabledTools"
          resetKey={`${props.name}:${props.value.transport}:enabledTools`}
          value={formatListLines(Array.isArray(extra.enabledTools) ? extra.enabledTools.filter((item): item is string => typeof item === "string") : [])}
          placeholder={t(props.locale, "mcpToolsListPlaceholder")}
          invalidMessage={t(props.locale, "mcpLineListInvalid")}
          rows={3}
          onValidityChange={updateLineFieldValidity}
          onValidChange={(value) => {
            updateExtra("enabledTools", parseListLines(value));
            return true;
          }}
        />
        <LineCodeField
          label={t(props.locale, "mcpDisabledTools")}
          hint={t(props.locale, "mcpToolsListHint")}
          fieldKey="disabledTools"
          resetKey={`${props.name}:${props.value.transport}:disabledTools`}
          value={formatListLines(Array.isArray(extra.disabledTools) ? extra.disabledTools.filter((item): item is string => typeof item === "string") : [])}
          placeholder={t(props.locale, "mcpToolsListPlaceholder")}
          invalidMessage={t(props.locale, "mcpLineListInvalid")}
          rows={3}
          onValidityChange={updateLineFieldValidity}
          onValidChange={(value) => {
            updateExtra("disabledTools", parseListLines(value));
            return true;
          }}
        />
      </AdvancedCollapse>
      <AdvancedCollapse label={t(props.locale, "mcpToolWorkbenchTitle")}>
        <McpToolWorkbench key={props.name} locale={props.locale} serverName={props.name} server={props.value} />
      </AdvancedCollapse>
      <ActionFooter
        onSave={props.onSave}
        onDelete={props.onDelete}
        saveLabel={t(props.locale, "mcpApplyConfig")}
        deleteLabel={t(props.locale, "delete")}
        isSaveDisabled={invalidLineFields.size > 0}
      >
        {isRemoteTransport && extra.auth === "oauth" ? (
          <button
            className="action-button"
            type="button"
            disabled={props.isTesting}
            onClick={() => void props.onRunAction("auth", props.name)}
          >
            <span>{t(props.locale, "mcpOauthLogin")}</span>
          </button>
        ) : null}
        <button
          className={props.isTesting ? "action-button is-loading" : "action-button"}
          type="button"
          disabled={props.isTesting}
          onClick={() => void props.onRunAction("test", props.name)}
        >
          {props.isTesting ? <LoaderCircle size={16} className="button-spinner" /> : null}
          <span>{props.isTesting ? t(props.locale, "mcpTesting") : t(props.locale, "mcpTest")}</span>
        </button>
      </ActionFooter>
    </section>
  );
}

export function McpImportDialog(props: {
  locale: Locale;
  value: string;
  onChange: (value: string) => void;
  onImport: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <DialogShell
      backdropClassName="mcp-import-backdrop"
      dialogClassName="glass-panel form-panel mcp-import-dialog"
      ariaLabelledBy="mcp-import-title"
      onClose={props.onCancel}
    >
        <div className="mcp-import-header">
          <div>
            <div className="section-title" id="mcp-import-title">{t(props.locale, "importMcpJson")}</div>
            <p className="mcp-import-hint">{t(props.locale, "mcpImportHint")}</p>
          </div>
          <button className="action-button compact icon-only" type="button" aria-label={t(props.locale, "cancel")} onClick={props.onCancel}>
            <X size={16} />
          </button>
        </div>
        <label className="field">
          <span>{t(props.locale, "pasteMcpJson")}</span>
          <textarea
            className="mcp-import-textarea"
            rows={12}
            value={props.value}
            placeholder={t(props.locale, "mcpImportPlaceholder")}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </label>
        <ActionFooter
          onSave={props.onImport}
          onCancel={props.onCancel}
          saveLabel={t(props.locale, "mcpImportApply")}
          cancelLabel={t(props.locale, "mcpImportCancel")}
        />
    </DialogShell>
  );
}

export function McpJsonViewerDialog(props: {
  locale: Locale;
  value: string;
  onClose: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copyJson = (): void => {
    const writeClipboard = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(props.value)
      : Promise.reject(new Error("Clipboard API is unavailable."));
    void writeClipboard.then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {
      setCopied(false);
    });
  };

  return (
    <DialogShell
      backdropClassName="mcp-json-viewer-backdrop"
      dialogClassName="glass-panel form-panel mcp-import-dialog"
      ariaLabelledBy="mcp-json-viewer-title"
      onClose={props.onClose}
    >
        <div className="mcp-import-header">
          <div>
            <div className="section-title" id="mcp-json-viewer-title">{t(props.locale, "mcpJsonViewerTitle")}</div>
            <p className="mcp-import-hint">{t(props.locale, "mcpJsonViewerHint")}</p>
          </div>
          <div className="mcp-json-viewer-actions">
            <button
              className="action-button compact icon-only"
              type="button"
              aria-label={t(props.locale, "copyContent")}
              title={copied ? t(props.locale, "copied") : t(props.locale, "copyContent")}
              onClick={copyJson}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <button className="action-button compact icon-only" type="button" aria-label={t(props.locale, "close")} onClick={props.onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <label className="field">
          <span>{t(props.locale, "mcpJsonViewerContent")}</span>
          <textarea
            className="mcp-import-textarea mcp-json-viewer-textarea"
            readOnly
            rows={14}
            value={props.value}
          />
        </label>
        <div className="button-row">
          <button className="action-button" type="button" onClick={props.onClose}>
            <X size={16} />
            <span>{t(props.locale, "close")}</span>
          </button>
        </div>
    </DialogShell>
  );
}

export function ProfileForm(props: {
  locale: Locale;
  models: string[];
  name: string;
  nameEditable: boolean;
  value: Profile;
  isActive: boolean;
  isTesting: boolean;
  onChange: (name: string, value: Profile) => void;
  onSave: () => void;
  onTest: (modelName: string) => Promise<ProfileConnectivityTestResult>;
  onActivate: () => void;
  onClone: () => void;
  onDelete: () => void;
}): JSX.Element {
  const value = props.value;
  const [isTestDialogOpen, setIsTestDialogOpen] = useState(false);
  return (
    <section className="glass-panel form-panel">
      <div className="section-title">{t(props.locale, "profileEditor")}</div>
      {props.nameEditable ? (
        <Field label={t(props.locale, "profileFormUniqueId")} value={props.name} onChange={(next) => props.onChange(next, { ...value, name: next })} />
      ) : (
        <ReadOnlyField label={t(props.locale, "profileFormUniqueId")} value={props.name} />
      )}
      <Field label={t(props.locale, "profileFormDisplayName")} value={value.label} onChange={(next) => props.onChange(props.name, { ...value, label: next })} />
      <SelectField
        label={t(props.locale, "formDefaultModel")}
        value={value.default_model}
        onChange={(next) => props.onChange(props.name, { ...value, default_model: next })}
        options={props.models.map((model) => ({ value: model, label: model }))}
      />
      <SelectField
        label={t(props.locale, "formPermissionMode")}
        value={value.default_permission_mode || "manual"}
        onChange={(next) => props.onChange(props.name, { ...value, default_permission_mode: next as PermissionMode })}
        options={PERMISSION_MODE_OPTIONS.map((option) => ({ value: option.value, label: labelForLocale(option.label, props.locale) }))}
      />
      <Toggle label={t(props.locale, "formThinking")} checked={value.thinking_enabled !== false} onChange={(checked) => props.onChange(props.name, { ...value, thinking_enabled: checked })} />
      <AdvancedCollapse label={t(props.locale, "profileAdvanced")}>
        <SelectField
          label={t(props.locale, "formEffort")}
          value={value.thinking_effort || ""}
          onChange={(next) => props.onChange(props.name, { ...value, thinking_effort: next || undefined })}
          options={[{ value: "", label: t(props.locale, "formEffortDefault") }, ...THINKING_EFFORT_OPTIONS.map((option) => ({ value: option.value, label: labelForLocale(option.label, props.locale) }))]}
        />
        <Toggle label={t(props.locale, "formPlanMode")} checked={value.default_plan_mode} onChange={(checked) => props.onChange(props.name, { ...value, default_plan_mode: checked })} />
        <Toggle label={t(props.locale, "formMergeSkills")} checked={value.merge_all_available_skills} onChange={(checked) => props.onChange(props.name, { ...value, merge_all_available_skills: checked })} />
        <Field label={t(props.locale, "formTuiTheme")} value={value.tui_theme || ""} onChange={(next) => props.onChange(props.name, { ...value, tui_theme: next || undefined })} />
        <Field label={t(props.locale, "formTuiEditor")} value={value.tui_editor_command || ""} onChange={(next) => props.onChange(props.name, { ...value, tui_editor_command: next || undefined })} />
      </AdvancedCollapse>
      <ActionFooter
        onSave={props.onSave}
        onDelete={props.onDelete}
        saveLabel={t(props.locale, "saveProfile")}
        deleteLabel={t(props.locale, "delete")}
      >
        <button
          className={props.isTesting ? "action-button is-loading" : "action-button"}
          type="button"
          disabled={props.isTesting}
          onClick={() => setIsTestDialogOpen(true)}
        >
          {props.isTesting ? <LoaderCircle size={16} className="button-spinner" /> : null}
          <span>{props.isTesting ? t(props.locale, "profileTesting") : t(props.locale, "profileTest")}</span>
        </button>
        <button className={props.isActive ? "action-button action-button-primary" : "action-button"} onClick={props.onActivate}>{t(props.locale, "activate")}</button>
        <button className="action-button" onClick={props.onClone}>{t(props.locale, "clone")}</button>
      </ActionFooter>
      {isTestDialogOpen ? (
        <ProfileTestDialog
          locale={props.locale}
          profile={value}
          profileName={props.name}
          models={props.models}
          onTest={props.onTest}
          onClose={() => setIsTestDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}

function ProfileTestDialog(props: {
  locale: Locale;
  profile: Profile;
  profileName: string;
  models: string[];
  onTest: (modelName: string) => Promise<ProfileConnectivityTestResult>;
  onClose: () => void;
}): JSX.Element {
  const testModel = props.profile.default_model;
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<ProfileConnectivityTestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasStarted, setHasStarted] = useState(false);

  const runTest = async (modelName: string): Promise<void> => {
    setHasStarted(true);
    setIsTesting(true);
    setErrorMessage("");
    try {
      const nextResult = await props.onTest(modelName);
      setResult(nextResult);
    } catch (error) {
      setResult(null);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTesting(false);
    }
  };

  const providerType = result?.providerType || "apikey";
  const prompt = result?.prompt ?? "hi";
  const displayModel = result?.modelName ?? testModel;

  return (
    <DialogShell
      backdropClassName="profile-test-backdrop"
      dialogClassName="profile-test-dialog glass-panel"
      ariaLabelledBy="profile-test-title"
      closeOnBackdrop={!isTesting}
      onClose={props.onClose}
    >
        <div className="profile-test-header">
          <h3 id="profile-test-title">{t(props.locale, "profileTestDialogTitle")}</h3>
          <button className="profile-test-close" type="button" aria-label={t(props.locale, "close")} onClick={props.onClose}>
            <X size={24} />
          </button>
        </div>

        <div className="profile-test-body">
          <div className="profile-test-account-card">
            <div className="profile-test-play">
              <Play size={28} />
            </div>
            <div className="profile-test-account-copy">
              <strong>{props.profileName}</strong>
              <span><b>{providerType.toUpperCase()}</b>{t(props.locale, "profileTestAccountLabel")}</span>
            </div>
            <span className="profile-test-active">{t(props.locale, "active")}</span>
          </div>

          <ProfileTestConsole
            locale={props.locale}
            profileName={props.profileName}
            providerType={providerType}
            modelName={displayModel}
            prompt={prompt}
            result={result}
            errorMessage={errorMessage}
            isTesting={isTesting}
            hasStarted={hasStarted}
          />

        </div>

        <div className="profile-test-actions">
          <button className="action-button" type="button" onClick={props.onClose}>
            {t(props.locale, "close")}
          </button>
          <button
            className={isTesting ? "action-button action-button-primary is-loading" : "action-button action-button-primary"}
            type="button"
            disabled={isTesting}
            onClick={() => void runTest(testModel)}
          >
            {isTesting ? <LoaderCircle size={17} className="button-spinner" /> : <RefreshCw size={17} />}
            <span>{isTesting ? t(props.locale, "profileTesting") : hasStarted ? t(props.locale, "profileTestRetry") : t(props.locale, "profileTestStart")}</span>
          </button>
        </div>
    </DialogShell>
  );
}

function ProfileTestConsole(props: {
  locale: Locale;
  profileName: string;
  providerType: string;
  modelName: string;
  prompt: string;
  result: ProfileConnectivityTestResult | null;
  errorMessage: string;
  isTesting: boolean;
  hasStarted: boolean;
}): JSX.Element {
  const response = props.result?.stdout || props.result?.stderr || "";
  return (
    <div className="profile-test-console">
      {props.hasStarted ? (
        <p className="is-info">{formatMessage(t(props.locale, "profileTestStartAccount"), { name: props.profileName })}</p>
      ) : null}
      <p>{formatMessage(t(props.locale, "profileTestAccountType"), { type: props.providerType })}</p>
      <p className={props.errorMessage ? "is-danger" : props.result ? "is-success" : "is-muted"}>
        {props.errorMessage
          ? t(props.locale, "profileTestFailed")
          : props.result
            ? t(props.locale, "profileTestConnected")
            : t(props.locale, "profileTestStart")}
      </p>
      <p className="is-cyan">{formatMessage(t(props.locale, "profileTestUsingModel"), { model: props.modelName })}</p>
      <p>{formatMessage(t(props.locale, "profileTestSendingPrompt"), { prompt: props.prompt })}</p>
      <p className="is-warning">{t(props.locale, "profileTestResponse")}</p>
      {props.isTesting ? (
        <p className="is-muted">{t(props.locale, "profileTesting")}</p>
      ) : props.errorMessage ? (
        <pre className="is-danger">{props.errorMessage}</pre>
      ) : response ? (
        <pre className="is-output">{response}</pre>
      ) : null}
      <div className="profile-test-console-divider" />
      {!props.isTesting && props.hasStarted ? (
        <p className={props.errorMessage ? "is-danger profile-test-console-status" : "is-success profile-test-console-status"}>
          {props.errorMessage ? <X size={18} /> : <Check size={18} />}
          <span>{props.errorMessage ? t(props.locale, "profileTestFailed") : t(props.locale, "profileTestCompleted")}</span>
        </p>
      ) : null}
    </div>
  );
}

export function PathField(props: {
  locale: Locale;
  label: string;
  value: string;
  readOnly?: boolean;
  fileType?: "toml" | "json";
  pickerProperties?: Array<"openFile" | "openDirectory" | "createDirectory">;
  onView?: () => void;
  extraActions?: Array<{
    key: string;
    label: string;
    icon: JSX.Element;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
  }>;
  onChange: (value: string) => void;
}): JSX.Element {
  const pickFile = async (): Promise<void> => {
    if (props.readOnly) {
      return;
    }
    const api = getApi();
    if (!api) {
      return;
    }
    const result = await api.pickFile({
      title: props.label,
      properties: props.pickerProperties ?? ["openFile"],
      ...(props.pickerProperties?.includes("openFile") !== false
        ? { filters: [{ name: (props.fileType ?? "toml").toUpperCase(), extensions: [props.fileType ?? "toml"] }] }
        : {}),
    });
    if (!result.canceled && result.filePath) {
      props.onChange(result.filePath);
    }
  };

  return (
    <div className="field">
      <span>{props.label}</span>
      <div className="field-row">
        <input
          value={props.value}
          readOnly={props.readOnly}
          disabled={props.readOnly}
          className={props.readOnly ? "field-input-disabled" : undefined}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <div className="field-row-actions">
          {props.extraActions?.map((action) => (
            <button
              key={action.key}
              className={action.className ?? "action-button compact icon-only"}
              type="button"
              aria-label={action.label}
              title={action.label}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.icon}
            </button>
          ))}
          {props.onView ? (
            <button
              className="action-button compact icon-only"
              type="button"
              aria-label={t(props.locale, "view")}
              title={t(props.locale, "view")}
              onClick={props.onView}
            >
              <Eye size={16} />
            </button>
          ) : null}
          {/* 浏览器形态没有原生路径选择对话框，隐藏浏览按钮；输入框保留手输。 */}
          {!props.readOnly && isDesktopRuntime() ? (
            <button
              className="action-button compact icon-only"
              type="button"
              aria-label={t(props.locale, "browse")}
              title={t(props.locale, "browse")}
              onClick={() => void pickFile()}
            >
              <FolderOpen size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function createFallbackState(): AppState {
  // 面板设置必须来自单一默认值来源：手写字面量会在 PanelSettings 增删字段时静默漂移。
  const panelSettings = createDefaultPanelSettings();

  return {
    configPath: panelSettings.config_path,
    configTarget: "kimi-code",
    profilesPath: "",
    panelSettingsPath: "~/.kimi-code-switch-gui/app.db#panel_settings",
    mcpConfigPath: "~/.kimi-code/mcp.json",
    mainConfig: {
      default_model: "",
      default_plan_mode: false,
      default_permission_mode: "",
      merge_all_available_skills: true,
      hooks: [],
      models: {},
      providers: {},
      loop_control: {},
      background: {},
      notifications: {},
      services: {},
      mcp: {},
    },
    profiles: {},
    activeProfile: "",
    panelSettings,
    mcpConfig: {
      mcpServers: {},
    },
  };
}

export function ensureEnumOptions(
  options: Array<{ value: string; label: string }>,
  currentValue: string | string[],
  locale: Locale,
): Array<{ value: string; label: string }> {
  const values = Array.isArray(currentValue) ? currentValue : [currentValue];
  const merged = [...options];
  for (const value of values) {
    if (!value || merged.some((option) => option.value === value)) {
      continue;
    }
    merged.push({
      value,
      label: formatMessage(t(locale, "unknownValue"), { value }),
    });
  }
  return merged;
}

export function applyAppearanceMode(mode: AppearanceMode): void {
  if (typeof document === "undefined") {
    return;
  }
  const resolvedMode =
    mode === "auto"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
  document.documentElement.dataset.theme = resolvedMode;
}

export function applyAppearanceTheme(theme: AppearanceTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.appearanceTheme = theme;
}

export function applyUiFontSize(size: UiFontSize): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.style.removeProperty("font-size");
  document.documentElement.dataset.uiFontSize = size;
}

export function formatMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function DoctorDriftList(props: {
  locale: Locale;
  drift: ConfigDriftEntry[] | undefined;
}): JSX.Element | null {
  const drift = props.drift ?? [];
  if (!drift.length) {
    return null;
  }
  return (
    <div className="doctor-issues doctor-drift">
      <div className="doctor-issue info">
        <span>info</span>
        <div>
          <strong>{t(props.locale, "driftTitle")}</strong>
          {drift.map((entry) => (
            <p key={`${entry.file}.${entry.path}.${entry.key}`}>
              {formatMessage(t(props.locale, "driftUnknownField"), {
                file: entry.file,
                path: entry.path,
                key: entry.key,
              })}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

export function formatSkillPathLabel(
  path: SkillsScanReport["paths"][number],
  locale: Locale,
): string {
  return predictSkillLibrary(path.path, locale, path).label;
}

export function renderSkillPathLabel(
  path: SkillsScanReport["paths"][number],
  locale: Locale,
): JSX.Element {
  const prediction = predictSkillLibrary(path.path, locale, path);
  return (
    <span className="skill-path-label">
      <span className={`skill-path-icon ${prediction.className}`} aria-hidden="true">
        <prediction.icon size={14} />
      </span>
      <span className="skill-path-text">
        <span className="skill-path-copy">{prediction.label}</span>
        <span className="skill-path-sub">{path.path}</span>
      </span>
    </span>
  );
}

export function predictSkillLibrary(
  path: string,
  locale: Locale,
  entry?: Pick<SkillsScanReport["paths"][number], "group" | "pluginId">,
): { icon: typeof Sparkles; className: string; label: string } {
  if (entry?.group === "plugin") {
    return { icon: Puzzle, className: "is-generic", label: entry.pluginId || t(locale, "skillLibraryPlugin") };
  }
  const normalized = path.toLowerCase();
  // 注意顺序：/.kimi-code/ 必须先于 /.kimi/ 判断（前者不包含后者，但语义更具体）。
  if (normalized.includes("/.kimi-code/")) {
    return { icon: MoonStar, className: "is-kimi", label: t(locale, "skillLibraryKimiCode") };
  }
  if (normalized.includes("/.claude/")) {
    return { icon: Sparkles, className: "is-claude", label: t(locale, "skillLibraryClaude") };
  }
  if (normalized.includes("/.codex/")) {
    return { icon: Boxes, className: "is-codex", label: t(locale, "skillLibraryCodex") };
  }
  if (normalized.includes("/.kimi/")) {
    return { icon: MoonStar, className: "is-kimi", label: t(locale, "skillLibraryKimi") };
  }
  if (normalized.includes("/agents/")) {
    return { icon: PenSquare, className: "is-agents", label: t(locale, "skillLibraryAgents") };
  }
  if (path === "(managed by CLI package)") {
    return { icon: FileText, className: "is-generic", label: t(locale, "skillLibraryBuiltin") };
  }
  return { icon: FolderOpen, className: "is-generic", label: t(locale, "skillLibraryCustom") };
}
