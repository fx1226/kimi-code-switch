import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderOpen,
  Home,
  Layers,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import type { AppearanceMode, Locale, Profile } from "@shared/types";
import type { BootstrapResult, WebApi } from "@shared/webApi";
import type { ChangePlan, NativeResource, Operation, ResourceSnapshot } from "@shared/resourceProtocol";
import { createWebApi, subscribeWebEvents, WebApiError } from "../http/webApi";
import lightLogo from "../assets/logo-light.png";
import darkLogo from "../assets/logo-dark.png";
import { initialLocale, localeOptions, msg, type MessageKey } from "./messages";
import { Dialog, Empty, Tabs } from "./ui";
import { ResourceForm, validateResource, type ResourceKind } from "./ResourceForms";
import {
  capturePreset,
  draftChanges,
  draftKey,
  record,
  rebaseDraft,
  redactSource,
  resourceEntries,
  resourceGroup,
  type ResourceDraft,
} from "./drafts";
import { InventoryPanel, RecoveryPanel } from "./ToolsPanels";
import { ConfigurationPanel } from "./ConfigurationPanel";
import { MigrationDialog } from "./MigrationDialog";

type Page = "overview" | "connections" | "extensions" | "configuration" | "recovery" | "preferences";
const pages: Array<{ id: Page; icon: typeof Home }> = [
  { id: "overview", icon: Home },
  { id: "connections", icon: Layers },
  { id: "extensions", icon: Plus },
  { id: "configuration", icon: SlidersHorizontal },
  { id: "recovery", icon: ShieldCheck },
];
const resourceIds: NativeResource[] = [
  "config",
  "mcp",
  "mcp-project",
  "mcp-local",
  "tui",
  "agents",
  "project-local",
];
type McpScope = "mcp" | "mcp-project" | "mcp-local";
const projectResources = new Set<NativeResource>(["project-local", "mcp-project", "mcp-local"]);
const fileNames: Record<NativeResource, string> = {
  config: "config.toml",
  mcp: "mcp.json",
  "mcp-project": ".mcp.json",
  "mcp-local": ".kimi-code/mcp.json",
  tui: "tui.toml",
  agents: "AGENTS.md",
  "project-local": ".kimi-code/local.toml",
  "skills-directory": "skills/",
  "plugins-directory": "plugins/",
};
type Snapshots = Partial<Record<NativeResource, ResourceSnapshot>>;
interface PendingPlan {
  plan: ChangePlan;
  draftKey?: string;
  onCommitted?: () => void;
  uncertain?: boolean;
}
interface UiFailure {
  title: MessageKey;
  message: string;
  connection: boolean;
}
function failure(error: unknown): UiFailure {
  if (error instanceof WebApiError && error.code === "AUTH_REQUIRED")
    return { title: "unauthorized", message: error.message, connection: true };
  if (error instanceof WebApiError && error.code === "CONNECTION_LOST")
    return { title: "disconnected", message: error.message, connection: true };
  return {
    title: "readError",
    message: error instanceof Error ? error.message : String(error),
    connection: false,
  };
}
function routePage(): Page {
  const page = new URLSearchParams(location.search).get("page");
  return [...pages.map((entry) => entry.id), "preferences"].includes(page ?? "")
    ? (page as Page)
    : "overview";
}

export function WebApp({
  api: suppliedApi,
  events = !suppliedApi,
}: {
  api?: WebApi;
  events?: boolean;
}): JSX.Element {
  const api = useMemo(() => suppliedApi ?? createWebApi(), [suppliedApi]);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<AppearanceMode>("auto");
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshots>({});
  const [page, setPage] = useState<Page>(routePage);
  const [connectionKind, setConnectionKind] = useState<"provider" | "model" | "presets">("provider");
  const [extensionKind, setExtensionKind] = useState<"mcp" | "skills" | "plugins">("mcp");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, ResourceDraft>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [error, setError] = useState<UiFailure | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [streamConnected, setStreamConnected] = useState(true);
  const [pending, setPending] = useState<PendingPlan | null>(null);
  const [source, setSource] = useState<ResourceSnapshot | null>(null);
  const [targetDialog, setTargetDialog] = useState(false);
  const [migrationDialog, setMigrationDialog] = useState(false);
  const [editTargetDialog, setEditTargetDialog] = useState(false);
  const [mcpScope, setMcpScope] = useState<McpScope>("mcp");
  const [targetName, setTargetName] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const loadSequence = useRef(0);
  const targetId = bootstrap?.preferences.activeTargetId ?? "";
  const target = bootstrap?.targets.find((entry) => entry.id === targetId);
  const [presets, setPresets] = useState<Profile[]>([]);
  const [presetName, setPresetName] = useState("");
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      const element = event.target;
      if (element instanceof HTMLElement && element !== document.body && !element.closest("dialog"))
        lastFocus.current = element;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  const migrationPending = Boolean(bootstrap?.migrationAvailable);
  const readOnly =
    !bootstrap?.compatibility.nativeWritesAllowed || Boolean(bootstrap?.recovery.blocked) || migrationPending;
  const reportError = useCallback((cause: unknown) => {
    setError(failure(cause));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("kimi-code-switch:locale", locale);
    } catch {
      /* optional preference cache */
    }
  }, [locale]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      document.documentElement.dataset.theme = theme === "auto" ? (media.matches ? "dark" : "light") : theme;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  useEffect(() => {
    const pop = (): void => {
      if (configurationDirty && !window.confirm(msg(locale, "discard") + "?")) {
        const url = new URL(location.href);
        url.searchParams.set("page", page);
        history.pushState(null, "", url);
        return;
      }
      setPage(routePage());
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [configurationDirty, locale, page]);
  useEffect(() => {
    const hasChanges = Object.keys(drafts).length > 0 || configurationDirty;
    const guard = (event: BeforeUnloadEvent): void => {
      if (hasChanges || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [drafts, configurationDirty, busy]);

  const load = useCallback(
    async (explicit = false, requestedTargetId?: string, throwOnFailure = false): Promise<void> => {
      const sequence = ++loadSequence.current;
      setLoading(true);
      try {
        const next = await api.bootstrap();
        const id = requestedTargetId ?? next.preferences.activeTargetId;
        const requestedResources = resourceIds.filter(
          (resource) =>
            !projectResources.has(resource) ||
            next.targets.find((entry) => entry.id === id)?.workingDirectory,
        );
        const results = await Promise.allSettled(
          requestedResources.map((resource) => api.readResource({ targetId: id, resource })),
        );
        if (sequence !== loadSequence.current) return;
        const nextSnapshots: Snapshots = {};
        const readErrors: string[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") nextSnapshots[requestedResources[index]!] = result.value;
          else readErrors.push(`${fileNames[requestedResources[index]!]}: ${failure(result.reason).message}`);
        });
        setBootstrap({ ...next, preferences: { ...next.preferences, activeTargetId: id } });
        setLocale(next.preferences.locale);
        setTheme(next.preferences.theme);
        setSnapshots(nextSnapshots);
        if (explicit) {
          setDrafts((current) =>
            Object.fromEntries(
              Object.entries(current).map(([key, draft]) => {
                const snapshot = nextSnapshots[draft.resource ?? (draft.kind === "mcp" ? "mcp" : "config")];
                return [
                  key,
                  draft.targetId === id && snapshot && (!draft.path || draft.path === snapshot.path)
                    ? rebaseDraft(draft, snapshot)
                    : draft,
                ];
              }),
            ),
          );
        }
        setExternalChange(false);
        setError(
          readErrors.length
            ? { title: "readError", message: readErrors.join("\n"), connection: false }
            : null,
        );
      } catch (cause) {
        if (sequence === loadSequence.current) reportError(cause);
        if (throwOnFailure) throw cause;
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    },
    [api, reportError],
  );
  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (!events) return;
    return subscribeWebEvents((event) => {
      if (event.type === "resource-changed" && event.targetId === targetId) setExternalChange(true);
    }, setStreamConnected);
  }, [events, targetId]);
  useEffect(() => {
    if (!targetId || page !== "connections" || connectionKind !== "presets") return;
    let active = true;
    api
      .listPresets({ targetId })
      .then((next) => {
        if (active) setPresets(next);
      })
      .catch((cause) => {
        if (active) reportError(cause);
      });
    return () => {
      active = false;
    };
  }, [api, targetId, page, connectionKind, reportError]);

  const navigate = (next: Page): void => {
    if (
      configurationDirty &&
      next !== page &&
      !window.confirm(msg(locale, "draft") + ". " + msg(locale, "discard") + "?")
    )
      return;
    setPage(next);
    const url = new URL(location.href);
    url.searchParams.set("page", next);
    history.pushState(null, "", url);
  };
  const execute = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await action();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };
  const showPlan = (plan: ChangePlan, key?: string): void => setPending({ plan, draftKey: key });
  const applyPlan = async (checkOnly = false): Promise<void> => {
    if (!pending || (pending.uncertain && !checkOnly)) return;
    const selectedPlan = pending;
    await execute(async () => {
      let operation: Operation | null = null;
      if (checkOnly) operation = await api.getOperation({ id: selectedPlan.plan.id });
      else {
        try {
          operation = await api.applyChange({
            targetId,
            planId: selectedPlan.plan.id,
            expectedRevision: selectedPlan.plan.expectedRevision,
          });
        } catch (cause) {
          if (!(cause instanceof WebApiError && cause.code === "CONNECTION_LOST")) throw cause;
          setPending({ ...selectedPlan, uncertain: true });
          // A dropped response does not mean the write failed. Query the same
          // plan identity; never resend an apply request as a connectivity retry.
          try {
            operation = await api.getOperation({ id: selectedPlan.plan.id });
          } catch {
            throw cause;
          }
        }
      }
      if (!operation) {
        setPending({ ...selectedPlan, uncertain: true });
        throw new Error(msg(locale, "operationUncertain"));
      }
      for (let count = 0; ["queued", "committing"].includes(operation.status) && count < 120; count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        let next: Operation | null;
        try {
          next = await api.getOperation({ id: operation.id });
        } catch (cause) {
          setPending({ ...selectedPlan, uncertain: true });
          throw cause;
        }
        if (!next) {
          setPending({ ...selectedPlan, uncertain: true });
          throw new Error(`Operation ${operation.id} is unavailable.`);
        }
        operation = next;
      }
      if (operation.status !== "succeeded") {
        if (["queued", "committing", "recovery-required"].includes(operation.status))
          setPending({ ...selectedPlan, uncertain: true });
        throw new Error(
          operation.status === "conflict"
            ? msg(locale, "conflict")
            : operation.diagnostics.map((entry) => entry.message).join("\n") || operation.status,
        );
      }
      if (selectedPlan.draftKey)
        setDrafts((current) => {
          const next = { ...current };
          delete next[selectedPlan.draftKey!];
          return next;
        });
      selectedPlan.onCommitted?.();
      setPending(null);
      await load();
      setNotice(msg(locale, "saved"));
    });
  };
  const changeTarget = (id: string): void => {
    if (migrationPending) return;
    if (configurationDirty && !window.confirm(msg(locale, "discard") + "?")) return;
    void execute(async () => {
      await api.savePreferences({ activeTargetId: id });
      setConfigurationDirty(false);
      setSelected({});
      setMcpScope("mcp");
      await load(false, id);
    });
  };
  const changePreferences = (patch: { locale?: Locale; theme?: AppearanceMode }): void => {
    if (migrationPending) return;
    void execute(async () => {
      const next = await api.savePreferences(patch);
      setLocale(next.locale);
      setTheme(next.theme);
      setNotice(msg(next.locale, "settingsSaved"));
    });
  };

  const renderResources = (kind: ResourceKind): JSX.Element => {
    const nativeId = kind === "mcp" ? mcpScope : "config";
    const snapshot = snapshots[nativeId];
    const entries = resourceEntries(snapshot, kind);
    const scope =
      kind === "mcp" ? `${nativeId}:${snapshot?.path ?? target?.workingDirectory ?? ""}` : undefined;
    const localDrafts = Object.values(drafts).filter(
      (entry) =>
        entry.targetId === targetId && entry.kind === kind && entry.scope === scope && !entry.originalName,
    );
    const selectionKey = `${targetId}:${kind}:${scope ?? ""}`;
    const selectedId = selected[selectionKey] ?? Object.keys(entries)[0] ?? localDrafts[0]?.key ?? "";
    const existingKey = draftKey(targetId, kind, selectedId, scope);
    const currentDraft = drafts[selectedId] ?? drafts[existingKey];
    const baseValue = record(entries[selectedId]);
    const current =
      currentDraft ??
      (selectedId && Object.hasOwn(entries, selectedId) && snapshot
        ? ({
            key: existingKey,
            targetId,
            kind,
            originalName: selectedId,
            name: selectedId,
            base: baseValue,
            value: baseValue,
            revision: snapshot.revision,
            resource: nativeId,
            scope,
            path: snapshot.path,
          } satisfies ResourceDraft)
        : null);
    const canEdit =
      Boolean(snapshot) &&
      !readOnly &&
      !busy &&
      !loading &&
      !snapshot?.diagnostics.some((entry) => entry.severity === "error");
    const errors = current ? validateResource(kind, current.name, current.value) : [];
    const hasEdits = Boolean(current && (current.originalName === null || draftChanges(current).length > 0));
    const setDraft = (patch: Partial<ResourceDraft>): void => {
      if (current) setDrafts((all) => ({ ...all, [current.key]: { ...current, ...patch } }));
    };
    const add = (): void => {
      const key = `${targetId}:${kind}:new:${crypto.randomUUID()}`;
      const value =
        kind === "provider"
          ? { type: "kimi", base_url: "", api_key: "" }
          : kind === "model"
            ? { provider: "", model: "" }
            : { transport: "stdio", command: "", args: [] };
      setDrafts((all) => ({
        ...all,
        [key]: {
          key,
          targetId,
          kind,
          originalName: null,
          name: "",
          base: {},
          value,
          revision: snapshot?.revision ?? "",
          resource: nativeId,
          scope,
          path: snapshot?.path,
        },
      }));
      setSelected((all) => ({ ...all, [selectionKey]: key }));
    };
    return (
      <ResourceWorkspace
        locale={locale}
        kind={kind}
        entries={entries}
        drafts={drafts}
        newDrafts={localDrafts}
        targetId={targetId}
        scope={scope}
        selectedId={selectedId}
        onSelect={(id) => setSelected((all) => ({ ...all, [selectionKey]: id }))}
        onAdd={add}
        canEdit={canEdit}
      >
        {snapshot?.diagnostics.map((entry, index) => (
          <div
            key={index}
            className={`w-notice ${entry.severity === "error" ? "w-notice-error" : ""}`}
            role={entry.severity === "error" ? "alert" : "status"}
          >
            {entry.message}
          </div>
        ))}
        {current ? (
          <>
            <div className="w-editor-header">
              <h2>{current.name || msg(locale, "add")}</h2>
              <div className="w-inline-actions">
                {snapshot ? (
                  <button className="w-button w-button-quiet" onClick={() => setSource(snapshot)}>
                    <FileText size={14} />
                    {msg(locale, "source")}
                  </button>
                ) : null}
                {current.originalName ? (
                  <button
                    className="w-button w-button-danger"
                    disabled={!canEdit || busy}
                    onClick={() =>
                      void execute(async () =>
                        showPlan(
                          await api.planChange({
                            targetId,
                            resource: nativeId,
                            expectedRevision: snapshot!.revision,
                            changes: [{ op: "delete", path: [resourceGroup(kind), current.originalName!] }],
                          }),
                          current.key,
                        ),
                      )
                    }
                  >
                    {msg(locale, "remove")}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="w-help">
              <code>{snapshot?.path}</code>
            </p>
            <ResourceForm
              key={current.key}
              kind={kind}
              name={current.name}
              value={current.value}
              locale={locale}
              existing={current.originalName !== null}
              disabled={!canEdit || busy}
              onNameChange={(name) => setDraft({ name })}
              onChange={(value) => setDraft({ value })}
            />
            {current.originalName && kind === "mcp" ? (
              <div className="w-inline-actions">
                <button
                  className="w-button"
                  disabled={busy || hasEdits}
                  onClick={() =>
                    void execute(async () => {
                      const result = await api.testMcp({
                        targetId,
                        name: current.originalName!,
                        resource: mcpScope,
                      });
                      setNotice(redactSource(JSON.stringify(result)));
                    })
                  }
                >
                  MCP {msg(locale, "diagnostics")}
                </button>
                <button
                  className="w-button"
                  disabled={busy || hasEdits}
                  onClick={() =>
                    void execute(async () => {
                      const result = await api.listMcpTools({
                        targetId,
                        name: current.originalName!,
                        resource: mcpScope,
                      });
                      setNotice(result.tools.map((tool) => tool.name).join(", ") || "0 tools");
                    })
                  }
                >
                  MCP tools
                </button>
              </div>
            ) : null}
            <div className="w-draft-bar">
              <span className="w-status-line">
                {hasEdits ? (
                  <>
                    <span className="w-dirty-dot" />
                    {msg(locale, "draft")}
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    {msg(locale, "nativeFiles")}
                  </>
                )}
              </span>
              <div className="w-draft-actions">
                {hasEdits ? (
                  <button
                    className="w-button w-button-quiet"
                    disabled={busy}
                    onClick={() =>
                      setDrafts((all) => {
                        const next = { ...all };
                        delete next[current.key];
                        return next;
                      })
                    }
                  >
                    {msg(locale, "discard")}
                  </button>
                ) : null}
                <button
                  className="w-button w-button-primary"
                  disabled={
                    !canEdit ||
                    !hasEdits ||
                    busy ||
                    errors.length > 0 ||
                    (!current.originalName && Object.hasOwn(entries, current.name.trim()))
                  }
                  onClick={() =>
                    void execute(async () =>
                      showPlan(
                        await api.planChange({
                          targetId,
                          resource: nativeId,
                          expectedRevision: current.revision,
                          changes: draftChanges(current),
                        }),
                        current.key,
                      ),
                    )
                  }
                >
                  {msg(locale, "preview")}
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <Empty
            action={
              canEdit ? (
                <button className="w-button" onClick={add}>
                  <Plus size={14} />
                  {msg(locale, "add")}
                </button>
              ) : undefined
            }
          >
            {snapshot ? msg(locale, "selectResource") : msg(locale, "readError")}
          </Empty>
        )}
      </ResourceWorkspace>
    );
  };

  if (!bootstrap)
    return (
      <div className="w-connection-page">
        <main className="w-connection-content">
          <Brand theme={theme} />
          <h1>{msg(locale, loading ? "loading" : (error?.title ?? "readError"))}</h1>
          {error ? (
            <>
              <p>
                {msg(
                  locale,
                  error.title === "unauthorized"
                    ? "unauthorizedHelp"
                    : error.connection
                      ? "disconnectedHelp"
                      : "readError",
                )}
              </p>
              <pre>{error.message}</pre>
              <button className="w-button w-button-primary" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={15} />
                {msg(locale, "retry")}
              </button>
            </>
          ) : (
            <LoaderCircle className="w-loading-icon" size={22} />
          )}
        </main>
      </div>
    );

  return (
    <div className="w-shell">
      <aside className="w-sidebar">
        <Brand theme={theme} />
        <nav aria-label={msg(locale, "localOnly")}>
          {pages.map(({ id, icon: Icon }) => (
            <button
              key={id}
              className="w-nav-button"
              aria-current={page === id ? "page" : undefined}
              title={msg(locale, id)}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{msg(locale, id)}</span>
            </button>
          ))}
        </nav>
        <div className="w-sidebar-footer">
          <button
            className="w-nav-button"
            title={msg(locale, "preferences")}
            aria-current={page === "preferences" ? "page" : undefined}
            onClick={() => navigate("preferences")}
          >
            <Settings2 size={18} />
            <span>{msg(locale, "preferences")}</span>
          </button>
          <p>
            {msg(locale, "localOnly")}
            <br />v{bootstrap.version}
          </p>
        </div>
      </aside>
      <main className="w-main">
        <header className="w-context">
          <div className="w-target">
            <FolderOpen size={18} />
            <div className="w-target-label">
              <span>{msg(locale, "target")}</span>
              <select
                aria-label={msg(locale, "target")}
                value={targetId}
                disabled={busy || loading || migrationPending}
                onChange={(event) => changeTarget(event.target.value)}
              >
                {bootstrap.targets.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <code title={target?.homePath}>{target?.homePath}</code>
            </div>
          </div>
          <div className="w-context-actions">
            <button
              className="w-button w-button-quiet w-icon-button"
              disabled={busy || migrationPending}
              aria-label={msg(locale, "editTarget")}
              title={msg(locale, "editTarget")}
              onClick={() => {
                setWorkingDirectory(target?.workingDirectory ?? "");
                setEditTargetDialog(true);
              }}
            >
              <Settings2 size={16} />
            </button>
            <button
              className="w-button w-button-quiet"
              onClick={() => setTargetDialog(true)}
              disabled={busy || migrationPending}
              title={msg(locale, "addTarget")}
              aria-label={msg(locale, "addTarget")}
            >
              <Plus size={16} />
              <span>{msg(locale, "addTarget")}</span>
            </button>
            <button
              className="w-button"
              onClick={() => void load(true)}
              disabled={busy || loading}
              title={msg(locale, "refresh")}
              aria-label={msg(locale, "refresh")}
            >
              <RefreshCw size={15} className={loading ? "w-loading-icon" : ""} />
              <span>{msg(locale, "refresh")}</span>
            </button>
          </div>
        </header>
        <div className="w-page">
          <div className="w-page-heading">
            <div>
              <h1>{msg(locale, page)}</h1>
              <p>
                {page === "overview"
                  ? msg(locale, "localOnly")
                  : page === "preferences"
                    ? msg(locale, "preferencesHelp")
                    : target?.name}
              </p>
            </div>
            {readOnly ? <span className="w-badge w-badge-warning">{msg(locale, "readOnly")}</span> : null}
          </div>
          {migrationPending ? (
            <div className="w-notice" role="status">
              <FolderOpen size={17} />
              <div>
                <strong>{msg(locale, "migrationNeeded")}</strong>
                <p>{msg(locale, "migrationHelp")}</p>
                <button className="w-button" onClick={() => setMigrationDialog(true)}>
                  {msg(locale, "reviewMigration")}
                </button>
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="w-notice w-notice-error" role="alert">
              <AlertCircle size={17} />
              <div>
                <strong>{msg(locale, error.title)}</strong>
                <p>{error.message}</p>
                {error.connection ? (
                  <button className="w-button" onClick={() => void load()}>
                    {msg(locale, "retry")}
                  </button>
                ) : null}
              </div>
              <button
                className="w-button w-button-quiet w-icon-button"
                aria-label={msg(locale, "close")}
                onClick={() => setError(null)}
              >
                <X size={15} />
              </button>
            </div>
          ) : null}
          {notice ? (
            <div className="w-notice w-notice-success" role="status">
              <Check size={17} />
              <div>{notice}</div>
              <button
                className="w-button w-button-quiet w-icon-button"
                aria-label={msg(locale, "close")}
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          ) : null}
          {!streamConnected ? (
            <div className="w-notice" role="status">
              <Unplug size={16} />
              <div>{msg(locale, "disconnectedHelp")}</div>
            </div>
          ) : null}
          {externalChange ? (
            <div className="w-notice" role="alert">
              <AlertCircle size={16} />
              <div>{msg(locale, "conflict")}</div>
              <button className="w-button" onClick={() => void load(true)}>
                {msg(locale, "refresh")}
              </button>
            </div>
          ) : null}
          {!bootstrap.compatibility.nativeWritesAllowed ? (
            <div className="w-notice">
              <CircleHelp size={17} />
              <div>
                {msg(locale, bootstrap.compatibility.detectedVersion ? "incompatible" : "notInstalled")}
              </div>
            </div>
          ) : null}
          {bootstrap.recovery.blocked ? (
            <div className="w-notice w-notice-error" role="alert">
              <ShieldCheck size={17} />
              <div>{bootstrap.recovery.message ?? msg(locale, "pendingRecovery")}</div>
            </div>
          ) : null}
          {page === "overview" ? (
            <div className="w-overview-grid">
              <section className="w-section">
                <div className="w-section-heading">
                  <h2>{msg(locale, "nativeFiles")}</h2>
                </div>
                {!snapshots.config?.exists && snapshots.config ? (
                  <p className="w-help">{msg(locale, "emptyConfig")}</p>
                ) : null}
                <div className="w-file-list">
                  {resourceIds
                    .filter((id) => !projectResources.has(id) || target?.workingDirectory)
                    .map((id) => {
                      const snapshot = snapshots[id];
                      return (
                        <div key={id} className="w-file-row">
                          <FileText size={17} />
                          <div className="w-file-copy">
                            <strong>{fileNames[id]}</strong>
                            <code>{snapshot?.path ?? msg(locale, "readError")}</code>
                          </div>
                          <span
                            className={`w-badge ${snapshot?.diagnostics.some((item) => item.severity === "error") ? "w-badge-warning" : ""}`}
                          >
                            {!snapshot
                              ? msg(locale, "readError")
                              : snapshot.diagnostics.some((item) => item.severity === "error")
                                ? msg(locale, "invalidFile")
                                : !snapshot.exists
                                  ? msg(locale, "missing")
                                  : readOnly
                                    ? msg(locale, "readOnly")
                                    : msg(locale, "ready")}
                          </span>
                          <button
                            className="w-button w-button-quiet w-icon-button"
                            disabled={!snapshot?.exists}
                            title={msg(locale, "source")}
                            aria-label={`${msg(locale, "source")} ${fileNames[id]}`}
                            onClick={() => snapshot && setSource(snapshot)}
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      );
                    })}
                </div>
              </section>
              <div className="w-stack">
                <section className="w-section">
                  <h2>Kimi Code</h2>
                  <dl className="w-definition-list">
                    <dt>{msg(locale, "version")}</dt>
                    <dd>{bootstrap.compatibility.detectedVersion ?? msg(locale, "notInstalled")}</dd>
                    <dt>{msg(locale, "status")}</dt>
                    <dd>
                      {msg(
                        locale,
                        bootstrap.compatibility.nativeWritesAllowed
                          ? "contractMatched"
                          : "unverifiedContract",
                      )}
                    </dd>
                    <dt>{msg(locale, "defaultModel")}</dt>
                    <dd>{String(record(snapshots.config?.data).default_model ?? "—")}</dd>
                    {bootstrap.officialAccount ? (
                      <>
                        <dt>{msg(locale, "account")}</dt>
                        <dd>
                          {msg(
                            locale,
                            (
                              {
                                stored: "accountStored",
                                expired: "accountExpired",
                                missing: "accountMissing",
                                revoked: "accountRevoked",
                                invalid: "accountInvalid",
                                unavailable: "unknown",
                              } as const
                            )[bootstrap.officialAccount.status],
                          )}
                          <p className="w-help">{msg(locale, "accountLocal")}</p>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </section>
                <CliPanel api={api} targetId={targetId} locale={locale} busy={busy} loginBlocked={readOnly} execute={execute} />
              </div>
            </div>
          ) : null}
          {page === "connections" ? (
            <>
              <Tabs
                label={msg(locale, "connections")}
                tabs={[
                  { id: "provider", label: msg(locale, "providers") },
                  { id: "model", label: msg(locale, "models") },
                  { id: "presets", label: msg(locale, "presets") },
                ]}
                active={connectionKind}
                onChange={setConnectionKind}
              />
              <div
                role="tabpanel"
                id={`web-panel-${connectionKind}`}
                aria-labelledby={`web-tab-${connectionKind}`}
              >
                {connectionKind !== "presets" ? (
                  renderResources(connectionKind)
                ) : (
                  <section className="w-section">
                    <h2>{msg(locale, "presets")}</h2>
                    <p className="w-help">{msg(locale, "presetHelp")}</p>
                    <div className="w-file-list">
                      {presets.map((preset) => (
                        <div className="w-file-row" key={preset.name}>
                          <div className="w-file-copy">
                            <strong>{preset.label || preset.name}</strong>
                            <code>{preset.default_model}</code>
                          </div>
                          <button
                            className="w-button"
                            disabled={busy || readOnly}
                            onClick={() =>
                              void execute(async () =>
                                showPlan(await api.planPreset({ targetId, name: preset.name })),
                              )
                            }
                          >
                            {msg(locale, "applyPreset")}
                          </button>
                          <button
                            className="w-button w-button-quiet w-button-danger"
                            disabled={busy || migrationPending}
                            onClick={() =>
                              void execute(async () => {
                                await api.deletePreset({ targetId, name: preset.name });
                                setPresets(await api.listPresets({ targetId }));
                              })
                            }
                          >
                            {msg(locale, "remove")}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="w-field-grid">
                      <label className="w-field">
                        <span>{msg(locale, "name")}</span>
                        <input value={presetName} onChange={(event) => setPresetName(event.target.value)} />
                      </label>
                    </div>
                    <div className="w-inline-actions" style={{ marginTop: 16 }}>
                      <button
                        className="w-button"
                        disabled={busy || migrationPending || !presetName.trim() || !record(snapshots.config?.data).default_model}
                        onClick={() =>
                          void execute(async () => {
                            const data = record(snapshots.config?.data);
                            await api.savePreset({
                              targetId,
                              preset: capturePreset(presetName.trim(), data),
                            });
                            setPresets(await api.listPresets({ targetId }));
                            setPresetName("");
                          })
                        }
                      >
                        {msg(locale, "capturePreset")}
                      </button>
                    </div>
                  </section>
                )}
              </div>
            </>
          ) : null}
          {page === "extensions" ? (
            <>
              <Tabs
                label={msg(locale, "extensions")}
                tabs={[
                  { id: "mcp", label: "MCP" },
                  { id: "skills", label: msg(locale, "skills") },
                  { id: "plugins", label: msg(locale, "plugins") },
                ]}
                active={extensionKind}
                onChange={setExtensionKind}
              />
              <div
                role="tabpanel"
                id={`web-panel-${extensionKind}`}
                aria-labelledby={`web-tab-${extensionKind}`}
              >
                {extensionKind === "mcp" ? (
                  <>
                    <section className="w-mcp-scope">
                      <label className="w-field">
                        <span>{msg(locale, "mcpScope")}</span>
                        <select
                          aria-label={msg(locale, "mcpScope")}
                          value={mcpScope}
                          onChange={(event) => setMcpScope(event.target.value as McpScope)}
                        >
                          <option value="mcp">{msg(locale, "mcpUser")}</option>
                          <option value="mcp-project" disabled={!target?.workingDirectory}>
                            {msg(locale, "mcpProject")}
                          </option>
                          <option value="mcp-local" disabled={!target?.workingDirectory}>
                            {msg(locale, "mcpLocal")}
                          </option>
                        </select>
                      </label>
                      <p className="w-help">{msg(locale, "mcpPrecedence")}</p>
                    </section>
                    {renderResources("mcp")}
                  </>
                ) : (
                  <InventoryPanel
                    key={`${targetId}:${extensionKind}`}
                    api={api}
                    targetId={targetId}
                    locale={locale}
                    kind={extensionKind}
                    onError={reportError}
                  />
                )}
              </div>
            </>
          ) : null}
          {page === "configuration" ? (
            <ConfigurationPanel
              key={`${targetId}:${target?.workingDirectory ?? ""}`}
              api={api}
              targetId={targetId}
              locale={locale}
              snapshots={snapshots}
              readOnly={readOnly || busy}
              onPlan={(plan, onCommitted) => setPending({ plan, onCommitted })}
              onError={reportError}
              onDirtyChange={setConfigurationDirty}
              onSource={setSource}
            />
          ) : null}
          {page === "recovery" ? (
            <RecoveryPanel
              key={targetId}
              api={api}
              targetId={targetId}
              locale={locale}
              onError={reportError}
              onPlan={showPlan}
              blocked={readOnly}
              privateWritesBlocked={migrationPending}
              onRecovered={() => void load()}
            />
          ) : null}
          {page === "preferences" ? (
            <section className="w-section">
              <div className="w-field-grid">
                <label className="w-field">
                  <span>{msg(locale, "language")}</span>
                  <select
                    aria-label={msg(locale, "language")}
                    value={locale}
                    disabled={busy || migrationPending}
                    onChange={(event) => changePreferences({ locale: event.target.value as Locale })}
                  >
                    {localeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="w-field">
                  <span>{msg(locale, "appearance")}</span>
                  <select
                    aria-label={msg(locale, "appearance")}
                    value={theme}
                    disabled={busy || migrationPending}
                    onChange={(event) => changePreferences({ theme: event.target.value as AppearanceMode })}
                  >
                    {(["auto", "light", "dark"] as const).map((value) => (
                      <option key={value} value={value}>
                        {msg(locale, value === "auto" ? "system" : value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="w-preferences-links">
                <span>Kimi Code Switch v{bootstrap.version}</span>
                <a
                  href="https://github.com/fx1226/kimi-code-switch/releases"
                  target="_blank"
                  rel="noreferrer"
                >
                  {msg(locale, "releases")}
                </a>
                <a href="https://github.com/fx1226/kimi-code-switch/issues" target="_blank" rel="noreferrer">
                  {msg(locale, "issueFeedback")}
                </a>
              </div>
            </section>
          ) : null}
          <footer className="w-page-footer">Kimi Code Switch · {msg(locale, "localOnly")}</footer>
        </div>
      </main>
      {migrationDialog ? (
        <MigrationDialog
          api={api}
          locale={locale}
          onClose={() => setMigrationDialog(false)}
          onMigrated={async () => {
            setSelected({});
            setDrafts({});
            setConfigurationDirty(false);
            await load(false, undefined, true);
            setNotice(msg(locale, "migrationDone"));
          }}
        />
      ) : null}
      {pending ? (
        <Dialog
          returnFocus={lastFocus.current}
          locale={locale}
          title={msg(locale, "changeSummary")}
          busy={busy}
          onClose={() => setPending(null)}
          footer={
            <>
              <button className="w-button" disabled={busy} onClick={() => setPending(null)}>
                {msg(locale, "cancel")}
              </button>
              <button
                className="w-button w-button-primary"
                disabled={
                  busy ||
                  readOnly ||
                  pending.uncertain ||
                  !pending.plan.changed ||
                  pending.plan.validation !== "passed" ||
                  pending.plan.diagnostics.some((entry) => entry.severity === "error")
                }
                onClick={() => void applyPlan()}
              >
                {busy ? msg(locale, "busy") : msg(locale, "apply")}
              </button>
            </>
          }
        >
          <p className="w-help">{msg(locale, "applyHelp")}</p>
          <code>{pending.plan.path}</code>
          {pending.plan.resources?.map((entry) => (
            <div key={entry.path} className="w-summary-item">
              <strong>{entry.resource}</strong>
              <code>{entry.path}</code>
            </div>
          ))}
          {pending.plan.diagnostics.map((entry, index) => (
            <p className={entry.severity === "error" ? "w-validation" : "w-help"} key={index}>
              {entry.message}
            </p>
          ))}
          {pending.uncertain ? (
            <div className="w-notice w-notice-error">
              <div>
                <p>{msg(locale, "operationUncertain")}</p>
                <button className="w-button" disabled={busy} onClick={() => void applyPlan(true)}>
                  {msg(locale, "checkOperation")}
                </button>
              </div>
            </div>
          ) : null}
          <h3>{msg(locale, "before")}</h3>
          <pre className="w-diff">{redactSource(pending.plan.redactedPreview.before)}</pre>
          <h3>{msg(locale, "after")}</h3>
          <pre className="w-diff">{redactSource(pending.plan.redactedPreview.after)}</pre>
        </Dialog>
      ) : null}
      {source ? (
        <Dialog locale={locale} title={fileNames[source.resource]} onClose={() => setSource(null)}>
          <code>{source.path}</code>
          <p className="w-help">{msg(locale, "sourceHelp")}</p>
          <pre className="w-source">{redactSource(source.content)}</pre>
        </Dialog>
      ) : null}
      {editTargetDialog ? (
        <Dialog
          locale={locale}
          title={msg(locale, "editTarget")}
          busy={busy}
          onClose={() => setEditTargetDialog(false)}
          footer={
            <>
              <button className="w-button" disabled={busy} onClick={() => setEditTargetDialog(false)}>
                {msg(locale, "cancel")}
              </button>
              <button
                className="w-button w-button-primary"
                disabled={busy || migrationPending}
                onClick={() => {
                  if (configurationDirty && !window.confirm(msg(locale, "discard") + "?")) return;
                  void execute(async () => {
                    await api.updateTarget({ targetId, workingDirectory: workingDirectory.trim() || null });
                    setEditTargetDialog(false);
                    setConfigurationDirty(false);
                    setMcpScope("mcp");
                    setSelected({});
                    await load();
                  });
                }}
              >
                {msg(locale, "saveTarget")}
              </button>
            </>
          }
        >
          <p className="w-help">{msg(locale, "projectContextHelp")}</p>
          <code>{target?.homePath}</code>
          <label className="w-field">
            <span>{msg(locale, "workingDirectory")}</span>
            <input
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
              autoComplete="off"
            />
          </label>
        </Dialog>
      ) : null}
      {targetDialog ? (
        <Dialog
          locale={locale}
          title={msg(locale, "addTarget")}
          busy={busy}
          onClose={() => setTargetDialog(false)}
          footer={
            <>
              <button className="w-button" disabled={busy} onClick={() => setTargetDialog(false)}>
                {msg(locale, "cancel")}
              </button>
              <button
                className="w-button w-button-primary"
                disabled={busy || migrationPending || !targetName.trim() || !targetPath.trim()}
                onClick={() =>
                  void execute(async () => {
                    await api.addTarget({
                      name: targetName.trim(),
                      homePath: targetPath.trim(),
                      ...(workingDirectory.trim() ? { workingDirectory: workingDirectory.trim() } : {}),
                    });
                    setTargetDialog(false);
                    setTargetName("");
                    setTargetPath("");
                    setWorkingDirectory("");
                    await load();
                  })
                }
              >
                {msg(locale, "add")}
              </button>
            </>
          }
        >
          <p className="w-help">{msg(locale, "targetHelp")}</p>
          <label className="w-field">
            <span>{msg(locale, "targetName")}</span>
            <input value={targetName} onChange={(event) => setTargetName(event.target.value)} />
          </label>
          <label className="w-field">
            <span>{msg(locale, "targetPath")}</span>
            <input
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
              placeholder="/Users/name/.kimi-code"
              autoComplete="off"
            />
          </label>
          <label className="w-field">
            <span>{msg(locale, "workingDirectory")}</span>
            <input
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
              placeholder="/Users/name/project"
              autoComplete="off"
            />
          </label>
        </Dialog>
      ) : null}
    </div>
  );
}

function Brand({ theme }: { theme: AppearanceMode }): JSX.Element {
  return (
    <div className="w-brand">
      <img src={theme === "dark" ? darkLogo : lightLogo} alt="" />
      <span>Kimi Code Switch</span>
    </div>
  );
}

function ResourceWorkspace({
  locale,
  kind,
  entries,
  drafts,
  newDrafts,
  targetId,
  scope,
  selectedId,
  onSelect,
  onAdd,
  canEdit,
  children,
}: {
  locale: Locale;
  kind: ResourceKind;
  entries: Record<string, unknown>;
  drafts: Record<string, ResourceDraft>;
  newDrafts: ResourceDraft[];
  targetId: string;
  scope?: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  canEdit: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const names = Object.keys(entries).filter((name) => name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="w-workspace">
      <aside className="w-resource-list">
        <div className="w-list-toolbar">
          <input
            className="w-input"
            aria-label={msg(locale, "search")}
            placeholder={msg(locale, "search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            className="w-button w-icon-button"
            aria-label={msg(locale, "add")}
            title={msg(locale, "add")}
            disabled={!canEdit}
            onClick={onAdd}
          >
            <Plus size={16} />
          </button>
        </div>
        <ul>
          {names.map((name) => (
            <li key={name}>
              <button
                className="w-resource-item"
                aria-current={selectedId === name ? "true" : undefined}
                onClick={() => onSelect(name)}
              >
                <span>
                  <strong>{name}</strong>
                  <small>
                    {String(
                      record(entries[name])[
                        kind === "provider" ? "type" : kind === "model" ? "provider" : "type"
                      ] ?? "",
                    )}
                  </small>
                </span>
                {drafts[draftKey(targetId, kind, name, scope)] ? (
                  <span className="w-dirty-dot" aria-label={msg(locale, "draft")} />
                ) : null}
              </button>
            </li>
          ))}
          {newDrafts.map((draft) => (
            <li key={draft.key}>
              <button
                className="w-resource-item"
                aria-current={selectedId === draft.key ? "true" : undefined}
                onClick={() => onSelect(draft.key)}
              >
                <span>{draft.name || msg(locale, "add")}</span>
                <span className="w-dirty-dot" aria-label={msg(locale, "draft")} />
              </button>
            </li>
          ))}
        </ul>
        {names.length === 0 && newDrafts.length === 0 ? (
          <p className="w-help">{msg(locale, search ? "noMatches" : "noResources")}</p>
        ) : null}
      </aside>
      <div className="w-editor">{children}</div>
    </div>
  );
}

function CliPanel({
  api,
  targetId,
  locale,
  busy,
  loginBlocked,
  execute,
}: {
  api: WebApi;
  targetId: string;
  locale: Locale;
  busy: boolean;
  loginBlocked: boolean;
  execute: (action: () => Promise<void>) => Promise<void>;
}): JSX.Element {
  return (
    <section className="w-section">
      <h2>{msg(locale, "cli")}</h2>
      <p className="w-help">{msg(locale, "cliHelp")}</p>
      <div className="w-inline-actions" style={{ marginTop: 16 }}>
        <button
          className="w-button"
          disabled={busy}
          onClick={() => void execute(async () => api.openKimi({ targetId }))}
        >
          <Terminal size={15} />
          {msg(locale, "cli")}
        </button>
        <button
          className="w-button"
          disabled={busy || loginBlocked}
          onClick={() =>
            void execute(async () => {
              await api.login({ targetId });
            })
          }
        >
          {msg(locale, "login")}
        </button>
      </div>
    </section>
  );
}
