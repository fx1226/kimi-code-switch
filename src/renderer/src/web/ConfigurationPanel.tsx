import { useEffect, useState } from "react";
import { Check, ChevronRight, FileText } from "lucide-react";
import type { Locale } from "@shared/types";
import type { ChangePlan, DocumentEdit, NativeResource, ResourceSnapshot } from "@shared/resourceProtocol";
import type { WebApi } from "@shared/webApi";
import { KIMI_EDITABLE_FIELDS, type KimiEditableField } from "@shared/kimiCompatibility";
import { record } from "./drafts";
import { msg } from "./messages";
import { Empty, Tabs } from "./ui";

const languageOrder: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"];
const labels: Record<string, readonly string[]> = {
  global: [
    "全局配置",
    "全域設定",
    "Global configuration",
    "グローバル設定",
    "Globale Konfiguration",
    "Configuración global",
  ],
  tui: [
    "终端界面",
    "終端介面",
    "Terminal interface",
    "ターミナル画面",
    "Terminaloberfläche",
    "Interfaz de terminal",
  ],
  project: [
    "项目配置",
    "專案設定",
    "Project configuration",
    "プロジェクト設定",
    "Projektkonfiguration",
    "Configuración del proyecto",
  ],
  unset: [
    "未设置，沿用官方默认",
    "未設定，沿用官方預設",
    "Not set; use Kimi defaults",
    "未設定：Kimi の既定値を使用",
    "Nicht festgelegt; Kimi-Standard verwenden",
    "Sin definir; usar valores de Kimi",
  ],
  yes: ["启用", "啟用", "Enabled", "有効", "Aktiviert", "Activado"],
  no: ["禁用", "停用", "Disabled", "無効", "Deaktiviert", "Desactivado"],
  nativeHelp: [
    "只提交你修改的字段。未设置的字段保留官方默认，其他内容保持原样。",
    "僅提交修改的欄位。未設定欄位保留官方預設，其餘內容維持原樣。",
    "Only edited fields are submitted. Unset fields keep Kimi defaults; other content is preserved.",
    "変更した項目のみ送信します。未設定の項目と他の内容は保持します。",
    "Nur bearbeitete Felder werden gesendet. Andere Inhalte bleiben erhalten.",
    "Solo se envían los campos editados. El resto no cambia.",
  ],
  noProject: [
    "此目标未设置工作目录。使用顶部目录设置选择项目后，即可查看项目文件。",
    "此目標未設定工作目錄。使用頂部目錄設定選擇專案後，即可查看專案檔案。",
    "This target has no working directory. Select a project in the directory settings above to view project files.",
    "作業ディレクトリが未設定です。上部のディレクトリ設定でプロジェクトを選択してください。",
    "Für dieses Ziel fehlt das Arbeitsverzeichnis. Wählen Sie oben in den Verzeichniseinstellungen ein Projekt.",
    "Este destino no tiene directorio de trabajo. Selecciona un proyecto en los ajustes del directorio de arriba.",
  ],
  onePerLine: [
    "每行一项",
    "每行一項",
    "One entry per line",
    "1 行に 1 項目",
    "Ein Eintrag pro Zeile",
    "Una entrada por línea",
  ],
  default_model: [
    "默认模型",
    "預設模型",
    "Default model",
    "既定のモデル",
    "Standardmodell",
    "Modelo predeterminado",
  ],
  default_permission_mode: [
    "权限模式",
    "權限模式",
    "Permission mode",
    "権限モード",
    "Berechtigungsmodus",
    "Modo de permisos",
  ],
  default_plan_mode: [
    "默认计划模式",
    "預設計畫模式",
    "Default plan mode",
    "既定の計画モード",
    "Standard-Planmodus",
    "Modo de planificación",
  ],
  "thinking.enabled": ["思考", "思考", "Thinking", "思考", "Denken", "Razonamiento"],
  "thinking.effort": [
    "思考强度",
    "思考強度",
    "Thinking effort",
    "思考の強度",
    "Denkaufwand",
    "Esfuerzo de razonamiento",
  ],
  merge_all_available_skills: [
    "合并全部可用技能",
    "合併所有可用技能",
    "Merge all available skills",
    "利用可能なスキルをすべて統合",
    "Alle Skills zusammenführen",
    "Combinar habilidades disponibles",
  ],
  extra_skill_dirs: [
    "附加技能目录",
    "額外技能目錄",
    "Additional skill directories",
    "追加スキルディレクトリ",
    "Zusätzliche Skill-Verzeichnisse",
    "Directorios adicionales de habilidades",
  ],
  telemetry: ["遥测", "遙測", "Telemetry", "テレメトリー", "Telemetrie", "Telemetría"],
  theme: [
    "终端主题",
    "終端主題",
    "Terminal theme",
    "ターミナルテーマ",
    "Terminaldesign",
    "Tema del terminal",
  ],
  render_latex: [
    "渲染 LaTeX",
    "呈現 LaTeX",
    "Render LaTeX",
    "LaTeX 表示",
    "LaTeX darstellen",
    "Mostrar LaTeX",
  ],
  disable_paste_burst: [
    "禁用连续粘贴检测",
    "停用連續貼上偵測",
    "Disable paste burst detection",
    "連続貼り付け検出を無効化",
    "Schnelleinfüge-Erkennung deaktivieren",
    "Desactivar detección de pegado rápido",
  ],
  cache_expiry_hint: [
    "缓存到期提示",
    "快取到期提示",
    "Cache expiry hint",
    "キャッシュ期限の通知",
    "Cache-Ablaufhinweis",
    "Aviso de caducidad de caché",
  ],
  disable_feedback_survey: [
    "禁用反馈问卷",
    "停用意見問卷",
    "Disable feedback survey",
    "フィードバックを無効化",
    "Feedback-Umfrage deaktivieren",
    "Desactivar encuesta",
  ],
  "editor.command": [
    "编辑器命令",
    "編輯器命令",
    "Editor command",
    "エディターコマンド",
    "Editor-Befehl",
    "Comando del editor",
  ],
  "notifications.enabled": ["通知", "通知", "Notifications", "通知", "Benachrichtigungen", "Notificaciones"],
  "notifications.notification_condition": [
    "通知条件",
    "通知條件",
    "Notification condition",
    "通知条件",
    "Benachrichtigungsbedingung",
    "Condición de notificación",
  ],
  "upgrade.auto_install": [
    "自动安装升级",
    "自動安裝升級",
    "Install upgrades automatically",
    "更新を自動インストール",
    "Aktualisierungen automatisch installieren",
    "Instalar actualizaciones automáticamente",
  ],
  "status_line.items": [
    "状态栏项目",
    "狀態列項目",
    "Status line items",
    "ステータス項目",
    "Statusleistenelemente",
    "Elementos de estado",
  ],
  "status_line.command": [
    "状态栏命令",
    "狀態列命令",
    "Status line command",
    "ステータスコマンド",
    "Statusleistenbefehl",
    "Comando de estado",
  ],
  "markdown.mermaid": [
    "Mermaid 图表",
    "Mermaid 圖表",
    "Mermaid diagrams",
    "Mermaid 図",
    "Mermaid-Diagramme",
    "Diagramas Mermaid",
  ],
  "workspace.additional_dir": [
    "附加工作目录",
    "額外工作目錄",
    "Additional working directories",
    "追加作業ディレクトリ",
    "Zusätzliche Arbeitsverzeichnisse",
    "Directorios de trabajo adicionales",
  ],
};
function text(locale: Locale, key: string): string {
  return labels[key]?.[languageOrder.indexOf(locale)] ?? key;
}
function readPath(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => record(value)[key], data);
}
type ConfigResource = "config" | "tui" | "agents" | "project-local";
interface DocumentDraft {
  fields: Record<string, unknown>;
  content?: string;
}

export function ConfigurationPanel({
  api,
  targetId,
  locale,
  snapshots,
  readOnly,
  onPlan,
  onError,
  onDirtyChange,
  onSource,
}: {
  api: WebApi;
  targetId: string;
  locale: Locale;
  snapshots: Partial<Record<NativeResource, ResourceSnapshot>>;
  readOnly: boolean;
  onPlan: (plan: ChangePlan, onCommitted: () => void) => void;
  onError: (error: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSource: (snapshot: ResourceSnapshot) => void;
}): JSX.Element {
  const [active, setActive] = useState<ConfigResource>("config");
  const [drafts, setDrafts] = useState<Partial<Record<ConfigResource, DocumentDraft>>>({});
  const [busy, setBusy] = useState(false);
  const snapshot = snapshots[active];
  const draft = drafts[active];
  const fields: readonly KimiEditableField[] =
    active === "config"
      ? KIMI_EDITABLE_FIELDS.config
      : active === "tui"
        ? KIMI_EDITABLE_FIELDS.tui
        : active === "project-local"
          ? KIMI_EDITABLE_FIELDS.project
          : [];
  const changed = (id: ConfigResource): boolean => {
    const saved = snapshots[id];
    const entry = drafts[id];
    if (!entry) return false;
    if (id === "agents") return entry.content !== undefined && entry.content !== (saved?.content ?? "");
    return Object.entries(entry.fields).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(readPath(saved?.data, key.split("."))),
    );
  };
  const anyDirty = (Object.keys(drafts) as ConfigResource[]).some(changed);
  useEffect(() => {
    onDirtyChange(anyDirty);
  }, [anyDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const dirty = changed(active);
  const blocked =
    readOnly || busy || !snapshot || snapshot.diagnostics.some((entry) => entry.severity === "error");
  const update = (key: string, value: unknown): void =>
    setDrafts((current) => ({
      ...current,
      [active]: { ...current[active], fields: { ...current[active]?.fields, [key]: value } },
    }));
  const plan = async (): Promise<void> => {
    if (!snapshot || blocked || !dirty) return;
    setBusy(true);
    try {
      const changes: DocumentEdit[] = Object.entries(draft?.fields ?? {})
        .filter(
          ([key, value]) => JSON.stringify(value) !== JSON.stringify(readPath(snapshot.data, key.split("."))),
        )
        .map(([key, value]) =>
          value === undefined
            ? { op: "delete", path: key.split(".") }
            : { op: "set", path: key.split("."), value },
        );
      onPlan(
        await api.planChange({
          targetId,
          resource: active,
          expectedRevision: snapshot.revision,
          ...(active === "agents" ? { content: draft?.content ?? snapshot.content ?? "" } : { changes }),
        }),
        () => {
          // A successful plan acknowledges only the draft captured for this
          // resource. Edits made after review and other resource drafts survive.
          setDrafts((current) => {
            const entry = current[active];
            if (!entry || !draft) return current;
            const remaining = { ...entry, fields: { ...entry.fields } };
            for (const [key, value] of Object.entries(draft.fields)) {
              if (
                Object.hasOwn(remaining.fields, key) &&
                JSON.stringify(remaining.fields[key]) === JSON.stringify(value)
              ) {
                delete remaining.fields[key];
              }
            }
            if (draft.content !== undefined && remaining.content === draft.content) {
              delete remaining.content;
            }
            const next = { ...current };
            if (!Object.keys(remaining.fields).length && remaining.content === undefined) delete next[active];
            else next[active] = remaining;
            return next;
          });
        },
      );
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Tabs
        label={msg(locale, "configuration")}
        active={active}
        onChange={setActive}
        tabs={[
          { id: "config", label: text(locale, "global") },
          { id: "tui", label: text(locale, "tui") },
          { id: "agents", label: "AGENTS.md" },
          { id: "project-local", label: text(locale, "project") },
        ]}
      />
      <section
        className="w-section w-stack"
        role="tabpanel"
        id={`web-panel-${active}`}
        aria-labelledby={`web-tab-${active}`}
      >
        {!snapshot ? (
          <Empty>{active === "project-local" ? text(locale, "noProject") : msg(locale, "readError")}</Empty>
        ) : (
          <>
            <div className="w-section-heading">
              <div>
                <h2>
                  {active === "agents"
                    ? "AGENTS.md"
                    : active === "tui"
                      ? "tui.toml"
                      : active === "project-local"
                        ? ".kimi-code/local.toml"
                        : "config.toml"}
                </h2>
                <code className="w-muted">{snapshot.path}</code>
              </div>
              <button
                className="w-button w-button-quiet"
                onClick={() => onSource(snapshot)}
                disabled={!snapshot.exists}
              >
                <FileText size={14} />
                {msg(locale, "source")}
              </button>
            </div>
            {snapshot.diagnostics.map((entry, index) => (
              <div
                key={index}
                className={`w-notice ${entry.severity === "error" ? "w-notice-error" : ""}`}
                role={entry.severity === "error" ? "alert" : "status"}
              >
                {entry.message}
              </div>
            ))}
            {active === "agents" ? (
              <label className="w-field">
                <span>AGENTS.md</span>
                <textarea
                  value={draft?.content ?? snapshot.content ?? ""}
                  disabled={blocked}
                  rows={18}
                  spellCheck={false}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      agents: { fields: {}, content: event.target.value },
                    }))
                  }
                />
              </label>
            ) : (
              <>
                <p className="w-help">{text(locale, "nativeHelp")}</p>
                <div className="w-field-grid">
                  {fields.map((field) => {
                    const key = field.path.join(".");
                    const value =
                      draft && Object.hasOwn(draft.fields, key)
                        ? draft.fields[key]
                        : readPath(snapshot.data, field.path);
                    return (
                      <label className="w-field" key={key}>
                        <span>{text(locale, key)}</span>
                        <code className="w-muted">{key}</code>
                        {field.type === "boolean" ? (
                          <select
                            aria-label={`${text(locale, key)} (${key})`}
                            value={value === undefined ? "" : String(value)}
                            disabled={blocked}
                            onChange={(event) =>
                              update(
                                key,
                                event.target.value === "" ? undefined : event.target.value === "true",
                              )
                            }
                          >
                            <option value="">{text(locale, "unset")}</option>
                            <option value="true">{text(locale, "yes")}</option>
                            <option value="false">{text(locale, "no")}</option>
                            {value !== undefined && typeof value !== "boolean" ? (
                              <option value={String(value)}>{String(value)}</option>
                            ) : null}
                          </select>
                        ) : field.type === "string-array" ? (
                          <>
                            <textarea
                              aria-label={`${text(locale, key)} (${key})`}
                              value={
                                Array.isArray(value)
                                  ? value.join("\n")
                                  : value === undefined
                                    ? ""
                                    : String(value)
                              }
                              disabled={blocked}
                              rows={3}
                              placeholder={text(locale, "onePerLine")}
                              onChange={(event) =>
                                update(
                                  key,
                                  event.target.value
                                    .split(/\r?\n/)
                                    .map((entry) => entry.trim())
                                    .filter(Boolean),
                                )
                              }
                            />
                            <span className="w-help">
                              {text(locale, "onePerLine")}
                              {field.values ? ` · ${field.values.join(", ")}` : ""}
                            </span>
                          </>
                        ) : field.values ? (
                          <select
                            aria-label={`${text(locale, key)} (${key})`}
                            value={value === undefined ? "" : String(value)}
                            disabled={blocked}
                            onChange={(event) => update(key, event.target.value || undefined)}
                          >
                            <option value="">{text(locale, "unset")}</option>
                            {field.values.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                            {Boolean(value) && !field.values.includes(String(value)) ? (
                              <option value={String(value)}>{String(value)}</option>
                            ) : null}
                          </select>
                        ) : (
                          <input
                            aria-label={`${text(locale, key)} (${key})`}
                            value={value === undefined ? "" : String(value)}
                            placeholder={text(locale, "unset")}
                            disabled={blocked}
                            onChange={(event) => update(key, event.target.value || undefined)}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            <div className="w-draft-bar">
              <span className="w-status-line">
                {dirty ? (
                  <>
                    <span className="w-dirty-dot" />
                    {msg(locale, "draft")}
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    {snapshot.exists ? msg(locale, "nativeFiles") : msg(locale, "missing")}
                  </>
                )}
              </span>
              <div className="w-draft-actions">
                {dirty ? (
                  <button
                    className="w-button w-button-quiet"
                    disabled={busy}
                    onClick={() =>
                      setDrafts((current) => {
                        const next = { ...current };
                        delete next[active];
                        return next;
                      })
                    }
                  >
                    {msg(locale, "discard")}
                  </button>
                ) : null}
                <button
                  className="w-button w-button-primary"
                  disabled={blocked || !dirty}
                  onClick={() => void plan()}
                >
                  {msg(locale, "preview")}
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
