# 使用统计（Usage Statistics）重构 — 拆分执行契约

目标：把「用量洞察」页重构为「使用统计」，总览页参考截图 2 版式（Hero 大数字 + 指标卡 + 缓存命中率进度条 + 多序列面积趋势图），原子页签变为 3 个：总览 / 分组统计 / 会话。手写 SVG 面积图（零新依赖）。

本文档是唯一权威契约。所有子代理开工前 **先 Read 本文件**，按其中接口、类名、i18n key、文件归属执行。任何一处与本文件冲突的写法都要以本文件为准。

---

## 0. 文件归属矩阵（各代理只准写自己的文件，严禁越界改别人的文件）

| 代理 | 可写文件（新增/修改） |
|------|----------------------|
| A1 数据层 | `src/shared/usageTypes.ts`（改）、`src/renderer/src/tauri/usageDb.ts`（改）、`src/renderer/src/tauri/usageDb.test.ts`（改）、`src/renderer/src/tauri/kimiSwitch.ts`（改） |
| A2 Hero 组件 | `src/renderer/src/usageHero.tsx`（新建） |
| A3 面积图组件 | `src/renderer/src/usageAreaChart.tsx`（新建）、`src/renderer/src/usageAreaChart.test.ts`（新建） |
| A4 仪表板重构 | `src/renderer/src/insightsComponents.tsx`（改）、`src/renderer/src/insightsComponents.test.tsx`（改）、删除 `src/renderer/src/insightsChart.tsx` 与 `src/renderer/src/insightsChart.test.tsx` |
| A5 i18n | `src/renderer/src/i18n.ts`（改，仅此一个文件） |
| A6 样式 | `src/renderer/src/insights.css`（改，仅此一个文件） |

禁止 A4 修改 `appOptions.ts`（`insights` 的 labelKey 不变，改文案由 A5 改 `insights:` 键值完成）。
禁止任何人改 Rust 后端、`src/shared/` 下除 `usageTypes.ts` 之外的文件。

通用约定（沿用根 AGENTS.md）：2 空格缩进、分号、双引号、函数组件 PascalCase、工具函数 camelCase、`window.kimiSwitch` 不要散落调用。

---

## 1. 类型（A1 加到 `src/shared/usageTypes.ts` 末尾）

```ts
export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TrendTokenPoint {
  /** 桶起点毫秒时间戳（hour 与 day 用同一套 bucketing，保证能和成本合并） */
  bucket: number;
  prompt: number;
  completion: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface CostSeriesPoint {
  bucket: number;
  /** null 表示该桶所有 model 均无定价 */
  cost: number | null;
}

/** 面积图每一桶的完整数据（token 与成本按 bucket 合并后的形态） */
export interface TrendSeries extends TrendTokenPoint {
  cost: number | null;
}
```

遵守 `src/shared/AGENTS.md`：runtime-neutral、纯类型。类型无需测试。

## 2. usageDb.ts（A1）

⚠️ `queryModelTokenSums(range, byDay: boolean)` 签名改为 `queryModelTokenSums(range, granularity: "none" | "day" | "hour", environmentId?)`：
- `"none"` = 返回整体一行（原 byDay=false 行为）
- `"day"` = 按本地日聚合（原 byDay=true 行为）
- `"hour"` = 按 `(ts/3600000)*3600000` 聚合
- 返回类型 `ModelTokenSums` 中 `day: string` 字段改为 `bucketMs: number`（"none" 时为 0；"day" 时 = `localDayStringToMs(strftime('%Y-%m-%d','localtime'))` 复刻 `queryTrend` 的 day 桶算法；"hour" 时 = `(ts/3600000)*3600000`）。其余字段不变。
- 保留现有 SQL 的 localtime、加法口径不变。

新增：

```ts
export async function queryTokenTotals(range: TimeRange, environmentId?: string): Promise<TokenUsageTotals>
```
SQL 意图：对 events 在 range 条件内 `SUM(prompt_tokens) / SUM(completion_tokens) / SUM(cache_read_tokens) / SUM(cache_creation_tokens)`，缺省 0。复用文件内已有 `buildRangeConditions`。

```ts
export async function queryTrendTokens(range: TimeRange, granularity: "hour" | "day", environmentId?: string): Promise<TrendTokenPoint[]>
```
按桶聚合四个 token 分项（hour: `(ts/3600000)*3600000`；day: `localDayStringToMs(strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime'))`），`ORDER BY bucket`。复用 `buildRangeConditions`。

```ts
export function resolveTrendGranularity(range: TimeRange): "hour" | "day"
```
逻辑：`today`/`3d` → "hour"；自定义范围（`{fromUtc,toUtc}`）跨度 ≤ 3 天 → "hour"；其余（7d/14d/30d/90d/mtd/custom>3d）→ "day"。

`usageDb.test.ts`：更新 `queryModelTokenSums` 用例的调用签名，新增覆盖 `queryTokenTotals`、`queryTrendTokens`（hour/day 桶）、`resolveTrendGranularity`（today/3d/custom≤3d → hour；7d/custom>3d → day）。

## 3. kimiSwitch.ts（A1）

- `usageQueryCost` 内部两处 `queryModelTokenSums(range, false/true)` 改为 `queryModelTokenSums(range, "none"/"day")`，其余保持（total/byDay/byModel 语义不变）。
- `ModelTokenSums.day` → `bucketMs` 的连带改动：`usageQueryCost` 中 `aggregateCost(modelDaySums, models, (r) => r.day)` 改为按 `(r) => r.bucketMs` 关联；`aggregateCost`/`costForModelTokens` 本体逻辑不动。

新增三个 bridge 方法（放在 `usageQueryCost` 附近，风格与现有 `never` 参数类型写法一致；`usageOpen` 为假时返回空结构）：

```ts
usageQueryTokenTotals: async (range: unknown) => { ok: true; totals: TokenUsageTotals }
  // !usageOpen 时返回全 0 totals

usageQueryTrendTokens: async (args: { range: unknown; granularity?: "hour" | "day" }) => { ok: true; series: TrendTokenPoint[] }
  // granularity 缺省时内部用 resolveTrendGranularity(args.range)

usageQueryCostSeries: async (range: unknown) => { ok: true; points: CostSeriesPoint[] }
  // granularity = resolveTrendGranularity(range)；
  // 逻辑：queryModelTokenSums(range, granularity, envId) →
  //      aggregateCost(rows, models, (r) => r.bucketMs) →
  //      摊平成按 bucket 升序的数组（跳过无数据桶不会出现——map 的 key 来自 rows，天然有序化即可）。
```

空返回示例：`{ ok: true as const, totals: { promptTokens: 0, completionTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } }`、`{ ok: true as const, series: [] }`、`{ ok: true as const, points: [] }`。

## 4. UsageHero（A2 新建 `src/renderer/src/usageHero.tsx`）

导出：

```ts
export interface UsageHeroProps {
  locale: Locale;
  overview: OverviewSlice;            // from @shared/usageTypes
  totals: TokenUsageTotals;           // from @shared/usageTypes
  costTotal: number | null;
  currency: DisplayCurrency;
  currencyRates?: Partial<Record<DisplayCurrency, number>>;
}
export function UsageHero(props: UsageHeroProps): JSX.Element
```

版式（截图 2）：
1. Hero 卡：左侧图标（lucide `Gauge`）+ 竖排「真实消耗 Tokens」标签，下方大数字 `overview.totalTokens`（千分位 `toLocaleString()`）+ 副行「≈ 换算值」（zh-CN/zh-TW 用「万」：x>=10000 → `(v/10000).toFixed(2)+"万"`；其余 locale 用 k/M，规则同现有 `formatNumber`）。右上角并排两个紧凑项：总请求数 = `overview.totalCalls`，总成本 = `costTotal`。
2. 指标卡行（5 张）：新增输入 `totals.promptTokens`（左下箭头 lucide `ArrowDownLeft`）、输出 `totals.completionTokens`（`ArrowUpRight`）、缓存创建 `totals.cacheCreationTokens`（`Database`）、缓存命中 `totals.cacheReadTokens`（`Sparkles`）、缓存命中率 `overview.cacheHitRate`（`Activity`，显示为百分比 1 位小数 + 底部绿色进度条，宽度 = 命中率×100%）。数字统一用千分位；≥1 万的同 Hero 副行换算规则（zh 用万，其它用 k/M）。命中率可为 0。
3. 次级行（3 张小卡）：推理 Token `overview.reasoningTokens`（`BrainCog`）、平均延迟 `overview.avgLatencyMs` 毫秒整数（`Clock`）、错误率 `overview.errorRate` 百分比 1 位小数（`AlertTriangle`）。

文案：全部通过 `t(locale, KEY)` 取，key 列表见 §6 表。成本显示复用现有 `formatCostWithCurrency(cost, currency, rates, t(locale,"costUnknown"))`（`@shared/currency`）。图标不存在的用 lucide 现有近似（`Zap`/`Activity`/`Cpu`）。

CSS 类名（A6 负责样式，你必须用这些类名）：
- hero 容器 `.usage-hero`；内部 `.usage-hero-main`、`.usage-hero-icon`、`.usage-hero-copy`、`.usage-hero-label`、`.usage-hero-value`、`.usage-hero-sub`、`.usage-hero-side`、`.usage-hero-side-item`、`.usage-hero-side-label`、`.usage-hero-side-value`
- 指标卡行容器 `.usage-metric-row`；卡片 `.usage-metric-card`、`.usage-metric-icon`、`.usage-metric-label`、`.usage-metric-value`、`.usage-metric-sub`；进度条 `.usage-progress`、`.usage-progress-bar`、`.usage-bar-fill`
- 次级行 `.usage-secondary-row`、卡 `.usage-secondary-card`、`.usage-secondary-value`

组件不自己写 `<style>`；不要 `import "./insights.css"` 或任何 css（样式由 A4 的容器 import）。

可导出纯函数（加分项，非必填）便于测试：`formatCompactToken(value: number, localeKey: "zh" | "other")`——建议本文件内私有实现即可；若导出，给一个小测试文件 `usageHero.test.ts`（可选）。

## 5. UsageAreaChart（A3 新建 `src/renderer/src/usageAreaChart.tsx`）

导出：

```ts
export interface UsageAreaChartLabels {
  cost: string;          // 成本
  cacheCreation: string; // 缓存创建
  cacheRead: string;     // 缓存命中
  input: string;         // 输入
  output: string;        // 输出
  axisTokens: string;    // 左轴提示（tokens）
}
export interface UsageAreaChartProps {
  data: TrendSeries[];   // 按 bucket 升序（A4 保证合并）
  locale: Locale;
  labels: UsageAreaChartLabels;
  currencySymbol?: string; // 默认 "$"
}
export function UsageAreaChart(props: UsageAreaChartProps): JSX.Element
```

实现要点（手写 SVG，零依赖，仿截图 2）：
- 固定 viewBox（如 `0 0 760 300`），`<svg width="100%" height="auto" viewBox=...>`；含 `<defs>` 渐变（缓存命中序列做面积渐变填充，渐变 id 用 useId 保证唯一）。
- 序列与颜色固定：cost=红 `#ef4444`（虚线 stroke-dasharray，右轴，允许隐藏当全部为 null）；cacheCreation=橙 `#f59e0b`；cacheRead=紫 `#a78bfa`（唯一带面积填充的序列）；input=蓝 `#3b82f6`；output=绿 `#10b981`。
- 双轴：左轴 tokens（k/M 刻度标签），右轴成本（2 位小数或 <0.01 显示 "<0.01"）。X 轴时间刻度：hour 桶 → 每桶 `HH:mm`（zh/ja 用 24h；en/de/es 用 12h `h:mm AM/PM`，用 `Intl.DateTimeFormat` + locale 派生）；day 桶 → `M/d`。
- hover：透明矩形捕获 `onMouseMove`/`onMouseLeave`，显示十字参考线 + tooltip（列出全部序列值 + 成本）。tooltip 类名用 `usage-chart-tooltip`。
- 图例：底部一排 5 项，类名 `usage-chart-legend`、`.usage-chart-legend-item`、`.usage-chart-legend-swatch`（颜色方块）。成本图例用虚线样式。
- 纯函数必须导出并测试：
  - `smoothPath(points: Array<{ x: number; y: number }>): string` —— Catmull-Rom → cubic bezier，产出 `M...C...`（边界用镜像控制点）
  - `niceTicks(max: number, count?: number): number[]` —— 人类友好刻度（1/2/5 步进）
  - `computeLayout(data: TrendSeries[], width: number, height: number) => { yMaxTokens; yMaxCost; xMin; xMax; mapX; mapYLeft; mapYRight; ticksLeft; ticksRight }`
- 空数据（length===0 或全零）：渲染占位提示 `labels` 之外用传入的 `emptyText?: string`？——A3 自己处理，A4 保证仅在 data.length>0 时渲染本组件，因此 A3 可假设非空。

组件不负责文案 key，只接收 `labels` 字符串。不 import 任何 css（由 A4 容器 import）。`usageAreaChart.test.ts` 覆盖 `smoothPath`（平滑、两端点闭合正确）、`niceTicks`（上限覆盖、步进友好）、`computeLayout`（双轴映射单调、极值正确）。

## 6. i18n 键（A5 只改 `src/renderer/src/i18n.ts`）

以 zh-CN 为 base 增加以下键（插到 insights 相关块内），en-US 同步；ja-JP/de-DE/es-ES 在其 `localeOverrides` 增加；zh-TW 在 `localeCompletionOverrides` 增加（不再依赖派生）。**六个 locale 都要有。** 新键值表：

| key | zh-CN | en-US | zh-TW | ja-JP | de-DE | es-ES |
|-----|-------|-------|-------|-------|-------|-------|
| usageHeroTitle | 真实消耗 Tokens | Real Tokens Used | 真實消耗 Tokens | 実消費 Tokens | Tokenverbrauch | Tokens reales |
| usageTotalCalls | 总请求数 | Total Requests | 總請求數 | 総リクエスト数 | Gesamtanfragen | Solicitudes totales |
| usageTotalCost | 总成本 | Total Cost | 總成本 | 総コスト | Gesamtkosten | Coste total |
| usageInputTokens | 新增输入 | New Input | 新增輸入 | 新規入力 | Neue Eingabe | Entrada nueva |
| usageOutputTokens | 输出 | Output | 輸出 | 出力 | Ausgabe | Salida |
| usageCacheCreation | 缓存创建 | Cache Write | 快取建立 | キャッシュ作成 | Cache schreiben | Escritura de caché |
| usageCacheHits | 缓存命中 | Cache Hits | 快取命中 | キャッシュヒット | Cache-Treffer | Aciertos de caché |
| usageTrendTitle | 使用趋势 | Usage Trend | 使用趨勢 | 使用トレンド | Nutzungstrend | Tendencia de uso |
| usageLegendCost | 成本 | Cost | 成本 | コスト | Kosten | Coste |
| usageLegendInput | 输入 | Input | 輸入 | 入力 | Eingabe | Entrada |
| usageLegendOutput | 输出 | Output | 輸出 | 出力 | Ausgabe | Salida |

图例的缓存创建/缓存命中复用 `usageCacheCreation`/`usageCacheHits`；次级卡复用现有 `insightsReasoningTokens`/`insightsAvgLatency`/`insightsErrorRate`；`usageHeroTitle` 同时作为图表标题左侧文案。

另：把所有 locale 里用户可见的侧栏/页签名改掉（不改其他键）：
- `insights:` 键：zh-CN `用量洞察`→`使用统计`；en-US `Usage Insights`→`Usage Statistics`；zh-TW（override 里的 `洞察`）→`使用統計`；ja-JP `インサイト`→`利用統計`；de-DE `Insights`→`Nutzungsstatistik`；es-ES 找到对应值→`Uso y estadísticas`（若 es 无此键则不改）。
- 全局 grep「用量洞察 / Usage Insights」等字面量：凡是指向**这个页面**的文案一律替换为改名后的对应词；指向上报/采集功能的描述（如 FirstRun 对话框推广文案、设置页提示）保留原义即可，不必强行替换（用子代理判断，倾向保守——只改明确指代页面的字符串）。

⚠️ `i18n.ts` 当前有大量未提交改动，在本文件现有结构上追加，不要重排或回滚已有 diff。

## 7. InsightsDashboard 重构（A4 只改 `insightsComponents.tsx` + 它的测试 + 删两个文件）

- `InsightsTab` 改为 `"overview" | "breakdown" | "sessions"`；`InsightsUiPrefs` 删除 `trendMetric`/`trendChartType` 字段（`DEFAULT_UI_PREFS`、`loadUiPrefs`、`saveUiPrefs` 调用处同步删）。
- `loadUiPrefs`：解析后若 `activeTab` 不在新联合类型中（旧值为 "trend"）→ 归一为 `"overview"`（在白名单校验即可，最简单：parse 后 `if (tab==="trend") tab="overview"`）。
- state：删 `trendData`/`trendMetric`/`trendChartType`/`selectedTrendPoint`/`costByDay`/`monthEstimate`；新增 `tokenTotals: TokenUsageTotals | null`、`trendSeries: TrendSeries[]`。删 `estimateMonthlyCost` import、`BarChart3`/`LineChart` import；删 `TrendChart, TrendChartType` import。
- `loadData`：`ingestNow()` 后 `Promise.allSettled` 依次为 overview / tokenTotals / trendTokens / costSeries / breakdownModel / breakdownProfile / sessionsSeven 共 **7** 项（sessions 保留现有 20 条查询）：分别调 `usageQueryOverview`、`usageQueryTokenTotals`、`usageQueryTrendTokens({range})`、`usageQueryCostSeries(range)`、2×`usageQueryBreakdown`、`usageQuerySessions`。部分失败 toast 文案 `(n/7)`。trendSeries 合并：用 map 把 costPoints 按 bucket 并到 trendTokenPoints（bucket 无 cost 记为 null；只保留 trendTokenPoints 中的桶）。
- 保留：时间范围选择器与刷新按钮逻辑、`kimi-refresh` 监听、breakdown 与 sessions 完整原实现。`InsightsSettingsPanel`/`FirstRunDialog` 一字不动。
- 导航条数组改为 `[["overview","insightsOverview"],["breakdown","insightsBreakdown"],["sessions","insightsSessions"]]`，删 trend 的 `TrendingUp` 图标项。
- 总览 tab 内容（替换原 overview-grid 与整段 trend tab）：
  ```tsx
  <div className="insights-overview">
    <UsageHero locale={locale} overview={overview!} totals={tokenTotals!} costTotal={costTotal} currency={displayCurrency} currencyRates={currencyRates} />
    <section className="insights-trend-section">
      <div className="insights-trend-section-head">
        <h3>{t(locale, "usageTrendTitle")}</h3>
        <span className="insights-trend-section-badge">{timeRangeLabel}</span>
      </div>
      {trendSeries.length === 0 ? ( existing 空态 coming-soon 块 ) : (
        <UsageAreaChart
          data={trendSeries}
          locale={locale}
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
  ```
  `timeRangeLabel` = 当前选中范围的短文案（preset 时用所选 preset 的 insightsTimeRange* 文案；custom 时用 `from ~ to` 原文）。overview/tokenTotals 为 null（加载中）时 Hero 显示占位（数字渲染 `-`）。
- 删除 `OverviewMetricCard` 组件及 `.insights-overview-grid` 相关 JSX；保留 `formatNumber`（sessions/breakdown 仍用）。
- 删除文件 `insightsChart.tsx` 与 `insightsChart.test.tsx`（确认无其他引用——只有本组件引用过 TrendChart）。`insightsPieChart.tsx` 保留。
- 更新 `insightsComponents.test.tsx`：断言子页签从 4 → 3（无 trend）、就绪渲染不再包含走势指标切换控件。
- 顶部 `import "./insights.css"` 保持不变（新样式同样走这个文件）。

## 8. CSS（A6 只改 `src/renderer/src/insights.css`）

- **删除**（重构后不再使用）：`.insights-overview-grid`、`.insights-metric-overview-card` 及其 `::before`/hover、`.color-blue/purple/green/orange/cyan/red .insights-metric-overview-icon`、`.insights-metric-overview-label`、`.insights-metric-overview-value` 一整块。
- **新增**（使用 tokens.css 变量，dark/light 与 appearance 主题都验证对比度；图表序列色为固定 hex）：
  - `.usage-hero`：`background: linear-gradient(120deg, rgba(var(--primary-rgb),0.08), transparent 55%), var(--panel-strong)`；`border:1px solid var(--line)`；`border-radius: var(--radius-lg)`；`padding:20px 24px`；`display:flex`；`justify-content:space-between`；`gap`。内部 `.usage-hero-main`（左，flex 列）、大数字 `var(--font-mono)` `var(--text-3xl)`（若无该 token 用 32px + fw-black）、`.usage-hero-sub` 用 `var(--muted)`。`.usage-hero-side`（右，两个 紧凑块 用 `display:flex; gap:24px`）。
  - `.usage-metric-row`：`grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr)); gap:14px; margin-top:16px`。`.usage-metric-card`：面板底、圆角、图标方块（36px 圆角，各色浅底）、label muted、value fw-bold 大字号。
  - `.usage-progress-bar`：8px 圆角条、底 `var(--line)`；`.usage-bar-fill`：`var(--success)`，`transition: width .4s cubic-bezier(.4,0,.2,1)`。
  - `.usage-secondary-row`：grid auto-fit minmax(140px,1fr)，小卡。
  - 趋势区块 `.insights-trend-section`（margin-top:20px，标题行 flex/space-between、`h3` 常规）；`.usage-area-chart` 容器（panel-strong 底、圆角、`padding:16px`）；`.usage-chart-legend`/item/swatch；`.usage-chart-tooltip`（复用 `.insights-chart-tooltip` 观感：panel-strong 底、圆角、shadow-md、absolute）；`.usage-chart-crosshair`（`stroke: var(--line-strong)`）。
- 保持后续文件其余现状不动。

## 9. 各自验证（不得打断别人的文件）

每个代理完成自己的部分后就地跑：
- A1：`npx vitest run src/renderer/src/tauri/usageDb.test.ts`；`npx tsc --noEmit` 允许因其它未完成文件报错，但你的文件自身不许有类型错。
- A3：`npx vitest run src/renderer/src/usageAreaChart.test.ts`。
- A4：`npx vitest run src/renderer/src/insightsComponents.test.tsx`；`npx tsc --noEmit`（容忍他人未完成导致的报错，但自己引入的错误必须清零）。
- A5：跑 `npm run test:watch` 不现实——改为在 i18n.ts 内自查 key 完整；另外确认 `npx tsc --noEmit` 中 i18n 相关无缺键报错（若有 t() 缺 key 的编译期校验则必须补齐）。
- 全部完成后，总集成验证（`npx tsc --noEmit` + `npm run build:web` + 全量相关 vitest）由主进程执行，各代理不必等待别人。

## 10. 不做的事

不改 Rust、不改 events 表、不动分组统计/会话交互、不动时间范围选择器与刷新逻辑、不新增 npm 依赖、不编辑 generated 目录（dist/、coverage/、src-tauri/target/）、不回滚任何现有未提交 diff。
