import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";

import type { BackupSummary, HistorySummary, Target } from "../../shared/webApi";
import type { NativeResource, ResourceDiagnostic, ResourceRestoreRequest, TrustedResourceContext } from "../../shared/resourceProtocol";
import type { createConfigurationService } from "../configuration";
import { atomicWriteText, authorizeMutation, exportPortableDirectoryAt, getDurableGrantsState, portableDirectoryHash, resolveFinalTarget } from "../native/fs";
import { getAppPaths } from "../native/paths";
import { isDbOpen, queryRows } from "../native/usage";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HOME_RESOURCES = ["config", "mcp", "tui", "agents", "skills-directory", "plugins-directory"] as const;
const PROJECT_RESOURCES = ["project-local", "mcp-project", "mcp-local"] as const;
const EARLY_SCOPE_EXCLUSION = "Not captured by this earlier v1 backup; the current native file will be preserved.";
type BackupResource = typeof HOME_RESOURCES[number] | typeof PROJECT_RESOURCES[number];
type Scope = "home" | "project" | "local";
interface ArchiveDocument { resource: BackupResource; scope: Scope; content: string | null; sha256: string }
interface Exclusion { resource: string; scope: Scope; reason: string }
interface Archive {
  format: "kimi-code-switch.backup";
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  targetId: string;
  /** Mapping metadata only: never used as a filesystem read/write location. */
  sourceHome?: string;
  resources: ArchiveDocument[];
  excluded: Exclusion[];
}
interface PortableBundle {
  exists: boolean;
  directories: string[];
  files: Array<{ relativePath: string; contentBase64: string; executable: boolean }>;
  sha256: string | null;
}
const hash = (content: string | null): string => content === null ? "" : createHash("sha256").update(content, "utf8").digest("hex");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const native = (resource: BackupResource): NativeResource => resource as NativeResource;
function contextFor(target: Target): TrustedResourceContext {
  if (!target.workingDirectory) return { home: target.homePath };
  const original = fs.realpathSync(target.workingDirectory);
  let projectRoot = original;
  while (!fs.existsSync(join(projectRoot, ".git"))) {
    const parent = dirname(projectRoot);
    if (parent === projectRoot) { projectRoot = original; break; }
    projectRoot = parent;
  }
  return { home: target.homePath, projectRoot, workingDirectory: target.workingDirectory };
}
const scopeFor = (resource: BackupResource): Scope => resource === "mcp-local" ? "local" : resource === "project-local" || resource === "mcp-project" ? "project" : "home";
const knownResource = (value: unknown): value is BackupResource => typeof value === "string" && [...HOME_RESOURCES, ...PROJECT_RESOURCES].includes(value as BackupResource);
const directoryResource = (resource: BackupResource): boolean => resource.endsWith("-directory");
function fail(message: string): never { throw new Error(message); }
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("Backup contains unsupported fields.");
}
function boundedString(value: unknown, limit = 1024): value is string { return typeof value === "string" && value.length <= limit && !value.includes("\0"); }
function relativePortablePath(value: unknown): asserts value is string {
  if (!boundedString(value, 4096) || !value || value.includes("\\") || value.includes(":") || value.split("/").length > 32
    || value.split("/").some((part) => !part || part === "." || part === "..")) fail("Backup contains an invalid portable path.");
}
function excludedPortablePath(path: string): boolean {
  return path.split("/").some((part) => /^(?:credentials?(?:\.[^.]+)?|sessions?|logs?)$/i.test(part));
}
function normalizedReferencePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!boundedString(value, 4096) || (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized))
    || normalized.split("/").some((part) => part === "." || part === "..")) fail("Invalid plugin source or root path in backup metadata.");
  return normalized;
}
function installedPluginDocument(bundle: PortableBundle): { file: PortableBundle["files"][number]; parsed: Record<string, unknown> } | null {
  const file = bundle.files.find((entry) => entry.relativePath === "installed.json");
  if (!file) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")); } catch { return fail("Invalid plugin installed.json in backup."); }
  if (!record(parsed) || !Array.isArray(parsed.plugins)) fail("Invalid plugin installed.json schema in backup.");
  for (const plugin of parsed.plugins) {
    if (!record(plugin) || typeof plugin.root !== "string") fail("Invalid installed plugin root in backup.");
    normalizedReferencePath(plugin.root);
  }
  return { file, parsed };
}
function remapPluginRoots(content: string, sourceHome: string | undefined, targetHome: string): { content: string; diagnostics: ResourceDiagnostic[] } {
  const bundle = parsePortable(content, true);
  const installed = installedPluginDocument(bundle);
  if (!installed) return { content, diagnostics: [] };
  const diagnostics: ResourceDiagnostic[] = [];
  const sourcePrefix = sourceHome === undefined ? undefined : `${normalizedReferencePath(sourceHome)}/plugins`;
  const targetPrefix = `${normalizedReferencePath(resolveFinalTarget(targetHome))}/plugins`;
  let remapped = false;
  let external = false;
  for (const raw of installed.parsed.plugins as Record<string, unknown>[]) {
    const originalRoot = normalizedReferencePath(raw.root as string);
    if (sourcePrefix !== undefined && (originalRoot === sourcePrefix || originalRoot.startsWith(`${sourcePrefix}/`))) {
      const suffix = originalRoot.slice(sourcePrefix.length);
      const nextRoot = `${targetPrefix}${suffix}`;
      if (originalRoot !== nextRoot) { raw.root = nextRoot; remapped = true; }
    } else external = true;
  }
  if (remapped) {
    installed.file.contentBase64 = Buffer.from(`${JSON.stringify(installed.parsed, null, 2)}\n`, "utf8").toString("base64");
    bundle.sha256 = portableDirectoryHash(bundle);
    diagnostics.push({ code: "plugin-roots-remapped", severity: "info", message: "Managed plugin roots are mapped from the backup home into the selected target; source and origin metadata are preserved." });
  }
  if (external) diagnostics.push({ code: sourceHome === undefined ? "plugin-source-home-unavailable" : "external-plugin-roots-preserved", severity: "warning", message: "Plugin roots outside the recorded source home are unchanged and are not copied. Verify that those external plugins remain available on this machine." });
  return { content: remapped ? JSON.stringify(bundle) : content, diagnostics };
}
function parsePortable(content: string, allowExcluded = false): PortableBundle {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return fail("Invalid portable directory backup."); }
  if (!record(value)) fail("Invalid portable directory backup.");
  exactKeys(value, ["exists", "directories", "files", "sha256"]);
  if (typeof value.exists !== "boolean" || !Array.isArray(value.directories) || !Array.isArray(value.files)
    || value.directories.length > 4000 || value.files.length > 4000
    || (value.sha256 !== null && value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(value.sha256)))) fail("Invalid portable directory schema.");
  const seen = new Set<string>();
  const directories: string[] = [];
  const files: PortableBundle["files"] = [];
  let bytes = 0;
  for (const path of value.directories) {
    relativePortablePath(path);
    if (seen.has(path) || (!allowExcluded && excludedPortablePath(path))) fail("Backup directory path is duplicated or excluded.");
    seen.add(path); directories.push(path);
  }
  for (const entry of value.files) {
    if (!record(entry)) fail("Invalid portable file.");
    exactKeys(entry, ["relativePath", "contentBase64", "executable"]);
    relativePortablePath(entry.relativePath);
    if (seen.has(entry.relativePath) || (!allowExcluded && excludedPortablePath(entry.relativePath))
      || typeof entry.contentBase64 !== "string" || typeof entry.executable !== "boolean"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)) fail("Invalid portable file schema.");
    const decoded = Buffer.from(entry.contentBase64, "base64");
    if (decoded.toString("base64") !== entry.contentBase64) fail("Noncanonical portable file content.");
    bytes += decoded.length;
    if (bytes > MAX_RESOURCE_BYTES) fail("Backup exceeds the resource size limit.");
    seen.add(entry.relativePath);
    files.push({ relativePath: entry.relativePath, contentBase64: entry.contentBase64, executable: entry.executable });
  }
  const filePaths = new Set(files.map((file) => file.relativePath));
  for (const path of seen) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      if (filePaths.has(parent) || !directories.includes(parent)) fail("Portable entries require distinct directory parents.");
    }
  }
  if (!value.exists && seen.size) fail("An absent directory cannot contain entries.");
  const bundle: PortableBundle = { exists: value.exists, directories, files, sha256: null };
  bundle.sha256 = portableDirectoryHash(bundle);
  if (value.sha256 && value.sha256 !== bundle.sha256) fail("Portable directory checksum mismatch.");
  return bundle;
}
function preserveExcludedEntries(desiredContent: string | null, currentContent: string | null): string {
  const empty = (): PortableBundle => ({ exists: false, directories: [], files: [], sha256: null });
  const desired = desiredContent === null ? empty() : parsePortable(desiredContent, true);
  desired.directories = desired.directories.filter((path) => !excludedPortablePath(path));
  desired.files = desired.files.filter((file) => !excludedPortablePath(file.relativePath));
  const current = currentContent === null ? empty() : parsePortable(currentContent, true);
  const keptFiles = current.files.filter((file) => excludedPortablePath(file.relativePath));
  const keptDirectories = current.directories.filter(excludedPortablePath);
  const directories = new Set(desired.directories);
  for (const path of [...keptDirectories, ...keptFiles.map((file) => file.relativePath)]) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
  }
  for (const path of keptDirectories) directories.add(path);
  desired.directories = [...directories].sort();
  desired.files.push(...keptFiles);
  desired.files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  desired.exists ||= Boolean(keptDirectories.length || keptFiles.length);
  desired.sha256 = null;
  return JSON.stringify(parsePortable(JSON.stringify(desired), true));
}
function validateArchive(content: string): Archive {
  if (Buffer.byteLength(content, "utf8") > MAX_ARCHIVE_BYTES) fail("Backup exceeds the 32 MiB archive limit.");
  let value: unknown;
  try { value = JSON.parse(content); } catch { return fail("Invalid backup JSON."); }
  if (!record(value)) fail("Invalid backup schema.");
  exactKeys(value, ["format", "version", "id", "name", "createdAt", "targetId", "sourceHome", "resources", "excluded"]);
  if (value.format !== "kimi-code-switch.backup" || value.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id)
    || !boundedString(value.name, 200) || !/^backup-[a-zA-Z0-9._-]+$/.test(value.name) || !boundedString(value.targetId, 200) || !boundedString(value.createdAt, 40)
    || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.resources) || !Array.isArray(value.excluded)
    || value.resources.length < HOME_RESOURCES.length || value.resources.length > 9 || value.excluded.length > 16006) fail("Unsupported backup schema or version.");
  if (value.sourceHome !== undefined) {
    if (typeof value.sourceHome !== "string") fail("Invalid backup source home metadata.");
    normalizedReferencePath(value.sourceHome);
  }
  const seen = new Set<BackupResource>();
  let bytes = 0;
  const resources: ArchiveDocument[] = value.resources.map((item) => {
    if (!record(item)) return fail("Invalid backup resource.");
    exactKeys(item, ["resource", "scope", "content", "sha256"]);
    if (!knownResource(item.resource) || seen.has(item.resource) || item.scope !== scopeFor(item.resource)
      || (item.content !== null && typeof item.content !== "string") || item.sha256 !== hash(item.content as string | null)) fail("Backup resource schema or checksum mismatch.");
    seen.add(item.resource);
    if (directoryResource(item.resource) && item.content !== null) {
      const portable = parsePortable(item.content as string);
      if (item.resource === "plugins-directory") installedPluginDocument(portable);
      bytes += portable.files.reduce((total, file) => total + Buffer.byteLength(file.contentBase64, "base64"), 0);
    } else bytes += Buffer.byteLength((item.content as string | null) ?? "", "utf8");
    if (bytes > MAX_RESOURCE_BYTES) fail("Backup exceeds the 24 MiB resource limit.");
    return { resource: item.resource, scope: scopeFor(item.resource), content: item.content as string | null, sha256: item.sha256 as string };
  });
  if (HOME_RESOURCES.some((resource) => !seen.has(resource))) fail("Backup is missing required home resources.");
  const excluded: Exclusion[] = value.excluded.map((item) => {
    if (!record(item)) return fail("Invalid backup exclusion manifest.");
    exactKeys(item, ["resource", "scope", "reason"]);
    if (!boundedString(item.resource, 4200) || !boundedString(item.reason, 200) || (item.scope !== "home" && item.scope !== "project" && item.scope !== "local")) fail("Invalid backup exclusion manifest.");
    return { resource: item.resource, scope: item.scope, reason: item.reason };
  });
  for (const resource of PROJECT_RESOURCES) {
    if (seen.has(resource) || excluded.some((item) => item.resource === resource && item.scope === scopeFor(resource))) continue;
    // These scopes were added after the initial v1 format. Missing resources
    // mean "not captured", never "delete the target file".
    if (resource === "mcp-project" || resource === "mcp-local") excluded.push({ resource, scope: scopeFor(resource), reason: EARLY_SCOPE_EXCLUSION });
    else fail(`Backup must state why ${resource} was excluded.`);
  }
  return { format: "kimi-code-switch.backup", version: 1, id: value.id, name: value.name, createdAt: value.createdAt, targetId: value.targetId,
    ...(typeof value.sourceHome === "string" ? { sourceHome: value.sourceHome } : {}), resources, excluded };
}
function summary(archive: Archive): BackupSummary {
  const compatibility = archive.excluded.some((item) => item.reason === EARLY_SCOPE_EXCLUSION);
  return { id: archive.id, name: archive.name, createdAt: archive.createdAt, targetId: archive.targetId, resources: archive.resources.map((item) => `${item.scope}:${item.resource}`), restorable: true,
    ...(compatibility ? { diagnostic: "Earlier v1 backup: project and local MCP files not captured by this backup will be preserved." } : {}) };
}
function readPrivateBytes(path: string, limit = MAX_ARCHIVE_BYTES): Buffer | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) fail("Invalid or oversized private backup file.");
    return fs.readFileSync(descriptor);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function readPrivate(path: string, limit = MAX_ARCHIVE_BYTES): string | null {
  return readPrivateBytes(path, limit)?.toString("utf8") ?? null;
}
function entries(path: string): string[] {
  try { return fs.readdirSync(path).filter((name) => UUID.test(name.replace(/\.json$/, "")) && name.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function writeArchive(path: string, archive: Archive): void {
  const directory = authorizeMutation(getDurableGrantsState(), dirname(path), "DirectoryTree");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const target = authorizeMutation(getDurableGrantsState(), path, "SingleFile");
  atomicWriteText(target, JSON.stringify(archive), "");
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

export function createWebBackupService(configuration: ReturnType<typeof createConfigurationService>) {
  const paths = getAppPaths();
  const backupRoot = join(paths.dataDir, "backups");
  async function snapshots(target: Target) {
    const resources: BackupResource[] = [...HOME_RESOURCES, ...(target.workingDirectory ? PROJECT_RESOURCES : [])];
    return Promise.all(resources.map((resource) => configuration.read(contextFor(target), native(resource))));
  }
  interface BackupEntry { name: string; path: string; kind: "file" | "directory" | "unsafe"; summary: BackupSummary; archive?: Archive }
  function backupNames(): string[] {
    try { return fs.readdirSync(backupRoot).filter((name) => !name.startsWith(".")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  function inspectEntry(target: Target, name: string): BackupEntry | null {
    const path = join(backupRoot, name);
    let stats: fs.Stats;
    try { stats = fs.lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const kind = stats.isSymbolicLink() ? "unsafe" : stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "unsafe";
    const id = `readonly-${hash(`${kind}:${name}`)}`;
    const base: BackupSummary = { id, name, createdAt: stats.mtime.toISOString(), targetId: target.id, resources: [], restorable: false };
    if (kind === "directory") return { name, path, kind, summary: { ...base, diagnostic: "Legacy directory backup: automatic restore is unavailable. Download preserves its files in a portable archive for inspection." } };
    if (kind === "unsafe") return { name, path, kind, summary: { ...base, diagnostic: "This entry is a symbolic link or unsupported file type; it will not be followed, exported or restored." } };
    let content: string | null;
    try { content = readPrivate(path); }
    catch { return { name, path, kind, summary: { ...base, diagnostic: "This backup cannot be read safely or exceeds the 32 MiB limit. The original entry remains unchanged." } }; }
    if (content === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { /* Retain malformed entries as downloadable evidence. */ }
    if (record(parsed) && boundedString(parsed.targetId, 200) && parsed.targetId !== target.id) return null;
    try {
      const archive = validateArchive(content);
      if (name !== `${archive.id}.json`) fail("Backup file identity mismatch.");
      return { name, path, kind, archive, summary: summary(archive) };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : "Unsupported backup format.";
      return { name, path, kind, summary: { ...base, diagnostic: `${diagnostic} Automatic restore is unavailable; download exports the original content.` } };
    }
  }
  function findEntry(target: Target, id: string): BackupEntry {
    if (!UUID.test(id) && !/^readonly-[a-f0-9]{64}$/.test(id)) fail("Invalid backup ID.");
    // Only server-enumerated names become paths. Client IDs are opaque selectors.
    for (const name of UUID.test(id) ? backupNames().filter((entry) => entry === `${id}.json`) : backupNames()) {
      const entry = inspectEntry(target, name);
      if (entry?.summary.id === id) return entry;
    }
    return fail("Backup not found or does not belong to this target.");
  }
  function load(target: Target, id: string): Archive {
    const entry = findEntry(target, id);
    if (!entry.archive) fail(entry.summary.diagnostic ?? "This backup cannot be restored automatically.");
    return entry.archive;
  }
  async function listBackups(target: Target): Promise<BackupSummary[]> {
    const archives: BackupSummary[] = [];
    for (const name of backupNames()) {
      try {
        const entry = inspectEntry(target, name);
        if (entry) archives.push(entry.summary);
      } catch {
        archives.push({ id: `readonly-${hash(`unreadable:${name}`)}`, name, createdAt: "", targetId: target.id, resources: [], restorable: false,
          diagnostic: "The backup entry could not be inspected. Other backups remain available and this entry was not changed." });
      }
    }
    return archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function createBackup(target: Target): Promise<BackupSummary> {
    const current = await snapshots(target);
    const excluded: Exclusion[] = ["credentials", "sessions", "logs"].map((resource) => ({ resource, scope: "home", reason: "Runtime and authentication data are excluded." }));
    if (!target.workingDirectory) {
      for (const resource of PROJECT_RESOURCES) excluded.push({ resource, scope: scopeFor(resource), reason: "No working directory is selected." });
    }
    const documents: ArchiveDocument[] = current.map((snapshot) => {
      const resource = snapshot.resource as BackupResource;
      let content = snapshot.content;
      if (directoryResource(resource) && content !== null) {
        const bundle = parsePortable(content, true);
        for (const path of [...bundle.directories, ...bundle.files.map((file) => file.relativePath)]) {
          if (excludedPortablePath(path)) excluded.push({ resource: `${resource}/${path}`, scope: "home", reason: "Runtime and authentication data are excluded." });
        }
        bundle.directories = bundle.directories.filter((path) => !excludedPortablePath(path));
        bundle.files = bundle.files.filter((file) => !excludedPortablePath(file.relativePath));
        bundle.sha256 = portableDirectoryHash(bundle);
        content = JSON.stringify(bundle);
      }
      return { resource, scope: scopeFor(resource), content, sha256: hash(content) };
    });
    const verified = await snapshots(target);
    if (current.some((snapshot, index) => snapshot.revision !== verified[index].revision || snapshot.path !== verified[index].path)) fail("Native resources changed during backup. Retry with the current files.");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const archive: Archive = { format: "kimi-code-switch.backup", version: 1, id, name: `backup-${createdAt.replace(/[:.]/g, "-")}`, createdAt, targetId: target.id, sourceHome: resolveFinalTarget(target.homePath), resources: documents, excluded };
    validateArchive(JSON.stringify(archive));
    writeArchive(join(backupRoot, `${id}.json`), archive);
    return summary(archive);
  }
  async function exportBackup(target: Target, id: string): Promise<{ fileName: string; content: string }> {
    const entry = findEntry(target, id);
    const fileName = entry.name.replace(/[\u0000-\u001f\\/:"*?<>|]/g, "_").slice(0, 200) || "backup";
    if (entry.kind === "unsafe") fail(entry.summary.diagnostic!);
    if (entry.kind === "directory") {
      const bundle = exportPortableDirectoryAt(entry.path);
      return { fileName: `${fileName}.portable.json`, content: JSON.stringify({ format: "kimi-code-switch.legacy-directory-export", version: 1, name: entry.name, bundle }, null, 2) };
    }
    const bytes = readPrivateBytes(entry.path);
    if (bytes === null) fail("Backup disappeared before export. Refresh the list.");
    const content = bytes.toString("utf8");
    if (Buffer.from(content, "utf8").equals(bytes)) return { fileName: entry.archive ? `${entry.archive.name}.json` : fileName, content };
    return { fileName: `${fileName}.raw.json`, content: JSON.stringify({ format: "kimi-code-switch.raw-file-export", version: 1, name: entry.name, encoding: "base64", content: bytes.toString("base64") }) };
  }
  async function importBackup(target: Target, content: string): Promise<BackupSummary> {
    const original = validateArchive(content);
    const archive = { ...original, id: randomUUID(), targetId: target.id };
    writeArchive(join(backupRoot, `${archive.id}.json`), archive);
    return summary(archive);
  }
  async function restoreDocuments(target: Target, documents: Array<{ resource: BackupResource; content: string | null }>, preserveExcluded = false, sourceHome?: string) {
    if (documents.some((document) => scopeFor(document.resource) !== "home") && !target.workingDirectory) fail("Select a working directory before restoring project or local configuration.");
    const requests: ResourceRestoreRequest[] = [];
    const diagnostics: ResourceDiagnostic[] = [];
    for (const document of documents) {
      const current = await configuration.read(contextFor(target), native(document.resource));
      let content = preserveExcluded && directoryResource(document.resource)
        ? preserveExcludedEntries(document.content, current.content)
        : document.content;
      if (document.resource === "plugins-directory" && content !== null) {
        const remapped = remapPluginRoots(content, sourceHome, target.homePath);
        content = remapped.content;
        diagnostics.push(...remapped.diagnostics);
      }
      requests.push({ resource: native(document.resource), content, expectedRevision: current.revision });
    }
    const plan = await configuration.planRestore(contextFor(target), requests);
    return { ...plan, diagnostics: [...plan.diagnostics, ...diagnostics] };
  }
  async function planRestore(target: Target, backupId: string) {
    const archive = load(target, backupId);
    const plan = await restoreDocuments(target, archive.resources, true, archive.sourceHome);
    if (archive.excluded.some((item) => item.reason === EARLY_SCOPE_EXCLUSION)) plan.diagnostics.push({ code: "earlier-backup-scopes-preserved", severity: "warning", message: "This earlier backup did not capture project/local MCP configuration; the existing files are excluded from restoration and remain unchanged." });
    return plan;
  }

  async function targetPaths(target: Target): Promise<Map<string, BackupResource>> {
    return new Map((await snapshots(target)).map((snapshot) => [snapshot.path, snapshot.resource as BackupResource]));
  }
  function legacyRows(): Record<string, unknown>[] {
    if (!isDbOpen() || !queryRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_history'").length) return [];
    return queryRows("SELECT id, snapshot_at, file_id, sha256, snapshot_path, target_path FROM config_history ORDER BY snapshot_at DESC LIMIT 1000");
  }
  function legacyResource(row: Record<string, unknown>): BackupResource | null {
    return row.file_id === "skills" ? "skills-directory" : knownResource(row.file_id) ? row.file_id : null;
  }
  function matchesLegacy(row: Record<string, unknown>, targets: Map<string, BackupResource>): boolean {
    return typeof row.target_path === "string" && isAbsolute(row.target_path) && targets.get(resolveFinalTarget(row.target_path)) === legacyResource(row);
  }
  async function listHistory(target: Target): Promise<HistorySummary[]> {
    const targets = await targetPaths(target);
    const history: HistorySummary[] = [];
    for (const name of entries(join(paths.dataDir, "operations"))) {
      const operation = configuration.getOperation(name.slice(0, -5));
      if (!operation) continue;
      const resources = operation.resources ?? [{ resource: operation.resource, path: operation.path }];
      if (!resources.length || resources.some((item) => targets.get(item.path) !== item.resource)) continue;
      history.push({ id: operation.id, createdAt: operation.createdAt, resource: resources.map((item) => item.resource).join(", "), path: operation.path, status: operation.status });
    }
    for (const row of legacyRows()) {
      if (!matchesLegacy(row, targets)) continue;
      history.push({ id: `legacy-${row.id}`, createdAt: String(row.snapshot_at), resource: legacyResource(row)!, path: String(row.target_path), status: "legacy-snapshot" });
    }
    return history.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function planHistoryRestore(target: Target, id: string) {
    const targets = await targetPaths(target);
    if (/^legacy-[1-9]\d*$/.test(id)) {
      const row = legacyRows().find((entry) => String(entry.id) === id.slice(7));
      if (!row || !matchesLegacy(row, targets)) fail("History does not belong to this target.");
      const snapshotPath = resolveFinalTarget(String(row.snapshot_path));
      const relativePath = relative(resolveFinalTarget(paths.historyDir), snapshotPath);
      if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) fail("Legacy snapshot is outside the history directory.");
      const compressed = fs.readFileSync(snapshotPath);
      if (compressed.length > MAX_ARCHIVE_BYTES) fail("Legacy snapshot exceeds the size limit.");
      const content = gunzipSync(compressed, { maxOutputLength: MAX_RESOURCE_BYTES }).toString("utf8");
      if (hash(content) !== row.sha256) fail("Legacy snapshot checksum mismatch.");
      const resource = legacyResource(row)!;
      if (directoryResource(resource)) parsePortable(content, true);
      return restoreDocuments(target, [{ resource, content }], true, resolveFinalTarget(target.homePath));
    }
    if (!UUID.test(id)) fail("Invalid history ID.");
    const operation = configuration.getOperation(id);
    if (!operation) fail("History operation not found.");
    const raw = readPrivate(join(paths.dataDir, "configuration-backups", `${id}.json`));
    if (raw === null) fail("This operation has no restorable before-snapshot.");
    let backup: unknown;
    try { backup = JSON.parse(raw); } catch { return fail("Invalid history backup."); }
    if (!record(backup) || backup.version !== 1 || backup.revision !== operation.beforeRevision || !Array.isArray(backup.documents)
      || !backup.documents.length || backup.documents.length > 9) fail("Invalid history backup schema.");
    const expected = operation.resources ?? [{ resource: operation.resource, path: operation.path, beforeRevision: operation.beforeRevision }];
    if (backup.documents.length !== expected.length) fail("History resource set mismatch.");
    const seen = new Set<string>();
    const documents = backup.documents.map((item) => {
      if (!record(item) || !knownResource(item.resource) || typeof item.path !== "string" || targets.get(item.path) !== item.resource
        || (item.content !== null && typeof item.content !== "string") || seen.has(item.path)) return fail("History does not belong to this target.");
      const recorded = expected.find((entry) => entry.path === item.path && entry.resource === item.resource);
      if (!recorded || recorded.beforeRevision !== hash(item.content as string | null)) fail("History revision mismatch.");
      if (directoryResource(item.resource) && item.content !== null) parsePortable(item.content as string, true);
      seen.add(item.path);
      return { resource: item.resource, content: item.content as string | null };
    });
    return restoreDocuments(target, documents, true, resolveFinalTarget(target.homePath));
  }
  return { listBackups, createBackup, exportBackup, importBackup, planRestore, listHistory, planHistoryRestore };
}
