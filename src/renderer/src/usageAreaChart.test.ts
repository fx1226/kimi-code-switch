import { describe, expect, it } from "vitest";
import { CHART_PADDING, clampTooltipLeft, computeChartHeight, computeLayout, niceTicks, pickXAxisLabelIndexes, smoothPath } from "./usageAreaChart";
import type { TrendSeries } from "@shared/usageTypes";

const W = 760;
const H = 300;

function makeSeries(values: Array<[number, number, number, number, number, number | null]>): TrendSeries[] {
  return values.map(([bucket, prompt, completion, cacheCreation, cacheRead, cost], i) => ({
    bucket,
    prompt,
    completion,
    cacheCreation,
    cacheRead,
    cost,
  }));
}

describe("smoothPath", () => {
  it("returns empty string for no points", () => {
    expect(smoothPath([])).toBe("");
  });

  it("returns a single move command for one point", () => {
    const out = smoothPath([{ x: 10, y: 20 }]);
    expect(out).toBe("M 10 20");
  });

  it("produces a smooth M..C.. path for 4 points", () => {
    const out = smoothPath([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 20 },
      { x: 30, y: 5 },
    ]);
    expect(out.startsWith("M 0 10")).toBe(true);
    // between n points there are n-1 curve segments
    expect(out.split("C ").length).toBe(4);
  });

  it("starts at the first point and ends on the last point", () => {
    const pts = [
      { x: 5, y: 5 },
      { x: 15, y: 15 },
      { x: 25, y: 10 },
    ];
    const out = smoothPath(pts);
    expect(out.startsWith(`M ${pts[0].x} ${pts[0].y}`)).toBe(true);
    expect(out.endsWith(` ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`)).toBe(true);
  });

  it("endpoints stay anchored (mirror control points keep first/last y stable)", () => {
    const out = smoothPath([
      { x: 0, y: 40 },
      { x: 10, y: 10 },
      { x: 20, y: 30 },
    ]);
    // final command must close on the last point coordinates
    expect(out.endsWith("20 30")).toBe(true);
    expect(out).toMatch(/M 0 40/);
  });

  it("does not overshoot the range of non-negative neighboring points", () => {
    const out = smoothPath([
      { x: 0, y: 100 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 80 },
    ]);
    const yValues = [...out.matchAll(/(?:M|C)\s+[-\d.]+\s+([-\d.]+)(?:\s+[-\d.]+\s+([-\d.]+)\s+[-\d.]+\s+([-\d.]+))?/g)]
      .flatMap((match) => match.slice(1).filter(Boolean).map(Number));
    expect(Math.min(...yValues)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...yValues)).toBeLessThanOrEqual(100);
  });
});

describe("computeChartHeight", () => {
  it("keeps wide charts compact while preserving a readable minimum", () => {
    expect(computeChartHeight(600)).toBe(240);
    expect(computeChartHeight(1200)).toBe(288);
    expect(computeChartHeight(1800)).toBe(320);
  });
});

describe("x-axis density and tooltip placement", () => {
  it("keeps the first and last date while limiting wide charts to twelve labels", () => {
    const indexes = pickXAxisLabelIndexes(90, 1400);
    expect(indexes[0]).toBe(0);
    expect(indexes[indexes.length - 1]).toBe(89);
    expect(indexes.length).toBeLessThanOrEqual(12);
  });

  it("clamps the tooltip inside both chart edges", () => {
    expect(clampTooltipLeft(0, 800, 220)).toBe(122);
    expect(clampTooltipLeft(800, 800, 220)).toBe(678);
    expect(clampTooltipLeft(400, 800, 220)).toBe(400);
  });
});

describe("niceTicks", () => {
  it("handles non-positive and non-finite max", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(-5)).toEqual([0]);
    expect(niceTicks(Number.NaN)).toEqual([0]);
    expect(niceTicks(Number.POSITIVE_INFINITY)).toEqual([0]);
  });

  it("covers the max with a friendly step (1/2/5)", () => {
    const ticks = niceTicks(180);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(180);
    const step = ticks[1] - ticks[0];
    expect(step).toBeGreaterThan(0);
    expect(step % 1).toBe(0);
    expect([1, 2, 5, 10, 20, 50, 100, 200]).toContain(step);
  });

  it("keeps a uniform friendly step across large magnitudes", () => {
    for (const max of [7, 99, 250, 1000, 42_000]) {
      const ticks = niceTicks(max);
      const step = ticks[1] - ticks[0];
      expect(step).toBeGreaterThan(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });
});

describe("computeLayout", () => {
  it("returns safe defaults for empty data", () => {
    const layout = computeLayout([], W, H);
    expect(layout.yMaxTokens).toBe(0);
    expect(layout.yMaxCost).toBe(0);
    expect(layout.ticksLeft).toEqual([0]);
    expect(layout.ticksRight).toEqual([0]);
    // 空数据时映射回退到 plot 左边界，y 拉到底基线
    expect(layout.mapX(0)).toBeCloseTo(CHART_PADDING.left);
    const baseline = CHART_PADDING.top + (H - CHART_PADDING.top - CHART_PADDING.bottom);
    expect(layout.mapYLeft(500)).toBeCloseTo(baseline);
  });

  it("maps y monotonically: larger tokens map to smaller y (upward)", () => {
    const data = makeSeries([
      [0, 100, 50, 10, 5, 2],
      [3600, 50, 20, 5, 2, 1],
    ]);
    const { mapYLeft, mapYRight } = computeLayout(data, W, H);
    expect(mapYLeft(100)).toBeLessThan(mapYLeft(50));
    expect(mapYRight(2)).toBeLessThan(mapYRight(1));
  });

  it("maps x monotonically increasing with bucket", () => {
    const data = makeSeries([
      [0, 1, 1, 1, 1, null],
      [3600, 1, 1, 1, 1, null],
      [7200, 1, 1, 1, 1, null],
    ]);
    const { mapX, xMin, xMax } = computeLayout(data, W, H);
    expect(mapX(xMin)).toBeLessThan(mapX(xMax));
    expect(mapX(0)).toBeLessThan(mapX(3600));
    expect(mapX(3600)).toBeLessThan(mapX(7200));
  });

  it("centers a single bucket in the plot", () => {
    const data = makeSeries([[1000, 1, 1, 0, 0, null]]);
    const { mapX } = computeLayout(data, W, H);
    const plotCenter = CHART_PADDING.left + (W - CHART_PADDING.left - CHART_PADDING.right) / 2;
    expect(mapX(1000)).toBeCloseTo(plotCenter);
  });

  it("y max covers the true peak tokens and cost", () => {
    const data = makeSeries([
      [0, 100, 50, 20, 10, 3],
      [3600, 80, 60, 15, 8, 1.2],
    ]);
    const { yMaxTokens, yMaxCost, ticksLeft, ticksRight } = computeLayout(data, W, H);
    expect(yMaxTokens).toBeGreaterThanOrEqual(100);
    expect(yMaxCost).toBeGreaterThanOrEqual(3);
    expect(ticksLeft[ticksLeft.length - 1]).toBe(yMaxTokens);
    expect(ticksRight[ticksRight.length - 1]).toBe(yMaxCost);
  });

  it("treats null costs as absent from the cost axis", () => {
    const data = makeSeries([
      [0, 100, 50, 20, 10, null],
      [3600, 80, 60, 15, 8, null],
    ]);
    const { yMaxCost, ticksRight } = computeLayout(data, W, H);
    expect(yMaxCost).toBe(0);
    expect(ticksRight).toEqual([0]);
  });
});
