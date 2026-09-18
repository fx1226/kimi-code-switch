import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ChangePlan, NativeResource, ResourceSnapshot } from "@shared/resourceProtocol";
import type { WebApi } from "@shared/webApi";
import { ConfigurationPanel } from "./ConfigurationPanel";

function fixture() {
  const snapshots: Partial<Record<NativeResource, ResourceSnapshot>> = {
    config: {
      resource: "config", path: "/tmp/config.toml", format: "toml", exists: true,
      revision: "config-r1", content: "", data: { default_model: "original-model", telemetry: true }, diagnostics: [],
    },
    tui: {
      resource: "tui", path: "/tmp/tui.toml", format: "toml", exists: true,
      revision: "tui-r1", content: "", data: { theme: "dark" }, diagnostics: [],
    },
    agents: {
      resource: "agents", path: "/tmp/AGENTS.md", format: "text", exists: true,
      revision: "agents-r1", content: "Original instructions", diagnostics: [],
    },
  };
  const api = {
    planChange: vi.fn(async (input: Parameters<WebApi["planChange"]>[0]): Promise<ChangePlan> => ({
      id: `plan-${input.resource}`, resource: input.resource, path: snapshots[input.resource]!.path,
      expectedRevision: input.expectedRevision, desiredRevision: `${input.resource}-r2`, changed: true,
      validation: "passed", diagnostics: [], createdAt: "2026-09-18",
      redactedPreview: { before: "before", after: "after" },
    })),
  } as unknown as WebApi;
  const props = {
    api, targetId: "default", locale: "en-US" as const, snapshots, readOnly: false,
    onPlan: vi.fn<(plan: ChangePlan, onCommitted: () => void) => void>(),
    onError: vi.fn(), onDirtyChange: vi.fn(), onSource: vi.fn(),
  };
  return { api, props };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ConfigurationPanel commit acknowledgements", () => {
  it("acknowledges the reviewed fields while retaining newer edits and independent resource drafts", async () => {
    const { api, props } = fixture();
    const view = render(<ConfigurationPanel {...props} />);
    fireEvent.change(screen.getByLabelText(/Default model/), { target: { value: "reviewed-model" } });
    fireEvent.change(screen.getByLabelText(/Telemetry/), { target: { value: "false" } });
    fireEvent.change(screen.getByLabelText(/Telemetry/), { target: { value: "true" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    const acknowledge = props.onPlan.mock.calls[0]![1];

    fireEvent.change(screen.getByLabelText(/Default model/), { target: { value: "newer-model" } });
    fireEvent.change(screen.getByLabelText(/Default plan mode/), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("tab", { name: "Terminal interface" }));
    fireEvent.change(screen.getByLabelText(/Terminal theme/), { target: { value: "light" } });
    await act(async () => { acknowledge(); });
    const snapshots = {
      ...props.snapshots,
      config: { ...props.snapshots.config!, revision: "config-r3", data: { default_model: "external-model", telemetry: false } },
    };
    view.rerender(<ConfigurationPanel {...props} snapshots={snapshots} />);
    expect(screen.getByLabelText(/Terminal theme/)).toHaveValue("light");
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("tab", { name: "Global configuration" }));
    expect(screen.getByLabelText(/Default model/)).toHaveValue("newer-model");
    expect(screen.getByLabelText(/Default plan mode/)).toHaveValue("true");
    expect(screen.getByLabelText(/Telemetry/)).toHaveValue("false");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenLastCalledWith({
      targetId: "default", resource: "config", expectedRevision: "config-r3",
      changes: [
        { op: "set", path: ["default_model"], value: "newer-model" },
        { op: "set", path: ["default_plan_mode"], value: true },
      ],
    });
  });

  it.each(["", "Saved instructions"])("releases acknowledged AGENTS.md content %j so fresh native content is shown", async (content) => {
    const { api, props } = fixture();
    const view = render(<ConfigurationPanel {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "AGENTS.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "AGENTS.md" }), { target: { value: content } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    expect(api.planChange).toHaveBeenLastCalledWith({
      targetId: "default", resource: "agents", expectedRevision: "agents-r1", content,
    });
    await act(async () => { props.onPlan.mock.calls[0]![1](); });
    view.rerender(<ConfigurationPanel {...props} snapshots={{
      ...props.snapshots,
      agents: { ...props.snapshots.agents!, revision: "agents-r3", content: "External instructions" },
    }} />);
    expect(screen.getByRole("textbox", { name: "AGENTS.md" })).toHaveValue("External instructions");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("retains AGENTS.md edits made after the acknowledged review", async () => {
    const { props } = fixture();
    render(<ConfigurationPanel {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "AGENTS.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "AGENTS.md" }), { target: { value: "Reviewed instructions" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); });
    fireEvent.change(screen.getByRole("textbox", { name: "AGENTS.md" }), { target: { value: "Newer instructions" } });
    await act(async () => { props.onPlan.mock.calls[0]![1](); });
    expect(screen.getByRole("textbox", { name: "AGENTS.md" })).toHaveValue("Newer instructions");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});
