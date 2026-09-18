// Wave 2：配置历史 / 面板设置 / 官方账号槽位 / 托盘 / 全局快捷键 / ChatGPT 桥接
// （对齐 src-tauri/src/config_history.rs、panel_settings_store.rs、
//   official_accounts.rs、tray.rs、shortcuts.rs、bridge.rs）。
//
// 连接策略：与 usage.ts 共用模块级单例 DatabaseSync 连接（getDb()）。
// 桌面专属命令（set_tray/show_main_window/set_dock_icon_visibility/
//   sync_window_toggle_shortcut）在服务端无托盘/全局快捷键能力，按浏览器形态期望
//   返回无副作用成功。
// ChatGPT 桥接（bridge_*）延后为后续 Wave：本模块仅注册为抛明确错误的占位，
//   避免 registry-contract 出现 unsupported command（chatgptBridgePanel 会 catch
//   错误渲染 signed-out 状态）。
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { fsCommands } from "./fs";
import { expandHome } from "./paths";
import { getDb, run, queryRows, queryRow, scalar } from "./usage";
import type { CommandHandlers } from "./index";

// 测试缝：允许把受管目录（history / official-accounts / credentials）重定向到临时目录，
// 避免测试污染真实 ~/.kimi-code-switch-gui 与 ~/.kimi-code。生产默认不设置，走真实路径。
let testHistoryDir: string | null = null;
let testAccountsRoot: string | null = null;
let testCredentialsDir: string | null = null;

/** 仅供测试调用：覆盖受管目录根；传 null 恢复默认。 */
export function setNativeTestDirs(dirs: {
  historyDir?: string | null;
  accountsRoot?: string | null;
  credentialsDir?: string | null;
}): void {
  if (dirs.historyDir !== undefined) testHistoryDir = dirs.historyDir;
  if (dirs.accountsRoot !== undefined) testAccountsRoot = dirs.accountsRoot;
  if (dirs.credentialsDir !== undefined) testCredentialsDir = dirs.credentialsDir;
}

// ─────────────────────────── 配置历史 ───────────────────────────

const CONFIG_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at TEXT NOT NULL,
  kimi_code_environment_id TEXT NOT NULL DEFAULT '',
  file_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  snapshot_path TEXT NOT NULL,
  target_path TEXT NOT NULL DEFAULT '',
  description TEXT,
  UNIQUE(kimi_code_environment_id, file_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_history_time
  ON config_history(snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_file
  ON config_history(file_id, snapshot_at DESC);
`;

function historyDir(): string {
  return testHistoryDir ?? expandHome("~/.kimi-code-switch-gui/history");
}

function legacyHistoryDirs(): string[] {
  return [
    expandHome("~/.kimi-code/.panel/history"),
    expandHome("~/.kimi/.panel/history"),
  ];
}

function ensureHistoryDir(): string {
  const target = historyDir();
  createDirAll(target);
  return target;
}

function createDirAll(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function gzipCompress(content: string): Buffer {
  return gzipSync(Buffer.from(content, "utf8"));
}

function gzipDecompress(compressed: Buffer): string {
  return gunzipSync(compressed).toString("utf8");
}

function writePrivateSnapshot(path: string, content: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // 非 POSIX 环境忽略
  }
}

function tableExists(name: string): boolean {
  return (
    queryRow("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1", [name]) !== null
  );
}

function tableHasColumn(table: string, column: string): boolean {
  const rows = queryRows(`SELECT name FROM pragma_table_info('${table}')`);
  return rows.some((r) => String(r.name) === column);
}

function ensureConfigHistoryEnvironmentColumn(): void {
  getDb().exec("SAVEPOINT cfg_history_migration;");
  let migrationError: unknown = null;
  try {
    try {
      run("ALTER TABLE config_history ADD COLUMN kimi_code_environment_id TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
    try {
      run("ALTER TABLE config_history ADD COLUMN target_path TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
    run(
      "UPDATE config_history SET kimi_code_environment_id = 'legacy-unassigned' " +
        "WHERE TRIM(kimi_code_environment_id) = ''",
    );
    migrateConfigHistoryUniqueConstraint();
    getDb().exec(
      "CREATE INDEX IF NOT EXISTS idx_history_environment_time " +
        "ON config_history(kimi_code_environment_id, snapshot_at DESC)",
    );
    getDb().exec("RELEASE SAVEPOINT cfg_history_migration;");
  } catch (error) {
    migrationError = error;
  }
  if (migrationError !== null) {
    try {
      getDb().exec("ROLLBACK TO SAVEPOINT cfg_history_migration;");
      getDb().exec("RELEASE SAVEPOINT cfg_history_migration;");
    } catch {
      // 回滚失败也抛出原始错误
    }
    throw new Error(`migrate config_history environment column: ${String(migrationError)}`);
  }
}

function migrateConfigHistoryUniqueConstraint(): void {
  const row = queryRow("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'config_history'");
  const createSql = row ? String(row.sql ?? "") : "";
  const normalized = createSql.split(/\s+/).join(" ");
  if (normalized.includes("UNIQUE(kimi_code_environment_id, file_id, sha256)")) {
    return;
  }
  try {
    getDb().exec(
      `SAVEPOINT cfg_history_unique_migration;
       DROP INDEX IF EXISTS idx_history_time;
       DROP INDEX IF EXISTS idx_history_file;
       DROP INDEX IF EXISTS idx_history_environment_time;
       ALTER TABLE config_history RENAME TO config_history_legacy;
       CREATE TABLE config_history (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         snapshot_at TEXT NOT NULL,
         kimi_code_environment_id TEXT NOT NULL DEFAULT 'legacy-unassigned',
         file_id TEXT NOT NULL,
         sha256 TEXT NOT NULL,
         size_bytes INTEGER NOT NULL,
         snapshot_path TEXT NOT NULL,
         target_path TEXT NOT NULL DEFAULT '',
         description TEXT,
         UNIQUE(kimi_code_environment_id, file_id, sha256)
       );
       INSERT INTO config_history (
         id, snapshot_at, kimi_code_environment_id, file_id, sha256,
         size_bytes, snapshot_path, target_path, description
       )
       SELECT
         id, snapshot_at,
         CASE WHEN TRIM(kimi_code_environment_id) = '' THEN 'legacy-unassigned'
              ELSE kimi_code_environment_id END,
         file_id, sha256, size_bytes, snapshot_path, target_path, description
       FROM config_history_legacy;
       DROP TABLE config_history_legacy;
       CREATE INDEX idx_history_time ON config_history(snapshot_at DESC);
       CREATE INDEX idx_history_file ON config_history(file_id, snapshot_at DESC);
       RELEASE SAVEPOINT cfg_history_unique_migration;`,
    );
  } catch (error) {
    try {
      getDb().exec("ROLLBACK TO SAVEPOINT cfg_history_unique_migration;");
      getDb().exec("RELEASE SAVEPOINT cfg_history_unique_migration;");
    } catch {
      // ignore
    }
    throw new Error(`migrate config_history unique constraint: ${String(error)}`);
  }
}

function backfillHistoryTargetPaths(): void {
  if (!tableExists("panel_settings")) return;
  const row = queryRow("SELECT kimi_code_environments FROM panel_settings WHERE id = 1");
  if (!row || row.kimi_code_environments == null) return;
  let environments: unknown[] = [];
  try {
    const parsed = JSON.parse(String(row.kimi_code_environments));
    if (Array.isArray(parsed)) environments = parsed;
  } catch {
    return;
  }
  for (const environment of environments) {
    if (typeof environment !== "object" || environment === null) continue;
    const env = environment as Record<string, unknown>;
    const environmentId = typeof env.id === "string" ? env.id : "";
    const homePath = typeof env.homePath === "string" ? env.homePath : "";
    if (!environmentId.trim() || !homePath.trim()) continue;
    const home = homePath.replace(/\/+$/, "");
    for (const [fileId, fileName] of [
      ["config", "config.toml"],
      ["mcp", "mcp.json"],
      ["tui", "tui.toml"],
      ["agents", "AGENTS.md"],
      ["skills", "skills"],
    ] as const) {
      const targetPath = `${home}/${fileName}`;
      run(
        "UPDATE config_history SET target_path = ?1 " +
          "WHERE kimi_code_environment_id = ?2 AND file_id = ?3 AND TRIM(target_path) = ''",
        [targetPath, environmentId, fileId],
      );
    }
  }
}

function normalizeLegacyDefaultHistoryTargets(): void {
  const retiredPrefix = "%/.kimi-code-switch-gui/.env/default/%";
  for (const [fileId, targetPath] of [
    ["config", "~/.kimi-code/config.toml"],
    ["mcp", "~/.kimi-code/mcp.json"],
    ["tui", "~/.kimi-code/tui.toml"],
    ["agents", "~/.kimi-code/AGENTS.md"],
    ["skills", "~/.kimi-code/skills"],
  ] as const) {
    run(
      "UPDATE config_history SET target_path = ?1 " +
        "WHERE kimi_code_environment_id = 'default' AND file_id = ?2 AND target_path LIKE ?3",
      [targetPath, fileId, retiredPrefix],
    );
  }
}

function moveSnapshot(source: string, destination: string): void {
  try {
    renameSync(source, destination);
    return;
  } catch {
    // 跨设备回退到复制
  }
  copyFileSync(source, destination);
  rmSync(source, { force: true });
}

function migrateHistorySnapshotPaths(): void {
  const target = historyDir();
  for (const legacy of legacyHistoryDirs()) {
    const rows = queryRows("SELECT id, snapshot_path FROM config_history");
    for (const row of rows) {
      const id = Number(row.id);
      const snapshotPath = String(row.snapshot_path ?? "");
      if (!snapshotPath.startsWith(legacy)) continue;
      const fileName = basename(snapshotPath);
      const next = join(target, fileName);
      let migrated = false;
      if (existsSync(snapshotPath)) {
        if (existsSync(next)) {
          if (readFileSync(snapshotPath).equals(readFileSync(next))) {
            try {
              rmSync(snapshotPath, { force: true });
              migrated = true;
            } catch {
              migrated = false;
            }
          }
        } else {
          try {
            moveSnapshot(snapshotPath, next);
            migrated = true;
          } catch {
            migrated = false;
          }
        }
      } else if (existsSync(next)) {
        migrated = true;
      }
      if (!migrated) continue;
      run("UPDATE config_history SET snapshot_path = ?1 WHERE id = ?2", [next, id]);
    }

    // 迁移未索引的快照文件
    if (!existsSync(legacy)) continue;
    for (const entry of readdirSync(legacy)) {
      const source = join(legacy, entry);
      if (!statSync(source).isFile()) continue;
      const destination = join(target, entry);
      if (existsSync(destination)) continue;
      try {
        moveSnapshot(source, destination);
      } catch {
        // 忽略单个失败
      }
    }
  }
}

function captureSnapshotContent(
  fileId: string,
  filePath: string,
): string | null {
  if (fileId === "panel") {
    const json = getPanelSettingsJson();
    if (json === null) return null;
    return json;
  }
  if (fileId === "skills") {
    try {
      const handler = fsCommands["export_portable_directory"];
      if (!handler) return null;
      const bundle = handler({ path: filePath }) as unknown;
      return JSON.stringify(bundle);
    } catch {
      return null;
    }
  }
  const resolved = expandHome(filePath);
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

function registeredEnvironmentTarget(
  environmentId: string,
  fileId: string,
): string | null {
  if (!tableExists("panel_settings")) return null;
  const row = queryRow("SELECT kimi_code_environments FROM panel_settings WHERE id = 1");
  if (!row || row.kimi_code_environments == null) return null;
  let environments: unknown[] = [];
  try {
    const parsed = JSON.parse(String(row.kimi_code_environments));
    if (Array.isArray(parsed)) environments = parsed;
  } catch {
    return null;
  }
  let homePath: string | undefined;
  for (const environment of environments) {
    if (typeof environment !== "object" || environment === null) continue;
    const env = environment as Record<string, unknown>;
    if (env.id === environmentId && typeof env.homePath === "string") {
      homePath = env.homePath;
      break;
    }
  }
  if (homePath === undefined) return null;
  const fileName = {
    config: "config.toml",
    mcp: "mcp.json",
    tui: "tui.toml",
    agents: "AGENTS.md",
    skills: "skills",
  }[fileId];
  if (!fileName) throw new Error(`unsupported environment file_id: ${fileId}`);
  return join(expandHome(homePath), fileName);
}

function captureSnapshot(
  fileId: string,
  filePath: string,
  description: string | null,
  kimiCodeEnvironmentId: string | null,
): number | null {
  if (!["config", "panel", "mcp", "tui", "agents", "skills"].includes(fileId)) {
    throw new Error(`unsupported snapshot file_id: ${fileId}`);
  }
  const content = captureSnapshotContent(fileId, filePath);
  if (content === null) return null;

  const sizeBytes = Buffer.byteLength(content, "utf8");
  const sha = sha256Hex(content);

  const environmentId =
    kimiCodeEnvironmentId && kimiCodeEnvironmentId.trim() !== ""
      ? kimiCodeEnvironmentId
      : "legacy-unassigned";

  const exists = queryRow(
    "SELECT 1 FROM config_history WHERE kimi_code_environment_id = ?1 AND file_id = ?2 AND sha256 = ?3",
    [environmentId, fileId, sha],
  ) !== null;
  if (exists) return null;

  const compressed = gzipCompress(content);
  const historyDirPath = ensureHistoryDir();

  const timestampMs = Date.now();
  const safeEnvironmentId = environmentId
    .split("")
    .map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "_"))
    .join("");
  const extension = fileId === "panel" || fileId === "skills" ? "json" : "toml";
  const snapshotFilename = `${timestampMs}-${safeEnvironmentId}-${fileId}.${extension}.gz`;
  const snapshotPath = join(historyDirPath, snapshotFilename);

  try {
    writePrivateSnapshot(snapshotPath, compressed);
  } catch {
    return null;
  }

  const snapshotAt = new Date().toISOString();
  try {
    run(
      "INSERT INTO config_history (" +
        "snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes, " +
        "snapshot_path, target_path, description" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [snapshotAt, environmentId, fileId, sha, sizeBytes, snapshotPath, filePath, description],
    );
    return Number(scalar("SELECT last_insert_rowid()"));
  } catch {
    try {
      rmSync(snapshotPath, { force: true });
    } catch {
      // ignore
    }
    return null;
  }
}

function listSnapshots(
  kimiCodeEnvironmentId: string,
  fileId: string | null,
  limit: number,
): Record<string, unknown>[] {
  const environmentId =
    kimiCodeEnvironmentId.trim() === "" ? "legacy-unassigned" : kimiCodeEnvironmentId;
  let rows: Record<string, unknown>[];
  if (fileId) {
    rows = queryRows(
      "SELECT id, snapshot_at, kimi_code_environment_id, file_id, sha256, " +
        "size_bytes, snapshot_path, target_path, description " +
        "FROM config_history WHERE kimi_code_environment_id = ?1 AND file_id = ?2 " +
        "ORDER BY snapshot_at DESC LIMIT ?3",
      [environmentId, fileId, limit],
    );
  } else {
    rows = queryRows(
      "SELECT id, snapshot_at, kimi_code_environment_id, file_id, sha256, " +
        "size_bytes, snapshot_path, target_path, description " +
        "FROM config_history WHERE kimi_code_environment_id = ?1 " +
        "ORDER BY snapshot_at DESC LIMIT ?2",
      [environmentId, limit],
    );
  }
  return rows.map((r) => ({
    id: Number(r.id),
    snapshot_at: String(r.snapshot_at ?? ""),
    kimi_code_environment_id: String(r.kimi_code_environment_id ?? ""),
    file_id: String(r.file_id ?? ""),
    sha256: String(r.sha256 ?? ""),
    size_bytes: Number(r.size_bytes ?? 0),
    snapshot_path: String(r.snapshot_path ?? ""),
    target_path: String(r.target_path ?? ""),
    description: r.description == null ? null : String(r.description),
  }));
}

function getSnapshotContent(snapshotId: number): string {
  const row = queryRow("SELECT snapshot_path FROM config_history WHERE id = ?1", [snapshotId]);
  if (!row) throw new Error(`snapshot not found: ${snapshotId}`);
  const compressed = readFileSync(String(row.snapshot_path));
  return gzipDecompress(compressed);
}

function restoreSnapshot(snapshotId: number): void {
  const row = queryRow(
    "SELECT file_id, snapshot_path, kimi_code_environment_id, target_path FROM config_history WHERE id = ?1",
    [snapshotId],
  );
  if (!row) throw new Error(`snapshot not found: ${snapshotId}`);
  const fileId = String(row.file_id);
  const snapshotEnvironmentId = String(row.kimi_code_environment_id ?? "");
  const snapshotTargetPath = String(row.target_path ?? "");
  const compressed = readFileSync(String(row.snapshot_path));
  const snapshotContent = gzipDecompress(compressed);

  if (fileId === "panel") {
    savePanelSettingsRaw(snapshotContent);
    return;
  }

  if (!["config", "mcp", "tui", "agents", "skills"].includes(fileId)) {
    if (fileId === "profiles") {
      throw new Error(
        "profiles snapshots are legacy-only; Profile data is stored in SQLite panel settings",
      );
    }
    throw new Error(`unknown file_id: ${fileId}`);
  }

  // 验证记录路径可恢复（拒绝 legacy-unassigned / 空目标），随后用受信环境注册表的权威目标。
  resolveSnapshotRestoreTarget(snapshotEnvironmentId, snapshotTargetPath);
  const registeredTarget = registeredEnvironmentTarget(snapshotEnvironmentId, fileId);
  if (!registeredTarget) {
    throw new Error(
      `environment ${snapshotEnvironmentId} is not registered; automatic restore is disabled`,
    );
  }
  const resolvedTarget = registeredTarget;

  if (fileId === "skills") {
    restoreSkillsSnapshot(snapshotId, snapshotContent, snapshotEnvironmentId, resolvedTarget);
    return;
  }

  // 创建回滚点快照
  let expectedTargetHash = "";
  if (existsSync(resolvedTarget)) {
    const currentContent = readFileSync(resolvedTarget, "utf8");
    expectedTargetHash = sha256Hex(currentContent);
    const exists = queryRow(
      "SELECT 1 FROM config_history WHERE kimi_code_environment_id = ?1 AND file_id = ?2 AND sha256 = ?3",
      [snapshotEnvironmentId, fileId, expectedTargetHash],
    ) !== null;
    if (!exists) {
      const compressedRollback = gzipCompress(currentContent);
      const historyDirPath = ensureHistoryDir();
      const rollbackPath = join(historyDirPath, `${Date.now()}-${fileId}.toml.gz`);
      writePrivateSnapshot(rollbackPath, compressedRollback);
      run(
        "INSERT INTO config_history (" +
          "snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes, " +
          "snapshot_path, target_path, description" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          new Date().toISOString(),
          snapshotEnvironmentId,
          fileId,
          expectedTargetHash,
          Buffer.byteLength(currentContent, "utf8"),
          rollbackPath,
          snapshotTargetPath,
          `Rollback point before restoring snapshot #${snapshotId}`,
        ],
      );
    }
  }

  atomicWriteText(resolvedTarget, snapshotContent, expectedTargetHash || undefined);
}

function restoreSkillsSnapshot(
  snapshotId: number,
  snapshotContent: string,
  snapshotEnvironmentId: string,
  targetPath: string,
): void {
  let snapshotBundle: unknown;
  try {
    snapshotBundle = JSON.parse(snapshotContent);
  } catch (error) {
    throw new Error(`parse Skills snapshot: ${String(error)}`);
  }
  const exportHandler = fsCommands["export_portable_directory"];
  const replaceHandler = fsCommands["replace_portable_directory"];
  if (!exportHandler || !replaceHandler) {
    throw new Error("Skills snapshot restore requires the portable directory commands (fs)");
  }
  const currentBundle = exportHandler({ path: targetPath }) as { sha256?: string };
  const currentSha = currentBundle && currentBundle.sha256 ? currentBundle.sha256 : "";
  // 回滚点：把当前 Skills 树存为快照
  const currentContent = JSON.stringify(currentBundle);
  const currentHash = sha256Hex(currentContent);
  const exists = queryRow(
    "SELECT 1 FROM config_history WHERE kimi_code_environment_id = ?1 AND file_id = 'skills' AND sha256 = ?2",
    [snapshotEnvironmentId, currentHash],
  ) !== null;
  if (!exists) {
    const compressed = gzipCompress(currentContent);
    const historyDirPath = ensureHistoryDir();
    const rollbackPath = join(historyDirPath, `${Date.now()}-skills.json.gz`);
    writePrivateSnapshot(rollbackPath, compressed);
    run(
      "INSERT INTO config_history (" +
        "snapshot_at, kimi_code_environment_id, file_id, sha256, size_bytes, " +
        "snapshot_path, target_path, description" +
        ") VALUES (?, ?, 'skills', ?, ?, ?, ?, ?)",
      [
        new Date().toISOString(),
        snapshotEnvironmentId,
        currentHash,
        Buffer.byteLength(currentContent, "utf8"),
        rollbackPath,
        targetPath,
        `Rollback point before restoring snapshot #${snapshotId}`,
      ],
    );
  }
  replaceHandler({ path: targetPath, bundle: snapshotBundle, expectedSha256: currentSha });
}

function resolveSnapshotRestoreTarget(environmentId: string, targetPath: string): string {
  if (environmentId.trim() === "" || environmentId === "legacy-unassigned") {
    throw new Error(
      "legacy snapshot has no environment assignment; choose a target environment before restoring",
    );
  }
  if (targetPath.trim() === "") {
    throw new Error("snapshot has no recorded target path; automatic restore is disabled");
  }
  return expandHome(targetPath);
}

function atomicWriteText(path: string, content: string, expectedSha256?: string): void {
  if (expectedSha256) {
    const currentHash = existsSync(path) ? sha256Hex(readFileSync(path, "utf8")) : "";
    if (currentHash !== expectedSha256) {
      throw new Error(`config file conflict: expected ${expectedSha256}, found ${currentHash}`);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "kimi-atomic-"));
  const tempPath = join(dir, "tmp");
  writeFileSync(tempPath, content, "utf8");
  try {
    mkdirSync(dirname(path), { recursive: true });
    renameSync(tempPath, path);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function cleanupOldSnapshots(): number {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const paths = queryRows("SELECT snapshot_path FROM config_history WHERE snapshot_at < ?1", [cutoff]).map(
    (r) => String(r.snapshot_path),
  );
  let deletedFiles = 0;
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
      deletedFiles += 1;
    } catch {
      // 文件可能已不存在
    }
  }
  return run("DELETE FROM config_history WHERE snapshot_at < ?1", [cutoff]);
}

function assignLegacySnapshot(snapshotId: number, environmentId: string): void {
  if (environmentId.trim() === "" || environmentId === "legacy-unassigned") {
    throw new Error("choose a registered Kimi Code environment");
  }
  const row = queryRow(
    "SELECT kimi_code_environment_id, file_id FROM config_history WHERE id = ?1",
    [snapshotId],
  );
  if (!row) throw new Error(`snapshot not found: ${snapshotId}`);
  const currentEnvironmentId = String(row.kimi_code_environment_id ?? "");
  const fileId = String(row.file_id ?? "");
  if (currentEnvironmentId !== "legacy-unassigned" && currentEnvironmentId.trim() !== "") {
    throw new Error(`snapshot #${snapshotId} is already assigned to ${currentEnvironmentId}`);
  }
  if (!["config", "mcp", "tui", "agents", "skills"].includes(fileId)) {
    throw new Error(`legacy ${fileId} snapshots cannot be assigned to an environment`);
  }
  const target = registeredEnvironmentTarget(environmentId, fileId);
  if (!target) {
    throw new Error(`environment ${environmentId} is not registered; assignment is disabled`);
  }
  run(
    "UPDATE config_history SET kimi_code_environment_id = ?1, target_path = ?2 WHERE id = ?3",
    [environmentId, target, snapshotId],
  );
}

function initConfigHistory(): void {
  getDb().exec(CONFIG_HISTORY_SCHEMA_SQL);
  ensureConfigHistoryEnvironmentColumn();
  backfillHistoryTargetPaths();
  normalizeLegacyDefaultHistoryTargets();
  ensureHistoryDir();
  migrateHistorySnapshotPaths();
}

// ─────────────────────────── 面板设置 ───────────────────────────

const PANEL_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS panel_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  config_target TEXT NOT NULL DEFAULT 'kimi-code',
  config_path TEXT NOT NULL,
  profiles TEXT NOT NULL DEFAULT '{}',
  active_profile TEXT NOT NULL DEFAULT 'default',
  profiles_path TEXT NOT NULL,
  follow_config_profiles INTEGER NOT NULL DEFAULT 1,
  theme TEXT NOT NULL DEFAULT 'auto',
  appearance_theme TEXT NOT NULL DEFAULT 'cupertino',
  ui_font_size TEXT NOT NULL DEFAULT 'medium',
  locale TEXT NOT NULL DEFAULT 'en-US',
  tray_icon INTEGER NOT NULL DEFAULT 0,
  sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
  display_open_mode TEXT NOT NULL DEFAULT 'normal',
  close_behavior TEXT NOT NULL DEFAULT 'minimize',
  terminal_app TEXT NOT NULL DEFAULT 'auto',
  last_display_id INTEGER,
  ui_state TEXT,
  favorites TEXT,
  active_official_account_id TEXT NOT NULL DEFAULT '',
  official_account_vault_enabled INTEGER NOT NULL DEFAULT 0,
  chatgpt_bridge_bindings TEXT NOT NULL DEFAULT '{}',
  backup_strategy TEXT NOT NULL DEFAULT 'manual',
  backup_frequency TEXT NOT NULL DEFAULT 'daily',
  backup_retention_count INTEGER NOT NULL DEFAULT 7,
  backup_destination_type TEXT NOT NULL DEFAULT 'local',
  backup_local_path TEXT NOT NULL,
  backup_webdav_url TEXT NOT NULL DEFAULT '',
  backup_webdav_username TEXT NOT NULL DEFAULT '',
  backup_webdav_password TEXT NOT NULL DEFAULT '',
  backup_webdav_path TEXT NOT NULL DEFAULT '/kimi-backups',
  shortcuts TEXT NOT NULL,
  model_ui_metadata TEXT NOT NULL DEFAULT '{}',
  kimi_code_environments TEXT,
  active_kimi_code_environment_id TEXT NOT NULL DEFAULT 'default',
  insights_status TEXT NOT NULL DEFAULT 'disabled',
  insights_proxy_port TEXT,
  insights_retention_days INTEGER NOT NULL DEFAULT 30,
  insights_disk_warn_threshold_mb INTEGER NOT NULL DEFAULT 500,
  insights_store_prompt_preview INTEGER NOT NULL DEFAULT 1,
  insights_onboarding_shown_at TEXT,
  insights_last_known_port INTEGER,
  insights_display_currency TEXT NOT NULL DEFAULT 'USD',
  insights_currency_rates TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const REQUIRED_PANEL_COLUMNS: Array<[string, string]> = [
  ["version", "version INTEGER NOT NULL DEFAULT 1"],
  ["config_target", "config_target TEXT NOT NULL DEFAULT 'kimi-code'"],
  ["config_path", "config_path TEXT NOT NULL DEFAULT ''"],
  ["profiles", "profiles TEXT NOT NULL DEFAULT '{}'"],
  ["active_profile", "active_profile TEXT NOT NULL DEFAULT 'default'"],
  ["profiles_path", "profiles_path TEXT NOT NULL DEFAULT ''"],
  ["follow_config_profiles", "follow_config_profiles INTEGER NOT NULL DEFAULT 1"],
  ["theme", "theme TEXT NOT NULL DEFAULT 'auto'"],
  ["appearance_theme", "appearance_theme TEXT NOT NULL DEFAULT 'cupertino'"],
  ["ui_font_size", "ui_font_size TEXT NOT NULL DEFAULT 'medium'"],
  ["locale", "locale TEXT NOT NULL DEFAULT 'en-US'"],
  ["tray_icon", "tray_icon INTEGER NOT NULL DEFAULT 0"],
  ["sidebar_collapsed", "sidebar_collapsed INTEGER NOT NULL DEFAULT 0"],
  ["display_open_mode", "display_open_mode TEXT NOT NULL DEFAULT 'normal'"],
  ["close_behavior", "close_behavior TEXT NOT NULL DEFAULT 'minimize'"],
  ["terminal_app", "terminal_app TEXT NOT NULL DEFAULT 'auto'"],
  ["last_display_id", "last_display_id INTEGER"],
  ["ui_state", "ui_state TEXT"],
  ["favorites", "favorites TEXT"],
  ["active_official_account_id", "active_official_account_id TEXT NOT NULL DEFAULT ''"],
  ["official_account_vault_enabled", "official_account_vault_enabled INTEGER NOT NULL DEFAULT 0"],
  ["chatgpt_bridge_bindings", "chatgpt_bridge_bindings TEXT NOT NULL DEFAULT '{}'"],
  ["backup_strategy", "backup_strategy TEXT NOT NULL DEFAULT 'manual'"],
  ["backup_frequency", "backup_frequency TEXT NOT NULL DEFAULT 'daily'"],
  ["backup_retention_count", "backup_retention_count INTEGER NOT NULL DEFAULT 7"],
  ["backup_destination_type", "backup_destination_type TEXT NOT NULL DEFAULT 'local'"],
  ["backup_local_path", "backup_local_path TEXT NOT NULL DEFAULT ''"],
  ["backup_webdav_url", "backup_webdav_url TEXT NOT NULL DEFAULT ''"],
  ["backup_webdav_username", "backup_webdav_username TEXT NOT NULL DEFAULT ''"],
  ["backup_webdav_password", "backup_webdav_password TEXT NOT NULL DEFAULT ''"],
  ["backup_webdav_path", "backup_webdav_path TEXT NOT NULL DEFAULT '/kimi-backups'"],
  ["shortcuts", "shortcuts TEXT NOT NULL DEFAULT '{}'"],
  ["model_ui_metadata", "model_ui_metadata TEXT NOT NULL DEFAULT '{}'"],
  ["kimi_code_environments", "kimi_code_environments TEXT"],
  ["active_kimi_code_environment_id", "active_kimi_code_environment_id TEXT NOT NULL DEFAULT 'default'"],
  ["insights_status", "insights_status TEXT NOT NULL DEFAULT 'disabled'"],
  ["insights_proxy_port", "insights_proxy_port TEXT"],
  ["insights_retention_days", "insights_retention_days INTEGER NOT NULL DEFAULT 30"],
  ["insights_disk_warn_threshold_mb", "insights_disk_warn_threshold_mb INTEGER NOT NULL DEFAULT 500"],
  ["insights_store_prompt_preview", "insights_store_prompt_preview INTEGER NOT NULL DEFAULT 1"],
  ["insights_onboarding_shown_at", "insights_onboarding_shown_at TEXT"],
  ["insights_last_known_port", "insights_last_known_port INTEGER"],
  ["insights_display_currency", "insights_display_currency TEXT NOT NULL DEFAULT 'USD'"],
  ["insights_currency_rates", "insights_currency_rates TEXT"],
  ["updated_at", "updated_at TEXT NOT NULL DEFAULT ''"],
  ["created_at", "created_at TEXT NOT NULL DEFAULT ''"],
];

function panelSettingsColumns(): string[] {
  return queryRows("SELECT name FROM pragma_table_info('panel_settings')").map((r) => String(r.name));
}

function ensurePanelSettingsColumns(): void {
  const columns = panelSettingsColumns();
  for (const [columnName, columnDefinition] of REQUIRED_PANEL_COLUMNS) {
    if (columns.includes(columnName)) continue;
    run(`ALTER TABLE panel_settings ADD COLUMN ${columnDefinition}`);
  }
}

function initPanelSettingsStore(): void {
  const tableExistsRow = queryRow(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='panel_settings'",
  );
  if (tableExistsRow) {
    const columns = panelSettingsColumns();
    const hasSettingsJsonOnly = columns.includes("settings_json") && !columns.includes("config_path");
    if (hasSettingsJsonOnly || !columns.includes("id")) {
      run("DROP TABLE panel_settings");
    } else {
      ensurePanelSettingsColumns();
    }
  }
  getDb().exec(PANEL_SETTINGS_SCHEMA_SQL);
}

const GET_PANEL_SETTINGS_SELECT = `
SELECT
  version, config_target, config_path, profiles, active_profile, profiles_path, follow_config_profiles,
  theme, appearance_theme, ui_font_size, locale,
  tray_icon, sidebar_collapsed, display_open_mode, close_behavior, terminal_app,
  last_display_id, ui_state, favorites, active_official_account_id,
  backup_strategy, backup_frequency, backup_retention_count, backup_destination_type,
  backup_local_path, backup_webdav_url, backup_webdav_username,
  backup_webdav_password, backup_webdav_path,
  shortcuts, model_ui_metadata, kimi_code_environments, active_kimi_code_environment_id,
  insights_status, insights_proxy_port, insights_retention_days,
  insights_disk_warn_threshold_mb, insights_store_prompt_preview,
  insights_onboarding_shown_at, insights_last_known_port,
  insights_display_currency, insights_currency_rates, official_account_vault_enabled,
  chatgpt_bridge_bindings
FROM panel_settings WHERE id = 1
`;

function getPanelSettingsJson(): string | null {
  const row = queryRow(GET_PANEL_SETTINGS_SELECT);
  if (!row) return null;
  const j = (key: string): unknown => row[key];
  const i = (key: string): number => Number(j(key) ?? 0);
  const s = (key: string): string => (j(key) == null ? "" : String(j(key)));
  const bool = (key: string): boolean => i(key) !== 0;
  const jsonOr = (key: string, fallback: unknown): unknown => {
    const raw = j(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(String(raw));
    } catch {
      return fallback;
    }
  };
  const optJson = (key: string): unknown => (j(key) == null ? null : jsonOr(key, null));
  const optNum = (key: string): number | null => (j(key) == null ? null : i(key));
  const optStr = (key: string): string | null => (j(key) == null ? null : s(key));

  const insightsProxyPortRaw = j("insights_proxy_port");
  let insightsProxyPort: unknown = null;
  if (insightsProxyPortRaw != null) {
    const text = String(insightsProxyPortRaw);
    insightsProxyPort = text === "auto" ? "auto" : Number(text);
  }

  return JSON.stringify({
    version: i("version"),
    config_target: s("config_target"),
    config_path: s("config_path"),
    profiles: jsonOr("profiles", {}),
    active_profile: s("active_profile"),
    profiles_path: s("profiles_path"),
    follow_config_profiles: bool("follow_config_profiles"),
    theme: s("theme"),
    appearance_theme: s("appearance_theme"),
    ui_font_size: s("ui_font_size"),
    locale: s("locale"),
    tray_icon: bool("tray_icon"),
    sidebar_collapsed: bool("sidebar_collapsed"),
    display_open_mode: s("display_open_mode"),
    close_behavior: s("close_behavior"),
    terminal_app: s("terminal_app"),
    last_display_id: optNum("last_display_id"),
    uiState: optJson("ui_state"),
    favorites: optJson("favorites"),
    active_official_account_id: s("active_official_account_id"),
    backup_strategy: s("backup_strategy"),
    backup_frequency: s("backup_frequency"),
    backup_retention_count: i("backup_retention_count"),
    backup_destination_type: s("backup_destination_type"),
    backup_local_path: s("backup_local_path"),
    backup_webdav_url: s("backup_webdav_url"),
    backup_webdav_username: s("backup_webdav_username"),
    backup_webdav_password: s("backup_webdav_password"),
    backup_webdav_path: s("backup_webdav_path"),
    shortcuts: jsonOr("shortcuts", {}),
    model_ui_metadata: jsonOr("model_ui_metadata", {}),
    kimi_code_environments: optJson("kimi_code_environments"),
    active_kimi_code_environment_id: s("active_kimi_code_environment_id"),
    insights_status: s("insights_status"),
    insights_proxy_port: insightsProxyPort,
    insights_retention_days: i("insights_retention_days"),
    insights_disk_warn_threshold_mb: i("insights_disk_warn_threshold_mb"),
    insights_store_prompt_preview: bool("insights_store_prompt_preview"),
    insights_onboarding_shown_at: optStr("insights_onboarding_shown_at"),
    insights_last_known_port: optNum("insights_last_known_port"),
    insights_display_currency: s("insights_display_currency"),
    insights_currency_rates: optJson("insights_currency_rates"),
    official_account_vault_enabled: bool("official_account_vault_enabled"),
    chatgpt_bridge_bindings: optJson("chatgpt_bridge_bindings"),
  });
}

function isRetiredDefaultEnvironmentHome(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.endsWith("/.kimi-code-switch-gui/.env/default");
}

function normalizeRetiredDefaultEnvironmentPaths(settings: Record<string, unknown>): void {
  if (typeof settings.config_path === "string") {
    const p = settings.config_path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p.endsWith("/.kimi-code-switch-gui/.env/default/config.toml")) {
      settings.config_path = "~/.kimi-code/config.toml";
    }
  }
  if (!Array.isArray(settings.kimi_code_environments)) return;
  for (const environment of settings.kimi_code_environments) {
    if (typeof environment !== "object" || environment === null) continue;
    const entry = environment as Record<string, unknown>;
    if (entry.id !== "default") continue;
    const homePath = typeof entry.homePath === "string" ? entry.homePath : "";
    if (isRetiredDefaultEnvironmentHome(homePath)) {
      entry.homePath = "~/.kimi-code";
    }
    entry.kind = "default";
  }
}

function modelUiMetadataJson(settings: Record<string, unknown>): string {
  const metadata = settings["model_ui_metadata"];
  if (metadata === undefined || metadata === null) return "{}";
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("model_ui_metadata must be an object");
  }
  const sanitizedEnvironments: Record<string, unknown> = {};
  for (const [environmentId, models] of Object.entries(metadata as Record<string, unknown>)) {
    if (environmentId.trim() === "") {
      throw new Error("model_ui_metadata environment id must not be empty");
    }
    if (typeof models !== "object" || models === null || Array.isArray(models)) {
      throw new Error("model_ui_metadata environment value must be an object");
    }
    const sanitizedModels: Record<string, unknown> = {};
    for (const [modelId, modelMeta] of Object.entries(models as Record<string, unknown>)) {
      if (modelId.trim() === "") {
        throw new Error("model_ui_metadata model id must not be empty");
      }
      if (typeof modelMeta !== "object" || modelMeta === null || Array.isArray(modelMeta)) {
        throw new Error("model_ui_metadata model value must be an object");
      }
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(modelMeta as Record<string, unknown>)) {
        switch (key) {
          case "auth_mode":
            if (value === "api-key" || value === "official-account") {
              sanitized[key] = value;
            } else {
              throw new Error("model_ui_metadata.auth_mode is invalid");
            }
            break;
          case "official_account_scope":
            if (value === "global") {
              sanitized[key] = value;
            } else {
              throw new Error("model_ui_metadata.official_account_scope is invalid");
            }
            break;
          case "pricing": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              throw new Error("model_ui_metadata.pricing must be an object");
            }
            const sanitizedPricing: Record<string, number> = {};
            for (const [pricingKey, price] of Object.entries(value as Record<string, unknown>)) {
              if (
                !["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_creation_per_mtok"].includes(
                  pricingKey,
                )
              ) {
                throw new Error(`model_ui_metadata.pricing.${pricingKey} is not supported`);
              }
              if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
                throw new Error(`model_ui_metadata.pricing.${pricingKey} must be non-negative`);
              }
              sanitizedPricing[pricingKey] = price;
            }
            sanitized[key] = sanitizedPricing;
            break;
          }
          default:
            throw new Error(
              `model_ui_metadata.${key} is not supported; native definitions and secrets are not stored in the GUI database`,
            );
        }
      }
      sanitizedModels[modelId] = sanitized;
    }
    sanitizedEnvironments[environmentId] = sanitizedModels;
  }
  return JSON.stringify(sanitizedEnvironments);
}

function savePanelSettingsRaw(settingsJson: string): void {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(settingsJson) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`parse settings json: ${String(error)}`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("panel settings must be a JSON object");
  }
  normalizeRetiredDefaultEnvironmentPaths(settings);

  const now = new Date().toISOString();
  const getStr = (key: string): string => (typeof settings[key] === "string" ? settings[key] : "");
  const getBool = (key: string): number => (settings[key] === true ? 1 : 0);
  const getI64 = (key: string): number =>
    typeof settings[key] === "number" ? Math.trunc(settings[key]) : 0;
  const getOptI64 = (key: string): number | null =>
    typeof settings[key] === "number" ? Math.trunc(settings[key]) : null;
  const getOptStr = (key: string): string | null =>
    typeof settings[key] === "string" ? settings[key] : null;
  const getJsonStr = (key: string): string | null =>
    settings[key] === undefined || settings[key] === null ? null : JSON.stringify(settings[key]);
  const getJsonObjectStr = (key: string): string =>
    settings[key] === undefined || settings[key] === null ? "{}" : JSON.stringify(settings[key]);
  const modelUiMetadata = modelUiMetadataJson(settings);

  const proxyPortRaw = settings["insights_proxy_port"];
  const proxyPortValue: string | null =
    typeof proxyPortRaw === "string"
      ? proxyPortRaw
      : typeof proxyPortRaw === "number"
        ? String(Math.trunc(proxyPortRaw))
        : null;

  let saveSql =
    "INSERT INTO panel_settings (" +
    "id, version, " +
    "config_target, config_path, profiles, active_profile, profiles_path, follow_config_profiles, " +
    "theme, appearance_theme, ui_font_size, locale, " +
    "tray_icon, sidebar_collapsed, display_open_mode, close_behavior, terminal_app, " +
    "last_display_id, ui_state, favorites, active_official_account_id, " +
    "backup_strategy, backup_frequency, backup_retention_count, backup_destination_type, " +
    "backup_local_path, backup_webdav_url, backup_webdav_username, " +
    "backup_webdav_password, backup_webdav_path, " +
    "shortcuts, model_ui_metadata, kimi_code_environments, active_kimi_code_environment_id, " +
    "insights_status, insights_proxy_port, insights_retention_days, " +
    "insights_disk_warn_threshold_mb, insights_store_prompt_preview, " +
    "insights_onboarding_shown_at, insights_last_known_port, " +
    "insights_display_currency, insights_currency_rates, official_account_vault_enabled, " +
    "chatgpt_bridge_bindings, " +
    "updated_at, created_at" +
    ") VALUES (" +
    "1, ?1, " +
    "?2, ?3, ?4, ?5, ?6, ?7, " +
    "?8, ?9, ?10, ?11, " +
    "?12, ?13, ?14, ?15, ?16, " +
    "?17, ?18, ?19, ?20, " +
    "?21, ?22, ?23, ?24, " +
    "?25, ?26, ?27, " +
    "?28, ?29, " +
    "?30, ?31, ?32, ?33, " +
    "?34, ?35, ?36, " +
    "?37, ?38, " +
    "?39, ?40, " +
    "?41, ?42, ?43, ?44, " +
    "?45, ?45" +
    ") ON CONFLICT(id) DO UPDATE SET " +
    "version = excluded.version, config_target = excluded.config_target, " +
    "config_path = excluded.config_path, profiles = excluded.profiles, " +
    "active_profile = excluded.active_profile, profiles_path = excluded.profiles_path, " +
    "follow_config_profiles = excluded.follow_config_profiles, theme = excluded.theme, " +
    "appearance_theme = excluded.appearance_theme, ui_font_size = excluded.ui_font_size, " +
    "locale = excluded.locale, tray_icon = excluded.tray_icon, " +
    "sidebar_collapsed = excluded.sidebar_collapsed, display_open_mode = excluded.display_open_mode, " +
    "close_behavior = excluded.close_behavior, terminal_app = excluded.terminal_app, " +
    "last_display_id = excluded.last_display_id, ui_state = excluded.ui_state, " +
    "favorites = excluded.favorites, active_official_account_id = excluded.active_official_account_id, " +
    "backup_strategy = excluded.backup_strategy, backup_frequency = excluded.backup_frequency, " +
    "backup_retention_count = excluded.backup_retention_count, " +
    "backup_destination_type = excluded.backup_destination_type, " +
    "backup_local_path = excluded.backup_local_path, backup_webdav_url = excluded.backup_webdav_url, " +
    "backup_webdav_username = excluded.backup_webdav_username, " +
    "backup_webdav_password = excluded.backup_webdav_password, " +
    "backup_webdav_path = excluded.backup_webdav_path, " +
    "shortcuts = excluded.shortcuts, model_ui_metadata = excluded.model_ui_metadata, " +
    "kimi_code_environments = excluded.kimi_code_environments, " +
    "active_kimi_code_environment_id = excluded.active_kimi_code_environment_id, " +
    "insights_status = excluded.insights_status, insights_proxy_port = excluded.insights_proxy_port, " +
    "insights_retention_days = excluded.insights_retention_days, " +
    "insights_disk_warn_threshold_mb = excluded.insights_disk_warn_threshold_mb, " +
    "insights_store_prompt_preview = excluded.insights_store_prompt_preview, " +
    "insights_onboarding_shown_at = excluded.insights_onboarding_shown_at, " +
    "insights_last_known_port = excluded.insights_last_known_port, " +
    "insights_display_currency = excluded.insights_display_currency, " +
    "insights_currency_rates = excluded.insights_currency_rates, " +
    "official_account_vault_enabled = excluded.official_account_vault_enabled, " +
    "chatgpt_bridge_bindings = excluded.chatgpt_bridge_bindings, " +
    "updated_at = excluded.updated_at";

  if (tableHasColumn("panel_settings", "mcp_servers")) {
    saveSql = saveSql
      .replace(
        "shortcuts, model_ui_metadata, kimi_code_environments",
        "shortcuts, model_ui_metadata, mcp_servers, kimi_code_environments",
      )
      .replace(
        "?30, ?31, ?32, ?33,",
        "?30, ?31, COALESCE((SELECT mcp_servers FROM panel_settings WHERE id = 1), '{}'), ?32, ?33,",
      );
  }

  const params: unknown[] = [
    getI64("version"),
    getStr("config_target"),
    getStr("config_path"),
    getJsonObjectStr("profiles"),
    getStr("active_profile"),
    getStr("profiles_path"),
    getBool("follow_config_profiles"),
    getStr("theme"),
    getStr("appearance_theme"),
    getStr("ui_font_size"),
    getStr("locale"),
    getBool("tray_icon"),
    getBool("sidebar_collapsed"),
    getStr("display_open_mode"),
    getStr("close_behavior"),
    getStr("terminal_app"),
    getOptI64("last_display_id"),
    getJsonStr("uiState"),
    getJsonStr("favorites"),
    getStr("active_official_account_id"),
    getStr("backup_strategy"),
    getStr("backup_frequency"),
    getI64("backup_retention_count"),
    getStr("backup_destination_type"),
    getStr("backup_local_path"),
    getStr("backup_webdav_url"),
    getStr("backup_webdav_username"),
    getStr("backup_webdav_password"),
    getStr("backup_webdav_path"),
    getJsonObjectStr("shortcuts"),
    modelUiMetadata,
    getJsonStr("kimi_code_environments"),
    getStr("active_kimi_code_environment_id"),
    getStr("insights_status"),
    proxyPortValue,
    getI64("insights_retention_days"),
    getI64("insights_disk_warn_threshold_mb"),
    getBool("insights_store_prompt_preview"),
    getOptStr("insights_onboarding_shown_at"),
    getOptI64("insights_last_known_port"),
    getStr("insights_display_currency"),
    getJsonStr("insights_currency_rates"),
    getBool("official_account_vault_enabled"),
    getJsonObjectStr("chatgpt_bridge_bindings"),
    now,
  ];
  run(saveSql, params);
}

const LEGACY_PANEL_TOML_PATHS: string[] = [
  "~/.kimi/config.panel.toml",
  "~/.kimi-code/.panel/config.panel.toml",
  "~/.kimi-code-switch-gui/config.panel.toml",
];

function isKnownLegacyPanelPath(path: string): boolean {
  const home = process.env.HOME || "";
  return LEGACY_PANEL_TOML_PATHS.some((candidate) => expandHome(candidate) === path);
}

function migratePanelSettingsFromToml(tomlPath: string): void {
  const resolvedPath = expandHome(tomlPath);
  if (!isKnownLegacyPanelPath(resolvedPath)) {
    throw new Error("panel TOML migration only accepts known legacy panel settings paths");
  }
  if (!existsSync(resolvedPath)) return;

  const dbHasSettings = getPanelSettingsJson() !== null;
  if (!dbHasSettings) {
    const tomlContent = readFileSync(resolvedPath, "utf8");
    const settingsJson = JSON.stringify(parseToml(tomlContent));
    savePanelSettingsRaw(settingsJson);
  }

  const migratedPath = resolvedPath.slice(0, resolvedPath.length - 5) + ".toml.migrated";
  if (existsSync(migratedPath)) {
    throw new Error(`refusing to overwrite existing migrated panel settings: ${migratedPath}`);
  }
  renameSync(resolvedPath, migratedPath);
}

// ── 最小 TOML 解析器（仅用于 legacy panel settings 迁移；不引入 npm 依赖）──
// 导出仅用于单测验证迁移语义。
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let currentTable: Record<string, unknown> = root;
  let currentPath: string[] = [];

  const getTable = (path: string[]): Record<string, unknown> => {
    let cursor = root;
    for (const part of path) {
      if (typeof cursor[part] !== "object" || cursor[part] === null || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    return cursor;
  };

  const parseValue = (raw: string): unknown => {
    const value = raw.trim();
    if (value === "") return "";
    if (value[0] === '"') {
      return JSON.parse(value);
    }
    if (value[0] === "'") {
      return value.slice(1, value.endsWith("'") ? -1 : undefined);
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (value[0] === "[") {
      return parseArrayValue(value);
    }
    if (value[0] === "{") {
      return parseInlineTable(value);
    }
    if (/^[-+]?\d+$/.test(value)) return Number(value);
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return Number(value);
    if (/^[-+]?\d+[eE][-+]?\d+$/.test(value)) return Number(value);
    // 裸字符串
    return value;
  };

  const parseArrayValue = (raw: string): unknown[] => {
    const inner = raw.slice(1, raw.lastIndexOf("]") === -1 ? undefined : raw.lastIndexOf("]"));
    const items: unknown[] = [];
    let depth = 0;
    let inString: string | null = null;
    let current = "";
    for (const ch of inner) {
      if (inString) {
        current += ch;
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        current += ch;
        continue;
      }
      if (ch === "[" || ch === "{") depth += 1;
      if (ch === "]" || ch === "}") depth -= 1;
      if (ch === "," && depth === 0) {
        items.push(parseValue(current));
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim() !== "") items.push(parseValue(current));
    return items;
  };

  const parseInlineTable = (raw: string): Record<string, unknown> => {
    const inner = raw.slice(1, raw.lastIndexOf("}") === -1 ? undefined : raw.lastIndexOf("}"));
    const obj: Record<string, unknown> = {};
    let depth = 0;
    let inString: string | null = null;
    let current = "";
    const pairs: string[] = [];
    for (const ch of inner) {
      if (inString) {
        current += ch;
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        current += ch;
        continue;
      }
      if (ch === "[" || ch === "{") depth += 1;
      if (ch === "]" || ch === "}") depth -= 1;
      if (ch === "," && depth === 0) {
        pairs.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim() !== "") pairs.push(current);
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim().replace(/^"|"$/g, "");
      obj[key] = parseValue(pair.slice(eq + 1));
    }
    return obj;
  };

  const stripComment = (line: string): string => {
    let inString: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === "#") return line.slice(0, i);
    }
    return line;
  };

  const setKey = (target: Record<string, unknown>, keyPath: string[], value: unknown): void => {
    let cursor = target;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const part = keyPath[i];
      if (typeof cursor[part] !== "object" || cursor[part] === null || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[keyPath[keyPath.length - 1]] = value;
  };

  for (let line of lines) {
    const stripped = stripComment(line).trim();
    if (stripped === "") continue;

    if (stripped.startsWith("[[")) {
      const header = stripped.slice(2, stripped.lastIndexOf("]]"));
      currentPath = header.split(".").map((part) => part.trim());
      const parent = getTable(currentPath.slice(0, -1));
      const key = currentPath[currentPath.length - 1];
      if (!Array.isArray(parent[key])) parent[key] = [];
      const arr = parent[key] as unknown[];
      const table: Record<string, unknown> = {};
      arr.push(table);
      currentTable = table;
      continue;
    }
    if (stripped.startsWith("[")) {
      const header = stripped.slice(1, stripped.lastIndexOf("]"));
      currentPath = header.split(".").map((part) => part.trim());
      currentTable = getTable(currentPath);
      continue;
    }

    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    const keyRaw = stripped.slice(0, eq).trim();
    const valueRaw = stripped.slice(eq + 1).trim();
    const keyParts = keyRaw.split(".").map((part) => part.trim().replace(/^"|"$/g, ""));
    setKey(currentTable, keyParts, parseValue(valueRaw));
  }

  return root;
}

// ─────────────────────────── 官方账号槽位 ───────────────────────────

const OFFICIAL_ACCOUNTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS official_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  account_hint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  credentials_slot_path TEXT NOT NULL,
  last_login_at TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_official_accounts_active
  ON official_accounts(is_active)
  WHERE is_active = 1;
`;

const KIMI_CODE_CREDENTIAL_FILENAMES = [
  "kimi-code.json",
  "managed:kimi-code.json",
  "kimi.json",
  "moonshot.json",
  "oauth.json",
  "auth.json",
  "credentials.json",
];

function officialAccountsRoot(): string {
  return testAccountsRoot ?? expandHome("~/.kimi-code-switch-gui/official-accounts");
}

function standardCredentialsDir(): string {
  return testCredentialsDir ?? expandHome("~/.kimi-code/credentials");
}

function safeAccountId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") throw new Error("Official account id cannot be empty.");
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  throw new Error("Official account id may only contain letters, numbers, '-' and '_'.");
}

// 进程内自增后缀避免同一毫秒内多次调用撞 id（Rust 用 timestamp_millis，Node 单线程更快更易碰撞）。
let accountIdCounter = 0;
function createAccountId(): string {
  accountIdCounter += 1;
  return `acct-${Date.now()}-${accountIdCounter}`;
}

function accountSlotDir(id: string): string {
  const safeId = safeAccountId(id);
  return join(officialAccountsRoot(), safeId, "credentials");
}

function nowIso(): string {
  return new Date().toISOString();
}

function pathToTilde(path: string): string {
  const home = process.env.HOME || "";
  if (home && path.startsWith(home)) {
    return `~/${path.slice(home.length).replace(/^[/\\]+/, "")}`;
  }
  return path;
}

function credentialsFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    if (KIMI_CODE_CREDENTIAL_FILENAMES.includes(entry)) files.push(path);
  }
  return files;
}

function hasCredentials(dir: string): boolean {
  return credentialsFilesIn(dir).length > 0;
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 非 POSIX 忽略
  }
}

function removeKimiCodeCredentials(dir: string): void {
  if (!existsSync(dir)) return;
  for (const file of credentialsFilesIn(dir)) {
    rmSync(file, { force: true });
  }
}

function copyKimiCodeCredentials(from: string, to: string): boolean {
  ensurePrivateDir(to);
  removeKimiCodeCredentials(to);
  const files = credentialsFilesIn(from);
  for (const file of files) {
    const fileName = basename(file);
    copyFileSync(file, join(to, fileName));
    try {
      chmodSync(join(to, fileName), 0o600);
    } catch {
      // 非 POSIX 忽略
    }
  }
  return files.length > 0;
}

function ensureOfficialAccountsSchema(): void {
  getDb().exec(OFFICIAL_ACCOUNTS_SCHEMA_SQL);
}

function rowToAccount(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id ?? ""),
    display_name: String(row.display_name ?? ""),
    account_hint: String(row.account_hint ?? ""),
    status: String(row.status ?? ""),
    is_active: Number(row.is_active ?? 0) !== 0,
    credentials_slot_path: String(row.credentials_slot_path ?? ""),
    last_login_at: String(row.last_login_at ?? ""),
    last_checked_at: String(row.last_checked_at ?? ""),
    last_used_at: String(row.last_used_at ?? ""),
    metadata_json: String(row.metadata_json ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function getAccount(id: string): Record<string, unknown> | null {
  const row = queryRow(
    "SELECT id, display_name, account_hint, status, is_active, credentials_slot_path, " +
      "last_login_at, last_checked_at, last_used_at, metadata_json, created_at, updated_at " +
      "FROM official_accounts WHERE id = ?1",
    [id],
  );
  return row ? rowToAccount(row) : null;
}

function getActiveAccount(): Record<string, unknown> | null {
  const row = queryRow(
    "SELECT id, display_name, account_hint, status, is_active, credentials_slot_path, " +
      "last_login_at, last_checked_at, last_used_at, metadata_json, created_at, updated_at " +
      "FROM official_accounts WHERE is_active = 1 LIMIT 1",
  );
  return row ? rowToAccount(row) : null;
}

function insertAccount(
  id: string,
  displayName: string,
  accountHint: string,
  status: string,
  isActive: boolean,
  slotPath: string,
): Record<string, unknown> {
  const now = nowIso();
  run(
    "INSERT INTO official_accounts (" +
      "id, display_name, account_hint, status, is_active, credentials_slot_path, " +
      "last_login_at, last_checked_at, last_used_at, metadata_json, created_at, updated_at" +
      ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, '{}', ?9, ?10)",
    [
      id,
      displayName,
      accountHint,
      status,
      isActive ? 1 : 0,
      slotPath,
      status === "logged-in" ? now : "",
      isActive ? now : "",
      now,
      now,
    ],
  );
  const account = getAccount(id);
  if (!account) throw new Error("Official account was not saved.");
  return account;
}

function initOfficialAccountsStore(): void {
  ensureOfficialAccountsSchema();
}

function listOfficialAccounts(): Record<string, unknown>[] {
  ensureOfficialAccountsSchema();
  const rows = queryRows(
    "SELECT id, display_name, account_hint, status, is_active, credentials_slot_path, " +
      "last_login_at, last_checked_at, last_used_at, metadata_json, created_at, updated_at " +
      "FROM official_accounts " +
      "ORDER BY is_active DESC, updated_at DESC, display_name COLLATE NOCASE ASC",
  );
  return rows.map(rowToAccount);
}

function createOfficialAccount(displayName: string): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const id = createAccountId();
  const slotDir = accountSlotDir(id);
  ensurePrivateDir(slotDir);
  const name = displayName.trim() === "" ? "Kimi Official Account" : displayName.trim();
  return insertAccount(id, name, "", "empty", false, pathToTilde(slotDir));
}

function renameOfficialAccount(id: string, displayName: string): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const safeId = safeAccountId(id);
  const name = displayName.trim();
  if (name === "") throw new Error("Official account display name cannot be empty.");
  run("UPDATE official_accounts SET display_name = ?1, updated_at = ?2 WHERE id = ?3", [
    name,
    nowIso(),
    safeId,
  ]);
  const account = getAccount(safeId);
  if (!account) throw new Error("Official account not found.");
  return account;
}

function officialOperationResult(
  account: Record<string, unknown>,
  activeAccountId: string,
  credentialsPresent: boolean,
): Record<string, unknown> {
  return { account, active_account_id: activeAccountId, credentials_present: credentialsPresent };
}

function captureCurrentOfficialAccount(displayName: string): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const id = createAccountId();
  const slotDir = accountSlotDir(id);
  ensurePrivateDir(slotDir);
  const credentialsPresent = copyKimiCodeCredentials(standardCredentialsDir(), slotDir);
  const name = displayName.trim() === "" ? "Current Kimi Account" : displayName.trim();
  run("UPDATE official_accounts SET is_active = 0", []);
  const account = insertAccount(
    id,
    name,
    "",
    credentialsPresent ? "logged-in" : "empty",
    true,
    pathToTilde(slotDir),
  );
  return officialOperationResult(account, String(account.id), credentialsPresent);
}

function prepareOfficialAccountLogin(id: string): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const safeId = safeAccountId(id);
  const account = getAccount(safeId);
  if (!account) throw new Error("Official account not found.");
  const active = getActiveAccount();
  if (active) {
    copyKimiCodeCredentials(standardCredentialsDir(), expandHome(String(active.credentials_slot_path)));
  }
  clearCurrentCredentials();
  return officialOperationResult(account, String(account.id), false);
}

function clearCurrentCredentials(): void {
  const dir = standardCredentialsDir();
  ensurePrivateDir(dir);
  removeKimiCodeCredentials(dir);
}

function completeOfficialAccountLogin(id: string, activate: boolean): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const safeId = safeAccountId(id);
  const account = getAccount(safeId);
  if (!account) throw new Error("Official account not found.");
  const slotDir = expandHome(String(account.credentials_slot_path));
  const credentialsPresent = copyKimiCodeCredentials(standardCredentialsDir(), slotDir);
  const now = nowIso();
  if (activate) {
    run("UPDATE official_accounts SET is_active = 0", []);
  } else {
    const active = getActiveAccount();
    if (active) {
      copyKimiCodeCredentials(expandHome(String(active.credentials_slot_path)), standardCredentialsDir());
    }
  }
  run(
    "UPDATE official_accounts " +
      "SET status = ?1, is_active = ?2, last_login_at = ?3, last_checked_at = ?4, " +
      "last_used_at = CASE WHEN ?2 = 1 THEN ?5 ELSE last_used_at END, updated_at = ?6 " +
      "WHERE id = ?7",
    [
      credentialsPresent ? "logged-in" : "empty",
      activate ? 1 : 0,
      credentialsPresent ? now : "",
      now,
      now,
      now,
      safeId,
    ],
  );
  const updated = getAccount(safeId);
  if (!updated) throw new Error("Official account not found.");
  const activeAccountId = activate
    ? String(updated.id)
    : getActiveAccount()
      ? String(getActiveAccount()!.id)
      : "";
  return officialOperationResult(updated, activeAccountId, credentialsPresent);
}

function activateOfficialAccount(id: string): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const safeId = safeAccountId(id);
  const target = getAccount(safeId);
  if (!target) throw new Error("Official account not found.");
  const previous = getActiveAccount();
  if (previous) {
    copyKimiCodeCredentials(standardCredentialsDir(), expandHome(String(previous.credentials_slot_path)));
  }
  const backupDir = join(officialAccountsRoot(), ".switch-backup");
  ensurePrivateDir(backupDir);
  const hadBackup = copyKimiCodeCredentials(standardCredentialsDir(), backupDir);
  let materializeError: unknown = null;
  try {
    copyKimiCodeCredentials(expandHome(String(target.credentials_slot_path)), standardCredentialsDir());
  } catch (error) {
    materializeError = error;
  }
  if (materializeError !== null) {
    if (hadBackup) {
      try {
        copyKimiCodeCredentials(backupDir, standardCredentialsDir());
      } catch {
        // ignore
      }
    }
    throw new Error(String(materializeError));
  }
  const credentialsPresent = hasCredentials(standardCredentialsDir());
  const now = nowIso();
  run("UPDATE official_accounts SET is_active = 0", []);
  run(
    "UPDATE official_accounts SET is_active = 1, status = ?1, last_checked_at = ?2, last_used_at = ?3, updated_at = ?4 WHERE id = ?5",
    [credentialsPresent ? "logged-in" : "empty", now, now, now, safeId],
  );
  const account = getAccount(safeId);
  if (!account) throw new Error("Official account not found.");
  return officialOperationResult(account, String(account.id), credentialsPresent);
}

function deleteOfficialAccount(id: string): void {
  ensureOfficialAccountsSchema();
  const safeId = safeAccountId(id);
  const account = getAccount(safeId);
  if (!account) throw new Error("Official account not found.");
  run("DELETE FROM official_accounts WHERE id = ?1", [safeId]);
  const slot = expandHome(String(account.credentials_slot_path));
  if (existsSync(slot)) {
    rmSync(slot, { recursive: true, force: true });
  }
  if (account.is_active === true) {
    clearCurrentCredentials();
  }
}

function getOfficialAccountCredentialsStatus(): Record<string, unknown> {
  ensureOfficialAccountsSchema();
  const active = getActiveAccount();
  const currentDir = standardCredentialsDir();
  return {
    active_account_id: active ? String(active.id) : "",
    credentials_present: hasCredentials(currentDir),
    standard_credentials_path: pathToTilde(currentDir),
  };
}

// ─────────────────────────── 桌面/桥接占位 ───────────────────────────

function noopDesktop(): void {
  // 服务端无托盘/全局快捷键/主窗口能力；返回无副作用成功（对齐浏览器形态期望）。
}

function bridgeNotImplemented(): never {
  throw new Error("ChatGPT subscription bridge is not implemented in the server runtime");
}

// ─────────────────────────── 命令注册 ───────────────────────────

export const storesCommands: CommandHandlers = {
  // 配置历史
  init_config_history(): void {
    initConfigHistory();
  },
  capture_snapshot(args: Record<string, unknown>): number | null {
    return captureSnapshot(
      String(args.fileId ?? ""),
      String(args.filePath ?? ""),
      args.description == null ? null : String(args.description),
      args.kimiCodeEnvironmentId == null ? null : String(args.kimiCodeEnvironmentId),
    );
  },
  list_snapshots(args: Record<string, unknown>): Record<string, unknown>[] {
    return listSnapshots(
      String(args.kimiCodeEnvironmentId ?? ""),
      args.fileId == null ? null : String(args.fileId),
      Number(args.limit ?? 100),
    );
  },
  assign_legacy_snapshot_environment(args: Record<string, unknown>): void {
    getDb().exec("BEGIN IMMEDIATE;");
    try {
      assignLegacySnapshot(Number(args.snapshotId), String(args.kimiCodeEnvironmentId ?? ""));
      getDb().exec("COMMIT;");
    } catch (error) {
      try {
        getDb().exec("ROLLBACK;");
      } catch {
        // ignore
      }
      throw error;
    }
  },
  get_snapshot_content(args: Record<string, unknown>): string {
    return getSnapshotContent(Number(args.snapshotId));
  },
  restore_snapshot(args: Record<string, unknown>): void {
    restoreSnapshot(Number(args.snapshotId));
  },
  cleanup_old_snapshots(): number {
    return cleanupOldSnapshots();
  },

  // 面板设置
  init_panel_settings_store(): void {
    initPanelSettingsStore();
  },
  get_panel_settings(): string | null {
    return getPanelSettingsJson();
  },
  save_panel_settings(args: Record<string, unknown>): void {
    savePanelSettingsRaw(String(args.settingsJson ?? ""));
  },
  export_panel_settings(): string {
    const json = getPanelSettingsJson();
    if (json === null) throw new Error("panel settings not found");
    return json;
  },
  import_panel_settings(args: Record<string, unknown>): void {
    savePanelSettingsRaw(String(args.settingsJson ?? ""));
  },
  migrate_panel_settings_from_toml(args: Record<string, unknown>): void {
    migratePanelSettingsFromToml(String(args.tomlPath ?? ""));
  },

  // 官方账号
  init_official_accounts_store(): void {
    initOfficialAccountsStore();
  },
  list_official_accounts(): Record<string, unknown>[] {
    return listOfficialAccounts();
  },
  get_official_account_credentials_status(): Record<string, unknown> {
    return getOfficialAccountCredentialsStatus();
  },
  create_official_account(args: Record<string, unknown>): Record<string, unknown> {
    return createOfficialAccount(String(args.displayName ?? ""));
  },
  rename_official_account(args: Record<string, unknown>): Record<string, unknown> {
    return renameOfficialAccount(String(args.id ?? ""), String(args.displayName ?? ""));
  },
  capture_current_official_account(args: Record<string, unknown>): Record<string, unknown> {
    return captureCurrentOfficialAccount(String(args.displayName ?? ""));
  },
  prepare_official_account_login(args: Record<string, unknown>): Record<string, unknown> {
    return prepareOfficialAccountLogin(String(args.id ?? ""));
  },
  complete_official_account_login(args: Record<string, unknown>): Record<string, unknown> {
    return completeOfficialAccountLogin(String(args.id ?? ""), args.activate === true);
  },
  activate_official_account(args: Record<string, unknown>): Record<string, unknown> {
    return activateOfficialAccount(String(args.id ?? ""));
  },
  delete_official_account(args: Record<string, unknown>): void {
    deleteOfficialAccount(String(args.id ?? ""));
  },

  // 托盘（桌面专属，服务端无副作用占位）
  set_tray(): void {
    noopDesktop();
  },
  show_main_window(): void {
    noopDesktop();
  },
  set_dock_icon_visibility(): void {
    noopDesktop();
  },

  // 全局快捷键（桌面专属，服务端无副作用占位）
  sync_window_toggle_shortcut(): void {
    noopDesktop();
  },

  // ChatGPT 订阅桥接（后续 Wave；抛明确错误占位，registry 完整性保持注册）
  bridge_start(): never {
    return bridgeNotImplemented();
  },
  bridge_stop(): never {
    return bridgeNotImplemented();
  },
  bridge_status(): never {
    return bridgeNotImplemented();
  },
  bridge_login(): never {
    return bridgeNotImplemented();
  },
  bridge_wait_login(): never {
    return bridgeNotImplemented();
  },
  bridge_logout(): never {
    return bridgeNotImplemented();
  },
  bridge_refresh_models(): never {
    return bridgeNotImplemented();
  },
  bridge_probe_connectivity(): never {
    return bridgeNotImplemented();
  },
};
