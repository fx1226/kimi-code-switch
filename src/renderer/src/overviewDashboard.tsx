import { useCallback, useEffect, useState } from "react";
import { Boxes, Check, Download, FileText, Globe, Layers3, LoaderCircle, RefreshCw, Zap } from "lucide-react";

import type { AppState, KimiCodeInstallSource, Locale, McpServerConfig } from "@shared/types";

import { ABOUT_INFO } from "./aboutPage";
import { APPEARANCE_THEME_OPTIONS, labelForLocale } from "./appOptions";
import { t } from "./i18n";

export type DiagnosticLevel = "ok" | "failed" | "pending" | "unavailable";

export interface DiagnosticsState {
  preload: DiagnosticLevel;
  loadState: DiagnosticLevel;
  previewState: DiagnosticLevel;
  lastError: string;
}

type OverviewTabId = "profiles" | "providers" | "models" | "mcp" | "skills";
type CliVersionState = {
  version: string;
  installed: boolean;
  checking?: boolean;
  latestVersion?: string;
  hasUpdate?: boolean;
  installCommand?: string;
  installSource?: KimiCodeInstallSource;
};

const EMPTY_CLI_VERSION: CliVersionState = { version: "", installed: false };

function cliVersionFromDetection(detection: AppState["kimiTargetDetection"] | undefined): CliVersionState {
  if (!detection) return { ...EMPTY_CLI_VERSION, checking: true };
  return {
    version: detection.version,
    installed: detection.installed,
    checking: detection.status === "checking",
    latestVersion: detection.latestVersion,
    hasUpdate: detection.hasUpdate,
    installCommand: detection.installCommand,
    installSource: detection.installSource,
  };
}

export function OverviewDashboard(props: {
  state: AppState;
  locale: Locale;
  diagnostics: DiagnosticsState;
  skillsReport: AppState["skillsReport"];
  mcpEntries: [string, McpServerConfig][];
  onNavigate: (tab: OverviewTabId, item?: string) => void;
}): JSX.Element {
  const { state, locale, diagnostics, skillsReport, mcpEntries, onNavigate } = props;
  const activeProfile = state.profiles[state.activeProfile];
  const providerEntries = Object.entries(state.mainConfig.providers);
  const modelEntries = Object.entries(state.mainConfig.models);
  const profileEntries = Object.entries(state.profiles);

  const activeProfileDisplayName = activeProfile?.label?.trim() || state.activeProfile || "-";
  const [cliVersion, setCliVersion] = useState<CliVersionState>(() => cliVersionFromDetection(state.kimiTargetDetection));
  const [isCliVersionChecking, setIsCliVersionChecking] = useState(false);
  const [isCliUpdating, setIsCliUpdating] = useState(false);
  const checkCliVersion = useCallback(async (checkLatest = false): Promise<void> => {
    setIsCliVersionChecking(true);
    try {
      const version = await window.kimiSwitch?.getCliVersion?.({ checkLatest, target: "kimi-code" });
      setCliVersion(version ?? EMPTY_CLI_VERSION);
    } catch {
      setCliVersion(EMPTY_CLI_VERSION);
    } finally {
      setIsCliVersionChecking(false);
    }
  }, []);

  useEffect(() => {
    setCliVersion(cliVersionFromDetection(state.kimiTargetDetection));
  }, [state.kimiTargetDetection]);

  const upgradeCli = useCallback(async (): Promise<void> => {
    setIsCliUpdating(true);
    try {
      await window.kimiSwitch?.upgradeKimiCli?.("kimi-code", { install: !cliVersion.installed });
      await checkCliVersion(true);
    } finally {
      setIsCliUpdating(false);
    }
  }, [checkCliVersion, cliVersion.installed]);

  const cliVersionText = cliVersion.checking
    ? t(locale, "configTargetDetecting")
    : cliVersion.installed
    ? cliVersion.hasUpdate && cliVersion.latestVersion
      ? `${cliVersion.version} -> ${cliVersion.latestVersion}`
      : cliVersion.version
    : t(locale, "overviewCliNotFound");

  const versionLabel = t(locale, "overviewKimiCodeVersion");
  const checkVersionLabel = t(locale, "overviewKimiCodeCheck");
  const updateVersionLabel = cliVersion.installed ? t(locale, "overviewKimiCodeUpdate") : t(locale, "overviewKimiCodeInstall");
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
        return cliVersion.installed ? t(locale, "configTargetInstallSourceUnknown") : t(locale, "overviewCliNotFound");
    }
  };

  const boolLabel = (v: boolean): string => t(locale, v ? "overviewOn" : "overviewOff");
  const resolveProfileModelName = (profile: AppState["profiles"][string]): string =>
    profile.default_model || state.mainConfig.default_model || "";
  const activeProfileModelName = activeProfile ? resolveProfileModelName(activeProfile) : state.mainConfig.default_model;
  const activeModel = activeProfileModelName ? state.mainConfig.models[activeProfileModelName] : undefined;
  const activeProviderName = activeModel?.provider ?? "";
  const prioritizeEntry = <T,>(entries: Array<[string, T]>, activeName: string, limit: number): Array<[string, T]> =>
    [...entries]
      .sort(([left], [right]) => {
        if (left === activeName) return -1;
        if (right === activeName) return 1;
        return left.localeCompare(right);
      })
      .slice(0, limit);
  const visibleProfiles = prioritizeEntry(profileEntries, state.activeProfile, 4);
  const visibleProviders = prioritizeEntry(providerEntries, activeProviderName, 3);
  const visibleModels = prioritizeEntry(modelEntries, activeProfileModelName, 3);
  const formatProfileModes = (profile: AppState["profiles"][string]): string => [
    `${t(locale, "overviewThinking")}: ${
      profile.thinking_enabled === undefined ? "—" : boolLabel(profile.thinking_enabled)
    }`,
    `${t(locale, "overviewYolo")}: ${profile.default_permission_mode || "manual"}`,
    `${t(locale, "overviewPlanMode")}: ${boolLabel(!!profile.default_plan_mode)}`,
  ].join(" · ");

  function themeLabel(theme: string): string {
    const option = APPEARANCE_THEME_OPTIONS.find((o) => o.value === theme);
    return option ? labelForLocale(option.label, locale) : theme || "aurora";
  }

  function permissionModeLabel(mode: string | undefined): string {
    switch (mode || "manual") {
      case "auto":
        return t(locale, "permissionModeAuto");
      case "yolo":
        return t(locale, "permissionModeYolo");
      default:
        return t(locale, "permissionModeManual");
    }
  }

  function BoolPill({ value }: { value: boolean }): JSX.Element {
    return (
      <span className={value ? "status-pill on" : "status-pill off"}>
        <span className="dot" />
        {boolLabel(value)}
      </span>
    );
  }

  const hasDiagnosticIssue = diagnostics.preload !== "ok" || diagnostics.loadState !== "ok" || diagnostics.previewState !== "ok";

  const resourceStats: Array<{ tab?: OverviewTabId; label: string; value: string | number }> = [
    { tab: "profiles", label: t(locale, "summaryProfiles"), value: profileEntries.length },
    { tab: "providers", label: t(locale, "summaryProviders"), value: providerEntries.length },
    { tab: "models", label: t(locale, "summaryModels"), value: modelEntries.length },
    { tab: "mcp", label: t(locale, "summaryMcp"), value: mcpEntries.length },
    { tab: "skills", label: t(locale, "summarySkills"), value: skillsReport ? skillsReport.summary.total : "-" },
  ];

  return (
    <section className="overview-grid overview-dashboard-v2">
      <section className="glass-panel overview-card overview-card-wide overview-hero overview-context-card">
        <div className="overview-context-main">
          <div className="overview-hero-header"><Zap size={16} /><span>{activeProfileDisplayName}</span></div>
          <div className="overview-app-title"><span className="overview-app-name">{activeProfileDisplayName}</span></div>
          <div className="overview-context-model">{activeProfileModelName || t(locale, "overviewProfileModelUnset")}</div>
          <div className="overview-context-modes">
            <span><span>{t(locale, "overviewThinking")}</span><BoolPill value={activeProfile?.thinking_enabled !== false} /></span>
            <span><span>{t(locale, "overviewPermissionMode")}</span><strong>{permissionModeLabel(activeProfile?.default_permission_mode)}</strong></span>
            <span><span>{t(locale, "overviewPlanMode")}</span><BoolPill value={!!activeProfile?.default_plan_mode} /></span>
          </div>
        </div>
        <div className="overview-health-card">
          <strong className={hasDiagnosticIssue ? "text-warn" : "text-ok"}>
            {hasDiagnosticIssue ? t(locale, "doctorStatusNeedsAttention") : t(locale, "doctorStatusOk")}
          </strong>
          <div className="overview-cli-summary">
            <span>{versionLabel}</span>
            <span className={cliVersion.installed || cliVersion.checking ? "overview-cli-version-value" : "overview-cli-version-value text-warn"}>
              <strong>{cliVersionText}</strong>
              <button className="overview-cli-check-button" type="button" title={checkVersionLabel} aria-label={checkVersionLabel} disabled={isCliVersionChecking || isCliUpdating} onClick={() => void checkCliVersion(true)}>{isCliVersionChecking ? <LoaderCircle size={14} className="button-spinner" /> : <RefreshCw size={14} />}</button>
              {!cliVersion.checking && (cliVersion.hasUpdate || !cliVersion.installed) ? <button className="overview-cli-check-button" type="button" title={updateVersionLabel} aria-label={updateVersionLabel} disabled={isCliUpdating || isCliVersionChecking} onClick={() => void upgradeCli()}>{isCliUpdating ? <LoaderCircle size={14} className="button-spinner" /> : <Download size={14} />}</button> : null}
            </span>
          </div>
        </div>
      </section>

      <div className="overview-stats-strip overview-card-wide">
        {resourceStats.map((stat) => stat.tab ? (
          <button key={stat.label} className="overview-stat" type="button" onClick={() => onNavigate(stat.tab!)}>
            <span className="overview-stat-label">{stat.label}</span><strong className="overview-stat-value">{stat.value}</strong>
          </button>
        ) : (
          <div key={stat.label} className="overview-stat"><span className="overview-stat-label">{stat.label}</span><strong className="overview-stat-value">{stat.value}</strong></div>
        ))}
      </div>

      <div className="overview-resource-grid overview-card-wide">
        <ResourceCard icon={Layers3} title={t(locale, "overviewProfileList")} count={profileEntries.length} tab="profiles" locale={locale} onNavigate={onNavigate} testId="overview-profiles-list">
          {visibleProfiles.map(([name, profile]) => <button key={name} className={name === state.activeProfile ? "overview-list-item active" : "overview-list-item"} type="button" onClick={() => onNavigate("profiles", name)}><span className="overview-list-name">{profile.label || name}</span><span className="overview-list-meta">{resolveProfileModelName(profile) || "-"}</span></button>)}
        </ResourceCard>
        <ResourceCard icon={Globe} title={t(locale, "overviewProviderList")} count={providerEntries.length} tab="providers" locale={locale} onNavigate={onNavigate} testId="overview-providers-list">
          {visibleProviders.map(([name, provider]) => <button key={name} className={name === activeProviderName ? "overview-list-item active" : "overview-list-item"} type="button" onClick={() => onNavigate("providers", name)}><span className="overview-list-name">{name}</span><span className="overview-list-meta">{provider.type}</span></button>)}
        </ResourceCard>
        <ResourceCard icon={Boxes} title={t(locale, "overviewModelList")} count={modelEntries.length} tab="models" locale={locale} onNavigate={onNavigate} testId="overview-models-list">
          {visibleModels.map(([name, model]) => <button key={name} className={name === activeProfileModelName ? "overview-list-item active" : "overview-list-item"} type="button" onClick={() => onNavigate("models", name)}><span className="overview-list-name">{name}</span><span className="overview-list-meta">{model.provider}</span></button>)}
        </ResourceCard>
      </div>

      <details className="glass-panel overview-card overview-card-wide overview-technical-details" data-testid="overview-technical-details">
        <summary>{t(locale, "overviewTechnicalDetails")}</summary>
        <div className="overview-hero-paths-grid">
          <div className="overview-hero-path"><span className="overview-hero-path-label">{t(locale, "overviewAppVersion")}</span><span className="overview-hero-path-value">v{ABOUT_INFO.version}</span></div>
          <div className="overview-hero-path"><span className="overview-hero-path-label">{t(locale, "overviewKimiCodeInstallSource")}</span><span className="overview-hero-path-value">{installSourceLabel(cliVersion.installSource)}</span></div>
          <div className="overview-hero-path"><span className="overview-hero-path-label">{t(locale, "overviewTheme")}</span><span className="overview-hero-path-value">{themeLabel(state.panelSettings.appearance_theme)}</span></div>
          <div className="overview-hero-path"><span className="overview-hero-path-label">{t(locale, "overviewConfigTitle")}</span><span className="overview-hero-path-value">{state.configPath}</span></div>
          <div className="overview-hero-path"><span className="overview-hero-path-label">{t(locale, "overviewMcpTitle")}</span><span className="overview-hero-path-value">{state.mcpConfigPath}</span></div>
        </div>
      </details>

      {hasDiagnosticIssue ? (
        <section className="glass-panel overview-card overview-card-wide overview-footer-merged">
          <div className="section-title">
            <FileText size={16} />
            <span>{t(locale, "diagnosticsTitle")}</span>
            <span className="overview-badge overview-badge-warn">!</span>
          </div>
          <div className="diagnostics-inline">
            <DiagnosticItem label={t(locale, "diagPreload")} level={diagnostics.preload} locale={locale} />
            <DiagnosticItem label={t(locale, "diagLoad")} level={diagnostics.loadState} locale={locale} />
            <DiagnosticItem label={t(locale, "diagPreview")} level={diagnostics.previewState} locale={locale} />
          </div>
          {diagnostics.lastError ? (
            <div className="diagnostics-block">
              <div className="code-head">{t(locale, "diagLastError")}</div>
              <pre>{diagnostics.lastError}</pre>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function ResourceCard(props: {
  icon: typeof Layers3;
  title: string;
  count: number;
  tab: OverviewTabId;
  locale: Locale;
  onNavigate: (tab: OverviewTabId, item?: string) => void;
  testId: string;
  children: React.ReactNode;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <section className="glass-panel overview-card overview-resource-card">
      <div className="section-title">
        <Icon size={18} /><span>{props.title}</span><span className="overview-badge">{props.count}</span>
        <button className="overview-more-link" type="button" aria-label={`${t(props.locale, "overviewShowMore")} ${props.title}`} onClick={() => props.onNavigate(props.tab)}>{t(props.locale, "overviewShowMore")}</button>
      </div>
      <div className="overview-list" data-testid={props.testId}>{props.children}</div>
    </section>
  );
}

function DiagnosticItem(props: {
  label: string;
  level: DiagnosticLevel;
  locale: Locale;
}): JSX.Element {
  return (
    <div className={`diagnostic-item ${props.level}`}>
      <span>{props.label}</span>
      <strong>{diagnosticLabel(props.level, props.locale)}</strong>
    </div>
  );
}

function diagnosticLabel(level: DiagnosticLevel, locale: Locale): string {
  switch (level) {
    case "ok":
      return t(locale, "diagOk");
    case "failed":
      return t(locale, "diagFailed");
    case "unavailable":
      return t(locale, "diagUnavailable");
    default:
      return t(locale, "diagPending");
  }
}
