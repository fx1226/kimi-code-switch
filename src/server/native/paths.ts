import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AppPaths {
  dataDir: string;
  databasePath: string;
  historyDir: string;
  serverLockPath: string;
  serverInfoPath: string;
  accessGrantsPath: string;
  transactionKeyPath: string;
  quarantineDir: string;
  tmpDir: string;
  migrationDir: string;
  legacyDataDir: string;
  kimiHome: string;
}

let configuredDataDir: string | null = null;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Configure once at startup, before opening any store. Tests may reset with null. */
export function configureAppPaths(options: { dataDir?: string | null } = {}): AppPaths {
  if (options.dataDir) {
    const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
    const directory = canonical(expandHome(options.dataDir));
    const broad = [homedir(), "/", "/System", "/Library", "/Applications", "/Users", "/usr", "/bin", "/sbin", "/etc", "/var", "/tmp"];
    if (dirname(directory) === directory || broad.some((path) => canonical(path) === directory)) {
      throw new Error("--data-dir must name a private application directory, not a home or system root");
    }
    configuredDataDir = directory;
  } else configuredDataDir = null;
  return getAppPaths();
}

export function getKimiCodeHome(): string {
  const value = process.env.KIMI_CODE_HOME;
  return value && value.trim().length > 0 ? value : "~/.kimi-code";
}

/** All tool-owned mutable resources follow --data-dir. Native Kimi files never do. */
export function getAppPaths(): AppPaths {
  const dataDir = configuredDataDir ?? join(homedir(), ".kimi-code-switch");
  return {
    dataDir,
    databasePath: join(dataDir, "app.db"),
    historyDir: join(dataDir, "history"),
    serverLockPath: join(dataDir, "server.lock"),
    serverInfoPath: join(dataDir, "server.json"),
    accessGrantsPath: join(dataDir, "access-grants.json"),
    transactionKeyPath: join(dataDir, "backup-encryption.key"),
    quarantineDir: join(dataDir, "quarantine"),
    tmpDir: join(dataDir, "tmp"),
    migrationDir: join(dataDir, "migrations"),
    legacyDataDir: join(homedir(), ".kimi-code-switch-gui"),
    kimiHome: resolve(expandHome(getKimiCodeHome())),
  };
}

export function getAppDataDir(): string {
  return getAppPaths().dataDir;
}
