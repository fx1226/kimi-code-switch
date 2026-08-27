import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { Locale } from "@shared/types";
import type { TrendSeries } from "@shared/usageTypes";

export const VIEW_WIDTH = 760;
export const VIEW_HEIGHT = 300;
export const CHART_PADDING = { top: 16, right: 64, bottom: 34, left: 56 } as const;

/** 序列固定色（契约指定 hex）。 */
export const SERIES_COLORS = {
  cost: "#ef4444",
  cacheCreation: "#f59e0b",
  cacheRead: "#a78bfa",
  input: "#3b82f6",
  output: "#10b981",
} as const;

export interface UsageAreaChartLabels {
  cost: string; // 成本
  cacheCreation: string; // 缓存创建
  cacheRead: string; // 缓存命中
  input: string; // 输入
  output: string; // 输出
  axisTokens: string; // 左轴提示（tokens）
}

export interface UsageAreaChartProps {
  data: TrendSeries[]; // 按 bucket 升序（A4 保证合并）
  locale: Locale;
  labels: UsageAreaChartLabels;
  currencySymbol?: string; // 默认 "$"
}

export function UsageAreaChart({
  data,
  locale,
  labels,
  currencySymbol = "$",
}: UsageAreaChartProps): JSX.Element {
  // useId 保证渐变 id 唯一；剔除冒号以稳妥用于 SVG url(#...) 引用
  const gradId = useId().replace(/:/g, "");
  const clipId = `${gradId}-plot`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [chartWidth, setChartWidth] = useState(VIEW_WIDTH);
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(() => new Set());
  const chartHeight = computeChartHeight(chartWidth);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = (): void => {
      const next = Math.max(320, Math.floor(element.clientWidth - 32));
      setChartWidth((current) => current === next ? current : next);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const hasPricedCost = data.some((point) => point.cost !== null);
  const visibleData = useMemo(() => data.map((point) => ({
    ...point,
    prompt: hiddenSeries.has("input") ? 0 : point.prompt,
    completion: hiddenSeries.has("output") ? 0 : point.completion,
    cacheCreation: hiddenSeries.has("cacheCreation") ? 0 : point.cacheCreation,
    cacheRead: hiddenSeries.has("cacheRead") ? 0 : point.cacheRead,
    cost: hiddenSeries.has("cost") ? null : point.cost,
  })), [data, hiddenSeries]);

  const layout = useMemo(
    () => computeLayout(visibleData, chartWidth, chartHeight),
    [visibleData, chartWidth, chartHeight],
  );
  const granularity = useMemo(() => inferGranularity(data), [data]);

  const plotLeft = CHART_PADDING.left;
  const plotRight = chartWidth - CHART_PADDING.right;
  const plotTop = CHART_PADDING.top;
  const plotBottom = chartHeight - CHART_PADDING.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const tokenPoints = useMemo(
    () => ({
      cacheCreation: visibleData.map((d) => ({ x: layout.mapX(d.bucket), y: layout.mapYLeft(d.cacheCreation) })),
      cacheRead: visibleData.map((d) => ({ x: layout.mapX(d.bucket), y: layout.mapYLeft(d.cacheRead) })),
      input: visibleData.map((d) => ({ x: layout.mapX(d.bucket), y: layout.mapYLeft(d.prompt) })),
      output: visibleData.map((d) => ({ x: layout.mapX(d.bucket), y: layout.mapYLeft(d.completion) })),
    }),
    [visibleData, layout],
  );

  const costSegments = useMemo(() => {
    const segments: Array<Array<{ x: number; y: number }>> = [];
    let current: Array<{ x: number; y: number }> = [];
    for (const d of visibleData) {
      if (d.cost !== null) {
        current.push({ x: layout.mapX(d.bucket), y: layout.mapYRight(d.cost) });
      } else if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length > 0) segments.push(current);
    return segments;
  }, [visibleData, layout]);
  const hasCost = costSegments.length > 0;

  const cacheReadLine = smoothPath(tokenPoints.cacheRead);
  const cacheReadArea =
    tokenPoints.cacheRead.length > 0
      ? `${cacheReadLine} L ${tokenPoints.cacheRead[tokenPoints.cacheRead.length - 1].x} ${plotBottom} L ${tokenPoints.cacheRead[0].x} ${plotBottom} Z`
      : "";

  const gridLines = layout.ticksLeft.map((v) => ({
    y: layout.mapYLeft(v),
    label: compactTokens(v),
  }));
  const costTickLabels = hasCost
    ? layout.ticksRight.map((v) => ({ y: layout.mapYRight(v), label: formatCost(v, currencySymbol) }))
    : [];

  const xLabels = useMemo(() => {
    return pickXAxisLabelIndexes(data.length, plotWidth).map((index) => ({
      x: layout.mapX(data[index].bucket),
      text: formatBucket(data[index].bucket, granularity, locale),
    }));
  }, [data, layout, granularity, locale, plotWidth]);

  const handleMouseMove = (e: ReactMouseEvent<SVGRectElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || data.length === 0) return;
    const targetX = plotLeft + ((e.clientX - rect.left) / rect.width) * plotWidth;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const dist = Math.abs(layout.mapX(data[i].bucket) - targetX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    setHoverIndex(best);
  };
  const handleMouseLeave = (): void => setHoverIndex(null);
  const handleKeyDown = (event: ReactKeyboardEvent<SVGRectElement>): void => {
    if (data.length === 0) return;
    const current = hoverIndex ?? 0;
    let next = current;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(data.length - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = data.length - 1;
    else return;
    event.preventDefault();
    setHoverIndex(next);
  };

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;
  const hoverX = hovered ? layout.mapX(hovered.bucket) : 0;

  const legendItems = [
    ...(hasPricedCost ? [{ key: "cost", label: labels.cost, color: SERIES_COLORS.cost, dashed: true }] : []),
    { key: "cacheCreation", label: labels.cacheCreation, color: SERIES_COLORS.cacheCreation, dashed: false },
    { key: "cacheRead", label: labels.cacheRead, color: SERIES_COLORS.cacheRead, dashed: false },
    { key: "input", label: labels.input, color: SERIES_COLORS.input, dashed: false },
    { key: "output", label: labels.output, color: SERIES_COLORS.output, dashed: false },
  ];

  type TooltipRow = { key: string; label: string; color: string; value: string };
  const tooltipRows: TooltipRow[] = hovered
    ? [
        { key: "cacheCreation", label: labels.cacheCreation, color: SERIES_COLORS.cacheCreation, value: compactTokens(hovered.cacheCreation) },
        { key: "cacheRead", label: labels.cacheRead, color: SERIES_COLORS.cacheRead, value: compactTokens(hovered.cacheRead) },
        { key: "input", label: labels.input, color: SERIES_COLORS.input, value: compactTokens(hovered.prompt) },
        { key: "output", label: labels.output, color: SERIES_COLORS.output, value: compactTokens(hovered.completion) },
        ...(hasCost
          ? [{ key: "cost", label: labels.cost, color: SERIES_COLORS.cost, value: hovered.cost !== null ? formatCost(hovered.cost, currencySymbol) : "–" }]
          : []),
      ]
    : [];

  const toggleSeries = (key: string): void => {
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div ref={containerRef} className="usage-area-chart">
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        role="group"
        aria-label={labels.axisTokens}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES_COLORS.cacheRead} stopOpacity="0.35" />
            <stop offset="100%" stopColor={SERIES_COLORS.cacheRead} stopOpacity="0" />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={plotLeft} y={plotTop} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>

        <text x={plotLeft} y={plotTop - 4} fill="var(--muted)" fontSize="11">
          {labels.axisTokens}
        </text>

        {gridLines.map((g, i) => (
          <g key={`tick-${i}`}>
            <line x1={plotLeft} y1={g.y} x2={plotRight} y2={g.y} stroke="var(--line)" />
            <text x={plotLeft - 8} y={g.y + 4} textAnchor="end" fill="var(--muted)" fontSize="11">
              {g.label}
            </text>
          </g>
        ))}

        {costTickLabels.map((c, i) => (
          <text
            key={`ctick-${i}`}
            x={plotRight + 8}
            y={c.y + 4}
            textAnchor="start"
            fill="var(--muted)"
            fontSize="11"
          >
            {c.label}
          </text>
        ))}

        {xLabels.map((l, i) => (
          <text
            key={`xlabel-${i}`}
            x={l.x}
            y={chartHeight - CHART_PADDING.bottom + 18}
            textAnchor="middle"
            fill="var(--muted)"
            fontSize="11"
          >
            {l.text}
          </text>
        ))}

        <g clipPath={`url(#${clipId})`}>
        {!hiddenSeries.has("cacheRead") && cacheReadArea !== "" && <path d={cacheReadArea} fill={`url(#${gradId})`} />}
        {!hiddenSeries.has("cacheRead") && <path
          d={cacheReadLine}
          fill="none"
          stroke={SERIES_COLORS.cacheRead}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />}
        {!hiddenSeries.has("cacheCreation") && <path
          d={smoothPath(tokenPoints.cacheCreation)}
          fill="none"
          stroke={SERIES_COLORS.cacheCreation}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />}
        {!hiddenSeries.has("input") && <path
          d={smoothPath(tokenPoints.input)}
          fill="none"
          stroke={SERIES_COLORS.input}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />}
        {!hiddenSeries.has("output") && <path
          d={smoothPath(tokenPoints.output)}
          fill="none"
          stroke={SERIES_COLORS.output}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />}

        {hasCost && costSegments.map((seg, i) => (
          <path
            key={`cost-${i}`}
            d={smoothPath(seg)}
            fill="none"
            stroke={SERIES_COLORS.cost}
            strokeWidth={2}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {hovered && (
          <line
            className="usage-chart-crosshair"
            x1={hoverX}
            y1={plotTop}
            x2={hoverX}
            y2={plotBottom}
            strokeWidth={1}
          />
        )}
        {hovered && [
          { key: "cacheCreation", value: hovered.cacheCreation, color: SERIES_COLORS.cacheCreation },
          { key: "cacheRead", value: hovered.cacheRead, color: SERIES_COLORS.cacheRead },
          { key: "input", value: hovered.prompt, color: SERIES_COLORS.input },
          { key: "output", value: hovered.completion, color: SERIES_COLORS.output },
        ].filter((point) => !hiddenSeries.has(point.key)).map((point) => (
          <circle
            key={`hover-${point.key}`}
            cx={hoverX}
            cy={layout.mapYLeft(point.value)}
            r={3.5}
            fill={point.color}
            stroke="var(--panel-strong)"
            strokeWidth={2}
          />
        ))}
        {hovered && hasCost && hovered.cost !== null && (
          <circle
            cx={hoverX}
            cy={layout.mapYRight(hovered.cost)}
            r={3.5}
            fill={SERIES_COLORS.cost}
            stroke="var(--panel-strong)"
            strokeWidth={2}
          />
        )}
        </g>

        <rect
          x={plotLeft}
          y={plotTop}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          tabIndex={0}
          role="slider"
          aria-label={labels.axisTokens}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, data.length - 1)}
          aria-valuenow={hoverIndex ?? 0}
          aria-valuetext={hovered
            ? `${formatBucket(hovered.bucket, granularity, locale)}; ${tooltipRows.map((row) => `${row.label} ${row.value}`).join("; ")}`
            : undefined}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onKeyDown={handleKeyDown}
          onFocus={() => setHoverIndex((current) => current ?? 0)}
          onBlur={() => setHoverIndex(null)}
        />
      </svg>

      <div className="usage-chart-legend">
        {legendItems.map((item) => (
          <button
            type="button"
            className="usage-chart-legend-item"
            key={item.key}
            aria-pressed={!hiddenSeries.has(item.key)}
            onClick={() => toggleSeries(item.key)}
          >
            <span
              className={`usage-chart-legend-swatch${item.dashed ? " dashed" : ""}`}
              style={
                item.dashed
                  ? { background: `repeating-linear-gradient(90deg, ${item.color} 0 4px, transparent 4px 8px)` }
                  : { background: item.color }
              }
            />
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {hovered && (
        <div
          className="usage-chart-tooltip"
          role="status"
          aria-live="polite"
          style={{
            left: `${clampTooltipLeft(hoverX + 16, chartWidth + 32)}px`,
            top: `${plotTop + 24}px`,
            transform: "translate(-50%, 0)",
          }}
        >
          <div className="usage-chart-tooltip-time">{formatBucket(hovered.bucket, granularity, locale)}</div>
          <div className="usage-chart-tooltip-rows">
            {tooltipRows.map((row) => (
              <div
                className="usage-chart-tooltip-row"
                key={row.key}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    flex: "none",
                    display: "inline-block",
                    background: row.color,
                  }}
                />
                <span style={{ color: "var(--muted)", flex: 1 }}>{row.label}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface AreaChartLayout {
  yMaxTokens: number;
  yMaxCost: number;
  xMin: number;
  xMax: number;
  mapX: (bucketMs: number) => number;
  mapYLeft: (tokens: number) => number;
  mapYRight: (cost: number) => number;
  ticksLeft: number[];
  ticksRight: number[];
}

/** 把「最大 token / 最大成本」换算成人类友好刻度并建立坐标映射。width/height 为完整 SVG 尺寸。 */
export function computeLayout(
  data: TrendSeries[],
  width: number,
  height: number,
): AreaChartLayout {
  const plotLeft = CHART_PADDING.left;
  const plotRight = width - CHART_PADDING.right;
  const plotTop = CHART_PADDING.top;
  const plotBottom = height - CHART_PADDING.bottom;
  const plotWidth = Math.max(plotRight - plotLeft, 1);
  const plotHeight = Math.max(plotBottom - plotTop, 1);

  if (data.length === 0) {
    return {
      yMaxTokens: 0,
      yMaxCost: 0,
      xMin: 0,
      xMax: 0,
      mapX: () => plotLeft,
      mapYLeft: () => plotTop + plotHeight,
      mapYRight: () => plotTop + plotHeight,
      ticksLeft: [0],
      ticksRight: [0],
    };
  }

  let maxTokens = 0;
  let maxCost = 0;
  for (const d of data) {
    maxTokens = Math.max(maxTokens, d.prompt, d.completion, d.cacheCreation, d.cacheRead);
    if (d.cost !== null) maxCost = Math.max(maxCost, d.cost);
  }

  const ticksLeft = niceTicks(maxTokens);
  const ticksRight = niceTicks(maxCost);
  const yMaxTokens = ticksLeft[ticksLeft.length - 1] ?? 0;
  const yMaxCost = ticksRight[ticksRight.length - 1] ?? 0;

  const xMin = data[0].bucket;
  const xMax = data[data.length - 1].bucket;
  const xSpan = xMax - xMin;

  const mapX = (bucketMs: number): number => xSpan > 0
    ? plotLeft + ((bucketMs - xMin) / xSpan) * plotWidth
    : plotLeft + plotWidth / 2;
  const mapYLeft = (tokens: number): number =>
    yMaxTokens > 0 ? plotTop + plotHeight - (tokens / yMaxTokens) * plotHeight : plotTop + plotHeight;
  const mapYRight = (cost: number): number =>
    yMaxCost > 0 ? plotTop + plotHeight - (cost / yMaxCost) * plotHeight : plotTop + plotHeight;

  return { yMaxTokens, yMaxCost, xMin, xMax, mapX, mapYLeft, mapYRight, ticksLeft, ticksRight };
}

/** 人类友好刻度（1/2/5 步进），从 0 覆盖到 max（含）。 */
export function niceTicks(max: number, count = 5): number[] {
  if (!isFinite(max) || max <= 0) return [0];
  const step = niceStep(max / Math.max(1, count));
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(roundTick(v));
  }
  if (ticks[ticks.length - 1] < max) ticks.push(roundTick(ticks[ticks.length - 1] + step));
  return ticks;
}

/**
 * Monotone cubic interpolation. Unlike an unconstrained Catmull-Rom spline,
 * its control points cannot manufacture negative values between non-negative
 * samples.
 */
export function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const dx = next.x - point.x;
    return dx === 0 ? 0 : (next.y - point.y) / dx;
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes[slopes.length - 1];
    const before = slopes[index - 1];
    const after = slopes[index];
    return before * after <= 0 ? 0 : (before + after) / 2;
  });

  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index];
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = tangents[index] / slope;
    const b = tangents[index + 1] / slope;
    const magnitude = Math.hypot(a, b);
    if (magnitude > 3) {
      const scale = 3 / magnitude;
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  const d = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const dx = p2.x - p1.x;
    const c1x = p1.x + dx / 3;
    const c1y = p1.y + tangents[i] * dx / 3;
    const c2x = p2.x - dx / 3;
    const c2y = p2.y - tangents[i + 1] * dx / 3;
    d.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`);
  }
  return d.join(" ");
}

export function computeChartHeight(width: number): number {
  return Math.round(Math.min(320, Math.max(240, width * 0.24)));
}

export function pickXAxisLabelIndexes(pointCount: number, plotWidth: number): number[] {
  if (pointCount <= 0) return [];
  if (pointCount === 1) return [0];
  const targetCount = Math.min(pointCount, Math.max(2, Math.min(12, Math.floor(plotWidth / 110))));
  const indexes = new Set<number>();
  for (let index = 0; index < targetCount; index += 1) {
    indexes.add(Math.round((index * (pointCount - 1)) / (targetCount - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

export function clampTooltipLeft(
  anchorX: number,
  containerWidth: number,
  tooltipWidth = 220,
  edgePadding = 12,
): number {
  const halfWidth = tooltipWidth / 2;
  return Math.min(
    containerWidth - halfWidth - edgePadding,
    Math.max(halfWidth + edgePadding, anchorX),
  );
}

function niceStep(rough: number): number {
  if (!isFinite(rough) || rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const f = rough / base;
  let mult: number;
  if (f <= 1) mult = 1;
  else if (f <= 2) mult = 2;
  else if (f <= 5) mult = 5;
  else mult = 10;
  return mult * base;
}

function roundTick(v: number): number {
  return Number(v.toFixed(6));
}

function compactTokens(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function formatCost(v: number, symbol: string): string {
  if (v > 0 && v < 0.01) return "<0.01";
  return `${symbol}${v.toFixed(2)}`;
}

function inferGranularity(data: TrendSeries[]): "hour" | "day" {
  if (data.length < 2) return "hour";
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    total += data[i].bucket - data[i - 1].bucket;
  }
  const avg = total / (data.length - 1);
  return avg >= 12 * 3600 * 1000 ? "day" : "hour";
}

function formatBucket(bucketMs: number, granularity: "hour" | "day", locale: Locale): string {
  const date = new Date(bucketMs);
  if (granularity === "day") {
    return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
  }
  const hour12 = locale !== "zh-CN" && locale !== "zh-TW" && locale !== "ja-JP";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12 }).format(date);
}
