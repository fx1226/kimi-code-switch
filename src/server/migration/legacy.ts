import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isProcessAlive, readLock } from "../lock";
import { atomicWriteText, authorizeMutation, getDurableGrantsState, resolveFinalTarget, sha256Bytes } from "../native/fs";
import { getAppPaths } from "../native/paths";
import { closeUsageDb } from "../native/usage";

export interface MigrationEntry {
  path: string;
  action: "copy" | "archive" | "retain";
  sizeBytes: number;
  sha256: string | null;
}
export interface LegacyMigrationPreview {
  status: "absent" | "available" | "complete" | "blocked";
  sourceDir: string;
  targetDir: string;
  manifestHash: string;
  entries: MigrationEntry[];
  blockedReason?: string;
}
export interface LegacyMigrationResult {
  status: "complete";
  migratedFiles: number;
  retainedPaths: string[];
  archiveDir: string;
}
interface MigrationJournal {
  version: 1;
  manifestHash: string;
  state: "copying" | "committing" | "finalizing" | "complete";
  stageDir: string;
  entries: MigrationEntry[];
  committed: string[];
  result?: LegacyMigrationResult;
}

function journalPath(): string { return join(getAppPaths().migrationDir, "legacy-v1.json"); }
function readJournal(): MigrationJournal | null {
  assertPrivateTarget(journalPath());
  if (!existsSync(journalPath())) return null;
  const parsed = JSON.parse(readFileSync(journalPath(), "utf8")) as MigrationJournal;
  const safeRelative = (value: unknown): value is string => typeof value === "string" && value.length > 0
    && !isAbsolute(value) && !value.split(/[\\/]/).some((part) => !part || part === "." || part === "..");
  if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.committed)
    || !/^[a-f0-9]{64}$/.test(parsed.manifestHash)
    || !["copying", "committing", "finalizing", "complete"].includes(parsed.state)
    || typeof parsed.stageDir !== "string" || dirname(parsed.stageDir) !== getAppPaths().migrationDir
    || !/^legacy-stage-[a-f0-9-]+$/.test(basename(parsed.stageDir))
    || parsed.entries.some((entry) => !safeRelative(entry.path) || !["copy", "archive", "retain"].includes(entry.action)
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0
      || (entry.action !== "retain" && (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))))
    || parsed.committed.some((path) => !parsed.entries.some((entry) => entry.path === path && entry.action !== "retain"))) {
    throw new Error("migration recovery record is invalid; leave private data unchanged");
  }
  assertPrivateTarget(parsed.stageDir);
  return parsed;
}

function assertPrivateTarget(path: string): void {
  const dataDir = getAppPaths().dataDir;
  const rel = relative(dataDir, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("migration private target escapes the data directory");
  const root = resolveFinalTarget(dataDir);
  const target = resolveFinalTarget(path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("migration private target escapes the data directory");
  // existsSync follows links and reports false for dangling links. Inspect each
  // private component directly, including parents of yet-to-be-created files.
  for (let current = path; current !== dataDir; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("migration private target must not be a symbolic link");
  }
}

/** A partial or unreadable journal must never let metadata initialize its database. */
export function hasPendingLegacyMigration(): boolean {
  try {
    const journal = readJournal();
    return journal !== null && journal.state !== "complete";
  } catch { return true; }
}

function authorizePrivateTarget(path: string, kind: "SingleFile" | "DirectoryTree" = "SingleFile"): void {
  assertPrivateTarget(path);
  authorizeMutation(getDurableGrantsState(), path, kind);
}

function syncPrivateDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    fsyncSync(fd);
  } catch { /* Directory fsync is not supported on every filesystem. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Publish a complete new file without following or replacing any existing entry. */
function copyPrivateFile(source: string, target: string, entry: MigrationEntry): void {
  authorizePrivateTarget(target);
  const parent = dirname(target);
  authorizePrivateTarget(parent, "DirectoryTree");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: Buffer;
  try { content = readFileSync(sourceFd); }
  finally { closeSync(sourceFd); }
  if (sha256Bytes(content) !== entry.sha256) throw new Error(`migration verification failed: ${entry.path}`);
  const temporary = join(parent, `.${basename(target)}.migration-${randomUUID()}`);
  authorizePrivateTarget(temporary);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, content);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    authorizePrivateTarget(target);
    // link is an atomic, no-replace publication on the shared private filesystem.
    // A concurrently created target (including a symlink) causes EEXIST.
    linkSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temporary);
  }
  syncPrivateDirectory(parent);
  verifyCopy(target, entry);
}

/** Read-only process checks. Never stop the old program on the user's behalf. */
export function findLegacyProcessBlocker(): string | null {
  const legacyLock = readLock(join(getAppPaths().legacyDataDir, "server.lock"));
  if (legacyLock && isProcessAlive(legacyLock.pid)) return `legacy kimi-code-switch-gui is running (pid ${legacyLock.pid}); close it before continuing`;
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 2000 });
    if (!result.error && result.status === 0) {
      for (const line of result.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match || Number(match[1]) === process.pid) continue;
        if (/^(kimi-code-switch-gui|Kimi Code Switch GUI)(?:$|[-.])/i.test(basename(match[2]))) {
          return `legacy desktop process is running (pid ${match[1]}); close it before continuing`;
        }
      }
    }
  }
  return null;
}

function collectEntries(root: string): MigrationEntry[] {
  if (!existsSync(root)) return [];
  const entries: MigrationEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      const stat = lstatSync(path);
      const top = rel.split(/[\\/]/)[0];
      if (["server.lock", "server.json", "tmp", "logs"].includes(top)) continue;
      // Managed native environments are intentionally retained at their original paths.
      if (top === ".env" || stat.isSymbolicLink()) {
        entries.push({ path: rel, action: "retain", sizeBytes: 0, sha256: null });
        continue;
      }
      if (stat.isDirectory()) { visit(path); continue; }
      if (!stat.isFile()) throw new Error(`unsupported legacy private entry: ${rel}`);
      const copy = ["app.db", "app.db-wal", "app.db-shm", "access-grants.json", "backup-encryption.key", "backup-encryption.key.previous", "history", "backups", "pending-save-transaction.json", "pending-restore-transaction.json"].includes(top);
      entries.push({ path: rel, action: copy ? "copy" : "archive", sizeBytes: stat.size, sha256: sha256Bytes(readFileSync(path)) });
    }
  };
  visit(root);
  return entries;
}

function emptyDatabase(path: string): boolean {
  if (!existsSync(path)) return true;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    return tables.every((row) => Number(database!.prepare(`SELECT COUNT(*) AS n FROM "${String(row.name).replaceAll('"', '""')}"`).get()?.n) === 0);
  } catch { return false; }
  finally { database?.close(); }
}

export function previewLegacyMigration(): LegacyMigrationPreview {
  const paths = getAppPaths();
  const base = { sourceDir: paths.legacyDataDir, targetDir: paths.dataDir, manifestHash: "", entries: [] as MigrationEntry[] };
  try {
    const journal = readJournal();
    if (journal?.state === "complete") return { ...base, status: "complete", manifestHash: journal.manifestHash, entries: journal.entries };
    const entries = collectEntries(paths.legacyDataDir);
    const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    const blocker = findLegacyProcessBlocker();
    if (blocker) return { ...base, entries, manifestHash, status: "blocked", blockedReason: blocker };
    if (!entries.length) return journal
      ? { ...base, entries, manifestHash, status: "blocked", blockedReason: "legacy data is missing during migration recovery; restore the original source before continuing" }
      : { ...base, entries, manifestHash, status: "absent" };
    if (!journal && !emptyDatabase(paths.databasePath)) return { ...base, entries, manifestHash, status: "blocked", blockedReason: "the new private database contains data; refusing to replace existing settings" };
    return { ...base, entries, manifestHash, status: "available" };
  } catch (error) {
    return { ...base, status: "blocked", blockedReason: error instanceof Error ? error.message : String(error) };
  }
}

function saveJournal(journal: MigrationJournal): void {
  authorizePrivateTarget(journalPath());
  authorizePrivateTarget(getAppPaths().migrationDir, "DirectoryTree");
  mkdirSync(getAppPaths().migrationDir, { recursive: true, mode: 0o700 });
  const previous = existsSync(journalPath()) ? sha256Bytes(readFileSync(journalPath())) : "";
  atomicWriteText(journalPath(), JSON.stringify(journal, null, 2), previous);
}

function verifyCopy(path: string, entry: MigrationEntry): void {
  if (!existsSync(path) || sha256Bytes(readFileSync(path)) !== entry.sha256) throw new Error(`migration verification failed: ${entry.path}`);
}

/** Explicit copy-only migration. A journal resumes interrupted commits without touching native files. */
export async function applyLegacyMigration(input: { manifestHash: string }): Promise<LegacyMigrationResult> {
  const paths = getAppPaths();
  const existingJournal = readJournal();
  if (existingJournal?.state === "complete" && existingJournal.result) return existingJournal.result;
  const preview = previewLegacyMigration();
  if (preview.status !== "available") throw new Error(preview.blockedReason ?? `migration is ${preview.status}`);
  if (!input.manifestHash || input.manifestHash !== preview.manifestHash) throw new Error("legacy data changed since preview; refresh the migration preview");
  if (existingJournal && existingJournal.manifestHash !== input.manifestHash) throw new Error("legacy data changed during migration recovery; refusing to overwrite staged data");
  closeUsageDb();
  const archiveDir = join(paths.dataDir, "archive", "legacy-v1");
  const journal: MigrationJournal = existingJournal ?? {
    version: 1, manifestHash: input.manifestHash, state: "copying",
    stageDir: join(paths.migrationDir, `legacy-stage-${randomUUID()}`), entries: preview.entries, committed: [],
  };
  saveJournal(journal);
  const copied = journal.entries.filter((entry) => entry.action !== "retain");
  for (const entry of copied) {
    const source = join(paths.legacyDataDir, entry.path);
    const stage = join(journal.stageDir, entry.action === "archive" ? "archive" : "active", entry.path);
    assertPrivateTarget(stage);
    if (!existsSync(stage)) {
      verifyCopy(source, entry);
      copyPrivateFile(source, stage, entry);
    }
    verifyCopy(stage, entry);
  }
  if (previewLegacyMigration().manifestHash !== input.manifestHash) throw new Error("legacy data changed while copying; source files were left untouched");
  const blocker = findLegacyProcessBlocker();
  if (blocker) throw new Error(blocker);
  const finalizing = journal.state === "finalizing";
  if (!finalizing) { journal.state = "committing"; saveJournal(journal); }
  // Keep a full original database archive for deferred feature data and a recovery reference.
  for (const entry of copied.filter((entry) => entry.path.startsWith("app.db"))) {
    const archived = join(archiveDir, entry.path);
    assertPrivateTarget(archived);
    if (!existsSync(archived)) {
      copyPrivateFile(join(journal.stageDir, "active", entry.path), archived, entry);
    }
    verifyCopy(archived, entry);
  }
  for (const entry of copied) {
    const target = join(entry.action === "archive" ? archiveDir : paths.dataDir, entry.path);
    assertPrivateTarget(target);
    if (journal.committed.includes(entry.path)) {
      if (!(finalizing && entry.path.startsWith("app.db"))) verifyCopy(target, entry);
      continue;
    }
    if (existsSync(target)) {
      if (entry.path === "app.db" && emptyDatabase(target)) {
        for (const path of [target, `${target}-wal`, `${target}-shm`]) authorizePrivateTarget(path);
        for (const path of [target, `${target}-wal`, `${target}-shm`]) rmSync(path, { force: true });
      } else if (sha256Bytes(readFileSync(target)) !== entry.sha256) {
        throw new Error(`migration target already has different data: ${entry.path}`);
      }
    }
    if (!existsSync(target)) {
      copyPrivateFile(join(journal.stageDir, entry.action === "archive" ? "archive" : "active", entry.path), target, entry);
    }
    verifyCopy(target, entry);
    journal.committed.push(entry.path);
    saveJournal(journal);
  }
  journal.state = "finalizing";
  saveJournal(journal);
  // Repoint only tool-owned snapshot locations. Native targets and environment roots stay literal.
  if (existsSync(paths.databasePath)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) authorizePrivateTarget(`${paths.databasePath}${suffix}`);
    const database = new DatabaseSync(paths.databasePath);
    try {
      const integrity = database.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok") throw new Error("migrated database failed integrity check");
      // The byte-for-byte archive above owns deferred feature data. The active
      // database contains only tool metadata, never a second native-config mirror.
      database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
      for (const object of database.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'").all()) {
        const name = String(object.name);
        if (object.type === "table" && ["panel_settings", "config_history"].includes(name)) continue;
        database.exec(`DROP ${String(object.type).toUpperCase()} IF EXISTS ${quote(name)}`);
      }
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='panel_settings'").get()) {
        for (const column of database.prepare("PRAGMA table_info(panel_settings)").all()) {
          const name = String(column.name);
          if (/^(webdav_|chatgpt_|insights_|official_account_|active_official_account_id$)/.test(name)) {
            database.exec(`UPDATE panel_settings SET ${quote(name)} = ${column.dflt_value ?? "NULL"}`);
          }
        }
      }
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_history'").get()) {
        const sourceHistory = join(paths.legacyDataDir, "history");
        const rows = database.prepare("SELECT id, snapshot_path FROM config_history").all();
        const update = database.prepare("UPDATE config_history SET snapshot_path=? WHERE id=?");
        for (const row of rows) {
          const path = String(row.snapshot_path ?? "");
          if (path.startsWith(`${sourceHistory}/`)) update.run(join(paths.historyDir, relative(sourceHistory, path)), row.id);
        }
      }
      database.exec("COMMIT");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no transaction was opened */ }
      throw error;
    } finally { database.close(); }
  }
  journal.state = "complete";
  journal.result = { status: "complete", migratedFiles: copied.length, retainedPaths: journal.entries.filter((e) => e.action === "retain").map((e) => join(paths.legacyDataDir, e.path)), archiveDir };
  saveJournal(journal);
  authorizePrivateTarget(journal.stageDir, "DirectoryTree");
  rmSync(journal.stageDir, { recursive: true, force: true });
  return journal.result;
}
