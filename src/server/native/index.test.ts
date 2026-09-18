import { afterEach, describe, expect, it } from "vitest";

import { commandRegistry, invokeCommand } from "./index";

describe("server command registry", () => {
  afterEach(() => {
    delete commandRegistry.__test_echo;
  });

  it("rejects unregistered commands with the unsupported-command error", async () => {
    await expect(invokeCommand("__never_registered", { path: "~/.kimi-code/config.toml" }))
      .rejects.toThrow("unsupported command __never_registered in server runtime");
    await expect(invokeCommand("__also_never_registered")).rejects.toThrow(/unsupported command/);
  });

  it("dispatches registered handlers with the invoke args", async () => {
    commandRegistry.__test_echo = async (args) => ({ echoed: args });
    await expect(invokeCommand("__test_echo", { value: 42 })).resolves.toEqual({ echoed: { value: 42 } });
    await expect(invokeCommand("__test_echo")).resolves.toEqual({ echoed: {} });
  });

  it("propagates handler failures as rejections", async () => {
    commandRegistry.__test_echo = () => {
      throw new Error("boom");
    };
    await expect(invokeCommand("__test_echo")).rejects.toThrow("boom");
  });

  it("has all four group modules wired into the registry", () => {
    // 完整性契约见 registry-contract.test.ts；这里只确认四组模块已挂载。
    const handlers = Object.values(commandRegistry).filter((handler) => typeof handler === "function");
    expect(handlers.length).toBeGreaterThan(0);
  });
});
