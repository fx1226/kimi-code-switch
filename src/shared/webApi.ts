import type { AppearanceMode, Locale, Profile, PluginInventoryReport } from "./types";
import type { SkillsScanReport } from "./skillsStore";
import type { ResourceSnapshot, ResourceChangeRequest, ChangePlan, Operation, RecoveryCase, ResolveRecoveryRequest, ConfigurationRecoveryState } from "./resourceProtocol";

/** The browser contract is deliberately independent of the server implementation. */
export interface Target {
  id: string;
  name: string;
  homePath: string;
  workingDirectory?: string;
  kind: "default" | "managed" | "external";
}

export interface Preferences { theme: AppearanceMode; locale: Locale; activeTargetId: string }
export interface Compatibility {
  detectedVersion: string | null;
  expectedVersion: string;
  nativeWritesAllowed: boolean;
  status: string;
  runtimeVerified: false;
}
export interface BootstrapResult {
  product: "Kimi Code Switch";
  version: string;
  targets: Target[];
  preferences: Preferences;
  compatibility: Compatibility;
  officialAccount?: { status: "stored" | "expired" | "missing" | "revoked" | "invalid" | "unavailable"; source: "official-2.0-local-files"; message: string; remoteValidated: false };
  recovery: { blocked: boolean; message?: string };
  migrationAvailable: boolean;
}

export interface BackupSummary { id: string; name: string; createdAt: string; targetId: string; resources: string[]; restorable?: boolean; diagnostic?: string }
export interface HistorySummary { id: string; createdAt: string; resource: string; path: string; status: string }
export interface LegacyMigrationPreview {
  status: "absent" | "available" | "complete" | "blocked";
  sourceDir: string;
  targetDir: string;
  manifestHash: string;
  entries: Array<{ path: string; action: "copy" | "archive" | "retain"; sizeBytes: number; sha256: string | null }>;
  blockedReason?: string;
}
export interface DiagnosticResult { ok: boolean; issues: Array<{ severity: string; message: string; resource?: string }> }
export interface McpTool { name: string; description: string; inputSchema: unknown }

export interface WebApi {
  bootstrap(): Promise<BootstrapResult>;
  readResource(input: { targetId: string; resource: ResourceChangeRequest["resource"] }): Promise<ResourceSnapshot>;
  planChange(input: ResourceChangeRequest & { targetId: string }): Promise<ChangePlan>;
  applyChange(input: { targetId: string; planId: string; expectedRevision: string }): Promise<Operation>;
  getOperation(input: { id: string }): Promise<Operation | null>;
  savePreferences(input: Partial<Preferences>): Promise<Preferences>;
  addTarget(input: { name: string; homePath: string; workingDirectory?: string; copyFromTargetId?: string }): Promise<Target>;
  updateTarget(input: { targetId: string; name?: string; workingDirectory?: string | null }): Promise<Target>;
  forgetTarget(input: { targetId: string }): Promise<void>;
  listPresets(input: { targetId: string }): Promise<Profile[]>;
  savePreset(input: { targetId: string; preset: Profile }): Promise<void>;
  deletePreset(input: { targetId: string; name: string }): Promise<void>;
  planPreset(input: { targetId: string; name: string }): Promise<ChangePlan>;
  scanSkills(input: { targetId: string }): Promise<SkillsScanReport>;
  listPlugins(input: { targetId: string }): Promise<PluginInventoryReport>;
  diagnose(input: { targetId: string }): Promise<DiagnosticResult>;
  listBackups(input: { targetId: string }): Promise<BackupSummary[]>;
  createBackup(input: { targetId: string }): Promise<BackupSummary>;
  exportBackup(input: { targetId: string; id: string }): Promise<{ fileName: string; content: string }>;
  planRestore(input: { targetId: string; backupId: string }): Promise<ChangePlan>;
  importBackup(input: { targetId: string; content: string }): Promise<BackupSummary>;
  listHistory(input: { targetId: string }): Promise<HistorySummary[]>;
  planHistoryRestore(input: { targetId: string; id: string }): Promise<ChangePlan>;
  listRecoveryCases(): Promise<RecoveryCase[]>;
  exportRecoveryJournal(input: { id: string; journalRevision: string }): Promise<{ fileName: string; content: string }>;
  resolveRecovery(input: ResolveRecoveryRequest): Promise<ConfigurationRecoveryState>;
  previewMigration(): Promise<LegacyMigrationPreview>;
  applyMigration(input: { manifestHash: string }): Promise<{ status: string; migratedFiles: number; retainedPaths: string[]; archiveDir?: string }>;
  openKimi(input: { targetId: string }): Promise<void>;
  login(input: { targetId: string }): Promise<{ opened: true }>;
  testMcp(input: { targetId: string; name: string; resource?: "mcp" | "mcp-project" | "mcp-local" }): Promise<unknown>;
  listMcpTools(input: { targetId: string; name: string; resource?: "mcp" | "mcp-project" | "mcp-local" }): Promise<{ tools: McpTool[] }>;
  callMcpTool(input: { targetId: string; name: string; resource?: "mcp" | "mcp-project" | "mcp-local"; toolName: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export type WebMethod = keyof WebApi;
export type WebEvent =
  | { type: "resource-changed"; targetId: string; resource: string; revision?: string }
  | { type: "operation"; operationId: string }
  | { type: "service-event"; name: string; detail: unknown };

export interface ApiErrorPayload { code: string; message: string; details?: unknown }
export type ApiResponse<T> = { ok: true; result: T } | { ok: false; error: ApiErrorPayload };
