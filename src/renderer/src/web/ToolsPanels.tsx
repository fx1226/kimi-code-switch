import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { redactDocumentText } from "@shared/configSafety";
import type { ChangePlan, RecoveryCase } from "@shared/resourceProtocol";
import type { SkillsScanReport } from "@shared/skillsStore";
import type { Locale, PluginInventoryReport } from "@shared/types";
import type { BackupSummary, DiagnosticResult, HistorySummary, WebApi } from "@shared/webApi";
import { msg } from "./messages";
import { Dialog, Empty } from "./ui";

const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"];
const words = {
  details: ["查看详情", "檢視詳情", "View details", "詳細を表示", "Details anzeigen", "Ver detalles"],
  origin: ["来源", "來源", "Source", "検出元", "Quelle", "Origen"],
  paths: [
    "扫描目录",
    "掃描目錄",
    "Discovery directories",
    "検索ディレクトリ",
    "Suchverzeichnisse",
    "Directorios de búsqueda",
  ],
  selected: ["已扫描", "已掃描", "Scanned", "検索済み", "Durchsucht", "Explorado"],
  skipped: ["未参与扫描", "未參與掃描", "Not scanned", "未検索", "Nicht durchsucht", "Sin explorar"],
  active: [
    "扫描结果有效",
    "掃描結果有效",
    "Effective in scan",
    "検索上有効",
    "Im Scan wirksam",
    "Efectivo en el análisis",
  ],
  shadowed: [
    "被同名资源覆盖",
    "被同名資源覆蓋",
    "Shadowed by another resource",
    "同名リソースにより無効",
    "Durch andere Ressource verdeckt",
    "Oculto por otro recurso",
  ],
  disabled: ["已禁用", "已停用", "Disabled", "無効", "Deaktiviert", "Desactivado"],
  enabled: [
    "配置已启用",
    "設定已啟用",
    "Enabled in configuration",
    "設定で有効",
    "In Konfiguration aktiviert",
    "Activado en la configuración",
  ],
  invalid: [
    "检查未通过",
    "檢查未通過",
    "Check failed",
    "検査に失敗",
    "Prüfung fehlgeschlagen",
    "Comprobación fallida",
  ],
  inventoryHelp: [
    "清单反映本地文件的扫描结果，不代表 Kimi Code 已加载或调用这些扩展。",
    "清單反映本機檔案的掃描結果，不代表 Kimi Code 已載入或呼叫這些擴充。",
    "This inventory describes local files, not whether Kimi Code has loaded or called these extensions.",
    "一覧はローカルファイルの検索結果です。Kimi Code による読込・呼出状況ではありません。",
    "Diese Liste beschreibt lokale Dateien, nicht ob Kimi Code die Erweiterungen geladen oder aufgerufen hat.",
    "Este inventario describe archivos locales, no si Kimi Code ha cargado o utilizado las extensiones.",
  ],
  hiddenContent: [
    "仅显示清单信息。技能正文、原始来源地址和执行配置不在此处展示。",
    "僅顯示清單資訊。技能正文、原始來源位址及執行設定不在此顯示。",
    "Inventory metadata only. Skill bodies, original source addresses and execution settings are not displayed.",
    "一覧情報のみを表示します。スキル本文、元の取得先、実行設定は表示しません。",
    "Nur Inventardaten. Skill-Inhalte, ursprüngliche Quelladressen und Ausführungseinstellungen werden nicht angezeigt.",
    "Solo metadatos. No se muestran los contenidos de skills, direcciones originales ni ajustes de ejecución.",
  ],
  extensionVersion: [
    "扩展版本",
    "擴充版本",
    "Extension version",
    "拡張機能のバージョン",
    "Erweiterungsversion",
    "Versión de la extensión",
  ],
  manifest: [
    "清单文件",
    "資訊清單檔案",
    "Manifest file",
    "マニフェスト",
    "Manifestdatei",
    "Archivo de manifiesto",
  ],
  skillRoots: [
    "技能目录",
    "技能目錄",
    "Skill directories",
    "スキルディレクトリ",
    "Skill-Verzeichnisse",
    "Directorios de skills",
  ],
  hooks: ["Hook 数量", "Hook 數量", "Hook count", "フック数", "Anzahl Hooks", "Número de hooks"],
  mcpCount: [
    "MCP 服务数量",
    "MCP 服務數量",
    "MCP server count",
    "MCP サーバー数",
    "Anzahl MCP-Server",
    "Número de servidores MCP",
  ],
  check: ["检查文件", "檢查檔案", "Check files", "ファイルを検査", "Dateien prüfen", "Comprobar archivos"],
  checkHelp: [
    "检查原生文件格式与兼容性，不修改配置。",
    "檢查原生檔案格式與相容性，不修改設定。",
    "Check native file formats and compatibility without changing configuration.",
    "設定を変更せず、ファイル形式と互換性を確認します。",
    "Prüft Originalformate und Kompatibilität, ohne die Konfiguration zu ändern.",
    "Comprueba los formatos nativos y la compatibilidad sin cambiar la configuración.",
  ],
  checked: [
    "本次文件检查通过。",
    "本次檔案檢查通過。",
    "File checks passed.",
    "ファイル検査に合格しました。",
    "Dateiprüfung bestanden.",
    "Comprobación de archivos superada.",
  ],
  backupCreated: [
    "备份已创建。",
    "備份已建立。",
    "Backup created.",
    "バックアップを作成しました。",
    "Sicherung erstellt.",
    "Copia creada.",
  ],
  backupImported: [
    "备份已导入，尚未恢复到原生文件。",
    "備份已匯入，尚未復原至原生檔案。",
    "Backup imported. Native files have not been restored.",
    "バックアップを取り込みました。ファイルの復元はまだ行われていません。",
    "Sicherung importiert. Originaldateien wurden noch nicht wiederhergestellt.",
    "Copia importada. Los archivos nativos aún no se han restaurado.",
  ],
  backupHelp: [
    "恢复会先生成变更计划，检查并应用后才写入原生文件。",
    "復原會先產生變更計畫，檢查並套用後才寫入原生檔案。",
    "Restoration creates a change plan. Native files are written only after review and application.",
    "復元内容を確認し適用するまで、ファイルは変更されません。",
    "Die Wiederherstellung erstellt einen Änderungsplan. Originaldateien werden erst nach Prüfung und Anwendung geschrieben.",
    "La restauración crea un plan. Los archivos nativos solo se escriben después de revisarlo y aplicarlo.",
  ],
  backupUnrestorable: [
    "不可恢复",
    "無法復原",
    "Cannot restore",
    "復元不可",
    "Nicht wiederherstellbar",
    "No se puede restaurar",
  ],
  export: [
    "下载备份",
    "下載備份",
    "Download backup",
    "バックアップをダウンロード",
    "Sicherung herunterladen",
    "Descargar copia",
  ],
  import: [
    "导入备份",
    "匯入備份",
    "Import backup",
    "バックアップを取り込む",
    "Sicherung importieren",
    "Importar copia",
  ],
  downloadStarted: [
    "已发起下载，请在浏览器中查看下载结果。",
    "已發起下載，請在瀏覽器中檢視下載結果。",
    "Download initiated. Check the result in your browser.",
    "ダウンロードを開始しました。ブラウザーで結果を確認してください。",
    "Download gestartet. Prüfen Sie das Ergebnis im Browser.",
    "Descarga iniciada. Comprueba el resultado en el navegador.",
  ],
  history: ["变更历史", "變更歷史", "Change history", "変更履歴", "Änderungsverlauf", "Historial de cambios"],
  noHistory: [
    "还没有变更记录。",
    "尚無變更記錄。",
    "No change history yet.",
    "変更履歴はまだありません。",
    "Noch kein Änderungsverlauf.",
    "Aún no hay historial de cambios.",
  ],
  restoreBlocked: [
    "当前原生配置为只读，暂时不能恢复。仍可检查文件和管理备份。",
    "目前原生設定為唯讀，暫時無法復原。仍可檢查檔案及管理備份。",
    "Native configuration is read only, so restoration is unavailable. File checks and backup management remain available.",
    "現在の設定は読み取り専用のため復元できません。ファイル検査とバックアップ管理は利用できます。",
    "Die Originalkonfiguration ist schreibgeschützt. Wiederherstellung ist nicht verfügbar; Dateiprüfung und Sicherungsverwaltung bleiben möglich.",
    "La configuración nativa es de solo lectura. No se puede restaurar, pero sí comprobar archivos y gestionar copias.",
  ],
  recoveryCases: [
    "未完成的文件操作",
    "未完成的檔案操作",
    "Unfinished file operations",
    "未完了のファイル操作",
    "Unvollständige Dateivorgänge",
    "Operaciones de archivo sin terminar",
  ],
  allTargets: [
    "这里列出所有配置目录的恢复记录。请核对每个文件的实际路径。",
    "此處列出所有設定目錄的復原記錄。請核對每個檔案的實際路徑。",
    "Recovery records cover all configuration directories. Check each file's actual path.",
    "すべての設定ディレクトリの復元記録です。各ファイルの実際のパスを確認してください。",
    "Die Wiederherstellungsprotokolle umfassen alle Konfigurationsverzeichnisse. Prüfen Sie jeden tatsächlichen Dateipfad.",
    "Los registros abarcan todos los directorios de configuración. Comprueba la ruta real de cada archivo.",
  ],
  noRecoveryCases: [
    "没有需要人工处置的恢复记录。",
    "沒有需要人工處理的復原記錄。",
    "No recovery records require manual review.",
    "手動確認が必要な復元記録はありません。",
    "Keine Wiederherstellungsprotokolle erfordern eine manuelle Prüfung.",
    "No hay registros que requieran revisión manual.",
  ],
  recoveryReview: [
    "检查当前文件",
    "檢查目前檔案",
    "Review current files",
    "現在のファイルを確認",
    "Aktuelle Dateien prüfen",
    "Revisar archivos actuales",
  ],
  keepCurrent: [
    "保留当前文件并归档恢复记录",
    "保留目前檔案並封存復原記錄",
    "Keep current files and archive recovery record",
    "現在のファイルを保持し復元記録をアーカイブ",
    "Aktuelle Dateien behalten und Protokoll archivieren",
    "Conservar archivos actuales y archivar el registro",
  ],
  keepCurrentHelp: [
    "确认后将接受下方文件的当前状态，并归档中断操作的恢复记录；不会恢复中断前的配置。",
    "確認後將接受下方檔案的目前狀態，並封存中斷操作的復原記錄；不會復原中斷前的設定。",
    "Confirmation accepts the current file states shown below and archives the interrupted operation's record. It does not restore the earlier configuration.",
    "確認すると以下のファイルの現在の状態を採用し、中断した操作の記録をアーカイブします。以前の設定には戻りません。",
    "Die Bestätigung übernimmt die unten angezeigten Dateistände und archiviert das Protokoll des unterbrochenen Vorgangs. Die frühere Konfiguration wird nicht wiederhergestellt.",
    "La confirmación acepta los estados actuales mostrados y archiva el registro de la operación interrumpida. No restaura la configuración anterior.",
  ],
  journalRevision: [
    "恢复记录版本",
    "復原記錄版本",
    "Journal revision",
    "復元記録のリビジョン",
    "Protokollrevision",
    "Revisión del registro",
  ],
  fileRevision: [
    "当前文件版本",
    "目前檔案版本",
    "Current file revision",
    "現在のファイルのリビジョン",
    "Aktuelle Dateirevision",
    "Revisión actual del archivo",
  ],
  currentPreview: [
    "当前内容（已脱敏）",
    "目前內容（已遮罩）",
    "Current content (redacted)",
    "現在の内容（機密情報は非表示）",
    "Aktueller Inhalt (bereinigt)",
    "Contenido actual (ocultado)",
  ],
  exportJournal: [
    "下载原始恢复记录",
    "下載原始復原記錄",
    "Download original recovery record",
    "元の復元記録をダウンロード",
    "Originalprotokoll herunterladen",
    "Descargar registro original",
  ],
  journalSensitive: [
    "原始恢复记录可能包含 API key、凭据及文件内容。下载后请妥善保管，不要公开分享。",
    "原始復原記錄可能包含 API key、憑證及檔案內容。下載後請妥善保管，勿公開分享。",
    "The original recovery record may contain API keys, credentials and file contents. Store the download securely and do not share it publicly.",
    "元の復元記録には API キー、認証情報、ファイル内容が含まれる可能性があります。安全に保管し、公開しないでください。",
    "Das Originalprotokoll kann API-Schlüssel, Zugangsdaten und Dateiinhalte enthalten. Bewahren Sie den Download sicher auf und teilen Sie ihn nicht öffentlich.",
    "El registro original puede contener claves API, credenciales y archivos. Guarda la descarga de forma segura y no la compartas públicamente.",
  ],
  unrecognizedJournal: [
    "此记录无法安全解析，不能确认涉及哪些文件。请先下载原始记录，并自行核对本机文件。",
    "此記錄無法安全解析，不能確認涉及哪些檔案。請先下載原始記錄，並自行核對本機檔案。",
    "This record cannot be safely interpreted, so its affected files cannot be verified. Download the original record and inspect the local files first.",
    "記録を安全に解析できず、対象ファイルを確認できません。元の記録をダウンロードしてローカルファイルを確認してください。",
    "Dieses Protokoll kann nicht sicher interpretiert werden; die betroffenen Dateien sind nicht verifiziert. Laden Sie das Original herunter und prüfen Sie zuerst die lokalen Dateien.",
    "No se puede interpretar este registro de forma segura ni verificar los archivos afectados. Descarga el original e inspecciona primero los archivos locales.",
  ],
  acknowledgeJournal: [
    "我已核对浏览器下载结果和当前文件，理解此记录无法完整验证，并确认保留当前文件。",
    "我已核對瀏覽器下載結果及目前檔案，理解此記錄無法完整驗證，並確認保留目前檔案。",
    "I checked the browser download and current files, understand that this record cannot be fully verified, and confirm keeping the current files.",
    "ダウンロード結果と現在のファイルを確認しました。記録を完全に検証できないことを理解し、現在のファイルを保持します。",
    "Ich habe den Browser-Download und die aktuellen Dateien geprüft, verstehe die unvollständige Prüfbarkeit des Protokolls und bestätige das Behalten der Dateien.",
    "He comprobado la descarga y los archivos actuales, entiendo que el registro no puede verificarse por completo y confirmo conservar los archivos actuales.",
  ],
  recoveryArchived: [
    "恢复记录已归档，保留了核对过的当前文件。",
    "復原記錄已封存，保留了核對過的目前檔案。",
    "Recovery record archived; the reviewed current files were kept.",
    "復元記録をアーカイブし、確認した現在のファイルを保持しました。",
    "Protokoll archiviert; die geprüften aktuellen Dateien wurden beibehalten.",
    "Registro archivado; se conservaron los archivos actuales revisados.",
  ],
  recoveryChanged: [
    "处置未完成。请重新读取恢复记录和文件版本后再检查。",
    "處理未完成。請重新讀取復原記錄及檔案版本後再檢查。",
    "Resolution did not complete. Reload the recovery record and file revisions before reviewing again.",
    "処理が完了しませんでした。復元記録とファイルのリビジョンを再読込して確認してください。",
    "Die Klärung wurde nicht abgeschlossen. Laden Sie das Protokoll und die Dateirevisionen vor einer erneuten Prüfung neu.",
    "La resolución no se completó. Recarga el registro y las revisiones de los archivos antes de volver a revisar.",
  ],
} as const;
type Word = keyof typeof words;
const text = (locale: Locale, key: Word): string => words[key][locales.indexOf(locale)] ?? words[key][2];
const safe = (value: string): string => redactDocumentText(value).text;

interface CommonProps {
  api: WebApi;
  targetId: string;
  locale: Locale;
  onError: (error: unknown) => void;
}
interface InventoryItem {
  id: string;
  name: string;
  path: string;
  source: string;
  status: Word;
  diagnostics: string[];
  fields: Array<{ label: Word; value: string }>;
}
interface InventoryData {
  items: InventoryItem[];
  paths: Array<{
    id: string;
    path: string;
    source: string;
    status: Word | "missing" | "unknown";
    reason: string;
  }>;
  diagnostics: string[];
}

function inventory(report: SkillsScanReport | PluginInventoryReport): InventoryData {
  if ("skills" in report)
    return {
      items: report.skills.map((skill) => ({
        id: skill.id,
        name: safe(skill.name),
        path: safe(skill.skillFilePath),
        source: `${skill.sourceGroup} · ${safe(skill.sourceLabel)}`,
        status: !skill.valid
          ? "invalid"
          : !skill.enabled
            ? "disabled"
            : skill.effective
              ? "active"
              : "shadowed",
        diagnostics: skill.diagnostics.map(safe),
        fields: [],
      })),
      paths: report.paths
        .filter((path) => path.group !== "builtin")
        .map((path) => ({
          id: path.id,
          path: safe(path.path),
          source: path.group,
          status: !path.exists ? "missing" : path.selected ? "selected" : "skipped",
          reason: safe(path.reason),
        })),
      diagnostics: report.builtinNotice ? [safe(report.builtinNotice)] : [],
    };
  return {
    items: report.plugins.map((plugin) => ({
      id: plugin.id,
      name: safe(plugin.displayName || plugin.id),
      path: safe(plugin.root),
      source: ["local-path", "zip-url", "github"].includes(plugin.source) ? plugin.source : "—",
      status: plugin.state === "error" ? "invalid" : plugin.enabled ? "enabled" : "disabled",
      diagnostics: plugin.diagnostics.map((entry) => `${entry.severity}: ${safe(entry.message)}`),
      fields: [
        ...(plugin.version ? [{ label: "extensionVersion" as const, value: safe(plugin.version) }] : []),
        ...(plugin.manifestPath ? [{ label: "manifest" as const, value: safe(plugin.manifestPath) }] : []),
        { label: "skillRoots", value: plugin.skillRoots.map((root) => safe(root.path)).join("\n") || "—" },
        { label: "hooks", value: String(plugin.hookCount) },
        { label: "mcpCount", value: String(Object.keys(plugin.mcpServers).length) },
      ],
    })),
    paths: [
      {
        id: "installed",
        path: safe(report.installedPath),
        source: "installed.json",
        status: "unknown",
        reason: "",
      },
    ],
    diagnostics: report.diagnostics.map((entry) => `${entry.severity}: ${safe(entry.message)}`),
  };
}

/** Scope identities prevent late responses from affecting a different target or API connection. */
function useScope(api: WebApi, targetId: string, kind = "recovery") {
  const scope = useMemo(() => ({}), [api, targetId, kind]);
  const current = useRef(scope);
  current.current = scope;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(() => mounted.current && current.current === scope, [scope]);
  return { scope, isCurrent };
}

function Diagnostics({ values }: { values: string[] }): JSX.Element | null {
  return values.length ? (
    <ul className="w-help">
      {values.map((value, index) => (
        <li key={index}>{value}</li>
      ))}
    </ul>
  ) : null;
}

function downloadTextFile(result: { fileName: string; content: string }): void {
  const url = URL.createObjectURL(new Blob([result.content], { type: "application/json" }));
  const revoke = URL.revokeObjectURL.bind(URL);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName.split(/[\\/]/).pop() || "kimi-code-switch-export.json";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => revoke(url), 1000);
  }
}

function RecoveryCases({
  api,
  targetId,
  locale,
  onError,
  onRecovered,
}: CommonProps & { onRecovered?: () => void }): JSX.Element {
  const { scope, isCurrent } = useScope(api, targetId, "manual-recovery");
  const [result, setResult] = useState<{ scope: object; cases?: RecoveryCase[]; failed?: boolean }>();
  const [selection, setSelection] = useState<{
    scope: object;
    item: RecoveryCase;
    exported: boolean;
    acknowledged: boolean;
    failed?: boolean;
  }>();
  const [working, setWorking] = useState<object>();
  const [archived, setArchived] = useState<object>();
  const [reload, setReload] = useState(0);
  const actionRef = useRef<object>();
  const callbacks = useRef({ onError, onRecovered });
  callbacks.current = { onError, onRecovered };
  useEffect(() => {
    let cancelled = false;
    setResult({ scope });
    setSelection(undefined);
    void api
      .listRecoveryCases()
      .then((cases) => {
        if (!cancelled && isCurrent()) setResult({ scope, cases });
      })
      .catch((error: unknown) => {
        if (!cancelled && isCurrent()) {
          setResult({ scope, failed: true });
          callbacks.current.onError(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, scope, isCurrent, reload]);
  const current = result?.scope === scope ? result : undefined;
  const selected = selection?.scope === scope ? selection : undefined;
  const loading = !current?.cases && !current?.failed;
  const busy = working === scope;
  const needsExport = Boolean(
    selected && (selected.item.requiresExport || selected.item.kind !== "transaction"),
  );
  const run = async (operation: () => Promise<void>, resolution = false) => {
    if (actionRef.current === scope || !isCurrent()) return;
    actionRef.current = scope;
    setWorking(scope);
    try {
      await operation();
    } catch (error) {
      if (isCurrent()) {
        if (resolution)
          setSelection((previous) => (previous?.scope === scope ? { ...previous, failed: true } : previous));
        callbacks.current.onError(error);
      }
    } finally {
      if (actionRef.current === scope) actionRef.current = undefined;
      if (isCurrent()) setWorking(undefined);
    }
  };
  const refresh = () => {
    setSelection(undefined);
    setReload((value) => value + 1);
  };
  const exportJournal = () => {
    if (!selected) return;
    void run(async () => {
      const file = await api.exportRecoveryJournal({
        id: selected.item.id,
        journalRevision: selected.item.journalRevision,
      });
      if (!isCurrent()) return;
      downloadTextFile(file);
      setSelection((previous) =>
        previous?.scope === scope && previous.item === selected.item
          ? { ...previous, exported: true }
          : previous,
      );
    });
  };
  const resolve = () => {
    if (!selected || selected.failed || (needsExport && (!selected.exported || !selected.acknowledged)))
      return;
    void run(async () => {
      await api.resolveRecovery({
        id: selected.item.id,
        journalRevision: selected.item.journalRevision,
        expectedRevisions: Object.fromEntries(
          selected.item.resources.map((resource) => [resource.path, resource.revision]),
        ),
        decision: "keep-current",
        ...(needsExport ? { acknowledgeMalformed: true } : {}),
      });
      if (!isCurrent()) return;
      setSelection(undefined);
      setArchived(scope);
      setReload((value) => value + 1);
      callbacks.current.onRecovered?.();
    }, true);
  };
  return (
    <section className="w-section" aria-label={text(locale, "recoveryCases")} aria-busy={loading}>
      <div className="w-section-heading">
        <h2>{text(locale, "recoveryCases")}</h2>
        <button type="button" className="w-button" disabled={loading || busy} onClick={refresh}>
          {msg(locale, "refresh")}
        </button>
      </div>
      <p className="w-help">{text(locale, "allTargets")}</p>
      {archived === scope ? (
        <p className="w-help" role="status">
          {text(locale, "recoveryArchived")}
        </p>
      ) : null}
      {loading ? (
        <p role="status">{msg(locale, "loading")}</p>
      ) : current?.failed ? (
        <Empty
          action={
            <button type="button" className="w-button" onClick={refresh}>
              {msg(locale, "retry")}
            </button>
          }
        >
          {msg(locale, "readError")}
        </Empty>
      ) : current?.cases?.length ? (
        <div className="w-file-list">
          {current.cases.map((item) => (
            <div className="w-file-row" key={item.id}>
              <div className="w-file-copy">
                <strong>{safe(item.id)}</strong>
                <span className="w-help">{item.kind}</span>
                {item.resources.map((resource) => (
                  <code key={resource.path}>{safe(resource.path)}</code>
                ))}
                <Diagnostics
                  values={item.diagnostics.map((entry) => `${entry.severity}: ${safe(entry.message)}`)}
                />
              </div>
              <button
                type="button"
                className="w-button"
                disabled={busy}
                aria-label={`${text(locale, "recoveryReview")} · ${safe(item.id)}`}
                onClick={() => {
                  setArchived(undefined);
                  setSelection({ scope, item, exported: false, acknowledged: false });
                }}
              >
                {text(locale, "recoveryReview")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Empty>{text(locale, "noRecoveryCases")}</Empty>
      )}
      {selected ? (
        <Dialog
          title={text(locale, "recoveryReview")}
          locale={locale}
          busy={busy}
          onClose={() => {
            if (!busy) setSelection(undefined);
          }}
          footer={
            <>
              <button
                type="button"
                className="w-button"
                disabled={busy}
                onClick={() => setSelection(undefined)}
              >
                {msg(locale, "cancel")}
              </button>
              {selected.failed ? (
                <button type="button" className="w-button" disabled={busy} onClick={refresh}>
                  {msg(locale, "refresh")}
                </button>
              ) : (
                <button
                  type="button"
                  className="w-button w-button-primary"
                  disabled={busy || (needsExport && (!selected.exported || !selected.acknowledged))}
                  onClick={resolve}
                >
                  {text(locale, "keepCurrent")}
                </button>
              )}
            </>
          }
        >
          <p>{text(locale, "keepCurrentHelp")}</p>
          <div className="w-summary-item">
            <strong>{safe(selected.item.id)}</strong>
            <span className="w-help">{text(locale, "journalRevision")}</span>
            <code>{selected.item.journalRevision}</code>
          </div>
          <Diagnostics
            values={selected.item.diagnostics.map((entry) => `${entry.severity}: ${safe(entry.message)}`)}
          />
          {selected.item.resources.map((resource) => (
            <div className="w-summary-item" key={resource.path}>
              <strong>{resource.resource}</strong>
              <code>{safe(resource.path)}</code>
              <span className="w-help">{text(locale, "fileRevision")}</span>
              <code>{resource.revision || msg(locale, "missing")}</code>
              <span className="w-help">{text(locale, "currentPreview")}</span>
              <pre className="w-source">{safe(resource.redactedCurrent)}</pre>
            </div>
          ))}
          {needsExport ? (
            <>
              {!selected.item.resources.length ? (
                <p className="w-help">{text(locale, "unrecognizedJournal")}</p>
              ) : null}
              <p className="w-notice">{text(locale, "journalSensitive")}</p>
              <div>
                <button
                  type="button"
                  className="w-button"
                  disabled={busy || selected.failed}
                  onClick={exportJournal}
                >
                  {text(locale, "exportJournal")}
                </button>
              </div>
              {selected.exported ? (
                <p role="status" className="w-help">
                  {text(locale, "downloadStarted")}
                </p>
              ) : null}
              <label className="w-check">
                <input
                  type="checkbox"
                  checked={selected.acknowledged}
                  disabled={busy || !selected.exported || selected.failed}
                  onChange={(event) => {
                    const acknowledged = event.target.checked;
                    setSelection((previous) =>
                      previous?.scope === scope ? { ...previous, acknowledged } : previous,
                    );
                  }}
                />
                <span>{text(locale, "acknowledgeJournal")}</span>
              </label>
            </>
          ) : null}
          {selected.failed ? (
            <p className="w-notice w-notice-error" role="alert">
              {text(locale, "recoveryChanged")}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </section>
  );
}

export function InventoryPanel({
  api,
  targetId,
  locale,
  onError,
  kind,
}: CommonProps & { kind: "skills" | "plugins" }): JSX.Element {
  const { scope, isCurrent } = useScope(api, targetId, kind);
  const [result, setResult] = useState<{ scope: object; data?: InventoryData; failed?: boolean }>();
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<{ scope: object; item: InventoryItem }>();
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    let cancelled = false;
    setResult({ scope });
    setSelected(undefined);
    const request = kind === "skills" ? api.scanSkills({ targetId }) : api.listPlugins({ targetId });
    void request
      .then((report) => {
        if (!cancelled && isCurrent()) setResult({ scope, data: inventory(report) });
      })
      .catch((error: unknown) => {
        if (!cancelled && isCurrent()) {
          setResult({ scope, failed: true });
          errorRef.current(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, targetId, kind, scope, isCurrent, reload]);
  const current = result?.scope === scope ? result : undefined;
  const data = current?.data;
  const loading = !data && !current?.failed;
  const item = selected?.scope === scope ? selected.item : undefined;
  return (
    <div className="w-stack">
      <section className="w-section" aria-label={msg(locale, kind)} aria-busy={loading}>
        <div className="w-section-heading">
          <h2>{msg(locale, kind)}</h2>
          <button
            type="button"
            className="w-button"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            {msg(locale, "refresh")}
          </button>
        </div>
        <p className="w-help">{text(locale, "inventoryHelp")}</p>
        {loading ? (
          <p role="status">{msg(locale, "loading")}</p>
        ) : current?.failed ? (
          <Empty
            action={
              <button type="button" className="w-button" onClick={() => setReload((value) => value + 1)}>
                {msg(locale, "retry")}
              </button>
            }
          >
            {msg(locale, "readError")}
          </Empty>
        ) : (
          <>
            <Diagnostics values={data?.diagnostics ?? []} />
            {data?.items.length ? (
              <div className="w-file-list">
                {data.items.map((entry) => (
                  <div className="w-file-row" key={entry.id}>
                    <div className="w-file-copy">
                      <strong>{entry.name}</strong>
                      <code>{entry.path}</code>
                      <span className="w-help">
                        {text(locale, "origin")}: {entry.source}
                      </span>
                      <Diagnostics values={entry.diagnostics} />
                    </div>
                    <span className={`w-badge${entry.status === "invalid" ? " w-badge-warning" : ""}`}>
                      {text(locale, entry.status)}
                    </span>
                    <button
                      type="button"
                      className="w-button"
                      aria-label={`${text(locale, "details")} · ${entry.name}`}
                      onClick={() => setSelected({ scope, item: entry })}
                    >
                      {text(locale, "details")}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>{msg(locale, "noResources")}</Empty>
            )}
          </>
        )}
      </section>
      {data ? (
        <section className="w-section" aria-label={text(locale, "paths")}>
          <div className="w-section-heading">
            <h2>{text(locale, "paths")}</h2>
          </div>
          <div className="w-file-list">
            {data.paths.map((path) => (
              <div className="w-file-row" key={path.id}>
                <div className="w-file-copy">
                  <code>{path.path}</code>
                  <span className="w-help">
                    {text(locale, "origin")}: {path.source}
                  </span>
                  {path.reason ? <p className="w-help">{path.reason}</p> : null}
                </div>
                <span className="w-badge">
                  {path.status === "missing" || path.status === "unknown"
                    ? msg(locale, path.status)
                    : text(locale, path.status)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {item ? (
        <Dialog title={item.name} locale={locale} onClose={() => setSelected(undefined)}>
          <p className="w-help">{text(locale, "hiddenContent")}</p>
          <dl className="w-definition-list">
            <dt>{msg(locale, "path")}</dt>
            <dd>
              <code>{item.path}</code>
            </dd>
            <dt>{text(locale, "origin")}</dt>
            <dd>{item.source}</dd>
            <dt>{msg(locale, "status")}</dt>
            <dd>{text(locale, item.status)}</dd>
            {item.fields.map((field) => (
              <Fragment key={field.label}>
                <dt>{text(locale, field.label)}</dt>
                <dd>
                  <pre className="w-source">{field.value}</pre>
                </dd>
              </Fragment>
            ))}
          </dl>
          <Diagnostics values={item.diagnostics} />
        </Dialog>
      ) : null}
    </div>
  );
}

export function RecoveryPanel({
  api,
  targetId,
  locale,
  onError,
  onPlan,
  onRecovered,
  blocked = false,
  privateWritesBlocked = false,
}: CommonProps & {
  onPlan: (plan: ChangePlan) => void;
  onRecovered?: () => void;
  blocked?: boolean;
  privateWritesBlocked?: boolean;
}): JSX.Element {
  const { scope, isCurrent } = useScope(api, targetId);
  const [lists, setLists] = useState<{
    scope: object;
    backups?: BackupSummary[];
    history?: HistorySummary[];
    backupError?: boolean;
    historyError?: boolean;
  }>();
  const [diagnostic, setDiagnostic] = useState<{ scope: object; result: DiagnosticResult }>();
  const [action, setAction] = useState<{ scope: object; name: string }>();
  const [notice, setNotice] = useState<{ scope: object; word: Word }>();
  const [reload, setReload] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const actionRef = useRef<{ scope: object; name: string }>();
  const callbacks = useRef({ onError, onPlan, blocked });
  callbacks.current = { onError, onPlan, blocked };
  useEffect(() => {
    let cancelled = false;
    setLists({ scope });
    setDiagnostic(undefined);
    setNotice(undefined);
    void Promise.allSettled([api.listBackups({ targetId }), api.listHistory({ targetId })]).then(
      ([backups, history]) => {
        if (cancelled || !isCurrent()) return;
        setLists({
          scope,
          backups: backups.status === "fulfilled" ? backups.value : undefined,
          history: history.status === "fulfilled" ? history.value : undefined,
          backupError: backups.status === "rejected",
          historyError: history.status === "rejected",
        });
        if (backups.status === "rejected") callbacks.current.onError(backups.reason);
        if (history.status === "rejected") callbacks.current.onError(history.reason);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, targetId, scope, isCurrent, reload]);
  const current = lists?.scope === scope ? lists : undefined;
  const loading =
    !current || (!current.backups && !current.backupError) || (!current.history && !current.historyError);
  const busy = action?.scope === scope;
  const disabled = loading || busy;
  const run = async (name: string, operation: () => Promise<void>) => {
    if (actionRef.current?.scope === scope || !isCurrent()) return;
    const next = { scope, name };
    actionRef.current = next;
    setAction(next);
    setNotice(undefined);
    try {
      await operation();
    } catch (error) {
      if (isCurrent()) callbacks.current.onError(error);
    } finally {
      if (actionRef.current === next) actionRef.current = undefined;
      if (isCurrent()) setAction(undefined);
    }
  };
  const addBackup = (backup: BackupSummary, word: Word) => {
    if (!isCurrent()) return;
    setLists((previous) =>
      previous?.scope === scope
        ? {
            ...previous,
            backups: [backup, ...(previous.backups ?? []).filter((entry) => entry.id !== backup.id)],
            backupError: false,
          }
        : previous,
    );
    setNotice({ scope, word });
  };
  const review = (name: string, operation: () => Promise<ChangePlan>) => {
    if (callbacks.current.blocked) return;
    void run(name, async () => {
      const plan = await operation();
      if (isCurrent() && !callbacks.current.blocked) callbacks.current.onPlan(plan);
    });
  };
  const download = (backup: BackupSummary) =>
    void run("export", async () => {
      const result = await api.exportBackup({ targetId, id: backup.id });
      if (!isCurrent()) return;
      downloadTextFile(result);
      setNotice({ scope, word: "downloadStarted" });
    });
  const retry = (
    <button
      type="button"
      className="w-button"
      disabled={disabled}
      onClick={() => setReload((value) => value + 1)}
    >
      {msg(locale, "retry")}
    </button>
  );
  const diagnosis = diagnostic?.scope === scope ? diagnostic.result : undefined;
  return (
    <div className="w-stack">
      {blocked ? (
        <p className="w-notice" role="status">
          {text(locale, "restoreBlocked")}
        </p>
      ) : null}
      {busy ? <p role="status">{msg(locale, "busy")}</p> : null}
      {notice?.scope === scope ? (
        <p className="w-notice" role="status">
          {text(locale, notice.word)}
        </p>
      ) : null}
      <RecoveryCases
        api={api}
        targetId={targetId}
        locale={locale}
        onError={onError}
        onRecovered={onRecovered}
      />
      <section className="w-section" aria-label={msg(locale, "diagnostics")}>
        <div className="w-section-heading">
          <h2>{msg(locale, "diagnostics")}</h2>
          <button
            type="button"
            className="w-button"
            disabled={busy}
            onClick={() =>
              void run("diagnose", async () => {
                const result = await api.diagnose({ targetId });
                if (isCurrent()) setDiagnostic({ scope, result });
              })
            }
          >
            {text(locale, "check")}
          </button>
        </div>
        <p className="w-help">{text(locale, "checkHelp")}</p>
        {diagnosis ? (
          <>
            <p className="w-help" role="status">
              {diagnosis.ok ? text(locale, "checked") : text(locale, "invalid")}
            </p>
            <Diagnostics
              values={diagnosis.issues.map(
                (entry) =>
                  `${entry.severity}${entry.resource ? ` · ${safe(entry.resource)}` : ""}: ${safe(entry.message)}`,
              )}
            />
          </>
        ) : null}
      </section>
      <section className="w-section" aria-label={msg(locale, "backups")} aria-busy={loading}>
        <div className="w-section-heading">
          <h2>{msg(locale, "backups")}</h2>
          <div className="w-inline-actions">
            <button
              type="button"
              className="w-button"
              disabled={disabled || privateWritesBlocked}
              onClick={() =>
                void run("create", async () =>
                  addBackup(await api.createBackup({ targetId }), "backupCreated"),
                )
              }
            >
              {msg(locale, "createBackup")}
            </button>
            <button
              type="button"
              className="w-button"
              disabled={disabled || privateWritesBlocked}
              onClick={() => fileInput.current?.click()}
            >
              {text(locale, "import")}
            </button>
            <button
              type="button"
              className="w-button"
              disabled={disabled}
              onClick={() => setReload((value) => value + 1)}
            >
              {msg(locale, "refresh")}
            </button>
          </div>
        </div>
        <input
          type="file"
          ref={fileInput}
          hidden
          accept=".json,application/json"
          aria-label={text(locale, "import")}
          disabled={disabled || privateWritesBlocked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && !privateWritesBlocked)
              void run("import", async () => {
                const content = await file.text();
                if (isCurrent()) addBackup(await api.importBackup({ targetId, content }), "backupImported");
              });
          }}
        />
        <p className="w-help">{text(locale, "backupHelp")}</p>
        {loading ? (
          <p role="status">{msg(locale, "loading")}</p>
        ) : current?.backupError ? (
          <Empty action={retry}>{msg(locale, "readError")}</Empty>
        ) : current?.backups?.length ? (
          <div className="w-file-list">
            {current.backups.map((backup) => (
              <div className="w-file-row" key={backup.id}>
                <div className="w-file-copy">
                  <strong>{safe(backup.name)}</strong>
                  <time className="w-help" dateTime={backup.createdAt}>
                    {safe(backup.createdAt)}
                  </time>
                  <code>{backup.resources.map(safe).join(" · ")}</code>
                  {backup.diagnostic ? <p className="w-help">{safe(backup.diagnostic)}</p> : null}
                </div>
                {backup.restorable === false ? (
                  <span className="w-badge w-badge-warning">{text(locale, "backupUnrestorable")}</span>
                ) : null}
                <div className="w-inline-actions">
                  <button
                    type="button"
                    className="w-button"
                    disabled={disabled}
                    aria-label={`${text(locale, "export")} · ${safe(backup.name)}`}
                    onClick={() => download(backup)}
                  >
                    {text(locale, "export")}
                  </button>
                  <button
                    type="button"
                    className="w-button"
                    disabled={disabled || blocked || backup.restorable === false}
                    aria-label={`${msg(locale, "restore")} · ${safe(backup.name)}`}
                    onClick={() =>
                      review("restore", () => api.planRestore({ targetId, backupId: backup.id }))
                    }
                  >
                    {msg(locale, "restore")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{msg(locale, "noBackups")}</Empty>
        )}
      </section>
      <section className="w-section" aria-label={text(locale, "history")} aria-busy={loading}>
        <div className="w-section-heading">
          <h2>{text(locale, "history")}</h2>
        </div>
        {loading ? (
          <p role="status">{msg(locale, "loading")}</p>
        ) : current?.historyError ? (
          <Empty action={retry}>{msg(locale, "readError")}</Empty>
        ) : current?.history?.length ? (
          <div className="w-file-list">
            {current.history.map((entry) => (
              <div className="w-file-row" key={entry.id}>
                <div className="w-file-copy">
                  <strong>{safe(entry.resource)}</strong>
                  <code>{safe(entry.path)}</code>
                  <time className="w-help" dateTime={entry.createdAt}>
                    {safe(entry.createdAt)}
                  </time>
                </div>
                <span className="w-badge">{safe(entry.status)}</span>
                <button
                  type="button"
                  className="w-button"
                  disabled={disabled || blocked}
                  aria-label={`${msg(locale, "restore")} · ${safe(entry.resource)} · ${safe(entry.createdAt)}`}
                  onClick={() => review("history", () => api.planHistoryRestore({ targetId, id: entry.id }))}
                >
                  {msg(locale, "restore")}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{text(locale, "noHistory")}</Empty>
        )}
      </section>
    </div>
  );
}
