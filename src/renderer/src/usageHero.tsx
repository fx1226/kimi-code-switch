import type { DisplayCurrency, Locale } from "@shared/types";
import type { OverviewSlice, TokenUsageTotals } from "@shared/usageTypes";
import { formatCostWithCurrency } from "@shared/currency";
import { Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, BrainCog, Clock, Database, Gauge, Sparkles } from "lucide-react";
import { t } from "./i18n";

export interface UsageHeroProps {
  locale: Locale;
  overview: OverviewSlice; // from @shared/usageTypes
  totals: TokenUsageTotals; // from @shared/usageTypes
  costTotal: number | null;
  currency: DisplayCurrency;
  currencyRates?: Partial<Record<DisplayCurrency, number>>;
}

/** 紧凑数值换算：中文使用「万/亿」，其它语言使用 k/M。 */
function formatCompactToken(value: number, locale: Locale): string {
  const formatDecimal = (scaledValue: number, digits: number): string => new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(scaledValue);

  if (locale === "zh-CN" || locale === "zh-TW") {
    const yiUnit = locale === "zh-TW" ? "億" : "亿";
    const wanUnit = locale === "zh-TW" ? "萬" : "万";
    // Promote values that round to 10,000.00万, avoiding a misleading unit at the boundary.
    if (value >= 99_999_950) return `${formatDecimal(value / 100_000_000, 2)}${yiUnit}`;
    if (value >= 10_000) return `${formatDecimal(value / 10_000, 2)}${wanUnit}`;
  }
  if (value >= 1_000_000) return `${formatDecimal(value / 1_000_000, 2)}M`;
  if (value >= 1_000) return `${formatDecimal(value / 1_000, 1)}k`;
  return value.toLocaleString(locale);
}

export function UsageHero(props: UsageHeroProps): JSX.Element {
  const { locale, overview, totals, costTotal, currency, currencyRates } = props;

  const costText = formatCostWithCurrency(costTotal, currency, currencyRates, t(locale, "costUnknown"));
  const hitRatePercent = `${(overview.cacheHitRate * 100).toFixed(1)}%`;
  const hitRateFill = Math.min(Math.max(overview.cacheHitRate, 0) * 100, 100);
  const hasRepresentativeLatency = overview.totalCalls > 0
    && overview.latencySamples / overview.totalCalls >= 0.8;

  const metricCards = [
    { icon: <ArrowDownLeft size={18} />, label: t(locale, "usageInputTokens"), value: formatCompactToken(totals.promptTokens, locale) },
    { icon: <ArrowUpRight size={18} />, label: t(locale, "usageOutputTokens"), value: formatCompactToken(totals.completionTokens, locale) },
    { icon: <Database size={18} />, label: t(locale, "usageCacheCreation"), value: formatCompactToken(totals.cacheCreationTokens, locale) },
    { icon: <Sparkles size={18} />, label: t(locale, "usageCacheHits"), value: formatCompactToken(totals.cacheReadTokens, locale) },
  ];

  const secondaryCards = [
    { icon: <BrainCog size={16} />, label: t(locale, "insightsReasoningTokens"), value: formatCompactToken(overview.reasoningTokens, locale) },
    { icon: <Clock size={16} />, label: t(locale, "insightsAvgLatency"), value: hasRepresentativeLatency ? `${Math.round(overview.avgLatencyMs)} ms` : "-" },
    { icon: <AlertTriangle size={16} />, label: t(locale, "insightsErrorRate"), value: `${(overview.errorRate * 100).toFixed(1)}%` },
  ];

  return (
    <>
      <div className="usage-hero">
        <div className="usage-hero-main">
          <div className="usage-hero-icon" aria-hidden="true">
            <Gauge size={22} />
          </div>
          <div className="usage-hero-copy">
            <div className="usage-hero-label">{t(locale, "usageHeroTitle")}</div>
            <div className="usage-hero-value">{overview.totalTokens.toLocaleString(locale)}</div>
            <div className="usage-hero-sub">≈ {formatCompactToken(overview.totalTokens, locale)}</div>
          </div>
        </div>
        <div className="usage-hero-side">
          <div className="usage-hero-side-item">
            <div className="usage-hero-side-label">{t(locale, "usageTotalCalls")}</div>
            <div className="usage-hero-side-value">{overview.totalCalls.toLocaleString(locale)}</div>
          </div>
          <div className="usage-hero-side-item">
            <div className="usage-hero-side-label">{t(locale, "usageTotalCost")}</div>
            <div className="usage-hero-side-value">{costText}</div>
          </div>
        </div>
      </div>

      <div className="usage-metric-row">
        {metricCards.map((card) => (
          <div key={card.label} className="usage-metric-card">
            <div className="usage-metric-head">
              <div className="usage-metric-icon" aria-hidden="true">{card.icon}</div>
              <div className="usage-metric-label">{card.label}</div>
            </div>
            <div className="usage-metric-value">{card.value}</div>
          </div>
        ))}
        <div className="usage-metric-card">
          <div className="usage-metric-head">
            <div className="usage-metric-icon" aria-hidden="true"><Activity size={18} /></div>
            <div className="usage-metric-label">{t(locale, "insightsCacheHitRate")}</div>
          </div>
          <div className="usage-metric-value">{hitRatePercent}</div>
          <div className="usage-progress" role="progressbar" aria-label={t(locale, "insightsCacheHitRate")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hitRateFill)}>
            <div className="usage-progress-bar">
              <div className="usage-bar-fill" style={{ width: `${hitRateFill}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="usage-secondary-row">
        {secondaryCards.map((card) => (
          <div key={card.label} className="usage-secondary-card">
            <span className="usage-metric-icon" aria-hidden="true">{card.icon}</span>
            <span className="usage-metric-label">{card.label}</span>
            <span className="usage-secondary-value">{card.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}
