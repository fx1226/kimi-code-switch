import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsDashboard, InsightsSettingsPanel } from "./insightsComponents";

const originalApi = window.kimiSwitch;

afterEach(() => {
  window.kimiSwitch = originalApi;
  window.localStorage?.removeItem("kimi-insights-ui-prefs-v1");
});

function enabledApi() {
  return {
    usageIngestNow: vi.fn(async () => ({ ok: true as const })),
    usageGetStatus: vi.fn(async () => ({
      ok: true as const,
      settings: {
        insights_status: "enabled",
        insights_proxy_port: 0,
        insights_retention_days: 90,
        insights_disk_warn_threshold_mb: 100,
        insights_store_prompt_preview: false,
        insights_onboarding_shown_at: "",
        insights_last_known_port: null,
        insights_display_currency: "USD",
        insights_currency_rates: {},
      },
    })),
    usageQueryOverview: vi.fn(async () => ({
      ok: true as const,
      slice: { totalCalls: 10, totalTokens: 1000, cacheHitRate: 0.5, reasoningTokens: 100, avgLatencyMs: 1200, latencySamples: 8, errorRate: 0.1 },
    })),
    usageQueryTokenTotals: vi.fn(async () => ({
      ok: true as const,
      totals: { promptTokens: 600, completionTokens: 400, cacheCreationTokens: 50, cacheReadTokens: 900 },
    })),
    usageQueryTrendTokens: vi.fn(async () => ({
      ok: true as const,
      series: [
        { bucket: 1704067200000, prompt: 600, completion: 400, cacheCreation: 50, cacheRead: 900 },
      ],
    })),
    usageQueryCostSeries: vi.fn(async () => ({
      ok: true as const,
      points: [{ bucket: 1704067200000, cost: 0.12 }],
      series: [
        { bucket: 1704067200000, prompt: 600, completion: 400, cacheCreation: 50, cacheRead: 900 },
      ],
    })),
    usageQueryCost: vi.fn(async () => ({
      ok: true as const,
      total: 0.12,
      byDay: { "1704067200000": 0.12 },
      byModel: {},
    })),
    usageQueryBreakdown: vi.fn(async () => ({ ok: true as const, rows: [] })),
    usageQuerySessions: vi.fn(async () => ({ ok: true as const, rows: [] })),
    usageGetStorageInfo: vi.fn(async () => ({ ok: true as const, info: { totalBytes: 0, exceedsWarn: false } })),
  };
}

// 安装到 window.kimiSwitch 时抹平为完整 API 类型；测试侧保留 vi.Mock 访问能力。
function installApi(api: ReturnType<typeof enabledApi>): void {
  window.kimiSwitch = api as unknown as Window["kimiSwitch"];
}

describe("InsightsDashboard", () => {
  it("renders a stable loading state while status is being fetched", () => {
    window.kimiSwitch = {
      usageGetStatus: vi.fn(() => new Promise(() => {})),
    } as unknown as Window["kimiSwitch"];

    const { getByRole } = render(<InsightsDashboard locale="zh-CN" />);

    expect(getByRole("status").textContent).toContain("加载中");
  });

  it("renders exactly three sub tabs with no trend tab", async () => {
    window.kimiSwitch = enabledApi() as unknown as Window["kimiSwitch"];

    const { findAllByRole } = render(<InsightsDashboard locale="zh-CN" />);

    const tabs = await findAllByRole("tab");
    expect(tabs).toHaveLength(3);

    const labels = tabs.map((btn) => btn.textContent);
    expect(labels).toEqual(["总览", "分组统计", "会话"]);
  });

  it("uses accessible tabs and supports keyboard navigation", async () => {
    window.kimiSwitch = enabledApi() as unknown as Window["kimiSwitch"];
    const { findByRole } = render(<InsightsDashboard locale="zh-CN" />);
    const overviewTab = await findByRole("tab", { name: "总览" });

    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });

    const breakdownTab = await findByRole("tab", { name: "分组统计" });
    await waitFor(() => expect(breakdownTab.getAttribute("aria-selected")).toBe("true"));
    expect(await findByRole("tabpanel", { name: "分组统计" })).toBeDefined();
  });

  it("does not render trend metric switching controls after ready", async () => {
    window.kimiSwitch = enabledApi() as unknown as Window["kimiSwitch"];

    const { container, findAllByRole } = render(<InsightsDashboard locale="zh-CN" />);

    await findAllByRole("button");

    expect(container.querySelector(".insights-trend-controls")).toBeNull();
    expect(container.querySelector(".insights-chart-type-toggle")).toBeNull();
  });

  it("places the adjustable time range beside the trend and reloads the shared statistics", async () => {
    const api = enabledApi();
    installApi(api);

    const { container, findByRole } = render(<InsightsDashboard locale="zh-CN" />);
    const rangeGroup = await findByRole("group", { name: "时间范围" });
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenCalled());
    api.usageIngestNow.mockClear();

    expect(rangeGroup.closest(".insights-trend-section-head")).not.toBeNull();
    expect(container.querySelector(".insights-dashboard-header .insights-trend-range-control")).toBeNull();
    expect(within(rangeGroup).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "今天", "最近 3 天", "最近 7 天", "最近 14 天", "最近 30 天", "最近 90 天", "本月", "自定义",
    ]);

    fireEvent.click(within(rangeGroup).getByRole("button", { name: "最近 30 天" }));
    await waitFor(() => {
      expect(api.usageQueryOverview).toHaveBeenLastCalledWith("30d");
      expect(api.usageQueryCostSeries).toHaveBeenLastCalledWith("30d");
    });
    expect(api.usageIngestNow).not.toHaveBeenCalled();
  });

  it("keeps current content visible and the refresh button idle while a range query is pending", async () => {
    const api = enabledApi();
    installApi(api);
    const { container, findByRole, getByText, queryByRole } = render(<InsightsDashboard locale="zh-CN" />);
    const rangeGroup = await findByRole("group", { name: "时间范围" });
    await waitFor(() => expect(getByText("1,000")).toBeDefined());
    const pendingOverview = new Promise<never>(() => {});
    api.usageQueryOverview.mockImplementationOnce(() => pendingOverview);

    fireEvent.click(within(rangeGroup).getByRole("button", { name: "最近 30 天" }));
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenLastCalledWith("30d"));

    expect(getByText("1,000")).toBeDefined();
    expect(container.querySelector('.usage-hero[aria-busy="true"]')).toBeNull();
    expect(queryByRole("button", { name: "加载中..." })).toBeNull();
    expect((await findByRole("button", { name: "刷新" })).hasAttribute("disabled")).toBe(false);
  });

  it("ingests logs only for an explicit refresh, before running queries", async () => {
    const api = enabledApi();
    installApi(api);
    const { findByRole } = render(<InsightsDashboard locale="zh-CN" />);
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenCalled());
    api.usageIngestNow.mockClear();
    api.usageQueryOverview.mockClear();
    let releaseIngest: (() => void) | undefined;
    api.usageIngestNow.mockImplementationOnce(() => new Promise((resolve) => {
      releaseIngest = () => resolve({ ok: true as const });
    }));

    fireEvent.click(await findByRole("button", { name: "刷新" }));
    expect(api.usageIngestNow).toHaveBeenCalledTimes(1);
    expect(api.usageQueryOverview).not.toHaveBeenCalled();

    releaseIngest?.();
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenCalled());
  });

  it("edits a custom range as a draft and queries only after apply", async () => {
    const api = enabledApi();
    installApi(api);
    const { findByLabelText, findByRole, findByText } = render(<InsightsDashboard locale="zh-CN" />);
    const rangeGroup = await findByRole("group", { name: "时间范围" });
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenCalled());
    api.usageQueryOverview.mockClear();

    fireEvent.click(within(rangeGroup).getByRole("button", { name: "自定义" }));
    expect(within(rangeGroup).getAllByRole("button")).toHaveLength(8);
    fireEvent.change(await findByLabelText("开始日期"), { target: { value: "2026-08-01" } });
    fireEvent.change(await findByLabelText("结束日期"), { target: { value: "2026-08-03" } });
    expect(api.usageQueryOverview).not.toHaveBeenCalled();

    fireEvent.click(await findByRole("button", { name: "应用" }));
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenLastCalledWith({
      fromUtc: new Date(2026, 7, 1).getTime(),
      toUtc: new Date(2026, 7, 4).getTime(),
    }));
    const appliedGroup = await findByRole("group", { name: "时间范围" });
    expect(within(appliedGroup).getByRole("button", { name: "自定义" }).getAttribute("aria-pressed")).toBe("true");
    expect(await findByText("2026-08-01 — 2026-08-03")).toBeDefined();

    fireEvent.click(within(appliedGroup).getByRole("button", { name: "最近 30 天" }));
    await waitFor(() => expect(api.usageQueryOverview).toHaveBeenLastCalledWith("30d"));
  });
});

describe("InsightsSettingsPanel", () => {
  it("uses the shared accessible dialog for irreversible data reset confirmation", async () => {
    window.kimiSwitch = enabledApi() as unknown as Window["kimiSwitch"];
    const { findByRole, queryByRole } = render(<InsightsSettingsPanel locale="en-US" />);

    fireEvent.click(await findByRole("button", { name: "Clear Data" }));
    const dialog = await findByRole("dialog", { name: "Confirm Clearing Insights Data" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
  });

  it("does not persist an implicit default exchange rate when the input was not changed", async () => {
    const usageSetConfig = vi.fn(async () => ({ ok: true as const }));
    window.kimiSwitch = {
      usageGetStatus: vi.fn(async () => ({
        ok: true as const,
        settings: {
          insights_status: "enabled",
          insights_proxy_port: "auto",
          insights_retention_days: 90,
          insights_disk_warn_threshold_mb: 100,
          insights_store_prompt_preview: false,
          insights_onboarding_shown_at: "done",
          insights_last_known_port: null,
          insights_display_currency: "CNY",
          insights_currency_rates: {},
        },
        proxy: { status: "running" },
      })),
      usageGetStorageInfo: vi.fn(async () => ({
        ok: true as const,
        info: { totalBytes: 0, exceedsWarn: false },
      })),
      usageSetConfig,
    } as unknown as Window["kimiSwitch"];

    const { findByRole } = render(<InsightsSettingsPanel locale="zh-CN" />);
    const rateInput = await findByRole("spinbutton");
    expect((rateInput as HTMLInputElement).value).toBe("7.2");

    fireEvent.focus(rateInput);
    fireEvent.blur(rateInput);

    expect(usageSetConfig).not.toHaveBeenCalled();
  });

  it("remounts the effective rate when switching currencies and does not write it on blur", async () => {
    let currency: "CNY" | "EUR" = "CNY";
    const usageSetConfig = vi.fn(async (patch: { insights_display_currency?: "CNY" | "EUR" }) => {
      if (patch.insights_display_currency) currency = patch.insights_display_currency;
      return { ok: true as const };
    });
    const usageGetStatus = vi.fn(async () => ({
      ok: true as const,
      settings: {
        insights_status: "enabled" as const,
        insights_proxy_port: "auto" as const,
        insights_retention_days: 90,
        insights_disk_warn_threshold_mb: 100,
        insights_store_prompt_preview: false,
        insights_onboarding_shown_at: "done",
        insights_last_known_port: null,
        insights_display_currency: currency,
        insights_currency_rates: {},
      },
      proxy: { status: "running" },
    }));
    window.kimiSwitch = {
      usageGetStatus,
      usageGetStorageInfo: vi.fn(async () => ({ ok: true as const, info: { totalBytes: 0, exceedsWarn: false } })),
      usageSetConfig,
    } as unknown as Window["kimiSwitch"];

    const { findByRole, getByRole } = render(<InsightsSettingsPanel locale="zh-CN" />);
    fireEvent.click(await findByRole("button", { name: "显示币种 CNY" }));
    fireEvent.click(await findByRole("option", { name: "EUR" }));
    await waitFor(() => expect((getByRole("spinbutton") as HTMLInputElement).value).toBe("0.92"));
    const rateInput = getByRole("spinbutton");
    fireEvent.blur(rateInput);

    expect(usageSetConfig).toHaveBeenCalledTimes(1);
    expect(usageSetConfig).toHaveBeenCalledWith({ insights_display_currency: "EUR" });
  });
});
