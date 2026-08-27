import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronsLeft, ChevronsRight, RefreshCw, Search, Terminal, X } from "lucide-react";

import type { KimiCodeEnvironment, ShortcutAction, ShortcutBinding } from "@shared/types";
import { applyProfile, DEFAULT_KIMI_CODE_ENVIRONMENT_NAME, normalizeKimiCodeEnvironments } from "@shared/configStore";
import type { SearchResult } from "@shared/configStore";
import { parseMcpConfigStrict } from "@shared/mcpStore";
import { formatAcceleratorForPlatform, getBrowserShortcutPlatform, normalizeShortcuts } from "@shared/shortcutStore";

import { CommandPalette } from "./commandPalette";
import { QuickProfileSwitcher } from "./quickProfileSwitcher";
import type { SaveRecoveryInfo } from "./tauri/kimiSwitch";
import { TabPanels } from "./tabs/TabPanels";
import { ProfileCentricView } from "./views/ProfileCentricView";
import { AddAssistantWizard } from "./wizards/AddAssistantWizard";
import { CascadeDeleteDialog } from "./dialogs/CascadeDeleteDialog";
import { getCascadePreview } from "@shared/configRelations";
import type { CascadeImpact } from "@shared/configRelations";
import { deleteProvider, deleteModel, deleteProfile } from "@shared/configStore";
import { useAppHandlers } from "./useAppHandlers";
import { maybeRunScheduledBackup } from "./backupAuto";
import { useShortcuts } from "./useShortcuts";
import { TAB_ITEMS, LOCALE_OPTIONS, THEME_OPTIONS, ASSISTANT_SUB_ITEMS } from "./appOptions";
import type { TabId } from "./appOptions";
import {
  BackupRecordsDialog,
  ConfirmDialog,
  DocumentViewerDialog,
} from "./dialogs";
import { t } from "./i18n";
import { McpImportDialog, formatMessage } from "./tabComponents";
import { TopbarControls } from "./topbarControls";
import { ToastContainer } from "./Toast";
import { useToast } from "./useToast";
import { getApi } from "./appHelpers";
import logoLight from "./assets/logo-light.png";
import logoDark from "./assets/logo-dark.png";

export function App(): JSX.Element {
  const app = useAppHandlers();
  const { toasts, showToast, removeToast } = useToast();
  const {
    state,
    activeTab, setActiveTab,
    locale, title, diagnostics,
    loadState,
    closeConfirmDialog,
    selectedProvider, setSelectedProvider,
    selectedModel, setSelectedModel,
    selectedProfile, setSelectedProfile,
    selectedMcpServer, setSelectedMcpServer,
    setSelectedSkill,
    setSelectedSkillPath,
    skillsViewMode, setSkillsViewMode,
    skillsReport,
    isSkillsLoading,
    documentViewer, setDocumentViewer,
    backupRecordsDialog, setBackupRecordsDialog,
    migrateLegacyBackupRecord,
    doctorReport,
    setFileSnapshot,
    error, setError, notice, setNotice, externalChange, setExternalChange,
    isMcpImportOpen, setIsMcpImportOpen,
    mcpImportDraft, setMcpImportDraft,
    mcpImportInitialDraft, setMcpImportInitialDraft,
    mcpTestingName, setMcpTestingName,
    profileTestingName, setProfileTestingName,
    isBackupRunning,
    isWebDavTesting,
    isBackupPasswordVisible, setIsBackupPasswordVisible,
    confirmDialog,
    dirtyProviders, dirtyModels, dirtyProfiles, dirtyMcpServers,
    providerEntries, modelEntries, profileEntries, mcpEntries,
    skillPathEntries, skillEntries, sortedSkillPathEntries,
    visibleSkillEntries,
    selectedProviderName, selectedModelName,
    selectedProfileName, selectedMcpServerName,
    selectedSkillPathId, selectedSkillData, selectedSkillPathData,
    selectedProviderData, selectedModelData,
    selectedProfileData, selectedMcpServerData,
    isProviderNameEditable, isProfileNameEditable, isMcpServerNameEditable,
    updateState, updateImmediateState,
    resolveUnsavedChanges, runAfterUnsavedHandled, onSave, persistState,
    confirmDeleteResource, requestConfirm,
    closeMcpImportDialog, requestCloseMcpImportDialog,
    refreshSkills, openDocumentViewer,
    runManualBackup, runWebDavTest, openKimiInTerminal,
    runDoctor,
    openBackupRecords, deleteBackupRecord, restoreBackupRecord,
  } = app;
  const shortcuts = normalizeShortcuts(state.panelSettings.shortcuts);
  const shortcutPlatform = getBrowserShortcutPlatform();
  const tabShortcutLabels = createTabShortcutLabels(shortcuts, shortcutPlatform);
  const globalSearchShortcutLabel = shortcuts["app.globalSearch"].enabled
    ? formatAcceleratorForPlatform(shortcuts["app.globalSearch"].accelerator, shortcutPlatform)
    : "";
  const isSidebarCollapsed = state.panelSettings.sidebar_collapsed;
  const kimiCodeEnvironments = normalizeKimiCodeEnvironments(state.panelSettings.kimi_code_environments);
  const activeKimiCodeEnvironmentId = state.panelSettings.active_kimi_code_environment_id
    ?? kimiCodeEnvironments[0]?.id
    ?? "default";
  const environmentOptions = kimiCodeEnvironments.map((environment: KimiCodeEnvironment) => ({
    value: environment.id,
    label:
      environment.name === DEFAULT_KIMI_CODE_ENVIRONMENT_NAME
        ? t(locale, "kimiCodeEnvironmentDefaultDisplay")
        : (environment.name || environment.id),
    description: environment.description || environment.id,
  }));
  const toggleSidebar = useCallback(() => {
    updateImmediateState((draft) => {
      draft.panelSettings.sidebar_collapsed = !draft.panelSettings.sidebar_collapsed;
    });
  }, [updateImmediateState]);
  const switchKimiCodeEnvironment = useCallback((environmentId: string): void => {
    if (!environmentId || environmentId === activeKimiCodeEnvironmentId) {
      return;
    }
    runAfterUnsavedHandled(() => {
      void (async () => {
        const api = getApi();
        if (!api?.saveKimiCodeEnvironmentPreference) {
          setError("Kimi Switch API does not support Kimi Code environment management.");
          return;
        }
        try {
          setExternalChange(null);
          setFileSnapshot(null);
          const result = await api.saveKimiCodeEnvironmentPreference(kimiCodeEnvironments, environmentId);
          setFileSnapshot(result.snapshot);
          await loadState();
          // 切换环境后自动刷新（loadState）并跳转到总览页。
          setActiveTab("overview");
          setNotice(t(locale, "kimiCodeEnvironmentActivated"));
        } catch (switchError) {
          setError(switchError instanceof Error ? switchError.message : String(switchError));
        }
      })();
    });
  }, [
    activeKimiCodeEnvironmentId,
    kimiCodeEnvironments,
    loadState,
    locale,
    runAfterUnsavedHandled,
    setActiveTab,
    setError,
    setExternalChange,
    setFileSnapshot,
    setNotice,
  ]);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [cascadeTarget, setCascadeTarget] = useState<{ type: "provider" | "model"; name: string; impact: CascadeImpact } | null>(null);
  const requestCascadeDelete = (type: "provider" | "model", name: string): void => {
    setCascadeTarget({ type, name, impact: getCascadePreview(state, { type, name }) });
  };

  // C2：启动后展示待人工恢复的 save journal（unknown → 只读恢复；quarantined → 提示）。
  const [saveRecovery, setSaveRecovery] = useState<SaveRecoveryInfo | null>(null);
  useEffect(() => {
    const api = getApi();
    if (api?.getPendingSaveRecovery) {
      const info = api.getPendingSaveRecovery();
      if (info) setSaveRecovery(info);
    }
    // loadState 完成后再次检查（首次检查可能在 loadState 尚未填充 pendingSaveRecovery 时执行）。
    const check = (): void => {
      const apiNow = getApi();
      if (apiNow?.getPendingSaveRecovery) {
        const info = apiNow.getPendingSaveRecovery();
        setSaveRecovery(info ?? null);
      }
    };
    window.addEventListener("kimi-refresh", check);
    return () => window.removeEventListener("kimi-refresh", check);
  }, []);

  useShortcuts({
    shortcuts,
    onSave: () => void onSave(),
    onReload: () => runAfterUnsavedHandled(() => void loadState()),
    onRefresh: () => {
      window.dispatchEvent(new CustomEvent("kimi-refresh"));
    },
    onNavigate: (tab) => runAfterUnsavedHandled(() => setActiveTab(tab)),
    onGlobalSearch: () => setCommandPaletteOpen((v) => !v),
    onQuickProfileSwitch: () => setQuickSwitcherOpen((v) => !v),
  });

  // 将 error 和 notice 转换为 Toast
  useEffect(() => {
    if (error) {
      showToast(error, "error");
      setError("");
    }
  }, [error, showToast, setError]);

  useEffect(() => {
    if (notice) {
      showToast(notice, "success");
      setNotice("");
    }
  }, [notice, showToast, setNotice]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const handleBeforeClose = (event: Event): void => {
      const detail = (event as CustomEvent<{ acknowledge: () => void; resolve: (allow: boolean) => void }>).detail;
      detail.acknowledge();
      void resolveUnsavedChanges()
        .then((decision) => detail.resolve(decision !== "cancel"))
        .catch(() => detail.resolve(false));
    };
    window.addEventListener("kimi-before-close", handleBeforeClose);
    return () => window.removeEventListener("kimi-before-close", handleBeforeClose);
  }, [resolveUnsavedChanges]);

  // 托盘动作（切换语言/主题/Profile）已写盘，重新加载状态以实时刷新 UI
  useEffect(() => {
    function handleTrayReload(): void {
      runAfterUnsavedHandled(() => void loadState());
    }
    window.addEventListener("kimi-tray-reload", handleTrayReload);
    return () => window.removeEventListener("kimi-tray-reload", handleTrayReload);
  }, [loadState, runAfterUnsavedHandled]);

  // 托盘「使用统计」入口：显示窗口后切到 Insights 子页
  useEffect(() => {
    function handleOpenInsights(): void {
      runAfterUnsavedHandled(() => setActiveTab("insights"));
    }
    window.addEventListener("kimi-open-insights", handleOpenInsights);
    return () => window.removeEventListener("kimi-open-insights", handleOpenInsights);
  }, [runAfterUnsavedHandled, setActiveTab]);

  // 定时备份（scheduled 策略）：每 5 分钟检查一次是否到期，到期则补做。
  // 用 ref 持有最新 state，避免把 state 放进 effect 依赖导致定时器反复重建。
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  useEffect(() => {
    const timer = window.setInterval(() => {
      void maybeRunScheduledBackup(latestStateRef.current);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleCommandPaletteSelect = useCallback((result: SearchResult): void => {
    setCommandPaletteOpen(false);
    runAfterUnsavedHandled(() => {
      setActiveTab(result.tabId as TabId);
      if (result.type === "provider") setSelectedProvider(result.name);
      else if (result.type === "model") setSelectedModel(result.name);
      else if (result.type === "profile") setSelectedProfile(result.name);
      else if (result.type === "mcp") setSelectedMcpServer(result.name);
    });
  }, [runAfterUnsavedHandled, setActiveTab, setSelectedProvider, setSelectedModel, setSelectedProfile, setSelectedMcpServer]);

  const handleQuickSwitchActivate = useCallback((profileName: string): void => {
    setQuickSwitcherOpen(false);
    runAfterUnsavedHandled(() => updateState((draft) => {
        applyProfile(draft, profileName);
      }, {
        historySummary: formatMessage(t(locale, "historyActivateProfile"), { name: profileName }),
      }));
  }, [locale, runAfterUnsavedHandled, updateState]);

  const visibleTabItems = TAB_ITEMS.filter((item) => item.id !== "about");
  const bottomTabItems = TAB_ITEMS.filter((item) => item.id === "about");
  const configTabItems = [
    TAB_ITEMS.find((item) => item.id === "profiles")!,
    ...ASSISTANT_SUB_ITEMS,
  ];
  const primaryTabItems = visibleTabItems.filter((item) => !["profiles", "providers", "models"].includes(item.id));

  const activeProfileDisplayName = state.profiles[state.activeProfile]?.label?.trim() || state.activeProfile || "-";
  const activePageItem = [...TAB_ITEMS, ...ASSISTANT_SUB_ITEMS].find((item) => item.id === activeTab);
  const activePageTitle = activePageItem ? t(locale, activePageItem.labelKey) : t(locale, "overview");
  const activePageDescription = t(locale, `${activeTab}PageDescription`);

  return (
    <div className={isSidebarCollapsed ? "shell sidebar-collapsed" : "shell"}>
      <div className="window-titlebar drag-region" aria-hidden="true" data-tauri-drag-region>
        <div className="window-titlebar-safe" data-tauri-drag-region />
      </div>
      {externalChange ? (
        <div className="app-tip-layer" role="status" aria-live="polite">
          <div className="app-tip app-tip-warning">
            <AlertTriangle size={18} className="app-tip-icon" />
            <span className="app-tip-message">
              {t(locale, "fileWatchExternalChange").replace("{files}", externalChange.changedFileNames.join(", "))}
            </span>
            <button
              type="button"
              className="app-tip-action"
              onClick={() => {
                runAfterUnsavedHandled(() => {
                  setExternalChange(null);
                  void loadState();
                });
              }}
            >
              <RefreshCw size={13} />
              {t(locale, "fileWatchReload")}
            </button>
            <button
              type="button"
              className="app-tip-close"
              aria-label={t(locale, "close")}
              onClick={() => setExternalChange(null)}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {saveRecovery ? (
        <div className="app-tip-layer" role="dialog" aria-label={t(locale, "saveRecoveryTitle")}>
          <div className="app-tip app-tip-warning">
            <AlertTriangle size={18} className="app-tip-icon" />
            <span className="app-tip-message">
              {saveRecovery.action === "unknown" || saveRecovery.action === "unknown-restore"
                ? t(locale, "saveRecoveryUnknown")
                : t(locale, saveRecovery.reason === "malformed" ? "saveRecoveryQuarantinedMalformed" : "saveRecoveryQuarantinedUnsupported")}
            </span>
            <button
              type="button"
              className="app-tip-action"
              onClick={async () => {
                const api = getApi();
                if (!api?.resolveSaveRecovery) return;
                await api.resolveSaveRecovery("abandon");
                setSaveRecovery(null);
                setNotice(t(locale, "saveRecoveryAbandoned"));
              }}
            >
              <X size={13} />
              {t(locale, "saveRecoveryAbandon")}
            </button>
            <button
              type="button"
              className="app-tip-close"
              aria-label={t(locale, "close")}
              onClick={() => setSaveRecovery(null)}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
      <div className="background-grid" />
      <aside className="sidebar glass-panel">
        <div className="brand drag-region" data-tauri-drag-region>
          <div className="brand-mark" data-tauri-drag-region>
            <img className="brand-logo brand-logo-light" src={logoLight} alt="Kimi Code Switch" />
            <img className="brand-logo brand-logo-dark" src={logoDark} alt="Kimi Code Switch" />
          </div>
          <div className="brand-copy" data-tauri-drag-region>
            <h1 title={title}>{t(locale, "appNameShort")}</h1>
            <p>{t(locale, "appSubtitle")}</p>
          </div>
          <button
            type="button"
            className="sidebar-collapse-button no-drag"
            aria-label={t(locale, isSidebarCollapsed ? "expandSidebar" : "collapseSidebar")}
            title={t(locale, isSidebarCollapsed ? "expandSidebar" : "collapseSidebar")}
            onClick={toggleSidebar}
          >
            {isSidebarCollapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>
        <nav className="nav" aria-label={t(locale, "primaryNavigation")}>
          {primaryTabItems.slice(0, 1).map(({ id, icon: Icon, labelKey }) => (
            <NavigationButton key={id} id={id} icon={Icon} label={t(locale, labelKey)} activeTab={activeTab} shortcut={tabShortcutLabels[id]} onSelect={(tab) => runAfterUnsavedHandled(() => setActiveTab(tab))} />
          ))}
          <div className="nav-section">
            <div className="nav-section-label">{t(locale, "configManagement")}</div>
            {configTabItems.map(({ id, icon: Icon, labelKey }) => (
              <NavigationButton key={id} id={id} icon={Icon} label={t(locale, labelKey)} activeTab={activeTab} shortcut={tabShortcutLabels[id]} secondary onSelect={(tab) => runAfterUnsavedHandled(() => setActiveTab(tab))} />
            ))}
          </div>
          {primaryTabItems.slice(1).map(({ id, icon: Icon, labelKey }) => (
            <NavigationButton key={id} id={id} icon={Icon} label={t(locale, labelKey)} activeTab={activeTab} shortcut={tabShortcutLabels[id]} onSelect={(tab) => runAfterUnsavedHandled(() => setActiveTab(tab))} />
          ))}
        </nav>
        <nav className="nav nav-bottom" aria-label={t(locale, "about")}>
          {bottomTabItems.map(({ id, icon: Icon, labelKey }) => (
            <NavigationButton key={id} id={id} icon={Icon} label={t(locale, labelKey)} activeTab={activeTab} shortcut={tabShortcutLabels[id]} onSelect={(tab) => runAfterUnsavedHandled(() => setActiveTab(tab))} />
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="page-heading">
            <h2>{activePageTitle}</h2>
            <p>{activePageDescription}</p>
          </div>
          <div className="toolbar">
            <button className="topbar-search-button" type="button" aria-label={t(locale, "globalSearch")} onClick={() => setCommandPaletteOpen(true)}>
              <Search size={17} />
              <span>{t(locale, "globalSearch")}</span>
              {globalSearchShortcutLabel ? <kbd>{globalSearchShortcutLabel}</kbd> : null}
            </button>
            <div className="toolbar-profile-context">
              <button className="active-profile-chip" type="button" title={state.activeProfile || undefined} onClick={() => setQuickSwitcherOpen(true)}>
                <span className="active-profile-label">{t(locale, "summaryActive")}</span>
                <strong className="active-profile-name">{activeProfileDisplayName}</strong>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <button
                className="active-profile-terminal no-drag"
                type="button"
                aria-label={t(locale, "openActiveProfileInTerminal")}
                title={t(locale, "openActiveProfileInTerminal")}
                disabled={!state.activeProfile}
                onClick={() => void openKimiInTerminal(state.activeProfile)}
              >
                <Terminal size={15} />
              </button>
            </div>
            <TopbarControls
              locale={locale}
              theme={state.panelSettings.theme}
              localeOptions={LOCALE_OPTIONS}
              themeOptions={THEME_OPTIONS}
              environmentId={activeKimiCodeEnvironmentId}
              environmentOptions={environmentOptions}
              onEnvironmentChange={switchKimiCodeEnvironment}
              onLocaleChange={(value) =>
                updateImmediateState((draft) => {
                  draft.panelSettings.locale = value;
                })
              }
              onThemeChange={(value) =>
                updateImmediateState((draft) => {
                  draft.panelSettings.theme = value;
                })
              }
            />
          </div>
        </header>

        <div className="content-scroll" id={`panel-${activeTab}`} aria-label={activePageTitle}>
          {activeTab === "profiles" ? (
            <ProfileCentricView
              state={state}
              locale={locale}
              selectedProfile={selectedProfileName}
              dirtyProfiles={dirtyProfiles}
              onSelect={(name) => runAfterUnsavedHandled(() => setSelectedProfile(name))}
              onSwitch={(profileName) =>
                runAfterUnsavedHandled(() => updateState((draft) => {
                  applyProfile(draft, profileName);
                }, {
                  historySummary: formatMessage(t(locale, "historyActivateProfile"), { name: profileName }),
                }))
              }
              onAddNew={() => setShowWizard(true)}
              onOpenTerminal={(profileName) => void openKimiInTerminal(profileName)}
            />
          ) : null}
          <TabPanels
            state={state}
            shortcuts={shortcuts}
            activeTab={activeTab}
            locale={locale}
            diagnostics={diagnostics}
            selectedProvider={selectedProvider}
            setSelectedProvider={setSelectedProvider}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            onRequestCascadeDelete={requestCascadeDelete}
            selectedProfile={selectedProfile}
            setSelectedProfile={setSelectedProfile}
            selectedMcpServer={selectedMcpServer}
            setSelectedMcpServer={setSelectedMcpServer}
            setSelectedSkill={setSelectedSkill}
            setSelectedSkillPath={setSelectedSkillPath}
            skillsViewMode={skillsViewMode}
            setSkillsViewMode={setSkillsViewMode}
            skillsReport={skillsReport}
            isSkillsLoading={isSkillsLoading}
            providerEntries={providerEntries}
            modelEntries={modelEntries}
            profileEntries={profileEntries}
            mcpEntries={mcpEntries}
            skillPathEntries={skillPathEntries}
            skillEntries={skillEntries}
            sortedSkillPathEntries={sortedSkillPathEntries}
            visibleSkillEntries={visibleSkillEntries}
            selectedProviderName={selectedProviderName}
            selectedModelName={selectedModelName}
            selectedProfileName={selectedProfileName}
            selectedMcpServerName={selectedMcpServerName}
            selectedSkillPathId={selectedSkillPathId}
            selectedSkillData={selectedSkillData}
            selectedSkillPathData={selectedSkillPathData}
            selectedProviderData={selectedProviderData}
            selectedModelData={selectedModelData}
            selectedProfileData={selectedProfileData}
            selectedMcpServerData={selectedMcpServerData}
            isProviderNameEditable={isProviderNameEditable}
            isProfileNameEditable={isProfileNameEditable}
            isMcpServerNameEditable={isMcpServerNameEditable}
            dirtyProviders={dirtyProviders}
            dirtyModels={dirtyModels}
            dirtyProfiles={dirtyProfiles}
            dirtyMcpServers={dirtyMcpServers}
            setIsMcpImportOpen={setIsMcpImportOpen}
            setMcpImportDraft={setMcpImportDraft}
            setMcpImportInitialDraft={setMcpImportInitialDraft}
            mcpTestingName={mcpTestingName}
            setMcpTestingName={setMcpTestingName}
            profileTestingName={profileTestingName}
            setProfileTestingName={setProfileTestingName}
            backupRecordsDialog={backupRecordsDialog}
            doctorReport={doctorReport}
            isBackupRunning={isBackupRunning}
            isWebDavTesting={isWebDavTesting}
            isBackupPasswordVisible={isBackupPasswordVisible}
            setIsBackupPasswordVisible={setIsBackupPasswordVisible}
            updateState={updateState}
            updateImmediateState={updateImmediateState}
            runAfterUnsavedHandled={runAfterUnsavedHandled}
            onSave={onSave}
            persistState={persistState}
            confirmDeleteResource={confirmDeleteResource}
            requestConfirm={requestConfirm}
            refreshSkills={refreshSkills}
            openDocumentViewer={openDocumentViewer}
            runManualBackup={runManualBackup}
            runWebDavTest={runWebDavTest}
            openKimiInTerminal={openKimiInTerminal}
            runDoctor={runDoctor}
            openBackupRecords={openBackupRecords}
            setActiveTab={setActiveTab}
            setError={setError}
            setNotice={setNotice}
            setExternalChange={setExternalChange}
            setFileSnapshot={setFileSnapshot}
            loadState={loadState}
          />
        </div>
      </main>
      {confirmDialog ? (
        <ConfirmDialog
          {...confirmDialog}
          onConfirm={() => closeConfirmDialog(true)}
          onCancel={() => closeConfirmDialog(false)}
        />
      ) : null}
      {documentViewer ? (
        <DocumentViewerDialog
          locale={locale}
          {...documentViewer}
          onClose={() => setDocumentViewer(null)}
        />
      ) : null}
      {backupRecordsDialog ? (
        <BackupRecordsDialog
          locale={locale}
          {...backupRecordsDialog}
          onDelete={deleteBackupRecord}
          onRestore={restoreBackupRecord}
          onMigrateLegacy={migrateLegacyBackupRecord}
          onLegacyEncryptionPasswordChange={(value) => setBackupRecordsDialog((current) => current ? {
            ...current,
            legacyEncryptionPassword: value,
          } : current)}
          onClose={() => setBackupRecordsDialog(null)}
        />
      ) : null}
      {isMcpImportOpen ? (
        <McpImportDialog
          locale={locale}
          value={mcpImportDraft}
          onChange={setMcpImportDraft}
          onCancel={requestCloseMcpImportDialog}
          onImport={() => {
            try {
              const imported = parseMcpConfigStrict(mcpImportDraft);
              const importedNames = Object.keys(imported.mcpServers);
              if (!importedNames.length) {
                setNotice("");
                setError(t(locale, "mcpImportInvalid"));
                return;
              }

              updateState((draft) => {
                draft.mcpConfig.mcpServers = {
                  ...draft.mcpConfig.mcpServers,
                  ...imported.mcpServers,
                };
              }, {
                persist: false,
                recordHistory: true,
                historySummary: t(locale, "mcpImportApply"),
              });
              setSelectedMcpServer(importedNames[0] ?? "");

              closeMcpImportDialog();
              setError("");
              setNotice(t(locale, "mcpImportSuccess"));
            } catch (importError) {
              const message = importError instanceof Error ? importError.message : String(importError);
              setNotice("");
              setError(`${t(locale, "mcpImportInvalid")} ${message}`);
            }
          }}
        />
      ) : null}
      {commandPaletteOpen ? (
        <CommandPalette
          state={state}
          locale={locale}
          onSelect={handleCommandPaletteSelect}
          onClose={() => setCommandPaletteOpen(false)}
        />
      ) : null}
      {quickSwitcherOpen ? (
        <QuickProfileSwitcher
          state={state}
          locale={locale}
          onActivate={handleQuickSwitchActivate}
          onClose={() => setQuickSwitcherOpen(false)}
        />
      ) : null}
      {showWizard ? (
        <AddAssistantWizard
          locale={locale}
          state={state}
          onComplete={(updater, profileName) => {
            updateState(updater, {
              persist: true,
              recordHistory: true,
              historySummary: formatMessage(t(locale, "historyWizardCreate"), { name: profileName }),
            });
            setShowWizard(false);
          }}
          onCancel={(dirty) => {
            if (!dirty) {
              setShowWizard(false);
              return;
            }
            void requestConfirm({
              title: t(locale, "wizardDiscardTitle"),
              description: t(locale, "wizardDiscardDescription"),
              confirmLabel: t(locale, "discardChanges"),
              cancelLabel: t(locale, "cancel"),
              tone: "danger",
              kind: "delete",
            }).then((confirmed) => {
              if (confirmed) setShowWizard(false);
            });
          }}
        />
      ) : null}
      {cascadeTarget ? (
        <CascadeDeleteDialog
          locale={locale}
          targetType={cascadeTarget.type}
          targetName={cascadeTarget.name}
          impact={cascadeTarget.impact}
          onConfirm={(strategy) => {
            let newFirstProvider = "";
            let newFirstModel = "";
            let newFirstProfile = "";
            updateState((draft) => {
              if (strategy === "cascade") {
                for (const m of cascadeTarget.impact.affectedModels) {
                  deleteModel(draft, m.name);
                }
                for (const p of cascadeTarget.impact.affectedProfiles) {
                  deleteProfile(draft, p.name);
                }
              }
              if (cascadeTarget.type === "provider") {
                deleteProvider(draft, cascadeTarget.name);
              } else {
                deleteModel(draft, cascadeTarget.name);
              }
              if (cascadeTarget.impact.isCurrentActive && cascadeTarget.impact.suggestedFallbackProfile) {
                applyProfile(draft, cascadeTarget.impact.suggestedFallbackProfile);
              }
              newFirstProvider = Object.keys(draft.mainConfig.providers)[0] ?? "";
              newFirstModel = Object.keys(draft.mainConfig.models)[0] ?? "";
              newFirstProfile = Object.keys(draft.profiles)[0] ?? "";
            }, {
              persist: true,
              recordHistory: true,
              historySummary: formatMessage(t(locale, "historyCascadeDelete"), { name: cascadeTarget.name }),
            });
            setSelectedProvider(newFirstProvider);
            setSelectedModel(newFirstModel);
            setSelectedProfile(newFirstProfile);
            setCascadeTarget(null);
          }}
          onCancel={() => setCascadeTarget(null)}
        />
      ) : null}
      <ToastContainer locale={locale} toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

function NavigationButton(props: {
  id: TabId;
  icon: typeof Search;
  label: string;
  activeTab: TabId;
  shortcut?: string;
  secondary?: boolean;
  onSelect: (tab: TabId) => void;
}): JSX.Element {
  const Icon = props.icon;
  const isActive = props.id === props.activeTab;
  return (
    <button
      id={`nav-${props.id}`}
      type="button"
      aria-current={isActive ? "page" : undefined}
      className={[
        "nav-item",
        props.secondary ? "nav-subitem" : "",
        isActive ? "active" : "",
      ].filter(Boolean).join(" ")}
      title={props.label}
      onClick={() => {
        if (!isActive) props.onSelect(props.id);
      }}
    >
      <Icon size={props.secondary ? 17 : 19} />
      <span>{props.label}</span>
      {props.shortcut ? <kbd className="nav-shortcut">{props.shortcut}</kbd> : null}
    </button>
  );
}

function createTabShortcutLabels(
  shortcuts: Record<ShortcutAction, ShortcutBinding>,
  platform: string,
): Partial<Record<string, string>> {
  const labels: Partial<Record<string, string>> = {};
  for (const [action, tab] of Object.entries(TAB_SHORTCUT_ACTIONS)) {
    const binding = shortcuts[action as ShortcutAction];
    if (!binding?.enabled || !binding.accelerator.trim()) {
      continue;
    }
    labels[tab] = formatAcceleratorForPlatform(binding.accelerator, platform);
  }
  return labels;
}

const TAB_SHORTCUT_ACTIONS: Record<string, string> = {
  "tab.overview": "overview",
  "tab.profiles": "profiles",
  "tab.providers": "providers",
  "tab.models": "models",
  "tab.mcp": "mcp",
  "tab.skills": "skills",
  "tab.insights": "insights",
  "tab.settings": "settings",
};
