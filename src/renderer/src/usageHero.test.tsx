import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Locale } from "@shared/types";
import { UsageHero } from "./usageHero";

function renderUsageHero(promptTokens: number, locale: Locale = "zh-CN", reasoningTokens = 0) {
  return render(
    <UsageHero
      locale={locale}
      overview={{
        totalCalls: 1,
        totalTokens: promptTokens,
        cacheHitRate: 0.5,
        reasoningTokens,
        avgLatencyMs: 100,
        latencySamples: 1,
        errorRate: 0,
      }}
      totals={{
        promptTokens,
        completionTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }}
      costTotal={0}
      currency="USD"
    />,
  );
}

describe("UsageHero", () => {
  it("uses 亿 for Chinese token totals once the value reaches one hundred million", () => {
    const { container, getByText } = renderUsageHero(164_400_800);

    expect(getByText("1.64亿")).toBeDefined();
    expect(container.querySelector(".usage-hero-sub")?.textContent).toBe("≈ 1.64亿");
  });

  it("keeps 万 for Chinese token totals below one hundred million", () => {
    const { container, getByText } = renderUsageHero(99_000_000);

    expect(getByText("9900.00万")).toBeDefined();
    expect(container.querySelector(".usage-hero-sub")?.textContent).toBe("≈ 9900.00万");
  });

  it("uses Traditional Chinese units for Traditional Chinese", () => {
    const { getByText } = renderUsageHero(100_000_000, "zh-TW");

    expect(getByText("1.00億")).toBeDefined();
  });

  it("keeps the existing M unit for non-Chinese locales", () => {
    const { getByText } = renderUsageHero(100_000_000, "en-US");

    expect(getByText("100.00M")).toBeDefined();
  });

  it("formats compact decimals with the selected non-Chinese locale", () => {
    const { getByText } = renderUsageHero(100_000_000, "de-DE");

    expect(getByText("100,00M")).toBeDefined();
  });

  it("promotes values that would round to ten thousand wan", () => {
    const { getByText } = renderUsageHero(99_999_999);

    expect(getByText("1.00亿")).toBeDefined();
  });

  it("uses the compact Chinese unit for reasoning tokens too", () => {
    const { getByText } = renderUsageHero(0, "zh-CN", 164_400_800);

    expect(getByText("1.64亿")).toBeDefined();
  });

  it("places each primary metric icon and label in the same header row", () => {
    const { container, getByText } = renderUsageHero(1_000);
    const inputLabel = getByText("新增输入");
    const header = inputLabel.closest(".usage-metric-head");

    expect(header).not.toBeNull();
    expect(header?.querySelector(".usage-metric-icon")).not.toBeNull();
    expect(container.querySelectorAll(".usage-metric-head")).toHaveLength(5);
  });
});
