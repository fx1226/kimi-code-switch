import { describe, expect, it } from "vitest";
import { serverFailureMessage } from "./messages";

describe("CLI public errors", () => {
  it("does not print raw token URLs, parser snippets or command arguments", () => {
    for (const prefix of ["spawn open ", "unknown option: ", "Error reading ", "server identity "]) {
      expect(serverFailureMessage(new Error(`${prefix}http://127.0.0.1:8417/#token=test-secret-do-not-print`))).not.toContain("test-secret");
    }
  });
  it("preserves actionable lifecycle classifications", () => {
    expect(serverFailureMessage(new Error("legacy kimi-code-switch-gui is running (pid 123)"))).toContain("close it");
    expect(serverFailureMessage(Object.assign(new Error("private details"), { code: "EPERM" }))).toContain("permission denied");
  });
});
