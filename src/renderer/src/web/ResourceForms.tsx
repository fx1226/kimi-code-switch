import { useId, useState } from "react";

export type ResourceKind = "provider" | "model" | "mcp";

export interface ResourceFormProps {
  kind: ResourceKind;
  name: string;
  value: Record<string, unknown>;
  onNameChange: (name: string) => void;
  onChange: (value: Record<string, unknown>) => void;
  locale: string;
  disabled?: boolean;
  existing?: boolean;
}

const text = {
  "en-US": {
    name: "Name",
    type: "Provider type",
    endpoint: "Base URL",
    key: "API key",
    provider: "Provider",
    model: "Model ID",
    context: "Context size",
    capabilities: "Capabilities",
    transport: "Transport",
    command: "Command",
    args: "Arguments",
    env: "Environment",
    headers: "Headers",
    enabled: "Enabled",
    show: "Show and edit",
    hide: "Hide",
    json: "Enter JSON; object values and array entries must be strings.",
    keyHelp:
      "Use the native API key or configure the env mapping. Environment variables are not resolved by this form.",
    envHelp: "Preserve Kimi Code's native environment mapping; values are not read from your system.",
    transportHelp: "Changing transport preserves fields from the other transport in this draft.",
    required: "Required.",
    url: "Enter an absolute http:// or https:// URL.",
    positive: "Enter a positive whole number.",
    object: "Enter a JSON object containing only string values.",
    array: "Enter a JSON array containing only strings.",
    boolean: "Must be true or false.",
    unsupported: "Unsupported transport.",
    string: "Must be text.",
  },
  "zh-CN": {
    name: "名称",
    type: "服务商类型",
    endpoint: "基础 URL",
    key: "API 密钥",
    provider: "服务商",
    model: "模型 ID",
    context: "上下文大小",
    capabilities: "模型能力",
    transport: "传输方式",
    command: "命令",
    args: "参数",
    env: "环境变量",
    headers: "请求头",
    enabled: "启用",
    show: "显示并编辑",
    hide: "隐藏",
    json: "填写 JSON；对象的值和数组的元素必须为字符串。",
    keyHelp: "填写原生 API 密钥，或配置 env 映射；此表单不会展开环境变量。",
    envHelp: "沿用 Kimi Code 的原生环境变量映射，不读取系统变量值。",
    transportHelp: "切换传输方式时，草稿会保留另一种方式的字段。",
    required: "此项必填。",
    url: "请填写完整的 http:// 或 https:// URL。",
    positive: "请填写正整数。",
    object: "请填写值均为字符串的 JSON 对象。",
    array: "请填写元素均为字符串的 JSON 数组。",
    boolean: "必须为 true 或 false。",
    unsupported: "不支持此传输方式。",
    string: "必须为文本。",
  },
  "zh-TW": {
    name: "名稱",
    type: "供應商類型",
    endpoint: "基礎 URL",
    key: "API 金鑰",
    provider: "供應商",
    model: "模型 ID",
    context: "上下文大小",
    capabilities: "模型能力",
    transport: "傳輸方式",
    command: "命令",
    args: "參數",
    env: "環境變數",
    headers: "請求標頭",
    enabled: "啟用",
    show: "顯示並編輯",
    hide: "隱藏",
    json: "填寫 JSON；物件的值及陣列的元素必須為字串。",
    keyHelp: "填寫原生 API 金鑰，或設定 env 對應；此表單不會展開環境變數。",
    envHelp: "沿用 Kimi Code 的原生環境變數對應，不讀取系統變數值。",
    transportHelp: "切換傳輸方式時，草稿會保留另一種方式的欄位。",
    required: "此欄必填。",
    url: "請填寫完整的 http:// 或 https:// URL。",
    positive: "請填寫正整數。",
    object: "請填寫值皆為字串的 JSON 物件。",
    array: "請填寫元素皆為字串的 JSON 陣列。",
    boolean: "必須為 true 或 false。",
    unsupported: "不支援此傳輸方式。",
    string: "必須為文字。",
  },
  "ja-JP": {
    name: "名前",
    type: "プロバイダーの種類",
    endpoint: "ベース URL",
    key: "API キー",
    provider: "プロバイダー",
    model: "モデル ID",
    context: "コンテキストサイズ",
    capabilities: "モデルの機能",
    transport: "接続方式",
    command: "コマンド",
    args: "引数",
    env: "環境変数",
    headers: "ヘッダー",
    enabled: "有効",
    show: "表示して編集",
    hide: "隠す",
    json: "JSON を入力してください。オブジェクトの値と配列の要素は文字列です。",
    keyHelp: "ネイティブの API キーまたは env マッピングを設定します。このフォームは環境変数を展開しません。",
    envHelp: "Kimi Code のネイティブ環境変数マッピングを保持します。システムの値は読み取りません。",
    transportHelp: "接続方式を変更しても、他の方式のフィールドは下書きに保持されます。",
    required: "必須です。",
    url: "http:// または https:// の完全な URL を入力してください。",
    positive: "正の整数を入力してください。",
    object: "文字列値のみを含む JSON オブジェクトを入力してください。",
    array: "文字列のみを含む JSON 配列を入力してください。",
    boolean: "true または false にしてください。",
    unsupported: "未対応の接続方式です。",
    string: "文字列にしてください。",
  },
  "de-DE": {
    name: "Name",
    type: "Anbietertyp",
    endpoint: "Basis-URL",
    key: "API-Schlüssel",
    provider: "Anbieter",
    model: "Modell-ID",
    context: "Kontextgröße",
    capabilities: "Modellfunktionen",
    transport: "Transport",
    command: "Befehl",
    args: "Argumente",
    env: "Umgebungsvariablen",
    headers: "Header",
    enabled: "Aktiviert",
    show: "Anzeigen und bearbeiten",
    hide: "Ausblenden",
    json: "JSON eingeben; Objektwerte und Array-Einträge müssen Zeichenfolgen sein.",
    keyHelp:
      "Nativen API-Schlüssel oder env-Zuordnung verwenden. Dieses Formular löst keine Umgebungsvariablen auf.",
    envHelp: "Die native Umgebungszuordnung von Kimi Code bleibt erhalten. Systemwerte werden nicht gelesen.",
    transportHelp: "Beim Wechsel bleiben die Felder des anderen Transports im Entwurf erhalten.",
    required: "Erforderlich.",
    url: "Eine vollständige http://- oder https://-URL eingeben.",
    positive: "Eine positive ganze Zahl eingeben.",
    object: "Ein JSON-Objekt nur mit Zeichenfolgenwerten eingeben.",
    array: "Ein JSON-Array nur mit Zeichenfolgen eingeben.",
    boolean: "Muss true oder false sein.",
    unsupported: "Nicht unterstützter Transport.",
    string: "Muss Text sein.",
  },
  "es-ES": {
    name: "Nombre",
    type: "Tipo de proveedor",
    endpoint: "URL base",
    key: "Clave API",
    provider: "Proveedor",
    model: "ID del modelo",
    context: "Tamaño del contexto",
    capabilities: "Capacidades",
    transport: "Transporte",
    command: "Comando",
    args: "Argumentos",
    env: "Variables de entorno",
    headers: "Cabeceras",
    enabled: "Activado",
    show: "Mostrar y editar",
    hide: "Ocultar",
    json: "Introduce JSON; los valores del objeto y elementos del array deben ser cadenas.",
    keyHelp: "Usa la clave API nativa o configura env. Este formulario no resuelve variables de entorno.",
    envHelp: "Conserva el mapeo nativo de Kimi Code; no se leen los valores del sistema.",
    transportHelp: "Al cambiar de transporte, se conservan los campos del otro transporte en el borrador.",
    required: "Obligatorio.",
    url: "Introduce una URL completa http:// o https://.",
    positive: "Introduce un número entero positivo.",
    object: "Introduce un objeto JSON cuyos valores sean cadenas.",
    array: "Introduce un array JSON que solo contenga cadenas.",
    boolean: "Debe ser true o false.",
    unsupported: "Transporte no compatible.",
    string: "Debe ser texto.",
  },
};

type Copy = (typeof text)["en-US"];
type IssueCode = "required" | "url" | "positive" | "object" | "array" | "boolean" | "unsupported" | "string";
interface Issue {
  field: string;
  code: IssueCode;
}

function isStringRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function transportOf(value: Record<string, unknown>): unknown {
  if (Object.hasOwn(value, "transport")) return value.transport;
  if (typeof value.command === "string") return "stdio";
  if (typeof value.url === "string") return "http";
  return undefined;
}

function issuesFor(kind: ResourceKind, name: string, value: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const required = (field: string, entry: unknown): void => {
    if (typeof entry !== "string" || !entry.trim()) issues.push({ field, code: "required" });
  };
  const strings = (field: string, shape: "object" | "array"): void => {
    if (value[field] === undefined) return;
    const valid =
      shape === "object"
        ? isStringRecord(value[field])
        : Array.isArray(value[field]) &&
          (value[field] as unknown[]).every((entry) => typeof entry === "string");
    if (!valid) issues.push({ field, code: shape });
  };
  const url = (field: string, mandatory: boolean): void => {
    const entry = value[field];
    if (entry === undefined || entry === "") {
      if (mandatory) issues.push({ field, code: "required" });
      return;
    }
    try {
      const parsed = new URL(typeof entry === "string" ? entry : "");
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      issues.push({ field, code: "url" });
    }
  };
  required("name", name);
  if (kind === "provider") {
    required("type", value.type);
    url("base_url", false);
    if (value.api_key !== undefined && typeof value.api_key !== "string")
      issues.push({ field: "api_key", code: "string" });
    strings("env", "object");
  } else if (kind === "model") {
    required("provider", value.provider);
    required("model", value.model);
    if (
      value.max_context_size !== undefined &&
      (typeof value.max_context_size !== "number" ||
        !Number.isSafeInteger(value.max_context_size) ||
        value.max_context_size < 1)
    ) {
      issues.push({ field: "max_context_size", code: "positive" });
    }
    strings("capabilities", "array");
  } else {
    const transport = transportOf(value);
    if (typeof transport !== "string" || !["stdio", "http", "sse"].includes(transport))
      issues.push({ field: "transport", code: "unsupported" });
    if (transport === "stdio") {
      required("command", value.command);
      strings("args", "array");
      strings("env", "object");
    } else if (transport === "http" || transport === "sse") {
      url("url", true);
      strings("headers", "object");
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean")
      issues.push({ field: "enabled", code: "boolean" });
  }
  return issues;
}

/** Local form validation only. The native document service remains authoritative. */
export function validateResource(kind: ResourceKind, name: string, value: Record<string, unknown>): string[] {
  return issuesFor(kind, name, value).map(({ field, code }) => `${field}: ${text["en-US"][code]}`);
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  help?: string;
}

function Feedback({ id, error, help }: Pick<FieldProps, "id" | "error" | "help">): JSX.Element {
  return (
    <>
      {help && (
        <p className="w-help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="w-validation" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function describedBy({ id, help, error }: FieldProps): string | undefined {
  return [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
}

function TextField(
  props: FieldProps & {
    value: unknown;
    onChange: (value: string) => void;
    disabled?: boolean;
    secret?: boolean;
    numeric?: boolean;
    copy: Copy;
  },
): JSX.Element {
  const [visible, setVisible] = useState(false);
  return (
    <div className="w-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        className="w-input"
        id={props.id}
        aria-label={props.label}
        type={props.secret && !visible ? "password" : "text"}
        inputMode={props.numeric ? "numeric" : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={typeof props.value === "string" || typeof props.value === "number" ? props.value : ""}
        disabled={props.disabled}
        aria-invalid={Boolean(props.error)}
        aria-describedby={describedBy(props)}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.secret && (
        <button
          className="w-button w-button-quiet"
          type="button"
          disabled={props.disabled}
          aria-controls={props.id}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? props.copy.hide : props.copy.show} · {props.label}
        </button>
      )}
      <Feedback {...props} />
    </div>
  );
}

function JsonField(
  props: FieldProps & {
    value: unknown;
    fallback: object;
    onChange: (value: unknown) => void;
    disabled?: boolean;
    secret?: boolean;
    copy: Copy;
  },
): JSX.Element {
  const [visible, setVisible] = useState(!props.secret);
  const serialized =
    typeof props.value === "string" ? props.value : JSON.stringify(props.value ?? props.fallback, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [lastValue, setLastValue] = useState(props.value);
  if (lastValue !== props.value) {
    setLastValue(props.value);
    setDraft(serialized);
  }
  return (
    <div className="w-field">
      {visible ? <label htmlFor={props.id}>{props.label}</label> : <span>{props.label}</span>}
      {props.secret && (
        <button
          className="w-button w-button-quiet"
          type="button"
          disabled={props.disabled}
          aria-expanded={visible}
          aria-controls={props.id}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? props.copy.hide : props.copy.show} · {props.label}
        </button>
      )}
      {visible && (
        <textarea
          className="w-input"
          id={props.id}
          aria-label={props.label}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          value={draft}
          disabled={props.disabled}
          aria-invalid={Boolean(props.error)}
          aria-describedby={describedBy(props)}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            let parsed: unknown;
            try {
              parsed = JSON.parse(next);
            } catch {
              parsed = next;
            }
            setLastValue(parsed);
            props.onChange(parsed);
          }}
        />
      )}
      <Feedback {...props} />
    </div>
  );
}

export function ResourceForm(props: ResourceFormProps): JSX.Element {
  const id = useId();
  const copy = text[props.locale as keyof typeof text] ?? text["en-US"];
  const issues = issuesFor(props.kind, props.name, props.value);
  const field = (key: string, label: string, help?: string): FieldProps => ({
    id: `${id}-${key}`,
    label,
    help,
    error:
      issues
        .filter((issue) => issue.field === key)
        .map((issue) => copy[issue.code])
        .join(" ") || undefined,
  });
  const change = (key: string, value: unknown): void => props.onChange({ ...props.value, [key]: value });
  const input = (key: string, label: string, help?: string): JSX.Element => (
    <TextField
      key={`${props.kind}-${props.name}-${key}`}
      {...field(key, `${label} (${key})`, help)}
      value={props.value[key]}
      disabled={props.disabled}
      copy={copy}
      secret={key === "api_key"}
      numeric={key === "max_context_size"}
      onChange={(value) => change(key, key === "max_context_size" && value.trim() ? Number(value) : value)}
    />
  );
  const json = (
    key: string,
    label: string,
    fallback: object,
    secret = false,
    help = copy.json,
  ): JSX.Element => (
    <JsonField
      key={`${props.kind}-${props.name}-${key}`}
      {...field(key, `${label} (${key})`, help)}
      value={props.value[key]}
      fallback={fallback}
      secret={secret}
      copy={copy}
      disabled={props.disabled}
      onChange={(value) => change(key, value)}
    />
  );
  const transport = String(transportOf(props.value) ?? "");
  const transportField = field("transport", `${copy.transport} (transport)`, copy.transportHelp);
  return (
    <div className="w-field-grid">
      <TextField
        {...field("name", copy.name)}
        value={props.name}
        copy={copy}
        disabled={props.disabled || props.existing}
        onChange={props.onNameChange}
      />
      {props.kind === "provider" && (
        <>
          {input("type", copy.type)}
          {input("base_url", copy.endpoint)}
          {input("api_key", copy.key, copy.keyHelp)}
          {json("env", copy.env, {}, true, copy.envHelp)}
        </>
      )}
      {props.kind === "model" && (
        <>
          {input("provider", copy.provider)}
          {input("model", copy.model)}
          {input("max_context_size", copy.context)}
          {json("capabilities", copy.capabilities, [])}
        </>
      )}
      {props.kind === "mcp" && (
        <>
          <div className="w-field">
            <label htmlFor={transportField.id}>{transportField.label}</label>
            <select
              className="w-input"
              id={transportField.id}
              aria-label={transportField.label}
              value={transport}
              disabled={props.disabled}
              aria-invalid={Boolean(transportField.error)}
              aria-describedby={describedBy(transportField)}
              onChange={(event) => {
                change("transport", event.target.value);
              }}
            >
              {["stdio", "http", "sse"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
              {transportField.error && <option value={transport}>{transport}</option>}
            </select>
            <Feedback {...transportField} />
          </div>
          <div className="w-field">
            <label htmlFor={`${id}-enabled`}>
              <input
                id={`${id}-enabled`}
                type="checkbox"
                checked={props.value.enabled !== false}
                disabled={props.disabled}
                aria-invalid={issues.some((issue) => issue.field === "enabled")}
                aria-describedby={
                  issues.some((issue) => issue.field === "enabled") ? `${id}-enabled-error` : undefined
                }
                onChange={(event) => change("enabled", event.target.checked)}
              />{" "}
              {copy.enabled} (enabled)
            </label>
            <Feedback {...field("enabled", copy.enabled)} />
          </div>
          {transport === "stdio" ? (
            <>
              {input("command", copy.command)}
              {json("args", copy.args, [])}
              {json("env", copy.env, {}, true)}
            </>
          ) : (
            <>
              {input("url", "URL")}
              {json("headers", copy.headers, {}, true)}
            </>
          )}
        </>
      )}
    </div>
  );
}
