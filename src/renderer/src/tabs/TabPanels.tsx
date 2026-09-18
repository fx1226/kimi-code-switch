import { useEffect, useRef, useState } from "react";
import { Activity, Braces, Bug, CircleCheckBig, Copy, Download, ExternalLink, FileInput, FolderOpen, History, LoaderCircle, LogIn, Plus, Power, RefreshCw, RotateCcw, Save, Terminal, Trash2, Upload, X } from "lucide-react";
import { applyProfile, assessFullBackupRisk, cloneProfile, createDefaultKimiCodeEnvironment, deleteModel, deleteProfile, deleteProvider, fullBackupContainsRedactedSecrets, getKimiCodeConfigPath, getKimiCodeMcpConfigPath, getKimiCodeSkillsPath, getKimiCodeEnvironmentHomePath, normalizeKimiCodeEnvironments, validateFullBackup, upsertModel, upsertProfile, upsertProvider } from "@shared/configStore";
import { buildMcpConfigDocument } from "@shared/mcpStore";
import { buildModelName, ensureUniqueEntryName, normalizeEntryName } from "@shared/nameRules";
import { getCascadePreview } from "@shared/configRelations";
import {
  formatAcceleratorForPlatform,
  getBrowserShortcutPlatform,
  getShortcutConflicts,
  resetShortcutBinding,
  SHORTCUT_ACTIONS,
} from "@shared/shortcutStore";
import type {
  AppearanceMode,
  AppearanceTheme,
  AppState,
  BackupDestinationType,
  BackupFrequency,
  BackupStrategy,
  CloseBehavior,
  DisplayOpenMode,
  FullBackupBundle,
  KimiCodeInstallSource,
  KimiCodeEnvironment,
  Locale,
  OfficialAccount,
  ShortcutAction,
  ShortcutBinding,
  ConfigDoctorReport,
  TerminalApp,
  TuiConfig,
} from "@shared/types";

import { AboutPage } from "../aboutPage";
import { ChatgptBridgePanel } from "../chatgptBridgePanel";
import { getHistory, restoreHistoryEntry } from "../historyManager";
import { getApi, getMcpAction, getMcpActionNotice, getResourceLabel, createUniqueName, renameModelInState, renameProviderInState } from "../appHelpers";
import {
  APPEARANCE_THEME_OPTIONS,
  BACKUP_DESTINATION_OPTIONS, BACKUP_FREQUENCY_OPTIONS, BACKUP_STRATEGY_OPTIONS,
  CLOSE_BEHAVIOR_OPTIONS, DISPLAY_OPEN_OPTIONS, labelForLocale, LOCALE_OPTIONS, TERMINAL_APP_OPTIONS, THEME_OPTIONS, UI_FONT_SIZE_OPTIONS,
} from "../appOptions";
import type { KimiCodeSubTab, SettingsSubTab } from "../appOptions";
import { DialogShell } from "../dialogs";
import { ErrorBoundary } from "../ErrorBoundary";
import { isDesktopRuntime } from "../runtime";
import { CompactSelect, Field, FontSizeSliderField, SelectField, SettingsGroup, ShortcutRecorderField } from "../formControls";
import { t, translateError } from "../i18n";
import { InsightsSettingsPanel, InsightsDashboard } from "../insightsComponents";
import { EmptyState, ResourceWorkspace } from "../layoutComponents";
import { ProviderHealthBanner } from "../providerHealthBanner";
import { OverviewDashboard } from "../overviewDashboard";
import { SkillsWorkspace } from "../skillsWorkspace";
import { TabList } from "../tabList";
import type { KimiOAuthLoginEvent, ProviderCatalogSummary, ProviderHealthResult } from "../tauri/cli";
import {
  assignLegacySnapshotEnvironment,
  listSnapshots,
  restoreSnapshot,
  type SnapshotRecord,
} from "../tauri/configHistory";
import type { AppContext } from "./appContext";
import {
  ProviderForm, ModelForm, ProfileForm, McpServerForm,
  SecretField, PathField, createCopyName, createDefaultMcpServer,
  formatMessage, formatSkillPathLabel, renderSkillPathLabel, DoctorDriftList, McpJsonViewerDialog,
} from "../tabComponents";

type TabPanelsProps = Pick<
  AppContext,
  | "state"
  | "activeTab"
  | "activeSettingsSubTab"
  | "setActiveSettingsSubTab"
  | "kimiCodeSubTab"
  | "setKimiCodeSubTab"
  | "locale"
  | "diagnostics"
  | "selectedProvider"
  | "setSelectedProvider"
  | "selectedModel"
  | "setSelectedModel"
  | "selectedProfile"
  | "setSelectedProfile"
  | "selectedMcpServer"
  | "setSelectedMcpServer"
  | "setSelectedSkill"
  | "setSelectedSkillPath"
  | "skillsViewMode"
  | "setSkillsViewMode"
  | "skillsReport"
  | "isSkillsLoading"
  | "providerEntries"
  | "modelEntries"
  | "profileEntries"
  | "mcpEntries"
  | "skillPathEntries"
  | "skillEntries"
  | "sortedSkillPathEntries"
  | "visibleSkillEntries"
  | "selectedProviderName"
  | "selectedModelName"
  | "selectedProfileName"
  | "selectedMcpServerName"
  | "selectedSkillPathId"
  | "selectedSkillData"
  | "selectedSkillPathData"
  | "selectedProviderData"
  | "selectedModelData"
  | "selectedProfileData"
  | "selectedMcpServerData"
  | "isProviderNameEditable"
  | "isProfileNameEditable"
  | "isMcpServerNameEditable"
  | "dirtyProviders"
  | "dirtyModels"
  | "dirtyProfiles"
  | "dirtyMcpServers"
  | "setIsMcpImportOpen"
  | "setMcpImportDraft"
  | "setMcpImportInitialDraft"
  | "mcpTestingName"
  | "setMcpTestingName"
  | "profileTestingName"
  | "setProfileTestingName"
  | "backupRecordsDialog"
  | "doctorReport"
  | "isBackupRunning"
  | "isWebDavTesting"
  | "isBackupPasswordVisible"
  | "setIsBackupPasswordVisible"
  | "updateState"
  | "updateImmediateState"
  | "runAfterUnsavedHandled"
  | "onSave"
  | "persistState"
  | "confirmDeleteResource"
  | "requestConfirm"
  | "refreshSkills"
  | "openDocumentViewer"
  | "runManualBackup"
  | "runWebDavTest"
  | "runDoctor"
  | "openBackupRecords"
  | "setActiveTab"
  | "setError"
  | "setNotice"
  | "setFileSnapshot"
  | "openKimiInTerminal"
  | "loadState"
> & {
  shortcuts: Record<ShortcutAction, ShortcutBinding>;
  onRequestCascadeDelete: (type: "provider" | "model", name: string) => void;
  onOpenProfileWizard: () => void;
};

type CreateEnvironmentDraft = {
  id: string;
  name: string;
  description: string;
  workingDirectory: string;
  sourceEnvironmentId: string;
};

type KimiOAuthLoginState = {
  status: "idle" | "running" | "success" | "failed" | "account-required";
  url: string;
  userCode: string;
  expiresIn: number | null;
  message: string;
  messageKey: string;
};

type ProviderCatalogDialogState = {
  open: boolean;
  loading: boolean;
  items: ProviderCatalogSummary[];
  filter: string;
  catalogUrl: string;
  selectedId: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  registryUrl: string;
  registryApiKey: string;
  registryTrusted: boolean;
  error: string;
};

function createProviderCatalogDialogState(): ProviderCatalogDialogState {
  return {
    open: false,
    loading: false,
    items: [],
    filter: "",
    catalogUrl: "",
    selectedId: "",
    apiKey: "",
    baseUrl: "",
    defaultModel: "",
    registryUrl: "",
    registryApiKey: "",
    registryTrusted: false,
    error: "",
  };
}

function isOAuthAccountRequiredMessage(message: string | undefined): boolean {
  return Boolean(message?.includes("402 Payment Required") || message?.includes("Payment Required"));
}

function oauthFailureMessageKey(message: string | undefined): string {
  const normalized = message?.toLowerCase() ?? "";
  if (isOAuthAccountRequiredMessage(message)) return "kimiOauthAccountRequired";
  if (normalized.includes("expired")) return "kimiOauthExpired";
  if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("denied") || normalized.includes("reject")) {
    return "kimiOauthCancelled";
  }
  if (normalized.includes("already running")) return "kimiOauthAlreadyRunning";
  if (normalized.includes("spawn") || normalized.includes("not found") || normalized.includes("no such file")) return "kimiOauthCommandUnavailable";
  return "kimiOauthFailed";
}

function oauthStatusForEvent(event: KimiOAuthLoginEvent): KimiOAuthLoginState["status"] {
  if (event.kind === "account-required" || isOAuthAccountRequiredMessage(event.message ?? event.line)) {
    return "account-required";
  }
  if (event.kind === "failed" || event.kind === "error") {
    return "failed";
  }
  if (event.kind === "success" || event.kind === "complete") {
    return "success";
  }
  return "running";
}

function oauthMessageKeyForEvent(event: KimiOAuthLoginEvent): string {
  if (event.kind === "account-required" || isOAuthAccountRequiredMessage(event.message ?? event.line)) {
    return "kimiOauthAccountRequired";
  }
  switch (event.kind) {
    case "start":
    case "device-code":
    case "user-code":
    case "expires-in":
    case "output":
      return "kimiOauthWaiting";
    case "success":
    case "complete":
      return "kimiOauthSuccess";
    case "failed":
    case "error":
      return oauthFailureMessageKey(event.message ?? event.line);
    default:
      return "kimiOauthWaiting";
  }
}

const ENVIRONMENT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function buildKimiCodeEnvironmentId(environments: KimiCodeEnvironment[]): string {
  const usedIds = new Set(environments.map((environment) => environment.id));
  let attempts = 0;
  while (attempts < 100) {
    const id = Array.from({ length: 5 }, () => ENVIRONMENT_ID_ALPHABET[Math.floor(Math.random() * ENVIRONMENT_ID_ALPHABET.length)]).join("");
    if (!usedIds.has(id)) {
      return id;
    }
    attempts += 1;
  }
  throw new Error("Unable to generate a unique Kimi Code environment identifier.");
}

export function TabPanels(props: TabPanelsProps): JSX.Element {
  const {
    state,
    activeTab,
    activeSettingsSubTab,
    setActiveSettingsSubTab,
    kimiCodeSubTab,
    setKimiCodeSubTab,
    locale,
    diagnostics,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    selectedProfile,
    setSelectedProfile,
    selectedMcpServer,
    setSelectedMcpServer,
    setSelectedSkill,
    setSelectedSkillPath,
    onRequestCascadeDelete,
    onOpenProfileWizard,
    skillsViewMode,
    setSkillsViewMode,
    skillsReport,
    isSkillsLoading,
    providerEntries,
    modelEntries,
    profileEntries,
    mcpEntries,
    skillPathEntries,
    skillEntries,
    sortedSkillPathEntries,
    visibleSkillEntries,
    selectedProviderName,
    selectedModelName,
    selectedProfileName,
    selectedMcpServerName,
    selectedSkillPathId,
    selectedSkillData,
    selectedSkillPathData,
    selectedProviderData,
    selectedModelData,
    selectedProfileData,
    selectedMcpServerData,
    isProviderNameEditable,
    isProfileNameEditable,
    isMcpServerNameEditable,
    dirtyProviders,
    dirtyModels,
    dirtyProfiles,
    dirtyMcpServers,
    setIsMcpImportOpen,
    setMcpImportDraft,
    setMcpImportInitialDraft,
    mcpTestingName,
    setMcpTestingName,
    profileTestingName,
    setProfileTestingName,
    backupRecordsDialog,
    doctorReport,
    isBackupRunning,
    isWebDavTesting,
    isBackupPasswordVisible,
    setIsBackupPasswordVisible,
    updateState,
    updateImmediateState,
    runAfterUnsavedHandled,
    onSave,
    persistState,
    confirmDeleteResource,
    requestConfirm,
    refreshSkills,
    openDocumentViewer,
    runManualBackup,
    runWebDavTest,
    runDoctor,
    openBackupRecords,
    setActiveTab,
    setError,
    setNotice,
    setFileSnapshot,
    openKimiInTerminal,
    loadState,
    shortcuts,
  } = props;
  const shortcutConflicts = getShortcutConflicts(shortcuts);
  const shortcutPlatform = getBrowserShortcutPlatform();
  const shortcutConflictActions = new Set(shortcutConflicts.flatMap((conflict) => conflict.actions));
  const shortcutLabels = Object.fromEntries(
    SHORTCUT_ACTIONS.map((definition) => [definition.action, labelForLocale(definition.label, locale)]),
  ) as Record<ShortcutAction, string>;
  const [kimiCodeOAuthLogin, setKimiCodeOAuthLogin] = useState<KimiOAuthLoginState>({
    status: "idle",
    url: "",
    userCode: "",
    expiresIn: null,
    message: "",
    messageKey: "kimiOauthReady",
  });
  // B1：备份目录只能通过 Rust 原生系统目录选择器选择并在 Rust 侧登记 durable 写授权；
  // 手输/改 SQLite 里的 backup_local_path 字符串不得扩大授权。选中路径仅作为显示/保存值。
  const pickBackupDirectory = async (): Promise<void> => {
    const api = getApi();
    if (!api || typeof api.pickBackupDirectory !== "function") {
      setError(t(locale, "backupRuntimeOutdated"));
      return;
    }
    try {
      const result = await api.pickBackupDirectory(
        t(locale, "backupLocalPath"),
        state.panelSettings.backup_local_path || undefined,
      );
      if (result.canceled || !result.path) {
        return;
      }
      setError("");
      updateImmediateState((draft) => {
        draft.panelSettings.backup_local_path = result.path ?? "";
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const currentConfigTarget = "kimi-code" as const;
  const currentConfigTargetLabel = "Kimi Code";
  const targetDetection = state.kimiTargetDetection;
  const targetDetectionStatusLabel = targetDetection?.status === "checking"
    ? t(locale, "configTargetDetecting")
    : targetDetection?.status === "detected"
      ? t(locale, "configTargetDetected")
      : t(locale, "configTargetNotDetected");
  const targetDetectionStatusClass = targetDetection?.status === "checking"
    ? "is-pending"
    : targetDetection?.status === "detected"
      ? "is-ok"
      : "is-danger";
  const installSourceLabel = (source?: KimiCodeInstallSource): string => {
    switch (source) {
      case "homebrew":
        return t(locale, "configTargetInstallSourceHomebrew");
      case "official-script":
        return t(locale, "configTargetInstallSourceOfficialScript");
      case "npm":
        return t(locale, "configTargetInstallSourceNpm");
      case "pnpm":
        return t(locale, "configTargetInstallSourcePnpm");
      case "unknown":
      case undefined:
        return targetDetection?.installed ? t(locale, "configTargetInstallSourceUnknown") : t(locale, "overviewCliNotFound");
    }
  };
  const [environmentDrafts, setEnvironmentDrafts] = useState<Record<string, Pick<KimiCodeEnvironment, "name" | "homePath" | "description" | "workingDirectory">>>({});
  const [createEnvironmentDraft, setCreateEnvironmentDraft] = useState<CreateEnvironmentDraft | null>(null);
  const [selectedKimiCodeEnvironmentId, setSelectedKimiCodeEnvironmentId] = useState<string | null>(null);
  const kimiCodeEnvironments = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments);
  const activeKimiCodeEnvironment = kimiCodeEnvironments.find((environment) => environment.id === state.panelSettings.active_kimi_code_environment_id)
    ?? kimiCodeEnvironments[0]
    ?? createDefaultKimiCodeEnvironment();
  const selectedKimiCodeEnvironment = kimiCodeEnvironments.find((environment) => environment.id === selectedKimiCodeEnvironmentId)
    ?? activeKimiCodeEnvironment;
  const saveKimiCodeEnvironments = async (
    environments: KimiCodeEnvironment[],
    activeEnvironmentId = activeKimiCodeEnvironment.id,
  ): Promise<void> => {
    const api = getApi();
    if (!api?.saveKimiCodeEnvironmentPreference) {
      throw new Error("Kimi Switch API does not support Kimi Code environment management.");
    }
    const normalized = normalizeKimiCodeEnvironments(environments);
    setFileSnapshot(null);
    const result = await api.saveKimiCodeEnvironmentPreference(normalized, activeEnvironmentId);
    setFileSnapshot(result.snapshot);
    await loadState();
  };
  const buildNextEnvironmentSeed = (): CreateEnvironmentDraft => {
    const nextIndex = kimiCodeEnvironments.length + 1;
    let suffix = nextIndex;
    const usedIds = new Set(kimiCodeEnvironments.map((environment) => environment.id));
    while (usedIds.has(`env-${suffix}`)) {
      suffix += 1;
    }
    return {
      id: buildKimiCodeEnvironmentId(kimiCodeEnvironments),
      name: formatMessage(t(locale, "kimiCodeEnvironmentDefaultName"), { index: suffix }),
      description: "",
      workingDirectory: "",
      sourceEnvironmentId: "",
    };
  };
  const addKimiCodeEnvironment = (): void => {
    setCreateEnvironmentDraft(buildNextEnvironmentSeed());
  };
  const createKimiCodeEnvironment = (draft: CreateEnvironmentDraft): void => {
    void (async () => {
      if (!draft.name.trim()) {
        setError(t(locale, "kimiCodeEnvironmentRequired"));
        return;
      }
      const timestamp = new Date().toISOString();
      const id = draft.id;
      if (!id || kimiCodeEnvironments.some((environment) => environment.id === id)) {
        setError(t(locale, "kimiCodeEnvironmentIdentifierConflict"));
        return;
      }
      const homePath = getKimiCodeEnvironmentHomePath(id);
      const sourceEnvironment = draft.sourceEnvironmentId
        ? kimiCodeEnvironments.find((environment) => environment.id === draft.sourceEnvironmentId)
        : undefined;
      const { assertKimiCodeHomeEmpty, copyKimiCodeConfiguration } = await import("../tauri/fileAccess");
      if (sourceEnvironment) {
        await copyKimiCodeConfiguration(sourceEnvironment.homePath, homePath);
      } else {
        await assertKimiCodeHomeEmpty(homePath);
      }
      const sourceSnapshot = sourceEnvironment?.id === activeKimiCodeEnvironment.id
        ? {
            profiles: state.profiles,
            activeProfile: state.activeProfile,
          }
        : sourceEnvironment;
      const nextEnvironment: KimiCodeEnvironment = {
        id,
        name: draft.name.trim(),
        homePath,
        kind: "managed",
        description: draft.description.trim(),
        workingDirectory: draft.workingDirectory.trim() || sourceEnvironment?.workingDirectory || "",
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceEnvironmentId: sourceEnvironment?.id,
        profiles: sourceSnapshot?.profiles ? structuredClone(sourceSnapshot.profiles) : {},
        activeProfile: sourceSnapshot?.activeProfile ?? "",
      };
      await saveKimiCodeEnvironments([...kimiCodeEnvironments, nextEnvironment], nextEnvironment.id);
      setCreateEnvironmentDraft(null);
      setNotice(t(locale, "kimiCodeEnvironmentSaved"));
    })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };
  const environmentDraftFor = (environment: KimiCodeEnvironment): Pick<KimiCodeEnvironment, "name" | "homePath" | "description" | "workingDirectory"> => (
    environmentDrafts[environment.id] ?? {
      name: environment.name,
      homePath: environment.homePath,
      description: environment.description ?? "",
      workingDirectory: environment.workingDirectory ?? "",
    }
  );
  const updateEnvironmentDraft = (id: string, patch: Partial<Pick<KimiCodeEnvironment, "name" | "homePath" | "description" | "workingDirectory">>): void => {
    setEnvironmentDrafts((current) => {
      const environment = kimiCodeEnvironments.find((item) => item.id === id);
      if (!environment) {
        return current;
      }
      return {
        ...current,
        [id]: {
          ...(current[id] ?? {
            name: environment.name,
            homePath: environment.homePath,
            description: environment.description ?? "",
            workingDirectory: environment.workingDirectory ?? "",
          }),
          ...patch,
        },
      };
    });
  };
  const saveKimiCodeEnvironment = (id: string): void => {
    void (async () => {
      const draft = environmentDrafts[id];
      if (!draft) {
        return;
      }
      if (!draft.name.trim() || !draft.homePath.trim()) {
        setError(t(locale, "kimiCodeEnvironmentRequired"));
        return;
      }
      const next = kimiCodeEnvironments.map((environment) => environment.id === id
        ? {
          ...environment,
          name: draft.name.trim(),
          description: draft.description?.trim() ?? "",
          workingDirectory: draft.workingDirectory?.trim() ?? "",
          updatedAt: new Date().toISOString(),
        }
        : environment);
      await saveKimiCodeEnvironments(next, activeKimiCodeEnvironment.id);
      setEnvironmentDrafts((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
      setNotice(t(locale, "kimiCodeEnvironmentSaved"));
    })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };
  const activateKimiCodeEnvironment = (id: string): void => {
    void (async () => {
      await saveKimiCodeEnvironments(kimiCodeEnvironments, id);
      // 切换环境后自动刷新界面（saveKimiCodeEnvironments 内部已 loadState），并跳转到总览页。
      setActiveTab("overview");
      setNotice(t(locale, "kimiCodeEnvironmentActivated"));
    })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };
  const deleteKimiCodeEnvironment = (environment: KimiCodeEnvironment): void => {
    void (async () => {
      if (environment.id === "default" || kimiCodeEnvironments.length <= 1) {
        setError(t(locale, "kimiCodeEnvironmentCannotDelete"));
        return;
      }
      const shouldDelete = await requestConfirm({
        title: formatMessage(t(locale, "kimiCodeEnvironmentDeleteTitle"), {
          name: environment.name || environment.id,
        }),
        description: formatMessage(t(locale, "kimiCodeEnvironmentDeleteDescription"), {
          path: environment.homePath,
        }),
        confirmLabel: t(locale, "delete"),
        cancelLabel: t(locale, "cancel"),
        tone: "danger",
        kind: "delete",
      });
      if (!shouldDelete) {
        return;
      }
      const next = kimiCodeEnvironments.filter((item) => item.id !== environment.id);
      const nextActiveId = activeKimiCodeEnvironment.id === environment.id
        ? (next[0]?.id ?? "default")
        : activeKimiCodeEnvironment.id;
      await saveKimiCodeEnvironments(next, nextActiveId);
      const expectedManagedPath = getKimiCodeEnvironmentHomePath(environment.id);
      if (environment.kind === "managed" && environment.homePath === expectedManagedPath) {
        const { removeDir } = await import("../tauri/fileAccess");
        await removeDir(environment.homePath);
      }
      setNotice(t(locale, "kimiCodeEnvironmentDeleted"));
    })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };
  const renderInlineCodeMessage = (template: string, values: Record<string, string | number> = {}): JSX.Element => {
    const message = formatMessage(template, values);
    const parts = message.split(/(`[^`]+`)/g).filter(Boolean);
    return (
      <>
        {parts.map((part, index) => {
          if (part.startsWith("`") && part.endsWith("`")) {
            return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
          }
          return <span key={`${part}-${index}`}>{part}</span>;
        })}
      </>
    );
  };
  // window.toggle 等标记 desktopOnly 的条目依赖 Rust 全局快捷键注册，浏览器形态不展示。
  const visibleShortcutActions = SHORTCUT_ACTIONS.filter(
    (definition) => isDesktopRuntime() || definition.desktopOnly !== true,
  );
  const shortcutGroups = [
    {
      scope: "global" as const,
      title: t(locale, "shortcutGlobalGroup"),
      description: t(locale, "shortcutGlobalDescription"),
      actions: visibleShortcutActions.filter((definition) => definition.scope === "global"),
    },
    {
      scope: "window" as const,
      title: t(locale, "shortcutWindowGroup"),
      description: t(locale, "shortcutWindowDescription"),
      actions: visibleShortcutActions.filter((definition) => definition.scope === "window"),
    },
  ];
  // 空状态检查
  const hasProviders = Object.keys(state.mainConfig.providers).length > 0;
  const hasModels = Object.keys(state.mainConfig.models).length > 0;

  const [fullBackupImportDialog, setFullBackupImportDialog] = useState<{ open: boolean; data: FullBackupBundle | null; envCount: number; hasRedactedSecrets: boolean; riskItems: string[] }>({ open: false, data: null, envCount: 0, hasRedactedSecrets: false, riskItems: [] });
  const [providerCatalogDialog, setProviderCatalogDialog] = useState<ProviderCatalogDialogState>(createProviderCatalogDialogState);
  const [isImportingFullBackup, setIsImportingFullBackup] = useState(false);
  const [isMcpJsonViewerOpen, setIsMcpJsonViewerOpen] = useState(false);
  const [providerHealthResults, setProviderHealthResults] = useState<ProviderHealthResult[] | null>(null);
  const [isProviderHealthChecking, setIsProviderHealthChecking] = useState(false);
  const [providerHealthBannerOpen, setProviderHealthBannerOpen] = useState(false);
  const [providerHealthBannerKey, setProviderHealthBannerKey] = useState(0);
  const [officialAccounts, setOfficialAccounts] = useState<OfficialAccount[]>([]);
  const [officialAccountsLoading, setOfficialAccountsLoading] = useState(false);

  const refreshOfficialAccounts = (): void => {
    if (!state.panelSettings.official_account_vault_enabled) {
      setOfficialAccounts([]);
      setOfficialAccountsLoading(false);
      return;
    }
    const api = getApi();
    if (!api?.listOfficialAccounts) return;
    setOfficialAccountsLoading(true);
    void api.listOfficialAccounts()
      .then((accounts) => setOfficialAccounts(accounts))
      .catch(() => setOfficialAccounts([]))
      .finally(() => setOfficialAccountsLoading(false));
  };

  useEffect(() => {
    // 仅在挂载时拉取一次官方账号列表；后续变更由各操作显式调用 refreshOfficialAccounts。
    refreshOfficialAccounts();
  }, [state.panelSettings.official_account_vault_enabled]);

  const startKimiOAuthLogin = (): void => {
    const api = getApi();
    const loginTarget = currentConfigTarget;
    const loginTargetLabel = currentConfigTargetLabel;
    if (!api?.startKimiOAuthLogin) {
      setError(formatMessage(t(locale, "kimiOauthUnavailable"), { target: loginTargetLabel }));
      return;
    }
    setError("");
    setNotice("");
    setKimiCodeOAuthLogin({
      status: "running",
      url: "",
      userCode: "",
      expiresIn: null,
      message: formatMessage(t(locale, "kimiOauthWaiting"), { target: loginTargetLabel }),
      messageKey: "kimiOauthWaiting",
    });
    void api.startKimiOAuthLogin(loginTarget, (event) => {
      console.debug("[kimi-oauth-login]", event);
      if (event.target !== loginTarget) {
        return;
      }
      setKimiCodeOAuthLogin((current) => ({
        status: oauthStatusForEvent(event),
        url: event.url ?? current.url,
        userCode: event.user_code ?? current.userCode,
        expiresIn: event.expires_in ?? current.expiresIn,
        message: event.message ?? event.line ?? current.message,
        messageKey: oauthMessageKeyForEvent(event),
      }));
    })
      .then(async () => {
        setKimiCodeOAuthLogin((current) => ({
          ...current,
          status: "success",
          message: formatMessage(t(locale, "kimiOauthSuccess"), { target: loginTargetLabel }),
          messageKey: "kimiOauthSuccess",
        }));
        setNotice(formatMessage(t(locale, "kimiOauthSuccess"), { target: loginTargetLabel }));
        refreshOfficialAccounts();
        await loadState();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const messageKey = oauthFailureMessageKey(message);
        setKimiCodeOAuthLogin((current) => ({
          ...current,
          status: isOAuthAccountRequiredMessage(message) ? "account-required" : "failed",
          message,
          messageKey,
        }));
        console.debug("[kimi-oauth-login]", { kind: "failed", target: loginTarget, message });
        setError(formatMessage(t(locale, messageKey), { target: loginTargetLabel, message }));
      });
  };

  const activateOfficialAccount = (id: string): void => {
    const api = getApi();
    if (!api?.activateOfficialAccount) return;
    void api.activateOfficialAccount(id)
      .then(async () => {
        setNotice(t(locale, "officialAccountActivated"));
        refreshOfficialAccounts();
        await loadState();
      })
      .catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };

  const deleteOfficialAccount = (account: OfficialAccount): void => {
    const api = getApi();
    if (!api?.deleteOfficialAccount) return;
    void (async () => {
      if (!(await confirmDeleteResource(t(locale, "officialAccount"), account.display_name))) return;
      await api.deleteOfficialAccount(account.id);
      setNotice(t(locale, "officialAccountDeleted"));
      refreshOfficialAccounts();
      await loadState();
    })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };

  const runProvidersHealthCheck = (): void => {
    const api = getApi();
    if (!api || typeof api.runProvidersHealthCheck !== "function" || isProviderHealthChecking) {
      return;
    }
    setIsProviderHealthChecking(true);
    void Promise.resolve(api.runProvidersHealthCheck(state))
      .then((results) => setProviderHealthResults(results))
      .catch(() => setProviderHealthResults([]))
      .finally(() => {
        setIsProviderHealthChecking(false);
        // key++ 让提示条重挂载以重置自动关闭计时；open=true 重新展示。
        setProviderHealthBannerKey((key) => key + 1);
        setProviderHealthBannerOpen(true);
      });
  };

  const providerHealthReasonLabel = (result: ProviderHealthResult): string => {
    switch (result.reason) {
      case "ok":
        return result.latencyMs != null
          ? `${t(locale, "providerHealthOk")} · ${result.latencyMs}ms`
          : t(locale, "providerHealthOk");
      case "no-model":
        return t(locale, "providerHealthNoModel");
      case "missing-base-url":
        return t(locale, "providerHealthMissingBaseUrl");
      case "missing-api-key":
        return t(locale, "providerHealthMissingApiKey");
      case "oauth-unverified":
        return t(locale, "providerHealthOauthUnverified");
      case "rate-limited":
        return t(locale, "providerHealthRateLimited");
      case "http-error":
        return formatMessage(t(locale, "providerHealthHttpError"), { status: result.status ?? 0 });
      default:
        return t(locale, "providerHealthNetworkError");
    }
  };

  const refreshProviderCatalog = (filter = providerCatalogDialog.filter, catalogUrl = providerCatalogDialog.catalogUrl): void => {
    const api = getApi();
    if (!api || typeof api.listProviderCatalog !== "function") {
      setProviderCatalogDialog((current) => ({ ...current, error: t(locale, "backupRuntimeOutdated") }));
      return;
    }
    setProviderCatalogDialog((current) => ({ ...current, open: true, loading: true, error: "" }));
    void api.listProviderCatalog(filter, catalogUrl || undefined)
      .then((items) => setProviderCatalogDialog((current) => ({
        ...current,
        items,
        selectedId: items.some((item) => item.id === current.selectedId)
          ? current.selectedId
          : items[0]?.id ?? "",
        loading: false,
      })))
      .catch((error) => setProviderCatalogDialog((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })));
  };

  const openProviderCatalog = (): void => {
    setProviderCatalogDialog({ ...createProviderCatalogDialogState(), open: true, loading: true });
    refreshProviderCatalog("", "");
  };

  const importSelectedCatalogProvider = (): void => {
    const api = getApi();
    if (!api || typeof api.importProviderCatalog !== "function" || !providerCatalogDialog.selectedId) return;
    runAfterUnsavedHandled(async () => {
      setProviderCatalogDialog((current) => ({ ...current, loading: true, error: "" }));
      try {
        await api.importProviderCatalog({
          providerId: providerCatalogDialog.selectedId,
          apiKey: providerCatalogDialog.apiKey,
          defaultModel: providerCatalogDialog.defaultModel || undefined,
          baseUrl: providerCatalogDialog.baseUrl || undefined,
          url: providerCatalogDialog.catalogUrl || undefined,
        });
        setProviderCatalogDialog(createProviderCatalogDialogState());
        setNotice(t(locale, "providerCatalogImportSuccess"));
        await loadState();
      } catch (error) {
        setProviderCatalogDialog((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  };

  const importCustomProviderRegistry = (): void => {
    const api = getApi();
    if (!api || typeof api.importProviderRegistry !== "function") return;
    runAfterUnsavedHandled(async () => {
      setProviderCatalogDialog((current) => ({ ...current, loading: true, error: "" }));
      try {
        await api.importProviderRegistry({
          url: providerCatalogDialog.registryUrl,
          apiKey: providerCatalogDialog.registryApiKey,
        });
        setProviderCatalogDialog(createProviderCatalogDialogState());
        setNotice(t(locale, "providerRegistryImportSuccess"));
        await loadState();
      } catch (error) {
        setProviderCatalogDialog((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  };

  const updateTuiConfig = (patch: Partial<TuiConfig>): void => {
    updateState((draft) => {
      draft.tuiConfig = { ...(draft.tuiConfig ?? {}), ...patch };
    }, { persist: false });
  };

  const settingsSubTabs: Array<{ id: SettingsSubTab; label: string; description: string }> = [
    {
      id: "kimi-code",
      label: t(locale, "settingsTabKimiCode"),
      description: t(locale, "settingsTabKimiCodeDescription"),
    },
    {
      id: "general",
      label: t(locale, "settingsTabGeneral"),
      description: t(locale, "settingsTabGeneralDescription"),
    },
    {
      id: "shortcuts",
      label: t(locale, "settingsTabShortcuts"),
      description: t(locale, "settingsTabShortcutsDescription"),
    },
    {
      id: "backup",
      label: t(locale, "settingsTabBackup"),
      description: t(locale, "settingsTabBackupDescription"),
    },
    {
      id: "doctor",
      label: t(locale, "settingsTabDoctor"),
      description: t(locale, "settingsTabDoctorDescription"),
    },
    {
      id: "insights",
      label: t(locale, "settingsTabInsights"),
      description: t(locale, "settingsTabInsightsDescription"),
    },
    {
      id: "history",
      label: t(locale, "historyTitle"),
      description: t(locale, "settingsHistoryDescription"),
    },
  ];
  const isResourceWorkspaceTab = activeTab === "providers"
    || activeTab === "models"
    || activeTab === "profiles"
    || activeTab === "mcp"
    || activeTab === "skills"
    || activeTab === "settings";

  return (
    <ErrorBoundary locale={locale}>
      <>
        <div className={isResourceWorkspaceTab ? "tab-panel-shell tab-panel-shell-split" : "tab-panel-shell"}>
        {activeTab === "overview" ? (
          <OverviewDashboard
            state={state}
            locale={locale}
            diagnostics={diagnostics}
            skillsReport={skillsReport}
            mcpEntries={mcpEntries}
            onNavigate={(tab, item) => runAfterUnsavedHandled(() => {
              setActiveTab(tab);
              if (tab === "profiles" && item) setSelectedProfile(item);
              if (tab === "providers" && item) setSelectedProvider(item);
              if (tab === "models" && item) setSelectedModel(item);
            })}
            onOpenDoctor={() => runAfterUnsavedHandled(() => {
              setActiveSettingsSubTab("doctor");
              setActiveTab("settings");
            })}
          />
        ) : null}

        {activeTab === "providers" ? (
          <ResourceWorkspace
            headerActions={
              <>
                <button
                  className="action-button compact"
                  type="button"
                  onClick={openProviderCatalog}
                >
                  <Download size={15} />
                  <span>{t(locale, "providerCatalogOpen")}</span>
                </button>
                <button
                  className={isProviderHealthChecking ? "action-button compact icon-only is-loading" : "action-button compact icon-only"}
                  type="button"
                  disabled={isProviderHealthChecking || providerEntries.length === 0}
                  aria-label={t(locale, "providerHealthCheck")}
                  title={t(locale, "providerHealthCheck")}
                  onClick={runProvidersHealthCheck}
                >
                  {isProviderHealthChecking ? <LoaderCircle size={15} className="button-spinner" /> : <Activity size={15} />}
                </button>
              </>
            }
            listBanner={
              providerHealthBannerOpen && providerHealthResults ? (
                <ProviderHealthBanner
                  key={providerHealthBannerKey}
                  results={providerHealthResults}
                  emptyLabel={t(locale, "providerHealthEmpty")}
                  failLabel={t(locale, "providerHealthFail")}
                  reasonLabel={providerHealthReasonLabel}
                  closeLabel={t(locale, "close")}
                  onClose={() => setProviderHealthBannerOpen(false)}
                />
              ) : null
            }
            listItems={providerEntries.map(([name]) => name)}
            searchPlaceholder={t(locale, "searchResources")}
            renderItemLabel={(name) => {
              const provider = state.mainConfig.providers[name];
              return <span className="list-label-stack"><strong>{name}</strong><small>{provider?.type || "-"}</small></span>;
            }}
            dirtyItems={dirtyProviders}
            dirtyLabel={t(locale, "editedBadge")}
            selectedItem={selectedProviderName}
            itemClassName={() => "provider-list-row"}
            onSelect={(item) => setSelectedProvider(item)}
            copyLabel={t(locale, "clone")}
            onCopy={(name) =>
              updateState((draft) => {
                const provider = draft.mainConfig.providers[name];
                if (!provider) return;
                const copyName = createCopyName(name, draft.mainConfig.providers);
                draft.mainConfig.providers[copyName] = { ...provider };
                setSelectedProvider(copyName);
              }, {
                persist: false,
                recordHistory: true,
                historySummary: formatMessage(t(locale, "historyCloneProvider"), { name }),
              })
            }
            addLabel={t(locale, "newProvider")}
            addButtonClassName="action-button compact"
            addButtonTitle={t(locale, "newProvider")}
            addButtonContent={<><Plus size={15} /><span>{t(locale, "newProvider")}</span></>}
            onAdd={() => {
              // 名字必须在 updateState 之外生成：options 里的 historySummary
              // 与 updater 是两个独立闭包，内部声明的 name 在外面不可见。
              const name = createUniqueName("provider", Object.keys(state.mainConfig.providers));
              updateState((draft) => {
                upsertProvider(draft, name, {
                  type: "kimi",
                  base_url: "https://api.example.com/v1",
                  api_key: "",
                });
                setSelectedProvider(name);
              }, {
                persist: false,
                recordHistory: true,
                historySummary: formatMessage(t(locale, "historyNewProvider"), { name }),
              });
            }}
          >
            {selectedProviderData ? (
              <ProviderForm
                locale={locale}
                name={selectedProviderName}
                nameEditable={isProviderNameEditable}
                value={selectedProviderData}
                onChange={(name, patch) =>
                  updateState((draft) => {
                    const currentName = selectedProviderName;
                    const currentProvider = draft.mainConfig.providers[currentName];
                    if (!currentProvider) return;
                    const nextProvider = { ...currentProvider, ...patch };
                    const nextName = isProviderNameEditable
                      ? renameProviderInState(draft, currentName, name, nextProvider)
                      : currentName;

                    if (!isProviderNameEditable) {
                      draft.mainConfig.providers[currentName] = nextProvider;
                    }
                    setSelectedProvider(nextName);
                  }, { persist: false })
                }
                onSave={() => void onSave()}
                onDelete={() => {
                  void (async () => {
                    // 有引用时弹级联删除对话框（影响预览 + 一并删除/仅删此项）；无引用直接确认删除
                    const impact = getCascadePreview(state, { type: "provider", name: selectedProviderName });
                    if (impact.affectedModels.length > 0 || impact.affectedProfiles.length > 0) {
                      onRequestCascadeDelete("provider", selectedProviderName);
                      return;
                    }
                    if (!(await confirmDeleteResource(getResourceLabel(locale, "provider"), selectedProviderName))) return;
                    updateState((draft) => {
                      deleteProvider(draft, selectedProviderName);
                      setSelectedProvider(Object.keys(draft.mainConfig.providers)[0] ?? "");
                    }, {
                      historySummary: formatMessage(t(locale, "historyDeleteProvider"), { name: selectedProviderName }),
                    });
                  })();
                }}
              />
            ) : (
              <EmptyState locale={locale} hasItems={providerEntries.length > 0} />
            )}
          </ResourceWorkspace>
        ) : null}

        {activeTab === "models" ? (
          <ResourceWorkspace
            listItems={modelEntries.map(([name]) => name)}
            searchPlaceholder={t(locale, "searchResources")}
            renderItemLabel={(name) => {
              const model = state.mainConfig.models[name];
              return <span className="list-label-stack"><strong>{model?.model || name}</strong><small>{model?.provider || "-"}</small></span>;
            }}
            dirtyItems={dirtyModels}
            dirtyLabel={t(locale, "editedBadge")}
            selectedItem={selectedModelName}
            onSelect={(item) => setSelectedModel(item)}
            copyLabel={t(locale, "clone")}
            onCopy={(name) =>
              updateState((draft) => {
                const model = draft.mainConfig.models[name];
                if (!model) return;
                const copyModelId = createUniqueName(`${model.model}-copy`, Object.values(draft.mainConfig.models)
                  .filter((entry) => entry.provider === model.provider)
                  .map((entry) => entry.model));
                const copyName = buildModelName(model.provider, copyModelId);
                draft.mainConfig.models[copyName] = {
                  ...model,
                  model: copyModelId,
                  capabilities: [...model.capabilities],
                };
                setSelectedModel(copyName);
              }, {
                persist: false,
                recordHistory: true,
                historySummary: formatMessage(t(locale, "historyCloneModel"), { name }),
              })
            }
            addLabel={t(locale, "newModel")}
            addButtonClassName="action-button compact"
            addButtonTitle={!hasProviders ? t(locale, "tooltipAddProviderFirst") : t(locale, "newModel")}
            addButtonContent={<><Plus size={15} /><span>{t(locale, "newModel")}</span></>}
            addButtonDisabled={!hasProviders}
            onAdd={() => {
              const providerName = Object.keys(state.mainConfig.providers)[0];
              if (!providerName) {
                setError(t(locale, "errorCreateProviderFirst"));
                setNotice("");
                return;
              }
              const modelId = createUniqueName(
                "new-model",
                Object.values(state.mainConfig.models)
                  .filter((model) => model.provider === providerName)
                  .map((model) => model.model),
              );
              const name = buildModelName(providerName, modelId);
              updateState((draft) => {
                upsertModel(draft, name, {
                  provider: providerName,
                  model: modelId,
                  max_context_size: 128000,
                  capabilities: [],
                });
                setSelectedModel(name);
              }, {
                persist: false,
                recordHistory: true,
                historySummary: formatMessage(t(locale, "historyNewModel"), { name }),
              });
            }}
          >
            {selectedModelData ? (
              <ModelForm
                locale={locale}
                providers={Object.keys(state.mainConfig.providers)}
                officialAccounts={officialAccounts}
                activeOfficialAccountId={state.panelSettings.active_official_account_id}
                name={selectedModelName}
                value={selectedModelData}
                onChange={(_name, patch) =>
                  updateState((draft) => {
                    const currentName = selectedModelName;
                    const currentModel = draft.mainConfig.models[currentName];
                    if (!currentModel) return;
                    const nextModel = {
                      ...currentModel,
                      ...patch,
                      provider: normalizeEntryName(patch.provider ?? currentModel.provider),
                      model: normalizeEntryName(patch.model ?? currentModel.model),
                    };
                    if (nextModel.auth_mode !== "official-account") {
                      delete nextModel.official_account_scope;
                    }
                    const nextName = renameModelInState(draft, currentName, nextModel);
                    setSelectedModel(nextName);
                  }, { persist: false })
                }
                onSave={() => void onSave()}
                onDelete={() => {
                  void (async () => {
                    // 有引用时弹级联删除对话框；无引用直接确认删除
                    const impact = getCascadePreview(state, { type: "model", name: selectedModelName });
                    if (impact.affectedProfiles.length > 0) {
                      onRequestCascadeDelete("model", selectedModelName);
                      return;
                    }
                    if (!(await confirmDeleteResource(getResourceLabel(locale, "model"), selectedModelName))) return;
                    updateState((draft) => {
                      deleteModel(draft, selectedModelName);
                      setSelectedModel(Object.keys(draft.mainConfig.models)[0] ?? "");
                    }, {
                      historySummary: formatMessage(t(locale, "historyDeleteModel"), { name: selectedModelName }),
                    });
                  })();
                }}
              />
            ) : (
              <EmptyState locale={locale} hasItems={modelEntries.length > 0} />
            )}
          </ResourceWorkspace>
        ) : null}

        {activeTab === "profiles" ? (
          <ResourceWorkspace
            listTitle={t(locale, "profiles")}
            listItems={profileEntries.map(([name]) => name)}
            searchPlaceholder={t(locale, "searchResources")}
            dirtyItems={dirtyProfiles}
            dirtyLabel={t(locale, "editedBadge")}
            selectedItem={selectedProfileName}
            highlightedItem={state.activeProfile}
            renderItemLabel={(name) => {
              const profile = state.profiles[name];
              const displayName = profile?.label?.trim() || name;
              return (
                <span className="list-label-stack">
                  <strong>{displayName}</strong>
                  <small>{name}</small>
                </span>
              );
            }}
            itemTitle={(name) => state.profiles[name]?.label?.trim() || name}
            itemClassName={() => "profile-list-row"}
            onSelect={(item) => setSelectedProfile(item)}
            addLabel={t(locale, "newProfile")}
            addButtonClassName="action-button compact icon-only"
            addButtonTitle={t(locale, "newProfile")}
            addButtonContent={<Plus size={15} />}
            onAdd={onOpenProfileWizard}
            renderItemAction={(name) =>
              (
                <span className="list-row-action-set profile-actions">
                  <span className="list-hover-actions">
                    <button
                      className="list-terminal-button"
                      type="button"
                      aria-label={t(locale, "openInTerminal")}
                      title={t(locale, "openInTerminal")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openKimiInTerminal(name);
                      }}
                    >
                      <Terminal size={15} />
                    </button>
                  </span>
                  {name === state.activeProfile ? (
                    <span className="list-current-badge" aria-label={t(locale, "summaryActive")} title={t(locale, "summaryActive")}>
                      {t(locale, "active")}
                    </span>
                  ) : (
                    <span className="list-hover-actions">
                      <button
                        className="list-activate-button"
                        type="button"
                        aria-label={`${t(locale, "activate")} ${name}`}
                        title={t(locale, "activate")}
                        onClick={(event) => {
                          event.stopPropagation();
                          runAfterUnsavedHandled(() => updateState((draft) => {
                            applyProfile(draft, name);
                          }, {
                            historySummary: formatMessage(t(locale, "historyActivateProfile"), { name }),
                          }));
                        }}
                      >
                        {t(locale, "activate")}
                      </button>
                    </span>
                  )}
                </span>
              )
            }
          >
            {selectedProfileData ? (
              <ProfileForm
                locale={locale}
                models={Object.keys(state.mainConfig.models)}
                name={selectedProfileName}
                nameEditable={isProfileNameEditable}
                value={selectedProfileData}
                isActive={selectedProfileName === state.activeProfile}
                isTesting={profileTestingName === selectedProfileName}
                onChange={(name, nextProfile) =>
                  updateState((draft) => {
                    const currentName = selectedProfileName;
                    const normalizedName = isProfileNameEditable
                      ? ensureUniqueEntryName({
                          kind: "Profile",
                          name,
                          currentName,
                          existingNames: Object.keys(draft.profiles),
                        })
                      : currentName;
                    const normalizedProfile = {
                      ...nextProfile,
                    };
                    const nextProfiles = { ...draft.profiles };
                    delete nextProfiles[currentName];
                    nextProfiles[normalizedName] = { ...normalizedProfile, name: normalizedName };
                    if (draft.activeProfile === currentName) {
                      draft.activeProfile = normalizedName;
                    }
                    draft.profiles = nextProfiles;
                    setSelectedProfile(normalizedName);
                  }, { persist: false })
                }
                onSave={() => void onSave()}
                onTest={async (modelName) => {
                  const api = getApi();
                  if (!api || typeof api.testProfileConnectivity !== "function") {
                    setNotice("");
                    throw new Error(t(locale, "profileRuntimeOutdated"));
                  }
                  try {
                    setProfileTestingName(selectedProfileName);
                    const result = await api.testProfileConnectivity(state, selectedProfileName, modelName);
                    setError("");
                    setNotice("");
                    return result;
                  } catch (testError) {
                    const message = testError instanceof Error ? testError.message : String(testError);
                    const translatedMessage = translateError(locale, message);
                    setNotice("");
                    throw new Error(translatedMessage);
                  } finally {
                    setProfileTestingName("");
                  }
                }}
                onActivate={() =>
                  runAfterUnsavedHandled(() => updateState((draft) => {
                    applyProfile(draft, selectedProfileName);
                  }, {
                    historySummary: formatMessage(t(locale, "historyActivateProfile"), { name: selectedProfileName }),
                  }))
                }
                onClone={() =>
                  updateState((draft) => {
                    const source = selectedProfileName;
                    cloneProfile(draft, source, `${source}-copy`, `${selectedProfileData.label} ${t(locale, "copySuffix")}`);
                    setSelectedProfile(`${source}-copy`);
                  }, {
                    persist: false,
                    recordHistory: true,
                    historySummary: formatMessage(t(locale, "historyCloneProfile"), { name: selectedProfileName }),
                  })
                }
                onDelete={() => {
                  void (async () => {
                    if (!(await confirmDeleteResource(getResourceLabel(locale, "profile"), selectedProfileName))) return;
                    updateState((draft) => {
                      deleteProfile(draft, selectedProfileName);
                      setSelectedProfile(Object.keys(draft.profiles)[0] ?? "");
                    }, {
                      historySummary: formatMessage(t(locale, "historyDeleteProfile"), { name: selectedProfileName }),
                    });
                  })();
                }}
              />
            ) : (
              <EmptyState locale={locale} hasItems={profileEntries.length > 0} />
            )}
          </ResourceWorkspace>
        ) : null}

        {activeTab === "mcp" ? (
          <ResourceWorkspace
            listItems={mcpEntries.map(([name]) => name)}
            searchPlaceholder={t(locale, "searchResources")}
            renderItemLabel={(name) => {
              const server = state.mcpConfig.mcpServers[name];
              return <span className="list-label-stack"><strong>{name}</strong><small>{server?.transport || "stdio"}</small></span>;
            }}
            dirtyItems={dirtyMcpServers}
            dirtyLabel={t(locale, "editedBadge")}
            selectedItem={selectedMcpServerName}
            onSelect={(item) => setSelectedMcpServer(item)}
            addLabel={t(locale, "newMcpServer")}
            onAdd={() => {
              const name = createUniqueName("mcp", Object.keys(state.mcpConfig.mcpServers));
              updateState((draft) => {
                draft.mcpConfig.mcpServers[name] = createDefaultMcpServer();
                setSelectedMcpServer(name);
              }, {
                persist: false,
                recordHistory: true,
                historySummary: formatMessage(t(locale, "historyNewMcpServer"), { name }),
              });
            }}
            headerActions={
              <>
                <button
                  className="action-button compact icon-only"
                  type="button"
                  aria-label={t(locale, "mcpViewFullJson")}
                  title={t(locale, "mcpViewFullJson")}
                  onClick={() => setIsMcpJsonViewerOpen(true)}
                >
                  <Braces size={15} />
                </button>
                <button
                  className="action-button compact icon-only"
                  type="button"
                  aria-label={t(locale, "importMcpJson")}
                  title={t(locale, "importMcpJson")}
                  onClick={() => {
                    const initialDraft = t(locale, "mcpImportPlaceholder");
                    setIsMcpImportOpen(true);
                    setMcpImportDraft(initialDraft);
                    setMcpImportInitialDraft(initialDraft);
                  }}
                >
                  <FileInput size={15} />
                </button>
              </>
            }
            addButtonClassName="action-button compact"
            addButtonTitle={t(locale, "newMcpServer")}
            addButtonContent={<><Plus size={15} /><span>{t(locale, "newMcpServer")}</span></>}
            itemClassName={(name) =>
              state.mcpConfig.mcpServers[name]?.enabled === false ? "disabled" : null
            }
            renderItemAction={(name) => {
              const server = state.mcpConfig.mcpServers[name];
              if (!server) {
                return null;
              }
              return (
                <>
                  <button
                    className={server.enabled ? "list-toggle-button" : "list-toggle-button disabled"}
                    type="button"
                    aria-label={server.enabled ? t(locale, "disableMcp") : t(locale, "enableMcp")}
                    title={server.enabled ? t(locale, "disableMcp") : t(locale, "enableMcp")}
                    onClick={() =>
                      updateState((draft) => {
                        const target = draft.mcpConfig.mcpServers[name];
                        if (!target) return;
                        target.enabled = !target.enabled;
                      }, {
                        historySummary: formatMessage(
                          t(locale, server.enabled ? "historyDisableMcpServer" : "historyEnableMcpServer"),
                          { name },
                        ),
                      })
                    }
                  >
                    <Power size={15} />
                  </button>
                  <button
                    className="list-copy-button"
                    type="button"
                    aria-label={`${t(locale, "clone")} ${name}`}
                    title={t(locale, "clone")}
                    onClick={() =>
                      updateState((draft) => {
                        const target = draft.mcpConfig.mcpServers[name];
                        if (!target) return;
                        const copyName = createUniqueName("mcp", Object.keys(draft.mcpConfig.mcpServers));
                        draft.mcpConfig.mcpServers[copyName] = { ...target };
                        setSelectedMcpServer(copyName);
                      }, {
                        persist: false,
                        recordHistory: true,
                        historySummary: formatMessage(t(locale, "historyCloneMcpServer"), { name }),
                      })
                    }
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    className="list-delete-button"
                    type="button"
                    aria-label={`${t(locale, "delete")} ${name}`}
                    title={t(locale, "delete")}
                    onClick={() => {
                      void (async () => {
                        if (!(await confirmDeleteResource(getResourceLabel(locale, "mcp"), name))) return;
                        updateState((draft) => {
                          delete draft.mcpConfig.mcpServers[name];
                          if (selectedMcpServer === name) {
                            setSelectedMcpServer(Object.keys(draft.mcpConfig.mcpServers)[0] ?? "");
                          }
                        }, {
                          historySummary: formatMessage(t(locale, "historyDeleteMcpServer"), { name }),
                        });
                      })();
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              );
            }}
          >
            <div className="mcp-workspace">
              {state.pluginInventory && Object.keys(state.pluginInventory.mcpServers).length > 0 ? (
                <section className="glass-panel form-panel">
                  <div className="section-title">{t(locale, "mcpPluginScopeTitle")}</div>
                  <p className="settings-note">{t(locale, "mcpPluginScopeDescription")}</p>
                  <div className="kimi-environment-path-grid">
                    {Object.entries(state.pluginInventory.mcpServers).map(([name, server]) => (
                      <div key={name}>
                        <span>{server.enabled === false ? t(locale, "overviewOff") : t(locale, "overviewOn")}</span>
                        <code title={name}>{name} · {server.transport}</code>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {state.projectMcpConfig ? (
                <section className="glass-panel form-panel">
                  <div className="section-title">{t(locale, "mcpProjectScopeTitle")}</div>
                  <p className="settings-note">
                    {t(locale, "mcpProjectScopeDescription")} <code>{state.projectMcpConfig.configPath}</code>
                  </p>
                  {!state.projectMcpConfig.trusted ? (
                    <p className="settings-note error-text">{t(locale, "mcpProjectScopeUntrusted")}</p>
                  ) : null}
                  {state.projectMcpConfig.error ? (
                    <p className="settings-note error-text">{state.projectMcpConfig.error}</p>
                  ) : null}
                  {Object.keys(state.projectMcpConfig.declaredMcpServers).length > 0 ? (
                    <div className="kimi-environment-path-grid">
                      {Object.entries(state.projectMcpConfig.declaredMcpServers).map(([name, server]) => (
                        <div key={name}>
                          <span>
                            {!state.projectMcpConfig?.trusted
                              ? t(locale, "mcpProjectDeclaredInactive")
                              : state.mcpConfig.mcpServers[name]
                              ? t(locale, "mcpProjectOverridesUser")
                              : t(locale, "mcpProjectOnly")}
                          </span>
                          <code title={name}>{name} · {server.transport}</code>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="settings-note">{t(locale, "mcpProjectScopeEmpty")}</p>
                  )}
                </section>
              ) : null}
              {selectedMcpServerData ? (
                <McpServerForm
                  locale={locale}
                  name={selectedMcpServerName}
                  nameEditable={isMcpServerNameEditable}
                  value={selectedMcpServerData}
                  isTesting={mcpTestingName === selectedMcpServerName}
                  onRunAction={async (action, serverName) => {
                    const api = getApi();
                    const runAction = getMcpAction(api, action);
                    if (!api) {
                      setError("Tauri runtime API is unavailable. MCP command cannot continue.");
                      return;
                    }
                    if (!runAction) {
                      setNotice("");
                      setError(t(locale, "mcpRuntimeOutdated"));
                      return;
                    }
                    try {
                      if (action === "test") {
                        setMcpTestingName(serverName);
                      }
                      const persisted = await persistState(state);
                      if (!persisted) return;
                      await runAction(serverName);
                      setError("");
                      setNotice(getMcpActionNotice(locale, action));
                    } catch (commandError) {
                      const message = commandError instanceof Error ? commandError.message : String(commandError);
                      setNotice("");
                      setError(translateError(locale, message));
                    } finally {
                      if (action === "test") {
                        setMcpTestingName("");
                      }
                    }
                  }}
                  onChange={(name, nextServer) =>
                    updateState((draft) => {
                      const currentName = selectedMcpServerName;
                      const normalizedName = isMcpServerNameEditable
                        ? ensureUniqueEntryName({
                            kind: "MCP server",
                            name,
                            currentName,
                            existingNames: Object.keys(draft.mcpConfig.mcpServers),
                          })
                        : currentName;
                      const nextServers = { ...draft.mcpConfig.mcpServers };
                      delete nextServers[currentName];
                      nextServers[normalizedName] = nextServer;
                      draft.mcpConfig.mcpServers = nextServers;
                      setSelectedMcpServer(normalizedName);
                    }, { persist: false })
                  }
                  onSave={() => void onSave()}
                  onDelete={() => {
                    void (async () => {
                      if (!(await confirmDeleteResource(getResourceLabel(locale, "mcp"), selectedMcpServerName))) return;
                      updateState((draft) => {
                        delete draft.mcpConfig.mcpServers[selectedMcpServerName];
                        setSelectedMcpServer(Object.keys(draft.mcpConfig.mcpServers)[0] ?? "");
                      }, {
                        historySummary: formatMessage(t(locale, "historyDeleteMcpServer"), { name: selectedMcpServerName }),
                      });
                    })();
                  }}
                />
              ) : (
                <EmptyState locale={locale} hasItems={mcpEntries.length > 0} />
              )}
              {isMcpJsonViewerOpen ? (
                <McpJsonViewerDialog
                  locale={locale}
                  value={buildMcpConfigDocument(state.mcpConfig)}
                  onClose={() => setIsMcpJsonViewerOpen(false)}
                />
              ) : null}
            </div>
          </ResourceWorkspace>
        ) : null}

        {activeTab === "skills" ? (
          <ResourceWorkspace
            listTitle={t(locale, "skillsDirectory")}
            listItems={sortedSkillPathEntries.map((path) => path.id)}
            searchPlaceholder={t(locale, "searchResources")}
            itemLabel={(item) => {
              const path = sortedSkillPathEntries.find((entry) => entry.id === item);
              return path ? formatSkillPathLabel(path, locale) : item;
            }}
            renderItemLabel={(item) => {
              const path = sortedSkillPathEntries.find((entry) => entry.id === item);
              return path ? renderSkillPathLabel(path, locale) : item;
            }}
            itemTitle={(item) => {
              const path = sortedSkillPathEntries.find((entry) => entry.id === item);
              return path ? path.path : item;
            }}
            selectedItem={selectedSkillPathId}
            onSelect={(item) => {
              setSelectedSkillPath(item);
              setSelectedSkill("");
            }}
            addLabel={t(locale, "skillsRefresh")}
            onAdd={() => void refreshSkills(state)}
            addButtonTitle={t(locale, "skillsRefresh")}
            addButtonContent={
              isSkillsLoading ? <LoaderCircle size={15} className="button-spinner" /> : <RefreshCw size={15} />
            }
            addButtonClassName={isSkillsLoading ? "action-button compact icon-only is-loading" : "action-button compact icon-only"}
            itemClassName={(item) => {
              const path = skillPathEntries.find((entry) => entry.id === item);
              if (!path) {
                return null;
              }
              if (!path.exists || !path.selected) {
                return "disabled";
              }
              return null;
            }}
            renderItemAction={(item) => {
              const path = skillPathEntries.find((entry) => entry.id === item);
              if (!path) {
                return null;
              }
              const pathSkills = skillEntries.filter((skill) => skill.sourcePathId === item);
              return (
                <>
                  <span className="list-current-badge">{pathSkills.length}</span>
                </>
              );
            }}
          >
            <SkillsWorkspace
              locale={locale}
              report={skillsReport}
              selectedPath={selectedSkillPathData}
              visibleSkills={visibleSkillEntries}
              selectedSkill={selectedSkillData}
              viewMode={skillsViewMode}
              onViewModeChange={setSkillsViewMode}
              onSelectSkill={setSelectedSkill}
              isLoading={isSkillsLoading}
            />
          </ResourceWorkspace>
        ) : null}

        {activeTab === "insights" ? (
          <InsightsDashboard
            locale={locale}
            onStateChange={() => void loadState()}
            onOpenSettings={() => runAfterUnsavedHandled(() => {
              setActiveSettingsSubTab("insights");
              setActiveTab("settings");
            })}
          />
        ) : null}

        {activeTab === "settings" ? (
          <ResourceWorkspace
            listItems={settingsSubTabs.map((tab) => tab.id)}
            selectedItem={activeSettingsSubTab}
            itemLabel={(item) => settingsSubTabs.find((tab) => tab.id === item)?.label ?? item}
            renderItemLabel={(item) => {
              const tab = settingsSubTabs.find((entry) => entry.id === item);
              return tab ? (
                <span className="settings-list-label">
                  <strong>{tab.label}</strong>
                  <small>{tab.description}</small>
                </span>
              ) : item;
            }}
            onSelect={(item) => setActiveSettingsSubTab(item as SettingsSubTab)}
            addLabel={t(locale, "settings")}
          >
          <section className="glass-panel form-panel settings-grid settings-detail-panel">
            <div className="section-title section-title-with-hint">
              <span>{settingsSubTabs.find((tab) => tab.id === activeSettingsSubTab)?.label ?? t(locale, "settings")}</span>
              <span className="autosave-status">{t(locale, "changesAutoSaved")}</span>
            </div>
            {activeSettingsSubTab === "kimi-code" ? (
              <div className="settings-tab-panel kimi-code-settings-panel" id={`kimi-code-panel-${kimiCodeSubTab}`} role="tabpanel" aria-labelledby={`kimi-code-tab-${kimiCodeSubTab}`} tabIndex={0}>
                <TabList
                  label={t(locale, "settingsTabKimiCode")}
                  activeId={kimiCodeSubTab}
                  onChange={setKimiCodeSubTab}
                  className="settings-inner-tabs-nav"
                  tabClassName="settings-inner-tab-button"
                  panelIdPrefix="kimi-code"
                  items={([
                    ["instance", "settingsGroupConfigTarget"],
                    ["accounts", "officialAccountsTitle"],
                    ["environment", "kimiCodeEnvironmentTitle"],
                    ["plugins", "pluginsTitle"],
                  ] as const).map(([id, key]) => ({ id, label: t(locale, key) }))}
                />
                <p className="settings-inner-tab-desc">
                  {renderInlineCodeMessage(t(locale, kimiCodeSubTab === "instance"
                    ? "kimiCodeSubTabInstanceDesc"
                    : kimiCodeSubTab === "accounts"
                      ? "kimiCodeSubTabAccountsDesc"
                      : kimiCodeSubTab === "environment"
                        ? "kimiCodeSubTabEnvironmentDesc"
                        : "kimiCodeSubTabPluginsDesc"))}
                </p>
                {kimiCodeSubTab === "instance" ? (
                <SettingsGroup>
                  <div className="config-target-detection">
                    <div className="config-target-detection-main">
                      <div>
                        <span>{t(locale, "configTargetLabel")}</span>
                        <strong>{currentConfigTargetLabel}</strong>
                      </div>
                      <span className={`config-target-status ${targetDetectionStatusClass}`}>
                        {targetDetectionStatusLabel}
                      </span>
                    </div>
                    <div className="config-target-detection-grid">
                      <div className="config-target-metric">
                        <span>{t(locale, "configTargetVersion")}</span>
                        <code>{targetDetection?.version || t(locale, "overviewCliNotFound")}</code>
                      </div>
                      <div className="config-target-metric">
                        <span>{t(locale, "configTargetInstallSource")}</span>
                        <code>{installSourceLabel(targetDetection?.installSource)}</code>
                      </div>
                      <div className="config-target-path">
                        <span>{t(locale, "configTargetExecutable")}</span>
                        <code>{targetDetection?.executablePath || "-"}</code>
                      </div>
                      <div className="config-target-path config-target-resolved-path">
                        <span>{t(locale, "configTargetResolvedPath")}</span>
                        <code>{targetDetection?.resolvedPath || "-"}</code>
                      </div>
                    </div>
                    <p className="config-target-detection-note">
                      {renderInlineCodeMessage(t(locale, "configTargetAutoDescription"))}
                    </p>
                    {targetDetection?.installed === false ? (
                      <p className="config-target-install-warning">
                        {formatMessage(t(locale, "configTargetInstallRequired"), {
                          name: currentConfigTargetLabel,
                          command: "brew install kimi-code",
                        })}
                      </p>
                    ) : null}
                  </div>
                  <div className="section-title">{t(locale, "tuiEffectiveConfigTitle")}</div>
                  <p className="settings-note">{t(locale, "tuiEffectiveConfigDescription")}</p>
                  {state.tuiDiagnostics && (state.tuiDiagnostics.errors.length > 0 || state.tuiDiagnostics.warnings.length > 0) ? (
                    <div className="import-preview-warning" role="alert">
                      {[...state.tuiDiagnostics.errors, ...state.tuiDiagnostics.warnings].map((message) => (
                        <div key={message}>{message}</div>
                      ))}
                    </div>
                  ) : null}
                  <div className="kimi-environment-path-grid">
                    <div><span>{t(locale, "tuiTheme")}</span><code>{state.tuiConfig?.theme ?? "auto"}</code></div>
                    <div><span>{t(locale, "tuiEditor")}</span><code>{state.tuiConfig?.editorCommand || "$VISUAL / $EDITOR"}</code></div>
                    <div><span>{t(locale, "tuiRenderLatex")}</span><code>{String(state.tuiConfig?.renderLatex ?? true)}</code></div>
                    <div><span>{t(locale, "tuiCacheExpiryHint")}</span><code>{String(state.tuiConfig?.cacheExpiryHint ?? true)}</code></div>
                    <div><span>{t(locale, "tuiNotifications")}</span><code>{String(state.tuiConfig?.notificationsEnabled ?? true)} · {state.tuiConfig?.notificationCondition ?? "unfocused"}</code></div>
                    <div><span>{t(locale, "tuiUpgradeAutoInstall")}</span><code>{String(state.tuiConfig?.upgradeAutoInstall ?? true)}</code></div>
                    <div><span>{t(locale, "tuiStatusLine")}</span><code>{state.tuiConfig?.statusLine?.command || state.tuiConfig?.statusLine?.items?.join(", ") || "-"}</code></div>
                  </div>
                  <div className="section-title">{t(locale, "tuiAdvancedEditTitle")}</div>
                  <div className="settings-inline-fields">
                    <label className="toggle-field">
                      <input type="checkbox" checked={state.tuiConfig?.renderLatex ?? true} onChange={(event) => updateTuiConfig({ renderLatex: event.target.checked })} />
                      <span>{t(locale, "tuiRenderLatex")}</span>
                    </label>
                    <label className="toggle-field">
                      <input type="checkbox" checked={state.tuiConfig?.cacheExpiryHint ?? true} onChange={(event) => updateTuiConfig({ cacheExpiryHint: event.target.checked })} />
                      <span>{t(locale, "tuiCacheExpiryHint")}</span>
                    </label>
                    <label className="toggle-field">
                      <input type="checkbox" checked={state.tuiConfig?.notificationsEnabled ?? true} onChange={(event) => updateTuiConfig({ notificationsEnabled: event.target.checked })} />
                      <span>{t(locale, "tuiNotifications")}</span>
                    </label>
                    <label className="toggle-field">
                      <input type="checkbox" checked={state.tuiConfig?.upgradeAutoInstall ?? true} onChange={(event) => updateTuiConfig({ upgradeAutoInstall: event.target.checked })} />
                      <span>{t(locale, "tuiUpgradeAutoInstall")}</span>
                    </label>
                    <label className="toggle-field">
                      <input type="checkbox" checked={state.tuiConfig?.disable_paste_burst ?? false} onChange={(event) => updateTuiConfig({ disable_paste_burst: event.target.checked })} />
                      <span>{t(locale, "tuiDisablePasteBurst")}</span>
                    </label>
                  </div>
                  <SelectField
                    label={t(locale, "tuiNotificationCondition")}
                    value={state.tuiConfig?.notificationCondition ?? "unfocused"}
                    onChange={(value) => updateTuiConfig({ notificationCondition: value as "unfocused" | "always" })}
                    options={[
                      { value: "unfocused", label: t(locale, "tuiNotificationUnfocused") },
                      { value: "always", label: t(locale, "tuiNotificationAlways") },
                    ]}
                  />
                  <div className="settings-inline-fields">
                    <Field
                      label={t(locale, "tuiStatusItems")}
                      value={state.tuiConfig?.statusLine?.items?.join(", ") ?? ""}
                      onChange={(value) => updateTuiConfig({
                        statusLine: {
                          ...(state.tuiConfig?.statusLine ?? {}),
                          items: value.split(",").map((item) => item.trim()).filter(Boolean),
                        },
                      })}
                    />
                    <Field
                      label={t(locale, "tuiStatusCommand")}
                      value={state.tuiConfig?.statusLine?.command ?? ""}
                      onChange={(value) => updateTuiConfig({
                        statusLine: { ...(state.tuiConfig?.statusLine ?? {}), command: value },
                      })}
                    />
                  </div>
                  {state.projectLocalConfig ? (
                    <div className="glass-panel form-panel">
                      <div className="section-title">{t(locale, "projectLocalConfigTitle")}</div>
                      <p className="settings-note">{t(locale, "projectLocalConfigDescription")} <code>{state.projectLocalConfig.path}</code></p>
                      {state.projectLocalConfig.error ? (
                        <div className="import-preview-warning" role="alert">{state.projectLocalConfig.error}</div>
                      ) : (
                        <>
                          <label className="field">
                            <span>{t(locale, "projectAdditionalDirs")}</span>
                            <textarea
                              rows={4}
                              value={state.projectLocalConfig.additionalDirs.join("\n")}
                              placeholder={t(locale, "projectAdditionalDirsHint")}
                              onChange={(event) => updateState((draft) => {
                                if (!draft.projectLocalConfig) return;
                                draft.projectLocalConfig.additionalDirs = event.target.value
                                  .split(/\r?\n/)
                                  .map((entry) => entry.trim())
                                  .filter(Boolean);
                              }, { persist: false })}
                            />
                          </label>
                          <button
                            className="action-button compact"
                            type="button"
                            onClick={() => {
                              const api = getApi();
                              if (!api || typeof api.saveProjectAdditionalDirs !== "function") return;
                              void api.saveProjectAdditionalDirs(state.projectLocalConfig!.additionalDirs)
                                .then(async () => {
                                  setNotice(t(locale, "projectAdditionalDirsSaved"));
                                  await loadState();
                                })
                                .catch((error) => setError(error instanceof Error ? error.message : String(error)));
                            }}
                          >
                            <Save size={14} />
                            <span>{t(locale, "projectAdditionalDirsSave")}</span>
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </SettingsGroup>
                ) : null}
                {kimiCodeSubTab === "accounts" ? (
                <>
                <div className={`oauth-login-panel oauth-login-${kimiCodeOAuthLogin.status}`}>
                  <div className="oauth-login-copy">
                    <strong>{formatMessage(t(locale, "kimiOauthTitle"), { target: currentConfigTargetLabel })}</strong>
                    <span>{renderInlineCodeMessage(t(locale, "kimiOauthDescription"), { target: currentConfigTargetLabel })}</span>
                  </div>
                  <div className="oauth-login-actions">
                    <button
                      className={kimiCodeOAuthLogin.status === "running" ? "action-button is-loading" : "action-button"}
                      type="button"
                      disabled={kimiCodeOAuthLogin.status === "running"}
                      onClick={startKimiOAuthLogin}
                    >
                      {kimiCodeOAuthLogin.status === "running" ? <LoaderCircle size={14} className="button-spinner" /> : <LogIn size={14} />}
                      <span>{formatMessage(t(locale, kimiCodeOAuthLogin.status === "running" ? "kimiOauthRunning" : "kimiOauthLogin"), { target: currentConfigTargetLabel })}</span>
                    </button>
                    {kimiCodeOAuthLogin.url ? (
                      <button
                        className="action-button secondary"
                        type="button"
                        onClick={() => void getApi()?.openExternal?.(kimiCodeOAuthLogin.url)}
                      >
                        <ExternalLink size={14} />
                        <span>{t(locale, "kimiCodeOauthOpenBrowser")}</span>
                      </button>
                    ) : null}
                  </div>
                  {kimiCodeOAuthLogin.url || kimiCodeOAuthLogin.userCode || kimiCodeOAuthLogin.message ? (
                    <div className="oauth-login-status">
                      {kimiCodeOAuthLogin.url ? (
                        <div><span>{t(locale, "kimiCodeOauthUrl")}</span><code>{kimiCodeOAuthLogin.url}</code></div>
                      ) : null}
                      {kimiCodeOAuthLogin.userCode ? (
                        <div><span>{t(locale, "kimiCodeOauthUserCode")}</span><strong>{kimiCodeOAuthLogin.userCode}</strong></div>
                      ) : null}
                      {kimiCodeOAuthLogin.expiresIn !== null ? (
                        <div><span>{t(locale, "kimiCodeOauthExpiresIn")}</span><strong>{kimiCodeOAuthLogin.expiresIn}s</strong></div>
                      ) : null}
                      <div>
                        <span>{t(locale, "kimiCodeOauthStatus")}</span>
                        <em>{formatMessage(t(locale, kimiCodeOAuthLogin.messageKey), { target: currentConfigTargetLabel, message: kimiCodeOAuthLogin.message })}</em>
                      </div>
                    </div>
                  ) : null}
                </div>
                <SettingsGroup>
                  <div className="official-account-panel">
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={Boolean(state.panelSettings.official_account_vault_enabled)}
                        onChange={(event) => updateImmediateState((draft) => {
                          draft.panelSettings.official_account_vault_enabled = event.target.checked;
                          if (!event.target.checked) draft.panelSettings.active_official_account_id = "";
                        })}
                      />
                      <span>{t(locale, "officialAccountVaultEnable")}</span>
                    </label>
                    <p className="form-note is-block">{t(locale, "officialAccountVaultDescription")}</p>
                    {state.panelSettings.official_account_vault_enabled ? (
                    <>
                    <div className="official-account-toolbar">
                      <div>
                        <strong>{t(locale, "officialAccountsCurrent")}</strong>
                        <span>
                          {officialAccounts.find((account) => account.id === state.panelSettings.active_official_account_id)?.display_name
                            || t(locale, "officialAccountNoneActive")}
                        </span>
                      </div>
                    </div>
                    <div className="official-account-list">
                      {officialAccountsLoading ? (
                        <div className="official-account-empty">
                          <LoaderCircle size={14} className="button-spinner" />
                          <span>{t(locale, "loading")}</span>
                        </div>
                      ) : officialAccounts.length === 0 ? (
                        <div className="official-account-empty">{t(locale, "officialAccountEmpty")}</div>
                      ) : officialAccounts.map((account) => (
                        <div className={account.is_active ? "official-account-card active" : "official-account-card"} key={account.id}>
                          <div className="official-account-main">
                            <strong>{account.display_name}</strong>
                            <span>{account.credentials_slot_path}</span>
                          </div>
                          <div className="official-account-meta">
                            <span className={account.status === "logged-in" ? "config-target-status is-ok" : "config-target-status is-danger"}>
                              {account.status === "logged-in" ? t(locale, "officialAccountLoggedIn") : t(locale, "officialAccountEmptyStatus")}
                            </span>
                            {account.is_active ? <span className="config-target-status is-ok">{t(locale, "officialAccountActive")}</span> : null}
                          </div>
                          <div className="official-account-actions">
                            <button
                              className="action-button compact secondary"
                              type="button"
                              disabled={account.is_active || kimiCodeOAuthLogin.status === "running"}
                              onClick={() => activateOfficialAccount(account.id)}
                            >
                              <Power size={13} />
                              <span>{t(locale, "officialAccountActivate")}</span>
                            </button>
                            <button
                              className="action-button compact danger"
                              type="button"
                              disabled={kimiCodeOAuthLogin.status === "running"}
                              aria-label={t(locale, "delete")}
                              title={t(locale, "delete")}
                              onClick={() => deleteOfficialAccount(account)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    </>
                    ) : null}
                  </div>
                </SettingsGroup>
                <ChatgptBridgePanel
                  locale={locale}
                  state={state}
                  updateState={updateState}
                  setError={setError}
                  setNotice={setNotice}
                />
                </>
                ) : null}
                {kimiCodeSubTab === "environment" ? (
                <SettingsGroup>
                  <div className="kimi-environment-panel">
                    <div className="kimi-environment-summary">
                      <div>
                        <span>{t(locale, "kimiCodeEnvironmentActive")}</span>
                        <strong>{activeKimiCodeEnvironment.name || activeKimiCodeEnvironment.id}</strong>
                      </div>
                      <button className="action-button compact" type="button" onClick={addKimiCodeEnvironment}>
                        <Plus size={13} />
                        <span>{t(locale, "kimiCodeEnvironmentAdd")}</span>
                      </button>
                    </div>
                    <div className="kimi-environment-table-wrap">
                      <table className="kimi-environment-table">
                        <thead>
                          <tr>
                            <th>{t(locale, "kimiCodeEnvironmentIdentifier")}</th>
                            <th>{t(locale, "kimiCodeEnvironmentName")}</th>
                            <th>{t(locale, "actions")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kimiCodeEnvironments.map((environment) => {
                            const draft = environmentDraftFor(environment);
                            const isActive = environment.id === activeKimiCodeEnvironment.id;
                            const isSelected = environment.id === selectedKimiCodeEnvironment.id;
                            const isDirty = draft.name !== environment.name
                              || (draft.description ?? "") !== (environment.description ?? "")
                              || (draft.workingDirectory ?? "") !== (environment.workingDirectory ?? "");
                            return (
                              <tr
                                className={`${isActive ? "active" : ""} ${isSelected ? "selected" : ""}`.trim()}
                                key={environment.id}
                                onClick={() => setSelectedKimiCodeEnvironmentId(environment.id)}
                              >
                                <td>
                                  <code className="kimi-environment-identifier" title={environment.id}>{environment.id}</code>
                                </td>
                                <td>
                                  <div className="kimi-environment-name-cell">
                                    <div className="kimi-environment-name-line">
                                      <span className={isActive ? "status-dot active" : "status-dot"} />
                                      <strong>{draft.name || environment.id}</strong>
                                      {isDirty ? <span className="kimi-environment-dirty-dot" title={t(locale, "unsavedChanges")} /> : null}
                                    </div>
                                    <div className="kimi-environment-meta-line">
                                      <span>{draft.description || t(locale, "kimiCodeEnvironmentDescription")}</span>
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <div className="kimi-environment-row-actions">
                                    {isDirty ? (
                                      <button
                                        className="icon-button is-dirty"
                                        type="button"
                                        aria-label={t(locale, "saveProvider")}
                                        title={t(locale, "saveProvider")}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          saveKimiCodeEnvironment(environment.id);
                                        }}
                                      >
                                        <Save size={15} />
                                      </button>
                                    ) : null}
                                    <button
                                      className={isActive ? "icon-button is-active" : "icon-button"}
                                      type="button"
                                      disabled={isActive}
                                      aria-label={t(locale, "activate")}
                                      title={t(locale, "activate")}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        activateKimiCodeEnvironment(environment.id);
                                      }}
                                    >
                                      <CircleCheckBig size={15} />
                                    </button>
                                    <button
                                      className="icon-button danger"
                                      type="button"
                                      disabled={environment.id === "default" || kimiCodeEnvironments.length <= 1}
                                      aria-label={t(locale, "delete")}
                                      title={t(locale, "delete")}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        deleteKimiCodeEnvironment(environment);
                                      }}
                                    >
                                      <Trash2 size={15} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="kimi-environment-editor">
                      <div className="kimi-environment-editor-head">
                        <div>
                          <span>{selectedKimiCodeEnvironment.id === activeKimiCodeEnvironment.id ? t(locale, "kimiCodeEnvironmentActive") : t(locale, "kimiCodeEnvironment")}</span>
                          <strong>{selectedKimiCodeEnvironment.name || selectedKimiCodeEnvironment.id}</strong>
                        </div>
                        {(() => {
                          const draft = environmentDraftFor(selectedKimiCodeEnvironment);
                          const isActiveSelected = selectedKimiCodeEnvironment.id === activeKimiCodeEnvironment.id;
                          const isDirty = draft.name !== selectedKimiCodeEnvironment.name
                            || (draft.description ?? "") !== (selectedKimiCodeEnvironment.description ?? "")
                            || (draft.workingDirectory ?? "") !== (selectedKimiCodeEnvironment.workingDirectory ?? "");
                          return isDirty && !isActiveSelected ? (
                            <button className="action-button compact" type="button" onClick={() => saveKimiCodeEnvironment(selectedKimiCodeEnvironment.id)}>
                              <Save size={13} />
                              <span>{t(locale, "saveProvider")}</span>
                            </button>
                          ) : null;
                        })()}
                      </div>
                      {(() => {
                        const draft = environmentDraftFor(selectedKimiCodeEnvironment);
                        const isActiveSelected = selectedKimiCodeEnvironment.id === activeKimiCodeEnvironment.id;
                        return (
                          <>
                            <div className="settings-inline-fields">
                              <Field
                                label={t(locale, "kimiCodeEnvironmentName")}
                                value={draft.name}
                                readOnly={isActiveSelected}
                                onChange={(value) => updateEnvironmentDraft(selectedKimiCodeEnvironment.id, { name: value })}
                              />
                              <Field
                                label={t(locale, "kimiCodeEnvironmentHomePath")}
                                value={draft.homePath}
                                readOnly
                                onChange={() => {}}
                              />
                            </div>
                            <Field
                              label={t(locale, "kimiCodeEnvironmentDescription")}
                              value={draft.description ?? ""}
                              readOnly={isActiveSelected}
                              onChange={(value) => updateEnvironmentDraft(selectedKimiCodeEnvironment.id, { description: value })}
                            />
                            <Field
                              label={t(locale, "kimiCodeEnvironmentWorkingDirectory")}
                              value={draft.workingDirectory ?? ""}
                              onChange={(value) => updateEnvironmentDraft(selectedKimiCodeEnvironment.id, { workingDirectory: value })}
                            />
                            <div className="kimi-environment-path-grid">
                              <div>
                                <span>{t(locale, "configPath")}</span>
                                <code title={getKimiCodeConfigPath(draft.homePath)}>{getKimiCodeConfigPath(draft.homePath)}</code>
                              </div>
                              <div>
                                <span>{t(locale, "mcpConfigPathLabel")}</span>
                                <code title={getKimiCodeMcpConfigPath(draft.homePath)}>{getKimiCodeMcpConfigPath(draft.homePath)}</code>
                              </div>
                              <div>
                                <span>{t(locale, "kimiCodeEnvironmentSkillsPath")}</span>
                                <code title={getKimiCodeSkillsPath(draft.homePath)}>{getKimiCodeSkillsPath(draft.homePath)}</code>
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </SettingsGroup>
                ) : null}
                {kimiCodeSubTab === "plugins" ? (
                  <SettingsGroup title={t(locale, "pluginsInventoryTitle")} className="settings-group-wide">
                    <p className="settings-group-description">
                      {t(locale, "pluginsInventoryDescription")} <code>{state.pluginInventory?.installedPath ?? "-"}</code>
                    </p>
                    {state.pluginInventory?.diagnostics.length ? (
                      <div className="import-preview-warning" role="alert">
                        {state.pluginInventory.diagnostics.map((diagnostic, index) => (
                          <div key={`${index}-${diagnostic.message}`}>{diagnostic.severity}: {diagnostic.message}</div>
                        ))}
                      </div>
                    ) : null}
                    {state.pluginInventory?.plugins.length ? (
                      <div className="backup-records-list">
                        {state.pluginInventory.plugins.map((plugin) => (
                          <article className="backup-record-card" key={plugin.id}>
                            <div className="backup-record-meta">
                              <div>
                                <strong>{plugin.displayName || plugin.id}</strong>
                                <small>{plugin.version ?? "-"} · {plugin.source}</small>
                              </div>
                              <div>
                                <span>{plugin.enabled ? t(locale, "overviewOn") : t(locale, "overviewOff")}</span>
                                <small>{plugin.state}</small>
                              </div>
                              <div>
                                <span>{formatMessage(t(locale, "pluginsCapabilitySummary"), {
                                  skills: plugin.skillRoots.length,
                                  mcp: Object.keys(plugin.mcpServers).length,
                                  hooks: plugin.hookCount,
                                })}</span>
                              </div>
                            </div>
                            <code title={plugin.root}>{plugin.root}</code>
                            {plugin.diagnostics.length ? (
                              <div className="settings-note">
                                {plugin.diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`).join(" · ")}
                              </div>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="command-palette-empty">{t(locale, "pluginsInventoryEmpty")}</div>
                    )}
                  </SettingsGroup>
                ) : null}
              </div>
            ) : null}
            {activeSettingsSubTab === "general" ? (
              <div className="settings-tab-panel">
                <SettingsGroup title={t(locale, "settingsGroupAppearance")}>
                  <div className="settings-inline-fields">
                    <SelectField
                      label={t(locale, "locale")}
                      value={state.panelSettings.locale}
                      onChange={(value) =>
                        updateImmediateState((draft) => {
                          draft.panelSettings.locale = value as Locale;
                        })
                      }
                      options={LOCALE_OPTIONS.map((option) => ({
                        value: option.value,
                        label: option.longLabel,
                        badge: option.shortLabel,
                        badgeClassName: "flag",
                      }))}
                    />
                    <SelectField
                      label={t(locale, "displayOpenMode")}
                      value={state.panelSettings.display_open_mode}
                      onChange={(value) =>
                        updateImmediateState((draft) => {
                          draft.panelSettings.display_open_mode = value as DisplayOpenMode;
                        })
                      }
                      options={DISPLAY_OPEN_OPTIONS.map((option) => ({
                        value: option.value,
                        label: labelForLocale(option.label, locale),
                      }))}
                    />
                  </div>
                  <div className="settings-inline-fields">
                    <SelectField
                      label={t(locale, "theme")}
                      value={state.panelSettings.theme}
                      onChange={(value) =>
                        updateImmediateState((draft) => {
                          draft.panelSettings.theme = value as AppearanceMode;
                        })
                      }
                      selectedIcon={(THEME_OPTIONS.find((option) => option.value === state.panelSettings.theme) ?? THEME_OPTIONS[0]).icon}
                      options={THEME_OPTIONS.map((option) => ({
                        value: option.value,
                        label: labelForLocale(option.label, locale),
                        icon: option.icon,
                      }))}
                    />
                    <SelectField
                      label={t(locale, "appearanceTheme")}
                      value={state.panelSettings.appearance_theme ?? "aurora"}
                      onChange={(value) =>
                        updateImmediateState((draft) => {
                          draft.panelSettings.appearance_theme = value as AppearanceTheme;
                        })
                      }
                      selectedIcon={(APPEARANCE_THEME_OPTIONS.find((option) => option.value === state.panelSettings.appearance_theme) ?? APPEARANCE_THEME_OPTIONS[0]).icon}
                      options={APPEARANCE_THEME_OPTIONS.map((option) => ({
                        value: option.value,
                        label: labelForLocale(option.label, locale),
                        icon: option.icon,
                      }))}
                    />
                  </div>
                  <FontSizeSliderField
                    locale={locale}
                    label={t(locale, "uiFontSize")}
                    value={state.panelSettings.ui_font_size ?? "standard"}
                    options={UI_FONT_SIZE_OPTIONS}
                    onChange={(value) =>
                      updateImmediateState((draft) => {
                        draft.panelSettings.ui_font_size = value;
                      })
                    }
                  />
                </SettingsGroup>
                <SettingsGroup title={t(locale, "settingsGroupBehavior")}>
                  {/* 托盘与关闭行为依赖 Rust 原生托盘/窗口控制，仅桌面形态展示。 */}
                  {isDesktopRuntime() ? (
                    <label className="toggle-row">
                      <span>{t(locale, "trayIcon")}</span>
                      <input
                        type="checkbox"
                        checked={state.panelSettings.tray_icon}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          updateImmediateState((draft) => {
                            draft.panelSettings.tray_icon = enabled;
                            draft.panelSettings.close_behavior = enabled ? "keep-in-tray" : "quit";
                          });
                          void getApi()?.setTray?.(enabled).catch((trayError: unknown) => {
                            const message = trayError instanceof Error ? trayError.message : String(trayError);
                            setNotice("");
                            setError(translateError(locale, message));
                          });
                        }}
                      />
                    </label>
                  ) : null}
                  {isDesktopRuntime() && state.panelSettings.tray_icon ? (
                    <SelectField
                      label={t(locale, "closeBehavior")}
                      value={state.panelSettings.close_behavior}
                      onChange={(value) =>
                        updateImmediateState((draft) => {
                          draft.panelSettings.close_behavior = value as CloseBehavior;
                        })
                      }
                      options={CLOSE_BEHAVIOR_OPTIONS.map((option) => ({
                        value: option.value,
                        label: option.value === "quit"
                          ? t(locale, "closeBehaviorQuit")
                          : t(locale, "closeBehaviorKeepInTray"),
                      }))}
                    />
                  ) : null}
                  <SelectField
                    label={t(locale, "terminalApp")}
                    value={state.panelSettings.terminal_app}
                    onChange={(value) =>
                      updateImmediateState((draft) => {
                        draft.panelSettings.terminal_app = value as TerminalApp;
                      })
                    }
                    options={TERMINAL_APP_OPTIONS.map((option) => ({
                      value: option.value,
                      label: labelForLocale(option.label, locale),
                    }))}
                  />
                </SettingsGroup>
              </div>
            ) : null}
            {activeSettingsSubTab === "shortcuts" ? (
              <SettingsGroup title={t(locale, "settingsGroupShortcuts")} className="settings-group-wide">
              <div className="shortcut-settings-list">
                {shortcutGroups.map((group) => (
                  <section className={`shortcut-section ${group.scope}`} key={group.scope}>
                    <div className="shortcut-section-header">
                      <div>
                        <strong>{group.title}</strong>
                        <span>{group.description}</span>
                      </div>
                      <div className="shortcut-section-tools">
                        <span className={`shortcut-scope-badge ${group.scope}`}>
                          {group.scope === "global" ? t(locale, "shortcutGlobal") : t(locale, "shortcutWindow")}
                        </span>
                        <label className="shortcut-group-toggle">
                          <span>
                            {group.actions.some((definition) => shortcuts[definition.action].enabled)
                              ? t(locale, "enabled")
                              : t(locale, "shortcutDisabled")}
                          </span>
                          <input
                            type="checkbox"
                            checked={group.actions.some((definition) => shortcuts[definition.action].enabled)}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              updateImmediateState((draft) => {
                                for (const definition of group.actions) {
                                  draft.panelSettings.shortcuts[definition.action].enabled = enabled
                                    && draft.panelSettings.shortcuts[definition.action].accelerator.trim().length > 0;
                                }
                              });
                            }}
                          />
                        </label>
                      </div>
                    </div>
                    <div className="shortcut-section-list">
                      {group.actions.map((definition) => {
                        const binding = shortcuts[definition.action];
                        const isConflicting = shortcutConflictActions.has(definition.action);
                        const conflict = shortcutConflicts.find((entry) => entry.actions.includes(definition.action));
                        const conflictText = conflict
                          ? formatMessage(t(locale, "shortcutConflict"), {
                              actions: conflict.actions.map((action) => shortcutLabels[action]).join(" / "),
                            })
                          : "";

                        return (
                          <div
                            key={definition.action}
                            className={isConflicting ? "shortcut-row has-conflict" : "shortcut-row"}
                          >
                            <div className="shortcut-row-copy">
                              <strong>{labelForLocale(definition.label, locale)}</strong>
                              {isConflicting ? <em>{conflictText}</em> : <span>{definition.action}</span>}
                            </div>
                            <div className="shortcut-row-actions">
                              <ShortcutRecorderField
                                label={labelForLocale(definition.label, locale)}
                                displayValue={formatAcceleratorForPlatform(binding.accelerator, shortcutPlatform)}
                                placeholder={t(locale, "shortcutClickToRecord")}
                                recordingHint={t(locale, "shortcutRecorderHint")}
                                disabledText={t(locale, "shortcutDisabled")}
                                onChange={(accelerator) =>
                                  updateImmediateState((draft) => {
                                    draft.panelSettings.shortcuts[definition.action].accelerator = accelerator;
                                    draft.panelSettings.shortcuts[definition.action].enabled = Boolean(accelerator.trim());
                                  })
                                }
                              />
                              <button
                                className="shortcut-icon-button"
                                type="button"
                                title={t(locale, "shortcutReset")}
                                aria-label={t(locale, "shortcutReset")}
                                onClick={() =>
                                  updateImmediateState((draft) => {
                                    draft.panelSettings.shortcuts[definition.action] = resetShortcutBinding(definition.action);
                                  })
                                }
                              >
                                <RotateCcw size={15} />
                              </button>
                              <label className="shortcut-enable">
                                <input
                                  type="checkbox"
                                  checked={binding.enabled}
                                  onChange={(event) =>
                                    updateImmediateState((draft) => {
                                      draft.panelSettings.shortcuts[definition.action].enabled = event.target.checked;
                                    })
                                  }
                                />
                                <span>{binding.enabled ? t(locale, "enabled") : t(locale, "shortcutDisabled")}</span>
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
              <div className="button-row settings-action-row">
                <button
                  className="action-button"
                  type="button"
                  onClick={() =>
                    updateImmediateState((draft) => {
                      for (const definition of SHORTCUT_ACTIONS) {
                        draft.panelSettings.shortcuts[definition.action] = resetShortcutBinding(definition.action);
                      }
                    })
                  }
                >
                  {t(locale, "shortcutResetAll")}
                </button>
              </div>
              </SettingsGroup>
            ) : null}
            {activeSettingsSubTab === "doctor" ? (
              <SettingsGroup title={t(locale, "settingsGroupDoctor")} className="settings-group-wide">
              <DoctorReportPanel locale={locale} report={doctorReport} />
              <div className="button-row settings-action-row">
                <button
                  className="action-button action-button-primary"
                  type="button"
                  onClick={() => runDoctor(state)}
                >
                  <Bug size={16} />
                  <span>{t(locale, "doctorRun")}</span>
                </button>
              </div>
              </SettingsGroup>
            ) : null}
            {activeSettingsSubTab === "backup" ? (
              <>
                <SettingsGroup title={t(locale, "settingsGroupExportImport")} className="settings-group-export-import">
                  <p className="settings-group-description">{t(locale, "exportImportSecretsHint")}</p>
                  <div className="button-row settings-action-row">
                    <button
                      className="action-button"
                      type="button"
                      onClick={async () => {
                        const api = getApi();
                        if (!api) { setError(t(locale, "runtimeUnavailable")); return; }
                        if (typeof api.exportFullBackup !== "function") { setError(t(locale, "backupRuntimeOutdated")); return; }
                        try {
                          const bundle = await api.exportFullBackup(state);
                          const json = JSON.stringify(bundle, null, 2);
                          const result = await api.saveFile(json, { defaultPath: "kimi-full-backup.json" });
                          if (!result.canceled) { setError(""); setNotice(t(locale, "exportSuccessWithSecrets")); }
                        } catch (err) {
                          setNotice("");
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      <Download size={16} />
                      <span>{t(locale, "exportConfig")}</span>
                    </button>
                    <button
                      className="action-button"
                      type="button"
                      onClick={async () => {
                        const api = getApi();
                        if (!api) { setError(t(locale, "runtimeUnavailable")); return; }
                        if (typeof api.importFullBackup !== "function") { setError(t(locale, "backupRuntimeOutdated")); return; }
                        const fileResult = await api.pickFile({ filters: [{ name: "JSON", extensions: ["json"] }] });
                        if (fileResult.canceled) return;
                        try {
                          // 浏览器形态 pickFile 直接带回文件内容；Tauri 形态继续按路径 readFile。
                          let rawJson = fileResult.content;
                          if (rawJson === undefined) {
                            const readResult = await api.readFile(fileResult.filePath);
                            if (!readResult.ok || !readResult.content) { setError(readResult.error ?? t(locale, "importInvalidFile")); return; }
                            rawJson = readResult.content;
                          }
                          const parsed = JSON.parse(rawJson);
                          const validation = validateFullBackup(parsed);
                          if (!validation.valid) { setError(validation.errors.join(" ")); return; }
                          const data = parsed as FullBackupBundle;
                          const risk = assessFullBackupRisk(data);
                          setFullBackupImportDialog({
                            open: true,
                            data,
                            envCount: data.environments.length,
                            hasRedactedSecrets: fullBackupContainsRedactedSecrets(data),
                            riskItems: [
                              ...risk.stdioMcpCommands.map((item) => `MCP stdio · ${item}`),
                              ...risk.remoteMcpEndpoints.map((item) => `MCP remote · ${item}`),
                              ...risk.providerEndpoints.map((item) => `Provider · ${item}`),
                              ...risk.configHooks.map((item) => `Hook · ${item}`),
                              ...risk.agentsDocuments.map((item) => `AGENTS · ${item}`),
                              ...risk.executableSkillFiles.map((item) => `Executable Skill · ${item}`),
                              ...risk.skillDocumentsAndScripts.map((item) => `Skill content/script · ${item}`),
                              ...risk.pluginDirectories.map((item) => `Plugins · ${item}`),
                              ...risk.pluginExecutableFiles.map((item) => `Plugin executable · ${item}`),
                              ...risk.pluginCapabilities.map((item) => `Plugin capability · ${item}`),
                            ],
                          });
                        } catch { setError(t(locale, "importInvalidFile")); }
                      }}
                    >
                      <Upload size={16} />
                      <span>{t(locale, "importConfig")}</span>
                    </button>
                  </div>
                </SettingsGroup>
                <SettingsGroup title={t(locale, "settingsGroupBackup")} className="settings-group-wide">
              <SelectField
                label={t(locale, "backupStrategy")}
                value={state.panelSettings.backup_strategy}
                onChange={(value) =>
                  updateImmediateState((draft) => {
                    draft.panelSettings.backup_strategy = value as BackupStrategy;
                  })
                }
                options={BACKUP_STRATEGY_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(locale, option.labelKey),
                }))}
              />
              {state.panelSettings.backup_strategy === "scheduled" ? (
                <SelectField
                  label={t(locale, "backupFrequency")}
                  value={state.panelSettings.backup_frequency}
                  onChange={(value) =>
                    updateImmediateState((draft) => {
                      draft.panelSettings.backup_frequency = value as BackupFrequency;
                    })
                  }
                  options={BACKUP_FREQUENCY_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(locale, option.labelKey),
                  }))}
                />
              ) : null}
              <Field
                label={t(locale, "backupRetentionCount")}
                value={String(state.panelSettings.backup_retention_count)}
                onChange={(value) => {
                  const nextCount = Number.parseInt(value, 10);
                  if (Number.isNaN(nextCount)) {
                    return;
                  }
                  updateImmediateState((draft) => {
                    draft.panelSettings.backup_retention_count = Math.max(1, Math.min(99, nextCount));
                  });
                }}
                inputMode="numeric"
              />
              <SelectField
                label={t(locale, "backupDestinationType")}
                value={state.panelSettings.backup_destination_type}
                onChange={(value) =>
                  updateImmediateState((draft) => {
                    draft.panelSettings.backup_destination_type = value as BackupDestinationType;
                  })
                }
                options={BACKUP_DESTINATION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(locale, option.labelKey),
                }))}
              />
              {state.panelSettings.backup_destination_type === "local" ? (
                <PathField
                  locale={locale}
                  label={t(locale, "backupLocalPath")}
                  value={state.panelSettings.backup_local_path}
                  readOnly
                  onChange={() => {}}
                  extraActions={[
                    {
                      key: "pick-backup-directory",
                      label: t(locale, "browse"),
                      icon: <FolderOpen size={16} />,
                      onClick: () => void pickBackupDirectory(),
                    },
                  ]}
                />
              ) : (
                <>
                  <Field
                    label={t(locale, "backupWebdavUrl")}
                    value={state.panelSettings.backup_webdav_url}
                    onChange={(value) =>
                      updateImmediateState((draft) => {
                        draft.panelSettings.backup_webdav_url = value;
                      })
                    }
                  />
                  <Field
                    label={t(locale, "backupWebdavUsername")}
                    value={state.panelSettings.backup_webdav_username}
                    onChange={(value) =>
                      updateImmediateState((draft) => {
                        draft.panelSettings.backup_webdav_username = value;
                      })
                    }
                  />
                  <SecretField
                    label={t(locale, "backupWebdavPassword")}
                    value={state.panelSettings.backup_webdav_password}
                    visible={isBackupPasswordVisible}
                    onToggleVisible={() => setIsBackupPasswordVisible((current) => !current)}
                    onChange={(value) =>
                      updateImmediateState((draft) => {
                        draft.panelSettings.backup_webdav_password = value;
                      })
                    }
                    showLabel={t(locale, "showSecret")}
                    hideLabel={t(locale, "hideSecret")}
                  />
                  <Field
                    label={t(locale, "backupWebdavPath")}
                    value={state.panelSettings.backup_webdav_path}
                    onChange={(value) =>
                      updateImmediateState((draft) => {
                        draft.panelSettings.backup_webdav_path = value;
                      })
                    }
                  />
                  <p className="settings-note">{t(locale, "backupRecoveryKeyDescription")}</p>
                  <div className="button-row settings-action-row">
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => {
                        const api = getApi();
                        if (!api || typeof api.exportBackupEncryptionKey !== "function") {
                          setError(t(locale, "backupRuntimeOutdated"));
                          return;
                        }
                        void api.exportBackupEncryptionKey()
                          .then((result) => {
                            if (!result.canceled) {
                              setError("");
                              setNotice(t(locale, "backupRecoveryKeyExported"));
                            }
                          })
                          .catch((error) => setError(error instanceof Error ? error.message : String(error)));
                      }}
                    >
                      <Download size={16} />
                      <span>{t(locale, "backupRecoveryKeyExport")}</span>
                    </button>
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => {
                        const api = getApi();
                        if (!api || typeof api.importBackupEncryptionKey !== "function") {
                          setError(t(locale, "backupRuntimeOutdated"));
                          return;
                        }
                        void (async () => {
                          const confirmed = await requestConfirm({
                            title: t(locale, "backupRecoveryKeyImportTitle"),
                            description: t(locale, "backupRecoveryKeyImportDescription"),
                            confirmLabel: t(locale, "backupRecoveryKeyImport"),
                            cancelLabel: t(locale, "cancel"),
                            tone: "danger",
                            kind: "unsaved",
                          });
                          if (!confirmed) return;
                          const result = await api.importBackupEncryptionKey();
                          if (!result.canceled) {
                            setError("");
                            setNotice(t(locale, "backupRecoveryKeyImported"));
                          }
                        })().catch((error) => setError(error instanceof Error ? error.message : String(error)));
                      }}
                    >
                      <Upload size={16} />
                      <span>{t(locale, "backupRecoveryKeyImport")}</span>
                    </button>
                  </div>
                </>
              )}
              <div className="button-row settings-action-row">
                <button
                  className={isBackupRunning ? "action-button action-button-primary is-loading" : "action-button action-button-primary"}
                  type="button"
                  disabled={isBackupRunning}
                  onClick={runManualBackup}
                >
                  {isBackupRunning ? <LoaderCircle size={16} className="button-spinner" /> : <History size={16} />}
                  <span>{isBackupRunning ? t(locale, "backupRunning") : t(locale, "backupNow")}</span>
                </button>
                <button
                  className={
                    backupRecordsDialog?.isLoading ? "action-button is-loading" : "action-button"
                  }
                  type="button"
                  disabled={backupRecordsDialog?.isLoading}
                  onClick={openBackupRecords}
                >
                  {backupRecordsDialog?.isLoading ? <LoaderCircle size={16} className="button-spinner" /> : <FolderOpen size={16} />}
                  <span>{t(locale, "backupViewRecords")}</span>
                </button>
                {state.panelSettings.backup_destination_type === "webdav" ? (
                  <button
                    className={isWebDavTesting ? "action-button is-loading" : "action-button"}
                    type="button"
                    disabled={isWebDavTesting}
                    onClick={runWebDavTest}
                  >
                    {isWebDavTesting ? <LoaderCircle size={16} className="button-spinner" /> : <Bug size={16} />}
                    <span>{isWebDavTesting ? t(locale, "backupWebdavTesting") : t(locale, "backupWebdavTest")}</span>
                  </button>
                ) : null}
              </div>
                </SettingsGroup>
              </>
            ) : null}
            {activeSettingsSubTab === "history" ? (
              <SettingsGroup title={t(locale, "historyTitle")} className="settings-group-wide">
                <HistoryPanel
                  locale={locale}
                  state={state}
                  updateState={updateState}
                  requestConfirm={requestConfirm}
                  loadState={loadState}
                  setNotice={setNotice}
                  setError={setError}
                  runAfterUnsavedHandled={runAfterUnsavedHandled}
                />
              </SettingsGroup>
            ) : null}
            {activeSettingsSubTab === "insights" ? (
              <InsightsSettingsPanel locale={locale} onStateChange={() => void loadState()} />
            ) : null}
          </section>
          </ResourceWorkspace>
        ) : null}
        {activeTab === "about" ? <AboutPage locale={locale} /> : null}
        {providerCatalogDialog.open ? (
          <ProviderCatalogDialog
            locale={locale}
            state={providerCatalogDialog}
            onChange={(patch) => setProviderCatalogDialog((current) => ({ ...current, ...patch }))}
            onRefresh={() => refreshProviderCatalog()}
            onImport={importSelectedCatalogProvider}
            onImportRegistry={importCustomProviderRegistry}
            onClose={() => setProviderCatalogDialog(createProviderCatalogDialogState())}
          />
        ) : null}
        {fullBackupImportDialog.open && fullBackupImportDialog.data ? (
          <FullBackupImportDialog
            locale={locale}
            envCount={fullBackupImportDialog.envCount}
            hasRedactedSecrets={fullBackupImportDialog.hasRedactedSecrets}
            riskItems={fullBackupImportDialog.riskItems}
            isImporting={isImportingFullBackup}
            onConfirm={() => {
              void (async () => {
                const api = getApi();
                if (!api || typeof api.importFullBackup !== "function") {
                  setError(t(locale, "backupRuntimeOutdated"));
                  return;
                }
                setIsImportingFullBackup(true);
                try {
                  await api.importFullBackup(fullBackupImportDialog.data!);
                  setFullBackupImportDialog({ open: false, data: null, envCount: 0, hasRedactedSecrets: false, riskItems: [] });
                  setError("");
                  setNotice(t(locale, "importSuccessWithPanelSettings"));
                  await loadState();
                } catch (err) {
                  setNotice("");
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setIsImportingFullBackup(false);
                }
              })();
            }}
            onCancel={() => {
              if (isImportingFullBackup) return;
              setFullBackupImportDialog({ open: false, data: null, envCount: 0, hasRedactedSecrets: false, riskItems: [] });
            }}
          />
        ) : null}
        </div>
        {createEnvironmentDraft ? (
          <CreateKimiCodeEnvironmentDialog
            locale={locale}
            environments={kimiCodeEnvironments}
            draft={createEnvironmentDraft}
            onChange={setCreateEnvironmentDraft}
            onCancel={() => setCreateEnvironmentDraft(null)}
            onCreate={createKimiCodeEnvironment}
          />
        ) : null}
      </>
    </ErrorBoundary>
  );
}

function DoctorReportPanel(props: {
  locale: Locale;
  report: ConfigDoctorReport | null;
}): JSX.Element {
  const report = props.report;
  if (!report) {
    return (
      <div className="doctor-panel">
        <div className="doctor-summary muted">
          <strong>{t(props.locale, "doctorNotRun")}</strong>
          <span>{t(props.locale, "doctorNotRunHint")}</span>
        </div>
      </div>
    );
  }

  const visibleIssues = report.issues.slice(0, 8);
  return (
    <div className="doctor-panel">
      <div className={report.ok ? "doctor-summary ok" : "doctor-summary warning"}>
        <strong>
          {report.ok ? t(props.locale, "doctorStatusOk") : t(props.locale, "doctorStatusNeedsAttention")}
        </strong>
        <span>
          {formatMessage(t(props.locale, "doctorSummary"), {
            errors: report.errorCount,
            warnings: report.warningCount,
            infos: report.infoCount,
          })}
        </span>
      </div>
      {visibleIssues.length ? (
        <div className="doctor-issues">
          {visibleIssues.map((issue) => (
            <div key={issue.id} className={`doctor-issue ${issue.severity}`}>
              <span>{issue.severity}</span>
              <div>
                <strong>{issue.scope}</strong>
                <p>{issue.message}</p>
                {issue.suggestedAction ? <em>{issue.suggestedAction}</em> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <DoctorDriftList locale={props.locale} drift={report.drift} />
    </div>
  );
}


function ProviderCatalogDialog(props: {
  locale: Locale;
  state: ProviderCatalogDialogState;
  onChange: (patch: Partial<ProviderCatalogDialogState>) => void;
  onRefresh: () => void;
  onImport: () => void;
  onImportRegistry: () => void;
  onClose: () => void;
}): JSX.Element {
  const { locale, state, onChange, onRefresh, onImport, onImportRegistry, onClose } = props;
  return (
    <DialogShell
      backdropClassName="dialog-overlay"
      dialogClassName="dialog import-preview-dialog"
      ariaLabelledBy="provider-catalog-title"
      onClose={onClose}
    >
        <div className="dialog-header">
          <h3 id="provider-catalog-title">{t(locale, "providerCatalogTitle")}</h3>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t(locale, "close")}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body import-preview-body">
          <p>{t(locale, "providerCatalogDescription")}</p>
          <div className="settings-inline-fields">
            <Field label={t(locale, "providerCatalogFilter")} value={state.filter} onChange={(filter) => onChange({ filter })} />
            <Field label={t(locale, "providerCatalogUrl")} value={state.catalogUrl} onChange={(catalogUrl) => onChange({ catalogUrl })} />
          </div>
          <button className="action-button compact" type="button" disabled={state.loading} onClick={onRefresh}>
            {state.loading ? <LoaderCircle size={15} className="button-spinner" /> : <RefreshCw size={15} />}
            <span>{t(locale, "providerCatalogRefresh")}</span>
          </button>
          {state.error ? <div className="import-preview-warning" role="alert">{state.error}</div> : null}
          <div className="backup-records-list">
            {state.items.map((item) => (
              <button
                type="button"
                className={state.selectedId === item.id ? "history-entry-info active" : "history-entry-info"}
                key={item.id}
                onClick={() => onChange({ selectedId: item.id })}
              >
                <strong>{item.name}</strong>
                <code>{item.id}</code>
                <span>{item.type || "?"} · {formatMessage(t(locale, "providerCatalogModelCount"), { count: item.modelCount })}</span>
              </button>
            ))}
          </div>
          <div className="section-title">{t(locale, "providerCatalogImportTitle")}</div>
          <div className="settings-inline-fields">
            <Field label={t(locale, "providerCatalogSelectedId")} value={state.selectedId} onChange={(selectedId) => onChange({ selectedId })} />
            <label className="field">
              <span>{t(locale, "apiKeyLabel")}</span>
              <input type="password" value={state.apiKey} onChange={(event) => onChange({ apiKey: event.target.value })} />
            </label>
          </div>
          <div className="settings-inline-fields">
            <Field label={t(locale, "formBaseUrl")} value={state.baseUrl} onChange={(baseUrl) => onChange({ baseUrl })} />
            <Field label={t(locale, "providerCatalogDefaultModel")} value={state.defaultModel} onChange={(defaultModel) => onChange({ defaultModel })} />
          </div>
          <button className="action-button primary" type="button" disabled={state.loading || !state.selectedId || !state.apiKey} onClick={onImport}>
            {t(locale, "providerCatalogImportAction")}
          </button>
          <div className="section-title">{t(locale, "providerRegistryImportTitle")}</div>
          <div className="settings-inline-fields">
            <Field label={t(locale, "providerRegistryUrl")} value={state.registryUrl} onChange={(registryUrl) => onChange({ registryUrl, registryTrusted: false })} />
            <label className="field">
              <span>{t(locale, "apiKeyLabel")}</span>
              <input type="password" value={state.registryApiKey} onChange={(event) => onChange({ registryApiKey: event.target.value })} />
            </label>
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={state.registryTrusted}
              onChange={(event) => onChange({ registryTrusted: event.target.checked })}
            />
            <span>{t(locale, "providerRegistryTrustWarning")}</span>
          </label>
          <button className="action-button" type="button" disabled={state.loading || !state.registryUrl || !state.registryApiKey || !state.registryTrusted} onClick={onImportRegistry}>
            {t(locale, "providerRegistryImportAction")}
          </button>
        </div>
    </DialogShell>
  );
}

export function FullBackupImportDialog(props: {
  locale: Locale;
  envCount: number;
  hasRedactedSecrets: boolean;
  riskItems: string[];
  isImporting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { locale, envCount, hasRedactedSecrets, riskItems, isImporting, onConfirm, onCancel } = props;
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  return (
    <DialogShell
      backdropClassName="dialog-overlay"
      dialogClassName="dialog import-preview-dialog"
      ariaLabelledBy="full-backup-import-title"
      closeOnBackdrop={false}
      onClose={onCancel}
    >
        <div className="dialog-header">
          <h3 id="full-backup-import-title">{t(locale, "fullBackupImportTitle")}</h3>
          <button className="icon-button" type="button" onClick={onCancel} aria-label={t(locale, "close")}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body import-preview-body">
          <div className="import-preview-warning" role="alert">
            {formatMessage(t(locale, "fullBackupImportWarning"), { count: envCount })}
          </div>
          {hasRedactedSecrets ? (
            <div className="import-preview-warning" role="alert">{t(locale, "importRedactedWarning")}</div>
          ) : null}
          {riskItems.length > 0 ? (
            <div className="import-preview-warning" role="alert">
              <strong>{formatMessage(t(locale, "fullBackupTrustWarning"), { count: riskItems.length })}</strong>
              <ul>
                {riskItems.slice(0, 20).map((item) => <li key={item}><code>{item}</code></li>)}
              </ul>
            </div>
          ) : null}
          {riskItems.length > 0 ? (
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={trustConfirmed}
                onChange={(event) => setTrustConfirmed(event.target.checked)}
              />
              <span>{t(locale, "fullBackupExecutableTrustConfirm")}</span>
            </label>
          ) : null}
        </div>
        <div className="dialog-footer">
          <button className="action-button secondary" type="button" onClick={onCancel} disabled={isImporting}>
            {t(locale, "cancel")}
          </button>
          <button className="action-button primary" type="button" onClick={onConfirm} disabled={isImporting || (riskItems.length > 0 && !trustConfirmed)}>
            {isImporting ? t(locale, "fullBackupImporting") : t(locale, "importConfirm")}
          </button>
        </div>
    </DialogShell>
  );
}


function CreateKimiCodeEnvironmentDialog(props: {
  locale: Locale;
  environments: KimiCodeEnvironment[];
  draft: CreateEnvironmentDraft;
  onChange: (draft: CreateEnvironmentDraft) => void;
  onCancel: () => void;
  onCreate: (draft: CreateEnvironmentDraft) => void;
}): JSX.Element {
  const { locale, environments, draft, onChange, onCancel, onCreate } = props;
  const titleId = "create-kimi-environment-title";
  const generatedId = draft.id;
  const copyOptions = [
    { value: "", label: t(locale, "kimiCodeEnvironmentCopyNone") },
    ...environments.map((environment) => ({
      value: environment.id,
      label: environment.name || environment.id,
    })),
  ];
  return (
    <DialogShell
      backdropClassName="dialog-overlay"
      dialogClassName="dialog create-environment-dialog"
      ariaLabelledBy={titleId}
      onClose={onCancel}
    >
        <div className="dialog-header">
          <h3 id={titleId}>{t(locale, "kimiCodeEnvironmentCreateTitle")}</h3>
          <button className="icon-button" type="button" aria-label={t(locale, "close")} title={t(locale, "close")} onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body create-environment-body">
          <p>{t(locale, "kimiCodeEnvironmentCreateDescription")}</p>
          <div className="field">
            <span>{t(locale, "kimiCodeEnvironmentIdentifier")}</span>
            <code className="environment-id-preview">{generatedId}</code>
          </div>
          <Field
            label={t(locale, "kimiCodeEnvironmentName")}
            value={draft.name}
            onChange={(value) => onChange({ ...draft, name: value })}
          />
          <div className="field">
            <span>{t(locale, "kimiCodeEnvironmentCopyFrom")}</span>
            <CompactSelect
              ariaLabel={t(locale, "kimiCodeEnvironmentCopyFrom")}
              value={draft.sourceEnvironmentId}
              options={copyOptions}
              onChange={(value) => onChange({ ...draft, sourceEnvironmentId: value })}
            />
          </div>
          <Field
            label={t(locale, "kimiCodeEnvironmentDescription")}
            value={draft.description}
            onChange={(value) => onChange({ ...draft, description: value })}
          />
          <Field
            label={t(locale, "kimiCodeEnvironmentWorkingDirectory")}
            value={draft.workingDirectory}
            onChange={(value) => onChange({ ...draft, workingDirectory: value })}
          />
        </div>
        <div className="dialog-footer">
          <button className="action-button compact secondary" type="button" onClick={onCancel}>
            {t(locale, "cancel")}
          </button>
          <button className="action-button compact" type="button" onClick={() => onCreate(draft)}>
            <Plus size={13} />
            <span>{t(locale, "kimiCodeEnvironmentCreate")}</span>
          </button>
        </div>
    </DialogShell>
  );
}

function HistoryPanel(props: {
  locale: Locale;
  state: AppState;
  updateState: (updater: (draft: AppState) => void, options?: { persist?: boolean; recordHistory?: boolean; historySummary?: string }) => void;
  requestConfirm: TabPanelsProps["requestConfirm"];
  loadState: TabPanelsProps["loadState"];
  setNotice: TabPanelsProps["setNotice"];
  setError: TabPanelsProps["setError"];
  runAfterUnsavedHandled: TabPanelsProps["runAfterUnsavedHandled"];
}): JSX.Element {
  const [, forceUpdate] = useState(0);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [diskSnapshots, setDiskSnapshots] = useState<SnapshotRecord[]>([]);
  const [legacySnapshots, setLegacySnapshots] = useState<SnapshotRecord[]>([]);
  const [legacyTargets, setLegacyTargets] = useState<Record<number, string>>({});
  const [snapshotBusyId, setSnapshotBusyId] = useState<number | null>(null);
  const history = getHistory(props.state);
  const environments = normalizeKimiCodeEnvironments(props.state.panelSettings.kimi_code_environments);
  const activeEnvironmentId = props.state.panelSettings.active_kimi_code_environment_id ?? environments[0]?.id ?? "default";

  const refreshDiskSnapshots = async (): Promise<void> => {
    const [scoped, legacy] = await Promise.all([
      listSnapshots(activeEnvironmentId, undefined, 50),
      listSnapshots("legacy-unassigned", undefined, 50),
    ]);
    setDiskSnapshots(scoped);
    setLegacySnapshots(legacy);
  };

  useEffect(() => {
    void refreshDiskSnapshots();
  }, [activeEnvironmentId]);

  const restoreDiskSnapshot = async (snapshot: SnapshotRecord): Promise<void> => {
    const confirmed = await props.requestConfirm({
      title: t(props.locale, "historyRestoreSnapshotTitle"),
      description: formatMessage(t(props.locale, "historyRestoreSnapshotDescription"), {
        file: snapshot.file_id,
        time: new Date(snapshot.snapshot_at).toLocaleString(),
      }),
      confirmLabel: t(props.locale, "historyRestoreSnapshotAction"),
      cancelLabel: t(props.locale, "cancel"),
      tone: "danger",
      kind: "confirm",
    });
    if (!confirmed) return;
    setSnapshotBusyId(snapshot.id);
    try {
      if (!await restoreSnapshot(snapshot.id)) throw new Error(t(props.locale, "historyRestoreSnapshotFailed"));
      await props.loadState();
      await refreshDiskSnapshots();
      props.setNotice(t(props.locale, "historyRestoreSnapshotSuccess"));
    } catch (error) {
      props.setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSnapshotBusyId(null);
    }
  };

  const assignLegacySnapshot = async (snapshot: SnapshotRecord): Promise<void> => {
    const environmentId = legacyTargets[snapshot.id] ?? activeEnvironmentId;
    const environmentName = environments.find((environment) => environment.id === environmentId)?.name ?? environmentId;
    const confirmed = await props.requestConfirm({
      title: t(props.locale, "historyAssignSnapshotTitle"),
      description: formatMessage(t(props.locale, "historyAssignSnapshotDescription"), {
        file: snapshot.file_id,
        environment: environmentName,
      }),
      confirmLabel: t(props.locale, "historyAssignSnapshotAction"),
      cancelLabel: t(props.locale, "cancel"),
      tone: "danger",
      kind: "unsaved",
    });
    if (!confirmed) return;
    setSnapshotBusyId(snapshot.id);
    try {
      if (!await assignLegacySnapshotEnvironment(snapshot.id, environmentId)) {
        throw new Error(t(props.locale, "historyAssignSnapshotFailed"));
      }
      await refreshDiskSnapshots();
      props.setNotice(t(props.locale, "historyAssignSnapshotSuccess"));
    } catch (error) {
      props.setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSnapshotBusyId(null);
    }
  };

  const handleUndo = (entryId: string): void => {
    const previous = restoreHistoryEntry(entryId);
    if (previous) {
      props.updateState((draft) => {
        Object.assign(draft, previous);
      }, { persist: true, recordHistory: false });
      setExpandedEntryId(null);
      forceUpdate((n) => n + 1);
    }
  };

  return (
    <div className="history-panel">
      <section className="glass-panel form-panel">
        <div className="section-title">{t(props.locale, "historyDiskSnapshots")}</div>
        {diskSnapshots.length > 0 ? diskSnapshots.map((snapshot) => (
          <div className="history-entry-main" key={`disk-${snapshot.id}`}>
            <div className="history-entry-info">
              <span className="history-entry-time">{new Date(snapshot.snapshot_at).toLocaleString()}</span>
              <span className="history-entry-summary">{snapshot.file_id}</span>
              <code>{snapshot.target_path}</code>
            </div>
            <button
              type="button"
              className="action-button compact"
              disabled={snapshotBusyId === snapshot.id}
              onClick={() => props.runAfterUnsavedHandled(() => restoreDiskSnapshot(snapshot))}
            >
              <RotateCcw size={14} />
              <span>{t(props.locale, "historyRestoreSnapshotAction")}</span>
            </button>
          </div>
        )) : <div className="command-palette-empty">{t(props.locale, "historyNoDiskSnapshots")}</div>}
      </section>
      {legacySnapshots.length > 0 ? (
        <section className="glass-panel form-panel">
          <div className="section-title">{t(props.locale, "historyLegacySnapshots")}</div>
          {legacySnapshots.map((snapshot) => (
            <div className="history-entry-main" key={`legacy-${snapshot.id}`}>
              <div className="history-entry-info">
                <span className="history-entry-time">{new Date(snapshot.snapshot_at).toLocaleString()}</span>
                <span className="history-entry-summary">{snapshot.file_id}</span>
              </div>
              <CompactSelect
                ariaLabel={t(props.locale, "historyAssignSnapshotTarget")}
                value={legacyTargets[snapshot.id] ?? activeEnvironmentId}
                options={environments.map((environment) => ({
                  value: environment.id,
                  label: environment.name || environment.id,
                }))}
                onChange={(value) => setLegacyTargets((current) => ({ ...current, [snapshot.id]: value }))}
              />
              <button
                type="button"
                className="action-button compact"
                disabled={snapshotBusyId === snapshot.id}
                onClick={() => void assignLegacySnapshot(snapshot)}
              >
                {t(props.locale, "historyAssignSnapshotAction")}
              </button>
            </div>
          ))}
        </section>
      ) : null}
      <div className="section-title">{t(props.locale, "historySessionChanges")}</div>
      {history.length === 0 ? <div className="command-palette-empty">{t(props.locale, "historyNoHistory")}</div> : null}
      {history.map((entry) => (
        <div key={entry.id} className="history-entry">
          <div className="history-entry-main">
            <button
              type="button"
              className="history-entry-info"
              onClick={() => setExpandedEntryId((current) => current === entry.id ? null : entry.id)}
              aria-expanded={expandedEntryId === entry.id}
            >
              <span className="history-entry-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              <span className="history-entry-summary">{entry.summary}</span>
              <span className="history-entry-count">
                {formatMessage(t(props.locale, "historyChangesCount"), {
                  count: entry.details.reduce((total, detail) => total + detail.changeCount, 0),
                })}
              </span>
              <span className="history-entry-view">
                {expandedEntryId === entry.id ? t(props.locale, "historyHideDetails") : t(props.locale, "historyViewDetails")}
              </span>
            </button>
            <button type="button" className="action-button compact" onClick={() => handleUndo(entry.id)}>
              <RotateCcw size={14} />
              <span>{t(props.locale, "historyUndo")}</span>
            </button>
          </div>
          {expandedEntryId === entry.id ? (
            <div className="history-entry-details">
              {entry.details.length > 0 ? entry.details.map((detail) => (
                <section className="history-detail" key={detail.id}>
                  <div className="history-detail-title">
                    <span>{detail.title}</span>
                    <small>
                      {formatMessage(t(props.locale, "historyChangesCount"), { count: detail.changeCount })}
                    </small>
                  </div>
                  <div className="history-detail-diff" role="table" aria-label={detail.title}>
                    {renderHistoryDiffLines(detail.diff)}
                  </div>
                </section>
              )) : (
                <div className="command-palette-empty">{t(props.locale, "historyNoDetails")}</div>
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function renderHistoryDiffLines(diff: string): JSX.Element[] {
  return (diff ? diff.split("\n") : []).map((line, index) => {
    const kind = line.startsWith("+ ")
      ? "added"
      : line.startsWith("- ")
        ? "removed"
        : "context";
    const marker = kind === "added" ? "+" : kind === "removed" ? "-" : "";
    const content = line.startsWith("+ ") || line.startsWith("- ") || line.startsWith("  ")
      ? line.slice(2)
      : line;
    return (
      <div className={`history-diff-line ${kind}`} role="row" key={`${index}-${line}`}>
        <span className="history-diff-gutter" role="cell">{marker}</span>
        <code className="history-diff-code" role="cell">{content || " "}</code>
      </div>
    );
  });
}
