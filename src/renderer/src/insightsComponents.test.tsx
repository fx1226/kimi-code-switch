import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsDashboard } from "./insightsComponents";

const originalApi = window.kimiSwitch;

afterEach(() => {
  window.kimiSwitch = originalApi;
});

describe("InsightsDashboard", () => {
  it("renders a stable loading state while status is being fetched", () => {
    window.kimiSwitch = {
      usageGetStatus: vi.fn(() => new Promise(() => {})),
    } as unknown as Window["kimiSwitch"];

    const { getByRole } = render(<InsightsDashboard locale="zh-CN" />);

    expect(getByRole("status").textContent).toContain("加载中");
  });
});
