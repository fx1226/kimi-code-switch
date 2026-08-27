import { useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, Clock, Cpu, Database, HardDrive, LoaderCircle, PieChart as PieIcon, Power, Table as TableIcon, Terminal, TrendingUp, User, Zap } from "lucide-react";
import type { DisplayCurrency, Locale } from "@shared/types";
import type { InsightsSettings, TokenUsageTotals, TrendSeries } from "@shared/usageTypes";
import { CURRENCY_SYMBOLS, convertCost, formatCostWithCurrency, DEFAULT_CURRENCY_RATES, SUPPORTED_CURRENCIES } from "@shared/currency";
import { shouldShowFirstRunDialog } from "@shared/usageStore";
import { useDialogEscape, useFocusTrap } from "./dialogs";
import { t } from "./i18n";
import { SettingsGroup, SelectField } from "./formControls";
import { ToastContainer } from "./Toast";
import { useToast } from "./useToast";
import { UsageHero } from "./usageHero";
import { UsageAreaChart } from "./usageAreaChart";
import { PieChart, type PieDatum } from "./insightsPieChart";
import "./insights.css";

const UI_PREFS_KEY = "kimi-insights-ui-prefs-v1";
const CUSTOM_RANGE_MAX_DAYS = 365;

type InsightsTab = "overview" | "breakdown" | "sessions";
type BreakdownView = "table" | "pie";
type TimeRangeMode = "preset" | "custom";

interface InsightsUiPrefs {
  activeTab: InsightsTab;
  timeRangeKey: string;
  timeRangeMode: TimeRangeMode;
  customFrom: string;
  customTo: string;
  breakdownModelView: BreakdownView;
  breakdownProfileView: BreakdownView;
}

const DEFAULT_UI_PREFS: InsightsUiPrefs = {
  activeTab: "overview",
  timeRangeKey: "7d",
  timeRangeMode: "preset",
  customFrom: "",
  customTo: "",
  breakdownModelView: "table",
  breakdownProfileView: "table",
};

function formatLocalDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateInputDayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isValidCustomRange(from: string, to: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
  const fromDay = dateInputDayNumber(from);
  const toDay = dateInputDayNumber(to);
  const todayDay = dateInputDayNumber(today);
  return Number.isFinite(fromDay)
    && Number.isFinite(toDay)
    && fromDay <= toDay
    && toDay <= todayDay
    && fromDay >= todayDay - (CUSTOM_RANGE_MAX_DAYS - 1);
}

function loadUiPrefs(): InsightsUiPrefs {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return DEFAULT_UI_PREFS;
    const parsed = JSON.parse(raw) as Partial<InsightsUiPrefs>;
    let activeTab = (parsed.activeTab ?? DEFAULT_UI_PREFS.activeTab) as string;
    if (activeTab === "trend") activeTab = "overview";
    const merged = { ...DEFAULT_UI_PREFS, ...parsed, activeTab: activeTab as InsightsTab };
    const today = formatLocalDateInput(new Date());
    if (merged.timeRangeMode === "custom" && !isValidCustomRange(merged.customFrom, merged.customTo, today)) {
      return { ...merged, timeRangeMode: "preset", customFrom: "", customTo: "" };
    }
    return merged;
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

function saveUiPrefs(prefs: InsightsUiPrefs): void {
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage quota or disabled */
  }
}

interface FirstRunDialogProps {
  locale: Locale;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FirstRunDialog({ locale, onConfirm, onCancel }: FirstRunDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogEscape(onCancel);
  useFocusTrap(dialogRef);
  return (
    <div className="insights-first-run-backdrop">
      <div ref={dialogRef} className="glass-panel insights-first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="insights-first-run-title">
        <div className="insights-first-run-header">
          <div className="insights-first-run-icon">
            <TrendingUp size={24} />
          </div>
          <h2 id="insights-first-run-title">{t(locale, "insightsFirstRunTitle")}</h2>
        </div>
        <p className="insights-first-run-description">
          {t(locale, "insightsFirstRunDescription")}
        </p>
        <div className="insights-first-run-steps">
          {[1, 2, 3, 4].map((step) => (
            <div key={step} className="insights-first-run-step">
              <div className="insights-first-run-step-index">
                {step}
              </div>
              <p>
                {t(locale, `insightsFirstRunStep${step}` as never)}
              </p>
            </div>
          ))}
        </div>
        <div className="insights-first-run-actions">
          <button onClick={onCancel} className="insights-button-secondary">
            {t(locale, "insightsFirstRunCancel")}
          </button>
          <button onClick={onConfirm} className="insights-button-primary">
            {t(locale, "insightsFirstRunConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface InsightsSettingsPanelProps {
  locale: Locale;
  onStateChange?: () => void;
}

/**
 * 洞察设置面板（位于设置页内）
 * 仅包含：启用/禁用开关、代理状态、存储信息、配置选项
 * 完整的图表分析面板见 InsightsDashboard 独立 Tab
 */
export function InsightsSettingsPanel({ locale, onStateChange }: InsightsSettingsPanelProps): JSX.Element {
  const [settings, setSettings] = useState<InsightsSettings | null>(null);
  const [watcherStatus, setWatcherStatus] = useState<{ status: string; sessionsTracked?: number; eventsIngested?: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ totalBytes: number; exceedsWarn: boolean } | null>(null);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showFirstRunDialog, setShowFirstRunDialog] = useState(false);
  const { toasts, showToast, removeToast } = useToast();

  const loadStatus = async (): Promise<void> => {
    try {
      const result = await window.kimiSwitch.usageGetStatus();
      if (result.ok) {
        setSettings(result.settings);
        setWatcherStatus(result.proxy);
      }
    } catch (err) {
      console.error("Failed to load insights status:", err);
    }
  };

  const loadStorage = async (): Promise<void> => {
    try {
      const result = await window.kimiSwitch.usageGetStorageInfo();
      if (result.ok) {
        setStorageInfo(result.info);
      }
    } catch (err) {
      console.error("Failed to load storage info:", err);
    }
  };

  useEffect(() => {
    void loadStatus();
    void loadStorage();
  }, []);

  const enableInsights = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.kimiSwitch.usageEnable();
      if (result.ok) {
        await loadStatus();
        onStateChange?.();
        showToast(t(locale, "insightsToastEnabled"), "success");
      } else {
        showToast(`${t(locale, "insightsToastEnableError")}: ${result.message}`, "error");
      }
    } catch (err) {
      showToast(`${t(locale, "insightsToastEnableError")}: ${String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async (): Promise<void> => {
    if (settings && shouldShowFirstRunDialog(settings)) {
      setShowFirstRunDialog(true);
      return;
    }
    await enableInsights();
  };

  const handleDisable = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.kimiSwitch.usageDisable();
      if (result.ok) {
        await loadStatus();
        onStateChange?.();
        showToast(t(locale, "insightsToastDisabled"), "info");
      }
    } catch (err) {
      showToast(`${t(locale, "insightsToastDisableError")}: ${String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleResetData = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.kimiSwitch.usageResetAllData();
      if (result.ok) {
        await loadStatus();
        await loadStorage();
        showToast(t(locale, "insightsToastResetDone"), "success");
        setShowResetDialog(false);
      }
    } catch (err) {
      showToast(`${t(locale, "insightsToastResetError")}: ${String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleCurrencyChange = async (currency: DisplayCurrency): Promise<void> => {
    try {
      const result = await window.kimiSwitch.usageSetConfig({ insights_display_currency: currency });
      if (result.ok) {
        await loadStatus();
        onStateChange?.();
      }
    } catch (err) {
      showToast(`${t(locale, "insightsCurrencySaveFailed")}: ${String(err)}`, "error");
    }
  };

  const handleRateChange = async (currency: DisplayCurrency, raw: string): Promise<void> => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const currentRate = settings?.insights_currency_rates?.[currency] ?? DEFAULT_CURRENCY_RATES[currency];
    if (Math.abs(parsed - currentRate) < 1e-9) return;
    const nextRates = { ...(settings?.insights_currency_rates ?? {}), [currency]: parsed };
    try {
      const result = await window.kimiSwitch.usageSetConfig({ insights_currency_rates: nextRates });
      if (result.ok) {
        await loadStatus();
        onStateChange?.();
      }
    } catch (err) {
      showToast(`${t(locale, "insightsCurrencySaveFailed")}: ${String(err)}`, "error");
    }
  };

  const status = settings?.insights_status ?? "disabled";
  const isEnabled = status === "enabled";

  return (
    <>
      <ToastContainer locale={locale} toasts={toasts} onRemove={removeToast} />
      {showFirstRunDialog ? (
        <FirstRunDialog
          locale={locale}
          onCancel={() => setShowFirstRunDialog(false)}
          onConfirm={() => {
            void (async () => {
              setShowFirstRunDialog(false);
              await window.kimiSwitch.usageSetConfig({ insights_onboarding_shown_at: new Date().toISOString() });
              await enableInsights();
            })();
          }}
        />
      ) : null}
      <div className="settings-tab-panel">
        {/* 状态概览 */}
        <SettingsGroup title={t(locale, "insightsStatus")}>
          <div className="insights-status-card">
            <div className="insights-status-header">
              <div className="insights-status-info">
                <div className={`insights-status-icon ${isEnabled ? "enabled" : "disabled"}`}>
                  {isEnabled ? <CheckCircle2 size={28} color="white" /> : <Power size={28} color="white" />}
                </div>
                <div className="insights-status-text">
                  <div className="insights-status-title">{t(locale, "insightsStatus")}</div>
                  <div className={`insights-status-label ${isEnabled ? "enabled" : "disabled"}`}>
                    <div className={`insights-status-indicator ${isEnabled ? "enabled" : "disabled"}`} />
                    {status === "enabled"
                      ? t(locale, "insightsEnabled")
                      : status === "paused"
                        ? t(locale, "insightsPaused")
                        : t(locale, "insightsDisabled")}
                  </div>
                </div>
              </div>
              <div className="insights-buttons-group">
                {!isEnabled && (
                  <button onClick={handleEnable} disabled={loading} className="insights-button-primary">
                    <Power size={16} />
                    {t(locale, "insightsEnable")}
                  </button>
                )}
                {isEnabled && (
                  <button onClick={handleDisable} disabled={loading} className="insights-button-danger">
                    <Power size={16} />
                    {t(locale, "insightsDisable")}
                  </button>
                )}
              </div>
            </div>

            {isEnabled && watcherStatus && (
              <div className="insights-metrics-grid">
                <div className="insights-metric-card">
                  <div className="insights-metric-label">
                    <Activity size={14} />
                    {t(locale, "insightsMetricDataSource")}
                  </div>
                  <div className="insights-metric-value" style={{ fontSize: "var(--text-sm)" }}>
                    ~/.kimi-code/logs/kimi-code.log
                  </div>
                </div>
                <div className="insights-metric-card">
                  <div className="insights-metric-label">
                    <Database size={14} />
                    {t(locale, "insightsMetricEventsIngested")}
                  </div>
                  <div className="insights-metric-value">{watcherStatus.eventsIngested ?? 0}</div>
                </div>
                <div className="insights-metric-card">
                  <div className="insights-metric-label">
                    <TrendingUp size={14} />
                    {t(locale, "insightsMetricSessionsTracked")}
                  </div>
                  <div className="insights-metric-value">
                    {watcherStatus.sessionsTracked ?? 0}
                  </div>
                </div>
              </div>
            )}

            {isEnabled && (
              <div
                style={{
                  marginTop: "16px",
                  padding: "8px 12px",
                  background: "rgba(var(--primary-rgb), 0.05)",
                  border: "1px solid rgba(var(--primary-rgb), 0.15)",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-sm)",
                  color: "var(--text)",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <TrendingUp size={16} style={{ color: "rgba(var(--primary-rgb), 1)" }} />
                <span>{t(locale, "insightsEnterDashboardHint")}</span>
              </div>
            )}
          </div>
        </SettingsGroup>

        {/* 存储信息 */}
        <SettingsGroup title={t(locale, "insightsStorageInfo")}>
          <div className="glass-panel" style={{ borderRadius: "20px", overflow: "hidden" }}>
            <div className="insights-storage-grid">
              <div className="insights-storage-item">
                <div className="insights-storage-icon blue">
                  <Database size={24} color="white" />
                </div>
                <div className="insights-storage-label">{t(locale, "insightsStorageSqlite")}</div>
                <div className="insights-storage-value">
                  {storageInfo ? formatBytes(storageInfo.totalBytes * 0.3) : "0 B"}
                </div>
                <div className="insights-progress-bar">
                  <div
                    className="insights-progress-fill blue"
                    style={{
                      width: storageInfo
                        ? `${Math.min(((storageInfo.totalBytes * 0.3) / (100 * 1024 * 1024)) * 100, 100)}%`
                        : "0%",
                    }}
                  />
                </div>
              </div>
              <div className="insights-storage-item">
                <div className="insights-storage-icon purple">
                  <HardDrive size={24} color="white" />
                </div>
                <div className="insights-storage-label">{t(locale, "insightsStorageTotal")}</div>
                <div className="insights-storage-value">
                  {storageInfo ? formatBytes(storageInfo.totalBytes) : "0 B"}
                </div>
                <div className="insights-progress-bar">
                  <div
                    className={`insights-progress-fill ${storageInfo?.exceedsWarn ? "warning" : "purple"}`}
                    style={{
                      width: storageInfo
                        ? `${Math.min((storageInfo.totalBytes / (100 * 1024 * 1024)) * 100, 100)}%`
                        : "0%",
                    }}
                  />
                </div>
              </div>
            </div>
            {storageInfo?.exceedsWarn && (
              <div className="insights-warning-banner">
                <AlertCircle size={20} className="insights-warning-icon" style={{ flexShrink: 0, marginTop: 2 }} />
                <div className="insights-warning-text">
                  {t(locale, "insightsStorageExceedsWarn")}
                </div>
              </div>
            )}
          </div>
        </SettingsGroup>

        {/* 配置选项 */}
        <SettingsGroup title={t(locale, "insightsConfigGroup")}>
          <div className="insights-config-grid">
            <div className="insights-config-card blue">
              <div className="insights-config-label">{t(locale, "insightsRetentionDays")}</div>
              <div className="insights-config-value">
                <div className="insights-config-number blue">{settings?.insights_retention_days ?? 90}</div>
                <div className="insights-config-unit">{t(locale, "insightsConfigUnitDay")}</div>
              </div>
              <div className="insights-config-hint">{t(locale, "insightsRetentionHint")}</div>
            </div>
            <div className="insights-config-card purple">
              <div className="insights-config-label">{t(locale, "insightsDiskWarnThreshold")}</div>
              <div className="insights-config-value">
                <div className="insights-config-number purple">
                  {settings?.insights_disk_warn_threshold_mb ?? 100}
                </div>
                <div className="insights-config-unit">MB</div>
              </div>
              <div className="insights-config-hint">{t(locale, "insightsDiskWarnHint")}</div>
            </div>
          </div>
        </SettingsGroup>

        {/* 成本展示币种 */}
        <SettingsGroup title={t(locale, "insightsCurrencyGroup")}>
          <div className="insights-currency-row">
            <SelectField
              label={t(locale, "insightsDisplayCurrency")}
              value={settings?.insights_display_currency ?? "USD"}
              onChange={(v) => void handleCurrencyChange(v as DisplayCurrency)}
              options={SUPPORTED_CURRENCIES.map((c) => ({
                value: c,
                label: c,
                badge: c === "USD" ? "🇺🇸" : c === "CNY" ? "🇨🇳" : "🇪🇺",
              }))}
            />
            {(settings?.insights_display_currency ?? "USD") !== "USD" && (
              <label className="insights-currency-rate">
                <span className="insights-currency-rate-label">
                  {t(locale, "insightsCurrencyRate")} (1 USD =)
                </span>
                <input
                  key={settings?.insights_display_currency ?? "USD"}
                  type="number"
                  min="0"
                  step="0.01"
                  className="insights-currency-rate-input"
                  defaultValue={
                    settings?.insights_currency_rates?.[
                      settings.insights_display_currency ?? "USD"
                    ] ?? DEFAULT_CURRENCY_RATES[settings?.insights_display_currency ?? "USD"]
                  }
                  onBlur={(e) =>
                    void handleRateChange(
                      settings?.insights_display_currency ?? "USD",
                      e.target.value,
                    )
                  }
                />
              </label>
            )}
          </div>
          <div className="insights-currency-hint">{t(locale, "insightsCurrencyHint")}</div>
        </SettingsGroup>

        {/* 数据管理 */}
        <SettingsGroup title={t(locale, "insightsDataManageGroup")}>
          <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 500, marginBottom: "4px" }}>{t(locale, "insightsResetDataTitle")}</div>
              <div style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{t(locale, "insightsResetDataDesc")}</div>
            </div>
            <button onClick={() => setShowResetDialog(true)} disabled={loading} className="insights-button-danger">
              <AlertCircle size={14} />
              {t(locale, "insightsResetDataButton")}
            </button>
          </div>
        </SettingsGroup>
      </div>

      {/* 确认清除对话框 */}
      {showResetDialog && (
        <div className="dialog-overlay" onClick={() => setShowResetDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>
                <AlertCircle size={20} />
                {t(locale, "insightsResetDialogTitle")}
              </h3>
            </div>
            <div className="dialog-body">
              <p style={{ color: "var(--text)", marginBottom: "12px" }}>
                {t(locale, "insightsResetDialogIntro")}<strong>{t(locale, "insightsResetDialogIrreversible")}</strong>：
              </p>
              <ul style={{ color: "var(--muted)", fontSize: "0.875rem", lineHeight: "1.6", paddingLeft: "20px" }}>
                <li>{t(locale, "insightsResetDialogItem1")}</li>
                <li>{t(locale, "insightsResetDialogItem2")}</li>
                <li>{t(locale, "insightsResetDialogItem3")}</li>
              </ul>
              <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginTop: "12px" }}>
                {t(locale, "insightsResetDialogRebuild")}
              </p>
              <p style={{ color: "var(--danger)", fontSize: "0.875rem", marginTop: "12px", fontWeight: 500 }}>
                {t(locale, "insightsResetDialogKeepLogs")}
              </p>
            </div>
            <div className="dialog-footer">
              <button
                onClick={() => setShowResetDialog(false)}
                disabled={loading}
                className="insights-button-secondary"
              >
                {t(locale, "insightsResetDialogCancel")}
              </button>
              <button
                onClick={handleResetData}
                disabled={loading}
                className="insights-button-danger"
              >
                <AlertCircle size={14} />
                {t(locale, "insightsResetDialogConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 完整的使用统计面板（独立 Tab）
 * 包含：总览、分组统计、会话分析
 */
interface InsightsDashboardProps {
  locale: Locale;
  onStateChange?: () => void;
  onOpenSettings?: () => void;
}

export function InsightsDashboard({ locale, onStateChange, onOpenSettings }: InsightsDashboardProps): JSX.Element {
  const initialPrefs = loadUiPrefs();
  const [activeTab, setActiveTab] = useState<InsightsTab>(initialPrefs.activeTab);
  const [settings, setSettings] = useState<InsightsSettings | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [overview, setOverview] = useState<{
    totalCalls: number; totalTokens: number; cacheHitRate: number;
    reasoningTokens: number; avgLatencyMs: number; latencySamples: number; errorRate: number;
  } | null>(null);
  const [tokenTotals, setTokenTotals] = useState<TokenUsageTotals | null>(null);
  const [trendSeries, setTrendSeries] = useState<TrendSeries[]>([]);
  const [breakdownDataModel, setBreakdownDataModel] = useState<Array<{ name: string; calls: number; tokens: number; avgLatency: number }>>([]);
  const [breakdownDataProfile, setBreakdownDataProfile] = useState<Array<{ name: string; calls: number; tokens: number; avgLatency: number }>>([]);
  const [sessionsData, setSessionsData] = useState<Array<{ sessionId: string; calls: number; tokens: number; duration: string; profile: string; models: string; avgLatency: number; errors: number; startedAt: number }>>([]);
  const [costTotal, setCostTotal] = useState<number | null>(null);
  const [costByModel, setCostByModel] = useState<Record<string, number | null>>({});
  const loadRequestRef = useRef(0);
  const refreshRunningRef = useRef(false);
  const customRangeButtonRef = useRef<HTMLButtonElement>(null);
  const customFromInputRef = useRef<HTMLInputElement>(null);
  const [timeRangeKey, setTimeRangeKey] = useState<string>(initialPrefs.timeRangeKey);
  const [customFrom, setCustomFrom] = useState(initialPrefs.customFrom);
  const [customTo, setCustomTo] = useState(initialPrefs.customTo);
  const [draftCustomFrom, setDraftCustomFrom] = useState(initialPrefs.customFrom);
  const [draftCustomTo, setDraftCustomTo] = useState(initialPrefs.customTo);
  const [customEditorOpen, setCustomEditorOpen] = useState(false);
  const [timeRangeMode, setTimeRangeMode] = useState<TimeRangeMode>(initialPrefs.timeRangeMode);
  const [loading, setLoading] = useState(false);
  const [breakdownModelView, setBreakdownModelView] = useState<BreakdownView>(initialPrefs.breakdownModelView);
  const [breakdownProfileView, setBreakdownProfileView] = useState<BreakdownView>(initialPrefs.breakdownProfileView);
  const { toasts, showToast, removeToast } = useToast();

  useEffect(() => {
    saveUiPrefs({ activeTab, timeRangeKey, timeRangeMode, customFrom, customTo, breakdownModelView, breakdownProfileView });
  }, [activeTab, timeRangeKey, timeRangeMode, customFrom, customTo, breakdownModelView, breakdownProfileView]);

  useEffect(() => {
    if (customEditorOpen) customFromInputRef.current?.focus();
  }, [customEditorOpen]);

  const getTimeRange = (): unknown => {
    const now = new Date();
    if (timeRangeMode === "custom" && isValidCustomRange(customFrom, customTo, formatLocalDateInput(now))) {
      const parseLocalDay = (value: string): Date => {
        const [year, month, day] = value.split("-").map(Number);
        return new Date(year, month - 1, day);
      };
      const from = parseLocalDay(customFrom);
      const toExclusive = parseLocalDay(customTo);
      toExclusive.setDate(toExclusive.getDate() + 1);
      const toUtc = customTo === formatLocalDateInput(now) ? now.getTime() : toExclusive.getTime();
      return { fromUtc: from.getTime(), toUtc };
    }
    return timeRangeKey;
  };

  const loadStatus = async (): Promise<void> => {
    setStatusLoading(true);
    setStatusError("");
    try {
      const result = await window.kimiSwitch.usageGetStatus();
      if (result.ok) {
        setSettings(result.settings);
      } else {
        setStatusError(t(locale, "insightsToastLoadError"));
      }
    } catch (err) {
      setStatusError(`${t(locale, "insightsToastLoadError")}: ${String(err)}`);
    } finally {
      setStatusLoading(false);
    }
  };

  const loadData = async (options: { ingestLatest?: boolean; showRefreshState?: boolean } = {}): Promise<void> => {
    if (options.showRefreshState && refreshRunningRef.current) return;
    if (!options.showRefreshState && refreshRunningRef.current) return;
    const requestId = ++loadRequestRef.current;
    if (options.showRefreshState) {
      refreshRunningRef.current = true;
      setLoading(true);
    }
    const range = getTimeRange() as never;
    const requestedTab = activeTab;
    try {
      // 范围切换只查询现有 SQLite 数据。遍历全部 session/agent 日志成本较高，
      // 仅显式刷新时主动摄入；后台 watcher 仍会按 5 秒周期持续更新。
      if (options.ingestLatest) await window.kimiSwitch.usageIngestNow?.();
      if (requestedTab === "overview") {
        const [overviewRes, tokenTotalsRes, costSeriesRes] = await Promise.allSettled([
          window.kimiSwitch.usageQueryOverview(range),
          window.kimiSwitch.usageQueryTokenTotals(range),
          window.kimiSwitch.usageQueryCostSeries(range),
        ]);
        if (requestId !== loadRequestRef.current) return;
        const overviewOk = overviewRes.status === "fulfilled" && overviewRes.value.ok;
        const totalsOk = tokenTotalsRes.status === "fulfilled" && tokenTotalsRes.value.ok;
        const seriesOk = costSeriesRes.status === "fulfilled" && costSeriesRes.value.ok;
        if (overviewOk && totalsOk && seriesOk) {
          const costByBucket = new Map<number, number | null>();
          for (const point of costSeriesRes.value.points) costByBucket.set(point.bucket, point.cost);
          const nextTrend = costSeriesRes.value.series.map((point) => ({
            ...point,
            cost: costByBucket.get(point.bucket) ?? null,
          }));
          const costs = costSeriesRes.value.points.map((point) => point.cost);
          const nextCost = costs.length > 0 && costs.every((cost) => cost !== null)
            ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0)
            : null;
          setOverview(overviewRes.value.slice);
          setTokenTotals(tokenTotalsRes.value.totals);
          setTrendSeries(nextTrend);
          setCostTotal(nextCost);
        } else {
          setOverview(null);
          setTokenTotals(null);
          setTrendSeries([]);
          setCostTotal(null);
          const failures = [overviewRes, tokenTotalsRes, costSeriesRes]
            .filter((result) => result.status === "rejected" || !result.value.ok).length;
          showToast(`${t(locale, "insightsToastLoadError")} (${failures}/3)`, "error");
        }
      } else if (requestedTab === "breakdown") {
        const [breakdownModelRes, breakdownProfileRes, costRes] = await Promise.allSettled([
          window.kimiSwitch.usageQueryBreakdown({ dim: "model", range, limit: 20, orderBy: "tokens" }),
          window.kimiSwitch.usageQueryBreakdown({ dim: "profile", range, limit: 20, orderBy: "tokens" }),
          window.kimiSwitch.usageQueryCost(range),
        ]);
        if (requestId !== loadRequestRef.current) return;
        const modelOk = breakdownModelRes.status === "fulfilled" && breakdownModelRes.value.ok;
        const profileOk = breakdownProfileRes.status === "fulfilled" && breakdownProfileRes.value.ok;
        const costOk = costRes.status === "fulfilled" && costRes.value.ok;
        if (modelOk && profileOk && costOk) {
          setBreakdownDataModel(breakdownModelRes.value.rows.map((row) => ({ name: row.name, calls: row.calls, tokens: row.tokens, avgLatency: row.avg_latency_ms })));
          setBreakdownDataProfile(breakdownProfileRes.value.rows.map((row) => ({ name: row.name, calls: row.calls, tokens: row.tokens, avgLatency: row.avg_latency_ms })));
          setCostByModel(costRes.value.byModel);
        } else {
          setBreakdownDataModel([]);
          setBreakdownDataProfile([]);
          setCostByModel({});
          const failures = [breakdownModelRes, breakdownProfileRes, costRes]
            .filter((result) => result.status === "rejected" || !result.value.ok).length;
          showToast(`${t(locale, "insightsToastLoadError")} (${failures}/3)`, "error");
        }
      } else {
        const sessionsRes = await window.kimiSwitch.usageQuerySessions({ range, limit: 20 });
        if (requestId !== loadRequestRef.current) return;
        if (sessionsRes.ok) {
          setSessionsData(sessionsRes.rows.map((r) => ({
          sessionId: r.session_id,
          calls: r.calls,
          tokens: r.tokens,
          duration: r.ended_utc ? formatDuration(r.ended_utc - r.started_utc) : "-",
          profile: r.profile,
          models: r.models,
          avgLatency: r.avg_latency_ms,
          errors: r.errors,
          startedAt: r.started_utc,
          })));
        }
      }
    } catch (err) {
      if (requestId === loadRequestRef.current) {
        if (requestedTab === "overview") {
          setOverview(null);
          setTokenTotals(null);
          setTrendSeries([]);
          setCostTotal(null);
        } else if (requestedTab === "breakdown") {
          setBreakdownDataModel([]);
          setBreakdownDataProfile([]);
          setCostByModel({});
        } else {
          setSessionsData([]);
        }
      }
      showToast(`${t(locale, "insightsToastLoadError")}: ${String(err)}`, "error");
    } finally {
      if (options.showRefreshState) {
        refreshRunningRef.current = false;
        setLoading(false);
      }
    }
  };

  useEffect(() => { void loadStatus(); }, []);
  useEffect(() => {
    if (settings?.insights_status !== "enabled") return;
    const timer = window.setTimeout(() => { void loadData(); }, 80);
    return () => window.clearTimeout(timer);
  }, [settings, activeTab, timeRangeKey, timeRangeMode, customFrom, customTo]);
  useEffect(() => {
    const handler = (): void => { void loadData({ ingestLatest: true, showRefreshState: true }); };
    window.addEventListener("kimi-refresh", handler);
    return () => window.removeEventListener("kimi-refresh", handler);
  }, [activeTab, timeRangeKey, timeRangeMode, customFrom, customTo]);

  const isEnabled = settings?.insights_status === "enabled";
  if (statusLoading) {
    return <div className="insights-dashboard-empty" role="status"><LoaderCircle size={32} className="button-spinner" /><h2 className="insights-empty-title">{t(locale, "loading")}</h2></div>;
  }
  if (statusError) {
    return <div className="insights-dashboard-empty" role="alert"><AlertCircle size={40} /><h2 className="insights-empty-title">{t(locale, "insightsToastLoadError")}</h2><p className="insights-empty-description">{statusError}</p><button type="button" className="insights-button-primary" onClick={() => void loadStatus()}>{t(locale, "reload")}</button></div>;
  }
  if (!isEnabled) {
    return (
      <div className="insights-dashboard-empty">
        <div className="insights-empty-icon"><TrendingUp size={64} /></div>
        <h2 className="insights-empty-title">{t(locale, "insightsDashboardDisabledTitle")}</h2>
        <p className="insights-empty-description">
          {t(locale, "insightsDashboardDisabledDesc")}
          <br />{t(locale, "insightsDashboardDisabledHint")}
        </p>
        {onOpenSettings ? (
          <button onClick={onOpenSettings} className="insights-button-primary" style={{ marginTop: "16px" }}>
            {t(locale, "insightsDashboardOpenSettings")}
          </button>
        ) : null}
      </div>
    );
  }

  const displayCurrency: DisplayCurrency = settings?.insights_display_currency ?? "USD";
  const currencyRates = settings?.insights_currency_rates;
  const displayTrendSeries = trendSeries.map((point) => ({
    ...point,
    cost: convertCost(point.cost, displayCurrency, currencyRates),
  }));
  const todayInput = formatLocalDateInput(new Date());
  const earliestCustomDate = new Date();
  earliestCustomDate.setDate(earliestCustomDate.getDate() - (CUSTOM_RANGE_MAX_DAYS - 1));
  const earliestCustomInput = formatLocalDateInput(earliestCustomDate);
  const customRangeDirty = timeRangeMode !== "custom"
    || draftCustomFrom !== customFrom
    || draftCustomTo !== customTo;
  const customRangeValid = isValidCustomRange(draftCustomFrom, draftCustomTo, todayInput)
    && customRangeDirty;

  return (
    <div className="insights-dashboard">
      <div className="insights-dashboard-header">
        <div className="insights-dashboard-title">
          <TrendingUp size={20} />
          <h2>{t(locale, "insights")}</h2>
        </div>
        <div className="insights-dashboard-actions">
          <button onClick={() => void loadData({ ingestLatest: true, showRefreshState: true })} className="insights-button-secondary" disabled={loading}>
            <Activity size={14} />
            {loading ? t(locale, "insightsRefreshLoading") : t(locale, "insightsRefresh")}
          </button>
        </div>
      </div>

      <div className="insights-tabs-nav">
        {([["overview", "insightsOverview"], ["breakdown", "insightsBreakdown"], ["sessions", "insightsSessions"]] as const).map(([tab, key]) => (
          <button key={tab} disabled={loading} onClick={() => setActiveTab(tab)} className={`insights-tab-button ${activeTab === tab ? "active" : ""}`}>
            {tab === "overview" && <Activity size={16} />}
            {tab === "breakdown" && <Database size={16} />}
            {tab === "sessions" && <Zap size={16} />}
            {t(locale, key)}
          </button>
        ))}
      </div>

      <div className="insights-dashboard-content">
        {activeTab === "overview" && (
          <div className="insights-overview">
            {overview && tokenTotals ? (
              <UsageHero
                locale={locale}
                overview={overview}
                totals={tokenTotals}
                costTotal={costTotal}
                currency={displayCurrency}
                currencyRates={currencyRates}
              />
            ) : (
              <div className="usage-hero" aria-busy="true">
                <div className="usage-hero-main">
                  <div className="usage-hero-icon" aria-hidden="true">
                    <Activity size={22} />
                  </div>
                  <div className="usage-hero-copy">
                    <div className="usage-hero-label">{t(locale, "usageHeroTitle")}</div>
                    <div className="usage-hero-value">-</div>
                    <div className="usage-hero-sub">-</div>
                  </div>
                </div>
                <div className="usage-hero-side">
                  <div className="usage-hero-side-item">
                    <div className="usage-hero-side-label">{t(locale, "usageTotalCalls")}</div>
                    <div className="usage-hero-side-value">-</div>
                  </div>
                  <div className="usage-hero-side-item">
                    <div className="usage-hero-side-label">{t(locale, "usageTotalCost")}</div>
                    <div className="usage-hero-side-value">-</div>
                  </div>
                </div>
              </div>
            )}
            <section className="insights-trend-section">
              <div className="insights-trend-section-head">
                <h3>{t(locale, "usageTrendTitle")}</h3>
                <div className="insights-trend-time-controls">
                  <div
                    className="insights-trend-range-control"
                    role="group"
                    aria-label={t(locale, "insightsTimeRangeLabel")}
                  >
                    {([
                      ["today", "insightsTimeRangeToday"],
                      ["3d", "insightsTimeRange3d"],
                      ["7d", "insightsTimeRange7d"],
                      ["14d", "insightsTimeRange14d"],
                      ["30d", "insightsTimeRange30d"],
                      ["90d", "insightsTimeRange90d"],
                      ["mtd", "insightsTimeRangeMonth"],
                    ] as const).map(([value, labelKey]) => (
                      <button
                          key={value}
                          type="button"
                          disabled={loading}
                        className={`insights-trend-range-button${timeRangeMode === "preset" && timeRangeKey === value ? " active" : ""}`}
                        aria-pressed={timeRangeMode === "preset" && timeRangeKey === value}
                        onClick={() => {
                          setTimeRangeMode("preset");
                          setTimeRangeKey(value);
                          setCustomEditorOpen(false);
                        }}
                      >
                        {t(locale, labelKey)}
                      </button>
                    ))}
                    <button
                      ref={customRangeButtonRef}
                      type="button"
                      disabled={loading}
                      className={`insights-trend-range-button custom${timeRangeMode === "custom" ? " active" : ""}`}
                      aria-pressed={timeRangeMode === "custom"}
                      aria-expanded={customEditorOpen}
                      aria-controls="insights-custom-range-editor"
                      onClick={() => {
                        const now = new Date();
                        const from = new Date(now);
                        from.setDate(from.getDate() - 6);
                        setDraftCustomTo(customTo || formatLocalDateInput(now));
                        setDraftCustomFrom(customFrom || formatLocalDateInput(from));
                        setCustomEditorOpen(true);
                      }}
                    >
                      {t(locale, "insightsTimeRangeCustom")}
                    </button>
                  </div>
                  {timeRangeMode === "custom" && customFrom && customTo ? (
                    <span className="insights-trend-custom-summary">{customFrom} — {customTo}</span>
                  ) : null}
                  {customEditorOpen ? (
                    <div
                      id="insights-custom-range-editor"
                      className="insights-trend-time-custom"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setDraftCustomFrom(customFrom);
                          setDraftCustomTo(customTo);
                          setCustomEditorOpen(false);
                          customRangeButtonRef.current?.focus();
                        }
                      }}
                    >
                      <input
                        ref={customFromInputRef}
                        aria-label={t(locale, "insightsTimeRangeFrom")}
                        type="date"
                        disabled={loading}
                        value={draftCustomFrom}
                        min={earliestCustomInput}
                        max={draftCustomTo || todayInput}
                        onChange={(e) => setDraftCustomFrom(e.target.value)}
                        className="insights-select"
                      />
                      <span>—</span>
                      <input
                        aria-label={t(locale, "insightsTimeRangeTo")}
                        type="date"
                        disabled={loading}
                        value={draftCustomTo}
                        min={draftCustomFrom || undefined}
                        max={todayInput}
                        onChange={(e) => setDraftCustomTo(e.target.value)}
                        className="insights-select"
                      />
                      <button
                        type="button"
                        disabled={loading || !customRangeValid}
                        onClick={() => {
                          setCustomFrom(draftCustomFrom);
                          setCustomTo(draftCustomTo);
                          setTimeRangeMode("custom");
                          setCustomEditorOpen(false);
                          customRangeButtonRef.current?.focus();
                        }}
                        className="insights-button-primary"
                      >
                        {t(locale, "insightsTimeRangeApply")}
                      </button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          setDraftCustomFrom(customFrom);
                          setDraftCustomTo(customTo);
                          setCustomEditorOpen(false);
                          customRangeButtonRef.current?.focus();
                        }}
                        className="insights-button-secondary"
                      >
                        {t(locale, "cancel")}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              {trendSeries.length === 0 ? (
                <div className="insights-coming-soon"><TrendingUp size={48} /><h3>{t(locale, "insightsTrendEmpty")}</h3><p>{t(locale, "insightsTrendEmptyHint")}</p></div>
              ) : (
                <UsageAreaChart
                  data={displayTrendSeries}
                  locale={locale}
                  currencySymbol={CURRENCY_SYMBOLS[displayCurrency]}
                  labels={{
                    cost: t(locale, "usageLegendCost"),
                    cacheCreation: t(locale, "usageCacheCreation"),
                    cacheRead: t(locale, "usageCacheHits"),
                    input: t(locale, "usageLegendInput"),
                    output: t(locale, "usageLegendOutput"),
                    axisTokens: t(locale, "insightsTrendMetricTokens"),
                  }}
                />
              )}
            </section>
          </div>
        )}

        {activeTab === "breakdown" && (
          <div className="insights-breakdown-panel">
            <p className="insights-tab-desc">{t(locale, "insightsBreakdownDesc")}</p>
            <div className="insights-breakdown-dual">
              <BreakdownCard
                title={t(locale, "insightsBreakdownByModel")}
                data={breakdownDataModel}
                view={breakdownModelView}
                onViewChange={setBreakdownModelView}
                locale={locale}
                costByName={costByModel}
                currency={displayCurrency}
                currencyRates={currencyRates}
              />
              <BreakdownCard
                title={t(locale, "insightsBreakdownByProfile")}
                data={breakdownDataProfile}
                view={breakdownProfileView}
                onViewChange={setBreakdownProfileView}
                locale={locale}
              />
            </div>
          </div>
        )}

        {activeTab === "sessions" && (
          <div className="insights-sessions-panel">
            <p className="insights-tab-desc">{t(locale, "insightsSessionsDesc")}</p>
            {sessionsData.length === 0 ? (
              <div className="insights-coming-soon"><Zap size={48} /><h3>{t(locale, "insightsSessionsEmpty")}</h3><p>{t(locale, "insightsSessionsEmptyHint")}</p></div>
            ) : (
              <div className="insights-session-list">
                {sessionsData.map((row, i) => {
                  const modelList = row.models ? row.models.split(",").filter(Boolean) : [];
                  return (
                    <div key={i} className="insights-session-card">
                      <div className="insights-session-card-main">
                        <div className="insights-session-card-header">
                          <span className="insights-session-id" title={row.sessionId}>{row.sessionId}</span>
                          {row.errors > 0 && (
                            <span className="insights-session-badge danger" title={t(locale, "insightsSessionErrors")}>
                              <AlertCircle size={12} />
                              {row.errors}
                            </span>
                          )}
                        </div>
                        <div className="insights-session-meta">
                          <span className="insights-session-meta-item" title={t(locale, "insightsSessionStartedAt")}>
                            <Clock size={12} />
                            {formatTimestamp(row.startedAt)}
                          </span>
                          {row.profile && (
                            <span className="insights-session-meta-item" title={t(locale, "insightsSessionProfile")}>
                              <User size={12} />
                              {row.profile}
                            </span>
                          )}
                          {modelList.length > 0 && (
                            <span className="insights-session-meta-item" title={t(locale, "insightsSessionModels")}>
                              <Cpu size={12} />
                              {modelList.length === 1 ? modelList[0] : `${modelList[0]} +${modelList.length - 1}`}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="insights-session-stats">
                        <div className="insights-session-stat">
                          <div className="insights-session-stat-label">{t(locale, "insightsTotalTokens")}</div>
                          <div className="insights-session-stat-value">{formatNumber(row.tokens)}</div>
                        </div>
                        <div className="insights-session-stat">
                          <div className="insights-session-stat-label">{t(locale, "insightsTotalCalls")}</div>
                          <div className="insights-session-stat-value">{row.calls}</div>
                        </div>
                        <div className="insights-session-stat">
                          <div className="insights-session-stat-label">{t(locale, "insightsAvgLatency")}</div>
                          <div className="insights-session-stat-value">{row.avgLatency > 0 ? `${row.avgLatency} ms` : "-"}</div>
                        </div>
                        <div className="insights-session-stat">
                          <div className="insights-session-stat-label">{t(locale, "insightsSessionDuration")}</div>
                          <div className="insights-session-stat-value">{row.duration}</div>
                        </div>
                      </div>
                      <button
                        className="insights-icon-button"
                        title={t(locale, "insightsSessionResume")}
                        onClick={() => void window.kimiSwitch.usageOpenSessionTerminal(row.sessionId)}
                      >
                        <Terminal size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <ToastContainer locale={locale} toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

interface BreakdownCardProps {
  title: string;
  data: Array<{ name: string; calls: number; tokens: number; avgLatency: number }>;
  view: BreakdownView;
  onViewChange: (v: BreakdownView) => void;
  locale: Locale;
  costByName?: Record<string, number | null>;
  currency?: DisplayCurrency;
  currencyRates?: Partial<Record<DisplayCurrency, number>>;
}

function BreakdownCard({ title, data, view, onViewChange, locale, costByName, currency = "USD", currencyRates }: BreakdownCardProps): JSX.Element {
  const pieData: PieDatum[] = data.map((r) => ({ name: r.name || t(locale, "insightsUnknownName"), value: r.tokens }));
  const showCost = costByName !== undefined;

  return (
    <div className="insights-breakdown-card">
      <div className="insights-breakdown-card-header">
        <h4 className="insights-breakdown-card-title">{title}</h4>
        <div className="insights-chart-type-toggle" role="tablist" aria-label={t(locale, "insightsViewToggleLabel")}>
          <button
            type="button"
            role="tab"
            aria-selected={view === "table"}
            className={`insights-chart-type-btn ${view === "table" ? "active" : ""}`}
            onClick={() => onViewChange("table")}
            title={t(locale, "insightsViewTable")}
          >
            <TableIcon size={14} />
            <span>{t(locale, "insightsViewTable")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "pie"}
            className={`insights-chart-type-btn ${view === "pie" ? "active" : ""}`}
            onClick={() => onViewChange("pie")}
            title={t(locale, "insightsViewPie")}
          >
            <PieIcon size={14} />
            <span>{t(locale, "insightsViewPie")}</span>
          </button>
        </div>
      </div>
      {data.length === 0 ? (
        <div className="insights-coming-soon">
          <Database size={36} />
          <h3>{t(locale, "insightsBreakdownEmpty")}</h3>
          <p>{t(locale, "insightsBreakdownEmptyHint")}</p>
        </div>
      ) : view === "table" ? (
        <div className="insights-breakdown-table">
          <div className="insights-table-header">
            <span className="insights-table-cell name">{t(locale, "insightsTableColName")}</span>
            <span className="insights-table-cell num">{t(locale, "insightsTableColCalls")}</span>
            <span className="insights-table-cell num">{t(locale, "insightsTableColTokens")}</span>
            <span className="insights-table-cell num">{t(locale, "insightsTableColPct")}</span>
            <span className="insights-table-cell num">{t(locale, "insightsTableColLatency")}</span>
            {showCost && <span className="insights-table-cell num">{t(locale, "insightsCostColumn")}</span>}
          </div>
          {data.map((row, i) => {
            const totalTokens = data.reduce((sum, r) => sum + r.tokens, 0) || 1;
            const pct = ((row.tokens / totalTokens) * 100).toFixed(1);
            return (
              <div key={i} className="insights-table-row">
                <span className="insights-table-cell name">{row.name || t(locale, "insightsUnknownName")}</span>
                <span className="insights-table-cell num">{formatNumber(row.calls)}</span>
                <span className="insights-table-cell num">{formatNumber(row.tokens)}</span>
                <span className="insights-table-cell num">{pct}%</span>
                <span className="insights-table-cell num">{Math.round(row.avgLatency)} ms</span>
                {showCost && (
                  <span className="insights-table-cell num">{formatCost(costByName?.[row.name] ?? null, locale, currency, currencyRates)}</span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <PieChart data={pieData} locale={locale} unitLabel="tokens" />
      )}
    </div>
  );
}

// 加载中（overview/tokenTotals 为 null）时 Hero 区域渲染占位卡片（数字 `-`），
// 数据就绪后才会渲染真正的 UsageHero。

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Formats an estimated cost (stored in USD) for display, converting to the
 * user's chosen display currency. A `null` cost means no pricing is known for
 * the underlying model(s) — we render the localized "not priced" placeholder
 * rather than "$0.00", which would mislead the user into thinking the work was
 * free. Sub-cent non-zero costs show as "<{symbol}0.01".
 */
function formatCost(
  cost: number | null,
  locale: Locale,
  currency: DisplayCurrency,
  rates: Partial<Record<DisplayCurrency, number>> | undefined,
): string {
  return formatCostWithCurrency(cost, currency, rates, t(locale, "costUnknown"));
}

function formatTimestamp(ms: number): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - ms;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (diffMs < 7 * 86400000) {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}
