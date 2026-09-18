import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import parseToml from "@iarna/toml/parse-string.js";
import stringifyToml from "@iarna/toml/stringify.js";

import { applyDocumentPatch } from "../../shared/documentPatch";
import { redactDocumentText } from "../../shared/configSafety";
import type {
  ChangePlan, ConfigurationOperation, ConfigurationRecoveryState, NativeResource,
  ResourceChangeRequest, ResourceDiagnostic, ResourceRestoreRequest, ResourceSnapshot, TrustedResourceContext, RecoveryCase, ResolveRecoveryRequest,
} from "../../shared/resourceProtocol";
import { atomicWriteText, authorizeMutation, fsCommands, getDurableGrantsState, resolveFinalTarget } from "../native/fs";
import { expandHome } from "../native/paths";
import { withTargetWriteLock } from "../native/targetLock";
import { isDirectoryResource, parsePortableContent, portableContent, portablePreview, readPortableContent } from "./portable";
import { validateNativeCandidate } from "./candidateValidation";

export type { ChangePlan, ConfigurationOperation, ConfigurationRecoveryState, NativeResource, ResourceChangeRequest, ResourceSnapshot, TrustedResourceContext } from "../../shared/resourceProtocol";

export interface OfficialValidationResult {
  status: "passed" | "unavailable" | "failed";
  diagnostics: ResourceDiagnostic[];
}
export interface ConfigurationServiceOptions {
  dataDir: string;
  officialValidator?: (input: { context: TrustedResourceContext; resource: NativeResource; content: string }) => Promise<OfficialValidationResult>;
  /** Version policy may require an official validation before enabling writes. */
  requireOfficialValidation?: boolean;
  legacyJournalPaths?: string[];
  fault?: (point: "before-backup" | "after-backup" | "after-journal" | "before-write" | "after-write" | "before-complete") => void | Promise<void>;
}
interface PlannedDocument { resource: NativeResource; path: string; before: string | null; after: string | null; }
interface StoredPlan { public: ChangePlan; context: TrustedResourceContext; documents: PlannedDocument[]; expiresAt: number; bytes: number; }
interface Journal {
  version: 1;
  operation: ConfigurationOperation;
  documents: PlannedDocument[];
  backupPath: string;
}
const resources = new Set<NativeResource>(["config", "mcp", "mcp-project", "mcp-local", "tui", "agents", "project-local", "skills-directory", "plugins-directory"]);
const isMcpResource = (resource: NativeResource): boolean => resource === "mcp" || resource === "mcp-project" || resource === "mcp-local";
const queues = new Map<string, Promise<unknown>>();
const activeJournals = new Set<string>();
const terminalStatuses = new Set(["succeeded", "failed", "conflict"]);
const operationStatuses = new Set(["queued", "committing", "succeeded", "failed", "conflict", "recovery-required"]);

export class ConfigurationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ConfigurationError"; }
}
const diagnostic = (code: string, message: string, severity: ResourceDiagnostic["severity"] = "error"): ResourceDiagnostic => ({ code, message, severity });
const revision = (content: string | null): string => content === null ? "" : createHash("sha256").update(content).digest("hex");
const now = (): string => new Date().toISOString();
function readText(path: string): string | null {
  try { return fs.readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function readResourceContent(path: string, resource: NativeResource): string | null {
  return isDirectoryResource(resource) ? readPortableContent(path) : readText(path);
}
function authorized(path: string, directory = false): string {
  return authorizeMutation(getDurableGrantsState(), path, directory ? "DirectoryTree" : "SingleFile");
}
function ensurePrivateDirectory(path: string): void {
  const target = authorized(path, true);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(target, 0o700);
}
function privateWrite(path: string, value: unknown, expected?: string): void {
  ensurePrivateDirectory(dirname(path));
  const target = authorized(path);
  atomicWriteText(target, JSON.stringify(value), expected);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}
function removePrivateFile(path: string): void {
  const target = authorized(path);
  try { fs.unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function queued<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  queues.set(path, current);
  void current.finally(() => { if (queues.get(path) === current) queues.delete(path); }).catch(() => undefined);
  return current;
}
function queuedResources<T>(paths: string[], work: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  const acquire = (index: number): Promise<T> => index === ordered.length ? work() : queued(ordered[index], () => withTargetWriteLock(ordered[index], () => acquire(index + 1)));
  return acquire(0);
}
function documentsRevision(documents: PlannedDocument[], after = false): string {
  if (documents.length === 1) return revision(after ? documents[0].after : documents[0].before);
  return revision(JSON.stringify(documents.map((document) => [document.path, revision(after ? document.after : document.before)]).sort((a, b) => a[0].localeCompare(b[0]))));
}
function resourcePath(context: TrustedResourceContext, resource: NativeResource): string {
  if (!resources.has(resource)) throw new ConfigurationError("unknown-resource", "Unknown native resource.");
  const base = resource === "project-local" || resource === "mcp-project" ? context.projectRoot : resource === "mcp-local" ? context.workingDirectory : context.home;
  if (!base) throw new ConfigurationError("missing-project", "Select a project before editing its local configuration.");
  const expanded = expandHome(base);
  if (!isAbsolute(expanded) || expanded.split(/[\\/]/).includes("..")) throw new ConfigurationError("invalid-context", "The server resource context must contain an absolute directory.");
  const name = { config: "config.toml", mcp: "mcp.json", "mcp-project": ".mcp.json", "mcp-local": ".kimi-code/mcp.json", tui: "tui.toml", agents: "AGENTS.md", "project-local": ".kimi-code/local.toml", "skills-directory": "skills", "plugins-directory": "plugins" }[resource];
  return resolveFinalTarget(join(expanded, name));
}
function parseResource(resource: NativeResource, content: string | null): unknown {
  if (isDirectoryResource(resource)) return parsePortableContent(content);
  if (resource === "agents") return undefined;
  if (!content?.trim()) return {};
  if (isMcpResource(resource)) {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ConfigurationError("invalid-document", "An MCP file must contain a JSON object.");
    return data;
  }
  return parseToml(content);
}
/** Conservative previews intentionally hide whole sensitive lines and credential URL parts. */
export function redactResourcePreview(content: string): string {
  // Parse only for display, never for the persisted patch. This also masks
  // multiline values and nested env/headers without leaking continuation lines.
  const secretKey = /api[_-]?key|token|authorization|password|secret|credential|private[_-]?key|^env$|^headers$/i;
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redact(item)]));
  };
  let preview = content;
  try { preview = JSON.stringify(redact(JSON.parse(content)), null, 2); }
  catch { try { preview = stringifyToml(redact(parseToml(content)) as Record<string, unknown>); } catch { /* AGENTS.md uses conservative text redaction below. */ } }
  return redactDocumentText(preview).text.replace(/^.*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|bearer|private[_-]?key).*$/gim, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}
function validOperation(value: unknown): value is ConfigurationOperation {
  if (!value || typeof value !== "object") return false;
  const op = value as ConfigurationOperation;
  return typeof op.id === "string" && /^[a-f0-9-]{36}$/.test(op.id) && op.planId === op.id && resources.has(op.resource)
    && typeof op.path === "string" && isAbsolute(op.path) && typeof op.beforeRevision === "string"
    && typeof op.createdAt === "string" && typeof op.updatedAt === "string" && Array.isArray(op.diagnostics) && operationStatuses.has(op.status);
}
function validJournal(value: unknown): value is Journal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Journal;
  return journal.version === 1 && validOperation(journal.operation) && Array.isArray(journal.documents) && journal.documents.length > 0
    && new Set(journal.documents.map((document) => document?.path)).size === journal.documents.length
    && journal.documents.every((document) => document && resources.has(document.resource) && typeof document.path === "string" && isAbsolute(document.path)
      && (document.before === null || typeof document.before === "string") && (document.after === null || typeof document.after === "string"))
    && typeof journal.backupPath === "string" && journal.operation.beforeRevision === documentsRevision(journal.documents);
}
function applyPlannedDocument(document: PlannedDocument, rollback = false): void {
  const target = authorized(document.path, isDirectoryResource(document.resource));
  if (target !== document.path) throw new ConfigurationError("conflict", "The resource target changed since it was planned.");
  const content = rollback ? document.before : document.after;
  if (isDirectoryResource(document.resource)) {
    const original = parsePortableContent(rollback ? document.after : document.before);
    fsCommands.replace_portable_directory({ path: target, bundle: parsePortableContent(content), expectedSha256: original.sha256 ?? "" });
    return;
  }
  const expected = revision(rollback ? document.after : document.before);
  if (content === null) {
    if (expected !== "") fsCommands.remove_file_cas({ path: target, expectedSha256: expected });
    else if (readText(target) !== null) throw new ConfigurationError("conflict", "The resource was created externally.");
  } else {
    // A grant for project/.mcp.json authorizes that file, not its entire project.
    // Existing parents need no directory mutation or broader authorization.
    if (!fs.existsSync(dirname(target))) fs.mkdirSync(authorized(dirname(target), true), { recursive: true });
    atomicWriteText(target, content, expected);
  }
}

export function createConfigurationService(options: ConfigurationServiceOptions) {
  const root = resolve(expandHome(options.dataDir));
  const operationsDir = join(root, "operations");
  const journalsDir = join(root, "configuration-journals");
  const backupsDir = join(root, "configuration-backups");
  const plans = new Map<string, StoredPlan>();
  const exportedRecoveryJournals = new Map<string, string>();
  let recovery: ConfigurationRecoveryState = { blocked: false, pendingOperationIds: [], diagnostics: [] };
  let initialized: Promise<void> | undefined;
  let recoveryPromise: Promise<ConfigurationRecoveryState> | undefined;
  function prunePlans(): void { for (const [id, plan] of plans) if (plan.expiresAt <= Date.now()) plans.delete(id); }
  const operationPath = (id: string): string => join(operationsDir, `${id}.json`);
  const journalPath = (id: string): string => join(journalsDir, `${id}.json`);
  function persistOperation(operation: ConfigurationOperation): void { privateWrite(operationPath(operation.id), operation); }
  function getOperation(id: string): ConfigurationOperation | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const content = readText(operationPath(id));
    if (content === null) return null;
    try { const value: unknown = JSON.parse(content); return validOperation(value) ? value : null; }
    catch { return null; }
  }
  function inspectRecoveryCases(): Array<{ public: RecoveryCase; path: string; content: string; journal?: Journal }> {
    const cases: Array<{ public: RecoveryCase; path: string; content: string; journal?: Journal }> = [];
    const legacy = options.legacyJournalPaths ?? [join(root, "pending-save-transaction.json"), join(root, "pending-restore-transaction.json")];
    let entries: string[] = [];
    try { entries = fs.readdirSync(journalsDir).map((name) => join(journalsDir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const path of [...legacy, ...entries]) {
      if (activeJournals.has(path)) continue;
      const content = readText(path);
      if (content === null) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { /* Preserve malformed bytes for explicit export. */ }
      const journal = !legacy.includes(path) && validJournal(parsed) ? parsed : undefined;
      const kind: RecoveryCase["kind"] = journal ? "transaction" : legacy.includes(path) ? "legacy" : "malformed";
      const id = journal?.operation.id ?? `journal-${revision(path).slice(0, 32)}`;
      cases.push({ path, content, journal, public: { id, kind, journalRevision: revision(content), requiresExport: !journal,
        resources: journal?.documents.map((document) => {
          const current = readResourceContent(document.path, document.resource);
          return { resource: document.resource, path: document.path, revision: revision(current),
            redactedCurrent: isDirectoryResource(document.resource) ? portablePreview(current) : redactResourcePreview(current ?? "") };
        }) ?? [],
        diagnostics: [diagnostic(journal ? "unknown-revision" : "unrecognized-journal", journal ? "Review the current native revisions before keeping them and archiving the interrupted transaction." : "The journal cannot be interpreted safely. Export its original bytes and explicitly acknowledge keeping the current files.")],
      } });
    }
    return cases;
  }
  async function listRecoveryCases(): Promise<RecoveryCase[]> {
    await initialize();
    await recover();
    return inspectRecoveryCases().map((entry) => structuredClone(entry.public));
  }
  async function exportRecoveryJournal(input: { id: string; journalRevision: string }): Promise<{ fileName: string; content: string }> {
    await initialize();
    const entry = inspectRecoveryCases().find((item) => item.public.id === input.id);
    if (!entry || entry.public.journalRevision !== input.journalRevision) throw new ConfigurationError("conflict", "The recovery journal changed; review the latest recovery case.");
    exportedRecoveryJournals.set(input.id, input.journalRevision);
    return { fileName: `kimi-code-switch-recovery-${input.id}.json`, content: entry.content };
  }
  async function resolveRecovery(input: ResolveRecoveryRequest): Promise<ConfigurationRecoveryState> {
    await initialize();
    if (input.decision !== "keep-current") throw new ConfigurationError("invalid-recovery-decision", "Only an explicit keep-current recovery decision is supported.");
    const found = inspectRecoveryCases().find((entry) => entry.public.id === input.id);
    if (!found) throw new ConfigurationError("unknown-recovery", "The recovery case no longer exists.");
    await queuedResources([found.path, ...found.public.resources.map((resource) => resource.path)], async () => {
      const entry = inspectRecoveryCases().find((item) => item.public.id === input.id);
      if (!entry || entry.public.journalRevision !== input.journalRevision) throw new ConfigurationError("conflict", "The recovery journal changed; review the latest recovery case.");
      if (entry.public.requiresExport && (!input.acknowledgeMalformed || exportedRecoveryJournals.get(input.id) !== input.journalRevision)) throw new ConfigurationError("recovery-export-required", "Export this exact journal and explicitly acknowledge keeping current files before archiving it.");
      if (entry.public.resources.some((resource) => input.expectedRevisions[resource.path] !== resource.revision)) throw new ConfigurationError("conflict", "A recovery target changed after review; read its latest revision.");
      const archive = join(root, "recovery-archive", `${input.id}-${input.journalRevision.slice(0, 16)}.json`);
      ensurePrivateDirectory(dirname(archive));
      const target = authorized(archive);
      const existing = readText(target);
      if (existing !== null && existing !== entry.content) throw new ConfigurationError("archive-conflict", "The recovery archive path already contains different evidence.");
      if (existing === null) atomicWriteText(target, entry.content, "");
      if (readText(target) !== entry.content) throw new ConfigurationError("archive-failed", "The recovery journal could not be verified in the archive.");
      if (entry.journal?.documents.some((document) => revision(readResourceContent(document.path, document.resource)) !== input.expectedRevisions[document.path])) throw new ConfigurationError("conflict", "A native resource changed while the recovery evidence was being archived.");
      if (entry.journal) persistOperation({ ...entry.journal.operation, status: "failed", updatedAt: now(), diagnostics: [diagnostic("kept-current", "The user retained the reviewed native revisions and archived the interrupted transaction.", "info")] });
      // CAS removal checks the journal again after its evidence has been durably copied.
      fsCommands.remove_file_cas({ path: entry.path, expectedSha256: input.journalRevision });
      exportedRecoveryJournals.delete(input.id);
    });
    return recover();
  }
  async function recover(): Promise<ConfigurationRecoveryState> {
    recoveryPromise ??= performRecovery().finally(() => { recoveryPromise = undefined; });
    return recoveryPromise;
  }
  async function performRecovery(): Promise<ConfigurationRecoveryState> {
    const next: ConfigurationRecoveryState = { blocked: false, pendingOperationIds: [], diagnostics: [] };
    for (const path of options.legacyJournalPaths ?? [join(root, "pending-save-transaction.json"), join(root, "pending-restore-transaction.json")]) {
      if (readText(path) !== null) next.diagnostics.push(diagnostic("legacy-recovery-required", "A legacy configuration transaction requires explicit recovery before any mutation."));
    }
    let entries: string[] = [];
    try { entries = fs.readdirSync(journalsDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const entry of entries) {
      const path = join(journalsDir, entry);
      if (activeJournals.has(path)) continue;
      let value: unknown;
      try { value = JSON.parse(readText(path) ?? ""); } catch { /* malformed files block, never erase evidence */ }
      if (!validJournal(value) || entry !== `${value.operation.id}.json`) {
        next.diagnostics.push(diagnostic("invalid-journal", "An unreadable transaction journal requires manual recovery."));
        continue;
      }
      const initialJournal = value;
      await queuedResources([path, ...initialJournal.documents.map((document) => document.path)], async () => {
        if (activeJournals.has(path)) return;
        const freshContent = readText(path);
        if (freshContent === null) return;
        let fresh: unknown;
        try { fresh = JSON.parse(freshContent); } catch { /* Keep corrupted evidence and block. */ }
        if (!validJournal(fresh) || fresh.operation.id !== initialJournal.operation.id
          || JSON.stringify(fresh.documents.map((document) => document.path)) !== JSON.stringify(initialJournal.documents.map((document) => document.path))) {
          next.diagnostics.push(diagnostic("changed-journal", "The recovery journal changed while its resource locks were being acquired."));
          return;
        }
        const journal = fresh;
        const statuses = journal.documents.map((document) => {
          const current = readResourceContent(document.path, document.resource);
          return current === document.after ? "desired" : current === document.before ? "original" : "unknown";
        });
        if (statuses.includes("unknown")) {
          next.pendingOperationIds.push(journal.operation.id);
          next.diagnostics.push(diagnostic("unknown-revision", "A transaction target was changed externally; automatic recovery is blocked."));
          persistOperation({ ...journal.operation, status: "recovery-required", updatedAt: now(), diagnostics: [next.diagnostics[next.diagnostics.length - 1]] });
          return;
        }
        const completed = statuses.every((status) => status === "desired");
        if (!completed && statuses.some((status) => status === "desired")) {
          try {
            for (let index = journal.documents.length - 1; index >= 0; index--) {
              if (statuses[index] === "desired" && journal.documents[index].before !== journal.documents[index].after) applyPlannedDocument(journal.documents[index], true);
            }
          } catch {
            next.pendingOperationIds.push(journal.operation.id);
            next.diagnostics.push(diagnostic("rollback-incomplete", "An interrupted batch could not be fully rolled back; recovery requires attention."));
            return;
          }
        }
        if (journal.documents.some((document) => readResourceContent(document.path, document.resource) !== (completed ? document.after : document.before))) {
          next.pendingOperationIds.push(journal.operation.id);
          next.diagnostics.push(diagnostic("unknown-revision", "A native resource changed while recovery was being verified; its journal was retained."));
          persistOperation({ ...journal.operation, status: "recovery-required", updatedAt: now(), diagnostics: [next.diagnostics[next.diagnostics.length - 1]] });
          return;
        }
        persistOperation({ ...journal.operation, status: completed ? "succeeded" : "failed", updatedAt: now(),
          ...(completed ? { afterRevision: documentsRevision(journal.documents, true) } : {}),
          diagnostics: [diagnostic("recovered", completed ? "The interrupted write was verified on disk." : "The interrupted operation was rolled back to its original revisions.", "info")] });
        fsCommands.remove_file_cas({ path, expectedSha256: revision(freshContent) });
      });
    }
    next.blocked = next.diagnostics.some((item) => item.severity === "error");
    recovery = next;
    return structuredClone(recovery);
  }
  async function initialize(): Promise<void> { initialized ??= recover().then(() => undefined); await initialized; }
  async function assertWritable(_context?: TrustedResourceContext): Promise<void> {
    await initialize();
    // Reinspect durable journals so another local process cannot bypass the recovery gate.
    await recover();
    if (recovery.blocked) throw new ConfigurationError("recovery-required", "Resolve the pending configuration recovery before writing.");
  }
  async function read(context: TrustedResourceContext, resource: NativeResource): Promise<ResourceSnapshot> {
    prunePlans();
    const path = resourcePath(context, resource);
    const content = readResourceContent(path, resource);
    let data: unknown;
    const diagnostics: ResourceDiagnostic[] = [];
    try { data = parseResource(resource, content); }
    catch { diagnostics.push(diagnostic("invalid-document", "The existing native document is invalid; repair it before applying structured changes.")); }
    const exists = isDirectoryResource(resource) ? Boolean((data as { exists?: boolean } | undefined)?.exists) : content !== null;
    return { resource, path, format: resource === "agents" ? "text" : isMcpResource(resource) || isDirectoryResource(resource) ? "json" : "toml", exists, revision: revision(content), content, ...(data !== undefined ? { data } : {}), diagnostics };
  }
  async function plan(context: TrustedResourceContext, request: ResourceChangeRequest): Promise<ChangePlan> {
    await initialize();
    if (isDirectoryResource(request.resource)) throw new ConfigurationError("restore-only-resource", "Directory snapshots can only be applied through a reviewed backup or history restoration.");
    const snapshot = await read(context, request.resource);
    if (snapshot.revision !== request.expectedRevision) throw new ConfigurationError("conflict", "The native document changed. Read the current revision before planning.");
    if (snapshot.diagnostics.some((item) => item.severity === "error")) throw new ConfigurationError("invalid-document", "Structured editing is blocked for an invalid native document.");
    authorized(snapshot.path);
    let after: string | null;
    if (request.resource === "agents") {
      if (typeof request.content !== "string" || request.changes?.length) throw new ConfigurationError("invalid-change", "AGENTS.md accepts text content only.");
      after = request.content;
    } else {
      if (request.content !== undefined || !Array.isArray(request.changes)) throw new ConfigurationError("invalid-change", "Configuration changes require explicit field operations.");
      const patched = applyDocumentPatch(snapshot.format as "json" | "toml", snapshot.content, request.changes);
      after = snapshot.content === null && !patched.changed ? null : patched.content;
    }
    return buildPlan(context, [{ resource: request.resource, path: snapshot.path, before: snapshot.content, after }]);
  }
  async function validateCandidate(context: TrustedResourceContext, document: PlannedDocument): Promise<OfficialValidationResult> {
    parseResource(document.resource, document.after);
    try { validateNativeCandidate(document.resource, document.before, document.after); }
    catch (error) { throw new ConfigurationError("invalid-native-value", error instanceof Error ? error.message : "The native configuration contains an invalid changed value."); }
    const result: OfficialValidationResult = document.resource === "config" || document.resource === "tui"
      ? options.officialValidator
        ? await options.officialValidator({ context, resource: document.resource, content: document.after ?? "" })
        : { status: "unavailable", diagnostics: [diagnostic("official-validation-unavailable", "Syntax was checked locally. Official Kimi Code validation is unavailable and has not been claimed as verified.", "warning")] }
      : { status: "passed", diagnostics: [] };
    if (result.status === "failed") throw new ConfigurationError("official-validation-failed", "The official Kimi Code validator rejected the candidate configuration.");
    if (result.status === "unavailable" && options.requireOfficialValidation) throw new ConfigurationError("official-validation-required", "This runtime version requires official validation before writes can be enabled.");
    return result;
  }
  async function buildPlan(context: TrustedResourceContext, documents: PlannedDocument[]): Promise<ChangePlan> {
    if (!documents.length || new Set(documents.map((document) => document.path)).size !== documents.length) throw new ConfigurationError("invalid-batch", "A change plan must contain distinct native resources.");
    const results = await Promise.all(documents.map((document) => validateCandidate(context, document)));
    const first = documents[0];
    const preview = (after: boolean): string => documents.map((document) => `${documents.length > 1 ? `# ${document.resource}\n` : ""}${isDirectoryResource(document.resource) ? portablePreview(after ? document.after : document.before) : redactResourcePreview((after ? document.after : document.before) ?? "")}`).join("\n");
    const publicPlan: ChangePlan = { id: randomUUID(), resource: first.resource, path: first.path, expectedRevision: documentsRevision(documents),
      desiredRevision: documentsRevision(documents, true), changed: documents.some((document) => document.before !== document.after),
      validation: results.some((result) => result.status === "unavailable") ? "unavailable" : "passed",
      diagnostics: results.flatMap((result) => result.diagnostics), createdAt: now(), redactedPreview: { before: preview(false), after: preview(true) },
      resources: documents.map((document) => ({ resource: document.resource, path: document.path, expectedRevision: revision(document.before), desiredRevision: revision(document.after), changed: document.before !== document.after })) };
    prunePlans();
    const bytes = documents.reduce((size, document) => size + Buffer.byteLength(document.before ?? "") + Buffer.byteLength(document.after ?? ""), 0);
    const memoryLimit = 512 * 1024 * 1024;
    if (bytes > memoryLimit) throw new ConfigurationError("plan-too-large", "This restore exceeds the bounded in-memory plan size; split it into smaller resource plans.");
    while (plans.size >= 128 || [...plans.values()].reduce((total, plan) => total + plan.bytes, 0) + bytes > memoryLimit) plans.delete(plans.keys().next().value!);
    plans.set(publicPlan.id, { public: publicPlan, context: structuredClone(context), documents, bytes, expiresAt: Date.now() + 15 * 60_000 });
    return structuredClone(publicPlan);
  }
  async function planBatch(context: TrustedResourceContext, requests: ResourceChangeRequest[]): Promise<ChangePlan> {
    if (!requests.length || requests.length > resources.size) throw new ConfigurationError("invalid-batch", "A batch must contain distinct supported native resources.");
    const documents: PlannedDocument[] = [];
    for (const request of requests) {
      const child = await plan(context, request);
      documents.push(...plans.get(child.id)!.documents);
      plans.delete(child.id);
    }
    return buildPlan(context, documents);
  }
  /** Full replacement is reserved for an explicitly reviewed backup/history restore. */
  async function planRestore(context: TrustedResourceContext, snapshots: ResourceRestoreRequest[]): Promise<ChangePlan> {
    await initialize();
    if (!snapshots.length || snapshots.length > resources.size) throw new ConfigurationError("invalid-batch", "A restore must contain distinct supported native resources.");
    const documents: PlannedDocument[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.content !== null && typeof snapshot.content !== "string") throw new ConfigurationError("invalid-restore", "Restore content must be text or an absent-file marker.");
      const current = await read(context, snapshot.resource);
      if (current.revision !== snapshot.expectedRevision) throw new ConfigurationError("conflict", "A restore target changed since it was read.");
      authorized(current.path, isDirectoryResource(snapshot.resource));
      documents.push({ resource: snapshot.resource, path: current.path, before: current.content, after: isDirectoryResource(snapshot.resource) ? portableContent(snapshot.content) : snapshot.content });
    }
    return buildPlan(context, documents);
  }
  async function commit(planId: string, input: { expectedRevision: string }): Promise<ConfigurationOperation> {
    await initialize();
    prunePlans();
    const known = getOperation(planId);
    if (known && terminalStatuses.has(known.status)) return known;
    const stored = plans.get(planId);
    if (!stored) throw new ConfigurationError("unknown-plan", "The change plan expired or belongs to an earlier server process. Create a new plan.");
    if (input.expectedRevision !== stored.public.expectedRevision) throw new ConfigurationError("conflict", "The confirmed revision does not match this change plan.");
    await assertWritable(stored.context);
    return queuedResources(stored.documents.map((document) => document.path), async () => {
      const previous = getOperation(planId);
      if (previous && terminalStatuses.has(previous.status)) return previous;
      if (recovery.blocked) throw new ConfigurationError("recovery-required", "Resolve the pending configuration recovery before writing.");
      const timestamp = now();
      const operation: ConfigurationOperation = { id: planId, planId, resource: stored.public.resource, path: stored.public.path,
        status: "queued", createdAt: timestamp, updatedAt: timestamp, beforeRevision: stored.public.expectedRevision, diagnostics: stored.public.diagnostics,
        resources: stored.documents.map((document) => ({ resource: document.resource, path: document.path, beforeRevision: revision(document.before) })) };
      persistOperation(operation);
      const pendingPath = journalPath(planId);
      let journalCreated = false;
      let writeAttempted = false;
      try {
        if (stored.documents.some((document) => resourcePath(stored.context, document.resource) !== document.path || readResourceContent(document.path, document.resource) !== document.before)) throw new ConfigurationError("conflict", "A native document changed after preview.");
        if (!stored.public.changed) {
          operation.status = "succeeded"; operation.afterRevision = stored.public.expectedRevision;
          operation.updatedAt = now(); persistOperation(operation); return structuredClone(operation);
        }
        await options.fault?.("before-backup");
        const backupPath = join(backupsDir, `${planId}.json`);
        privateWrite(backupPath, { version: 1, revision: stored.public.expectedRevision, documents: stored.documents.map(({ resource, path, before }) => ({ resource, path, content: before })) }, "");
        await options.fault?.("after-backup");
        privateWrite(pendingPath, { version: 1, operation, documents: stored.documents, backupPath } satisfies Journal, "");
        journalCreated = true;
        activeJournals.add(pendingPath);
        await options.fault?.("after-journal");
        operation.status = "committing"; operation.updatedAt = now(); persistOperation(operation);
        for (const document of stored.documents) {
          if (document.before === document.after) continue;
          await options.fault?.("before-write");
          if (resourcePath(stored.context, document.resource) !== document.path || readResourceContent(document.path, document.resource) !== document.before) throw new ConfigurationError("conflict", "A native document changed immediately before commit.");
          writeAttempted = true;
          applyPlannedDocument(document);
          await options.fault?.("after-write");
          if (readResourceContent(document.path, document.resource) !== document.after) throw new ConfigurationError("unknown-revision", "The written document changed before it could be verified.");
          parseResource(document.resource, document.after);
        }
        await options.fault?.("before-complete");
        if (stored.documents.some((document) => readResourceContent(document.path, document.resource) !== document.after)) throw new ConfigurationError("unknown-revision", "A batch resource changed before commit completion.");
        operation.status = "succeeded"; operation.afterRevision = documentsRevision(stored.documents, true); operation.updatedAt = now();
        operation.resources = stored.documents.map((document) => ({ resource: document.resource, path: document.path, beforeRevision: revision(document.before), afterRevision: revision(document.after) }));
        persistOperation(operation);
        removePrivateFile(pendingPath);
        journalCreated = false;
        return structuredClone(operation);
      } catch (error) {
        const code = error instanceof ConfigurationError ? error.code : "write-failed";
        operation.status = writeAttempted && journalCreated ? "recovery-required" : code === "conflict" ? "conflict" : "failed";
        if (operation.status === "recovery-required") {
          try {
            const current = stored.documents.map((document) => readResourceContent(document.path, document.resource));
            if (stored.documents.some((document, index) => current[index] !== document.before && current[index] !== document.after)) throw new Error("unknown revision");
            for (let index = stored.documents.length - 1; index >= 0; index--) {
              const document = stored.documents[index];
              if (document.before !== document.after && current[index] === document.after) applyPlannedDocument(document, true);
            }
            if (stored.documents.some((document) => readResourceContent(document.path, document.resource) !== document.before)) throw new Error("rollback revision changed");
            operation.status = code === "conflict" ? "conflict" : "failed";
          } catch { /* Keep the durable journal and block later writes when rollback is unsafe. */ }
        }
        operation.updatedAt = now();
        operation.diagnostics = [...operation.diagnostics, diagnostic(code, error instanceof ConfigurationError ? error.message : "The operation failed; the native resource was not reported as saved.")];
        if (operation.status === "recovery-required") {
          recovery = { blocked: true, pendingOperationIds: [planId], diagnostics: operation.diagnostics.filter((item) => item.severity === "error") };
        } else if (journalCreated) { removePrivateFile(pendingPath); journalCreated = false; }
        try { persistOperation(operation); } catch { /* A durable journal remains authoritative after status-storage failure. */ }
        return structuredClone(operation);
      } finally {
        activeJournals.delete(pendingPath);
        if (terminalStatuses.has(operation.status)) plans.delete(planId);
      }
    });
  }
  return { read, plan, planBatch, planRestore, commit, getOperation, recover, assertWritable, listRecoveryCases, exportRecoveryJournal, resolveRecovery, getRecoveryState: async (): Promise<ConfigurationRecoveryState> => { await initialize(); return recover(); } };
}
export type ConfigurationService = ReturnType<typeof createConfigurationService>;
