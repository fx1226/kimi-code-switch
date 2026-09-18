import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { configureAppPaths, getAppPaths, getAppDataDir } from "./paths";
import { authorizeMutation } from "./fs";

afterEach(() => { configureAppPaths(); vi.unstubAllEnvs(); });

describe("private path context", () => {
  it("keeps all private stores under --data-dir and native paths independent", () => {
    vi.stubEnv("KIMI_CODE_HOME", "/tmp/native-kimi-home");
    const paths = configureAppPaths({ dataDir: "/tmp/isolated-switch-data" });
    expect(paths.kimiHome).toBe("/tmp/native-kimi-home");
    for (const key of ["databasePath", "historyDir", "serverLockPath", "serverInfoPath", "accessGrantsPath", "transactionKeyPath", "quarantineDir", "tmpDir", "migrationDir"] as const) {
      expect(paths[key].startsWith(`${paths.dataDir}/`), key).toBe(true);
    }
    expect(getAppDataDir()).toBe(paths.dataDir);
    expect(authorizeMutation([], join(paths.dataDir, "settings.json"), "SingleFile")).toContain("isolated-switch-data/settings.json");
  });
  it("defaults to the renamed private directory without making the legacy directory writable", () => {
    const paths = getAppPaths();
    expect(paths.dataDir.endsWith("/.kimi-code-switch")).toBe(true);
    expect(() => authorizeMutation([], join(paths.legacyDataDir, "config.panel.toml"), "SingleFile")).toThrow(/outside the authorized scope/);
  });
  it("does not turn a broad native-home environment value into whole-filesystem authorization", () => {
    vi.stubEnv("KIMI_CODE_HOME", "/");
    expect(() => authorizeMutation([], "/tmp/unrelated-config.toml", "SingleFile")).toThrow(/outside the authorized scope/);
  });
  it("rejects broad private data directories before chmod or lock creation", () => {
    expect(() => configureAppPaths({ dataDir: "/" })).toThrow(/private application directory/);
    expect(() => configureAppPaths({ dataDir: "~" })).toThrow(/private application directory/);
    expect(() => configureAppPaths({ dataDir: "/tmp" })).toThrow(/private application directory/);
  });
});
