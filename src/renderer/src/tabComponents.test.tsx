import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { McpTransportRadioGroup, ProviderForm, predictSkillLibrary } from "./tabComponents";

describe("predictSkillLibrary", () => {
  it("recognizes the native kimi-code skills directory instead of falling back to the generic label", () => {
    expect(predictSkillLibrary("~/.kimi-code/skills", "zh-CN").label).toBe("Kimi Code 技能库");
  });

  it("labels plugin skill roots with the plugin id", () => {
    const prediction = predictSkillLibrary(
      "~/.kimi-code/plugins/managed/kimi-cu/skills",
      "zh-CN",
      { group: "plugin", pluginId: "kimi-cu" },
    );
    expect(prediction.label).toBe("kimi-cu");
  });
});

describe("McpTransportRadioGroup", () => {
  it("exposes a named radio group and changes transport with arrow keys", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <McpTransportRadioGroup locale="en-US" value="stdio" readOnly={false} onChange={onChange} />,
    );

    const group = getByRole("radiogroup", { name: "Type" });
    const stdio = getByRole("radio", { name: /stdio/i });

    expect(group).toBeDefined();
    expect(stdio.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(stdio, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("streamable-http");
  });
});

describe("ProviderForm", () => {
  it("associates an invalid endpoint with its validation message", () => {
    const { getByDisplayValue } = render(
      <ProviderForm
        locale="en-US"
        name="demo"
        nameEditable
        value={{ type: "openai", base_url: "not a URL", api_key: "" }}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const endpoint = getByDisplayValue("not a URL");
    expect(endpoint.getAttribute("aria-invalid")).toBe("true");
    expect(endpoint.getAttribute("aria-describedby")).toBeTruthy();
  });
});
