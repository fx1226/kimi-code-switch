import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AppState } from "@shared/types";

import { createFallbackState } from "./tabComponents";
import { OverviewDashboard } from "./overviewDashboard";

function createState(): AppState {
  const state = createFallbackState();
  state.mainConfig.providers = {
    secondary: { type: "openai", base_url: "https://secondary.test", api_key: "" },
    primary: { type: "kimi", base_url: "https://primary.test", api_key: "" },
  };
  state.mainConfig.models = {
    "secondary/model-b": {
      provider: "secondary",
      model: "model-b",
      max_context_size: 128000,
      capabilities: [],
    },
    "primary/model-a": {
      provider: "primary",
      model: "model-a",
      max_context_size: 128000,
      capabilities: ["thinking"],
    },
  };
  state.profiles = {
    secondary: {
      name: "secondary",
      label: "Secondary",
      default_model: "secondary/model-b",
      default_plan_mode: false,
      default_permission_mode: "manual",
      merge_all_available_skills: false,
    },
    active: {
      name: "active",
      label: "Active Profile",
      default_model: "primary/model-a",
      default_plan_mode: true,
      default_permission_mode: "auto",
      merge_all_available_skills: false,
      thinking_enabled: true,
    },
  };
  state.activeProfile = "active";
  state.mainConfig.default_model = "primary/model-a";
  state.kimiTargetDetection = {
    status: "detected",
    installed: true,
    version: "0.38.0",
    executablePath: "/usr/local/bin/kimi",
    resolvedPath: "/usr/local/bin/kimi",
    installSource: "homebrew",
    hasUpdate: false,
  };
  return state;
}

function renderOverview(options: {
  onNavigate?: (tab: "profiles" | "providers" | "models" | "mcp" | "skills", item?: string) => void;
  onOpenDoctor?: () => void;
  diagnostics?: { preload: "ok" | "failed" | "pending" | "unavailable"; loadState: "ok" | "failed" | "pending" | "unavailable"; previewState: "ok" | "failed" | "pending" | "unavailable"; lastError: string };
} = {}) {
  return render(
    <OverviewDashboard
      state={createState()}
      locale="zh-CN"
      diagnostics={options.diagnostics ?? { preload: "ok", loadState: "ok", previewState: "ok", lastError: "" }}
      skillsReport={null}
      mcpEntries={[]}
      onNavigate={options.onNavigate ?? (() => {})}
      onOpenDoctor={options.onOpenDoctor ?? (() => {})}
    />,
  );
}

describe("OverviewDashboard", () => {
  it("prioritizes the active profile and its model/provider dependencies", () => {
    const { getByTestId } = renderOverview();

    expect(within(getByTestId("overview-profiles-list")).getAllByRole("button")[0].textContent).toContain("Active Profile");
    expect(within(getByTestId("overview-providers-list")).getAllByRole("button")[0].textContent).toContain("primary");
    expect(within(getByTestId("overview-models-list")).getAllByRole("button")[0].textContent).toContain("primary/model-a");
  });

  it("keeps every management entry visible even when the list is short", () => {
    const onNavigate = vi.fn();
    const { getByRole } = renderOverview({ onNavigate });

    fireEvent.click(getByRole("button", { name: "显示更多 配置方案列表" }));
    fireEvent.click(getByRole("button", { name: "显示更多 提供商列表" }));
    fireEvent.click(getByRole("button", { name: "显示更多 模型列表" }));

    expect(onNavigate.mock.calls).toEqual([["profiles"], ["providers"], ["models"]]);
  });

  it("makes resource statistics navigable", () => {
    const onNavigate = vi.fn();
    const { getByRole } = renderOverview({ onNavigate });

    fireEvent.click(getByRole("button", { name: "配置方案 2" }));
    fireEvent.click(getByRole("button", { name: "提供商 2" }));
    fireEvent.click(getByRole("button", { name: "模型 2" }));
    fireEvent.click(getByRole("button", { name: "MCP 服务 0" }));
    fireEvent.click(getByRole("button", { name: "技能 -" }));

    expect(onNavigate.mock.calls).toEqual([["profiles"], ["providers"], ["models"], ["mcp"], ["skills"]]);
  });

  it("uses permission-mode language and exposes health plus technical details", () => {
    const { getByText, getByTestId, queryByText } = renderOverview();

    expect(getByText("权限模式")).toBeDefined();
    expect(getByText("自动确认")).toBeDefined();
    expect(queryByText("YOLO")).toBeNull();
    expect(getByText("配置状态正常")).toBeDefined();
    expect(getByTestId("overview-technical-details").tagName).toBe("DETAILS");
  });

  it("offers one-click navigation to configuration doctor when startup health is degraded", () => {
    const onOpenDoctor = vi.fn();
    const { getByTestId } = renderOverview({
      onOpenDoctor,
      diagnostics: { preload: "ok", loadState: "failed", previewState: "unavailable", lastError: "Preview failed" },
    });

    fireEvent.click(getByTestId("overview-open-doctor"));
    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });
});
