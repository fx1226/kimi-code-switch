import { useEffect, useRef, useState } from "react";
import { redactDocumentText } from "@shared/configSafety";
import type { Locale } from "@shared/types";
import type { LegacyMigrationPreview, WebApi } from "@shared/webApi";
import { msg } from "./messages";
import { Dialog } from "./ui";

const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"];
const words = {
  title: ["迁移工具私有数据", "遷移工具私有資料", "Migrate private data", "ツールの専用データを移行", "Private Werkzeugdaten migrieren", "Migrar datos privados"],
  help: ["复制或归档旧工具的私有设置、备份和历史。原有目录保留，不搬移或修改 Kimi Code 原生配置。", "複製或封存舊工具的私有設定、備份及歷史。保留原有目錄，不搬移或修改 Kimi Code 原生設定。", "Copy or archive the old tool's private settings, backups and history. Original directories are kept; Kimi Code native configuration is not moved or modified.", "旧ツールの専用設定、バックアップ、履歴をコピーまたはアーカイブします。元のディレクトリを保持し、Kimi Code のネイティブ設定は移動・変更しません。", "Kopiert oder archiviert private Einstellungen, Sicherungen und Verlauf des alten Werkzeugs. Ursprüngliche Verzeichnisse bleiben erhalten; native Kimi-Code-Konfigurationen werden weder verschoben noch geändert.", "Copia o archiva los ajustes privados, copias e historial de la herramienta anterior. Se conservan los directorios originales; la configuración nativa de Kimi Code no se mueve ni modifica."],
  source: ["旧私有目录", "舊私有目錄", "Previous private directory", "旧専用ディレクトリ", "Bisheriges privates Verzeichnis", "Directorio privado anterior"],
  target: ["新私有目录", "新私有目錄", "New private directory", "新専用ディレクトリ", "Neues privates Verzeichnis", "Nuevo directorio privado"],
  manifest: ["预览版本", "預覽版本", "Preview revision", "プレビューのリビジョン", "Vorschaurevision", "Revisión de la vista previa"],
  entries: ["迁移清单", "遷移清單", "Migration entries", "移行一覧", "Migrationseinträge", "Elementos de migración"],
  available: ["可迁移", "可遷移", "Available", "移行可能", "Verfügbar", "Disponible"],
  blocked: ["迁移已阻止", "遷移已阻止", "Blocked", "移行不可", "Blockiert", "Bloqueado"],
  complete: ["迁移已完成", "遷移已完成", "Migration complete", "移行完了", "Migration abgeschlossen", "Migración completada"],
  absent: ["未发现待迁移数据", "未發現待遷移資料", "No data to migrate", "移行するデータなし", "Keine Daten zu migrieren", "No hay datos para migrar"],
  copy: ["复制", "複製", "Copy", "コピー", "Kopieren", "Copiar"],
  archive: ["归档", "封存", "Archive", "アーカイブ", "Archivieren", "Archivar"],
  retain: ["保留原位置", "保留原位置", "Retain in original location", "元の場所に保持", "Am ursprünglichen Ort behalten", "Conservar en la ubicación original"],
  empty: ["清单中没有文件。", "清單中沒有檔案。", "No files in this preview.", "このプレビューにファイルはありません。", "Keine Dateien in dieser Vorschau.", "No hay archivos en esta vista previa."],
  reload: ["重新读取迁移预览", "重新讀取遷移預覽", "Reload migration preview", "移行プレビューを再読込", "Migrationsvorschau neu laden", "Recargar vista previa de migración"],
  confirm: ["确认迁移私有数据", "確認遷移私有資料", "Confirm private data migration", "専用データの移行を確認", "Migration privater Daten bestätigen", "Confirmar migración de datos privados"],
  previewFailed: ["无法读取迁移预览。请重新读取后再确认迁移。", "無法讀取遷移預覽。請重新讀取後再確認遷移。", "The migration preview could not be read. Reload it before confirming migration.", "移行プレビューを読み込めません。再読込してから移行を確認してください。", "Die Migrationsvorschau konnte nicht gelesen werden. Laden Sie sie vor der Bestätigung neu.", "No se pudo leer la vista previa. Recárgala antes de confirmar la migración."],
  applyFailed: ["迁移未确认完成。请重新读取清单和预览版本后再试。", "尚未確認遷移完成。請重新讀取清單及預覽版本後再試。", "Migration completion was not confirmed. Reload the entries and preview revision before retrying.", "移行完了を確認できません。移行一覧とプレビューを再読込してから再試行してください。", "Der Abschluss der Migration wurde nicht bestätigt. Laden Sie Einträge und Vorschaurevision vor einem erneuten Versuch neu.", "No se confirmó la finalización de la migración. Recarga los elementos y la revisión antes de reintentar."],
  refreshFailed: ["迁移已完成，但页面状态未能刷新。请重新读取预览。", "遷移已完成，但頁面狀態無法重新整理。請重新讀取預覽。", "Migration completed, but the workspace could not be refreshed. Reload the preview.", "移行は完了しましたが、画面を更新できません。プレビューを再読込してください。", "Die Migration ist abgeschlossen, aber die Ansicht konnte nicht aktualisiert werden. Laden Sie die Vorschau neu.", "La migración se completó, pero no se pudo actualizar la vista. Recarga la vista previa."],
  invalidPreview: ["预览清单或版本无效，不能确认迁移。请重新读取。", "預覽清單或版本無效，無法確認遷移。請重新讀取。", "The preview entries or revision are invalid. Reload before confirming migration.", "プレビューの一覧またはリビジョンが無効です。移行前に再読込してください。", "Vorschau oder Revision ist ungültig. Laden Sie sie vor der Bestätigung neu.", "Los elementos o la revisión no son válidos. Recarga antes de confirmar."],
} as const;
type Word = keyof typeof words;
const text = (locale: Locale, key: Word): string => words[key][locales.indexOf(locale)] ?? words[key][2];
const safe = (value: string): string => redactDocumentText(value).text;
type Entry = LegacyMigrationPreview["entries"][number];
function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === "string" && entry.path.length > 0
    && ["copy", "archive", "retain"].includes(String(entry.action))
    && typeof entry.sizeBytes === "number" && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0;
}

export interface MigrationDialogProps {
  api: WebApi;
  locale: Locale;
  onClose: () => void;
  onMigrated: () => Promise<void>;
}

export function MigrationDialog({ api, locale, onClose, onMigrated }: MigrationDialogProps): JSX.Element {
  const [state, setState] = useState<{ api: WebApi; preview?: LegacyMigrationPreview; phase: "preview" | "apply" | "idle"; error?: Word; needsPreview?: boolean }>({ api, phase: "preview" });
  const [reload, setReload] = useState(0);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const applying = useRef(false);
  const latest = useRef({ api, onClose, onMigrated });
  latest.current = { api, onClose, onMigrated };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current += 1; }; }, []);
  useEffect(() => {
    const id = ++requestId.current;
    applying.current = false;
    setState((previous) => ({ api, preview: previous.api === api ? previous.preview : undefined, phase: "preview", needsPreview: true }));
    void api.previewMigration().then((preview) => {
      if (mounted.current && latest.current.api === api && requestId.current === id) setState({ api, preview, phase: "idle" });
    }).catch(() => {
      if (mounted.current && latest.current.api === api && requestId.current === id) setState((previous) => ({ ...previous, phase: "idle", error: "previewFailed", needsPreview: true }));
    });
    return () => { if (requestId.current === id) requestId.current += 1; };
  }, [api, reload]);
  const current = state.api === api ? state : undefined;
  const preview = current?.preview;
  const busy = current?.phase === "apply";
  const loading = !current || current.phase === "preview";
  const entries = Array.isArray(preview?.entries) ? preview.entries.filter(isEntry) : [];
  const counts = entries.reduce((summary, entry) => {
    summary[entry.action] += 1;
    summary.bytes += entry.sizeBytes;
    return summary;
  }, { copy: 0, archive: 0, retain: 0, bytes: 0 });
  const formatNumber = (value: number): string => new Intl.NumberFormat(locale).format(value);
  const validPreview = Boolean(preview && Array.isArray(preview.entries) && entries.length === preview.entries.length && typeof preview.manifestHash === "string" && preview.manifestHash.trim());
  const canApply = preview?.status === "available" && validPreview && !current?.needsPreview && !loading && !busy;
  const close = () => { if (!applying.current) latest.current.onClose(); };
  const apply = async () => {
    if (!canApply || !preview || applying.current) return;
    applying.current = true;
    const id = ++requestId.current;
    setState((previous) => ({ ...previous, phase: "apply", error: undefined }));
    let completed = false;
    try {
      const result = await api.applyMigration({ manifestHash: preview.manifestHash });
      if (!mounted.current || latest.current.api !== api || requestId.current !== id) return;
      if (result.status !== "complete") throw new Error("Migration did not complete");
      completed = true;
      setState((previous) => ({ ...previous, preview: { ...preview, status: "complete" } }));
      await latest.current.onMigrated();
      if (mounted.current && latest.current.api === api && requestId.current === id) latest.current.onClose();
    } catch {
      if (mounted.current && latest.current.api === api && requestId.current === id) setState((previous) => ({ ...previous, phase: "idle", needsPreview: true, error: completed ? "refreshFailed" : "applyFailed" }));
    } finally {
      if (requestId.current === id) { applying.current = false; if (mounted.current) setState((previous) => ({ ...previous, phase: "idle" })); }
    }
  };
  const refreshWorkspace = async () => {
    if (preview?.status !== "complete" || applying.current || loading) return;
    applying.current = true;
    const id = ++requestId.current;
    setState((previous) => ({ ...previous, phase: "apply", error: undefined }));
    try {
      await latest.current.onMigrated();
      if (mounted.current && latest.current.api === api && requestId.current === id) latest.current.onClose();
    } catch {
      if (mounted.current && latest.current.api === api && requestId.current === id) {
        setState((previous) => ({ ...previous, phase: "idle", error: "refreshFailed" }));
      }
    } finally {
      if (requestId.current === id) {
        applying.current = false;
        if (mounted.current) setState((previous) => ({ ...previous, phase: "idle" }));
      }
    }
  };
  const status = preview && ["available", "blocked", "complete", "absent"].includes(preview.status) ? preview.status : undefined;
  return (
    <Dialog
      title={text(locale, "title")}
      locale={locale}
      onClose={close}
      busy={busy}
      footer={
        <>
          <button type="button" className="w-button" disabled={busy} onClick={close}>
            {msg(locale, "close")}
          </button>
          <button
            type="button"
            className="w-button"
            disabled={loading || busy}
            onClick={() => {
              if (!applying.current) setReload((value) => value + 1);
            }}
          >
            {text(locale, "reload")}
          </button>
          {preview?.status === "complete" ? (
            <button
              type="button"
              className="w-button w-button-primary"
              disabled={loading || busy}
              onClick={() => void refreshWorkspace()}
            >
              {msg(locale, "refresh")}
            </button>
          ) : (
            <button
              type="button"
              className="w-button w-button-primary"
              disabled={!canApply}
              onClick={() => void apply()}
            >
              {text(locale, "confirm")}
            </button>
          )}
        </>
      }
    >
      <p className="w-help">{text(locale, "help")}</p>
      {loading || busy ? <p role="status">{msg(locale, loading ? "loading" : "busy")}</p> : null}
      {current?.error ? (
        <p className="w-notice w-notice-error" role="alert">{text(locale, current.error)}</p>
      ) : null}
      {preview ? (
        <div className="w-stack">
          <dl className="w-definition-list">
            <dt>{msg(locale, "status")}</dt>
            <dd><span className="w-badge">{status ? text(locale, status) : msg(locale, "unknown")}</span></dd>
            <dt>{text(locale, "source")}</dt>
            <dd><code>{safe(preview.sourceDir)}</code></dd>
            <dt>{text(locale, "target")}</dt>
            <dd><code>{safe(preview.targetDir)}</code></dd>
            <dt>{text(locale, "manifest")}</dt>
            <dd><code>{preview.manifestHash || msg(locale, "unknown")}</code></dd>
          </dl>
          {preview.blockedReason ? (
            <p className="w-notice" role="status">{safe(preview.blockedReason)}</p>
          ) : null}
          {preview.status === "available" && !validPreview ? (
            <p className="w-notice w-notice-error" role="alert">{text(locale, "invalidPreview")}</p>
          ) : null}
          <div>
            <h3>{text(locale, "entries")}: {formatNumber(entries.length)}</h3>
            <p className="w-help">
              {(["copy", "archive", "retain"] as const)
                .map((action) => `${text(locale, action)} ${formatNumber(counts[action])}`)
                .join(" · ")}
              {` · ${formatNumber(counts.bytes)} B`}
            </p>
            {entries.length ? (
              <div className="w-file-list">
                {entries.map((entry, index) => (
                  <div className="w-file-row" key={`${entry.path}:${index}`}>
                    <div className="w-file-copy">
                      <code>{safe(entry.path)}</code>
                      <span className="w-help">{formatNumber(entry.sizeBytes)} B</span>
                    </div>
                    <span className="w-badge">{text(locale, entry.action)}</span>
                  </div>
                ))}
              </div>
            ) : <p className="w-help">{text(locale, "empty")}</p>}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
