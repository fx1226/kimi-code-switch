import type { DocumentEdit } from "./documentPatch";

export type { DocumentEdit } from "./documentPatch";
export type NativeResource = "config" | "mcp" | "mcp-project" | "mcp-local" | "tui" | "agents" | "project-local" | "skills-directory" | "plugins-directory";
export type ResourceFormat = "toml" | "json" | "text";
export interface ResourceDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}
/** This context is resolved by the local server, never accepted as a client path. */
export interface TrustedResourceContext {
  home: string;
  projectRoot?: string;
  workingDirectory?: string;
}
export interface ResourceSnapshot {
  resource: NativeResource;
  path: string;
  format: ResourceFormat;
  exists: boolean;
  /** Empty means absent; an empty existing file has its SHA-256 digest. */
  revision: string;
  content: string | null;
  data?: unknown;
  diagnostics: ResourceDiagnostic[];
}
export interface ResourceChangeRequest {
  resource: NativeResource;
  expectedRevision: string;
  changes?: readonly DocumentEdit[];
  /** Raw editing is deliberately restricted to AGENTS.md. */
  content?: string;
}
export interface ResourceRestoreRequest { resource: NativeResource; content: string | null; expectedRevision: string }
export interface ChangePlan {
  id: string;
  resource: NativeResource;
  path: string;
  expectedRevision: string;
  desiredRevision: string;
  changed: boolean;
  diagnostics: ResourceDiagnostic[];
  validation: "passed" | "unavailable";
  createdAt: string;
  redactedPreview: { before: string; after: string };
  resources?: Array<{ resource: NativeResource; path: string; expectedRevision: string; desiredRevision: string; changed: boolean }>;
}
export type OperationStatus = "queued" | "committing" | "succeeded" | "failed" | "conflict" | "recovery-required";
export interface ConfigurationOperation {
  id: string;
  planId: string;
  resource: NativeResource;
  path: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  beforeRevision: string;
  afterRevision?: string;
  diagnostics: ResourceDiagnostic[];
  resources?: Array<{ resource: NativeResource; path: string; beforeRevision: string; afterRevision?: string }>;
}
export type Operation = ConfigurationOperation;
export interface ConfigurationRecoveryState {
  blocked: boolean;
  pendingOperationIds: string[];
  diagnostics: ResourceDiagnostic[];
}
export interface RecoveryCase {
  id: string;
  kind: "transaction" | "legacy" | "malformed";
  journalRevision: string;
  resources: Array<{ resource: NativeResource; path: string; revision: string; redactedCurrent: string }>;
  diagnostics: ResourceDiagnostic[];
  requiresExport: boolean;
}
export interface ResolveRecoveryRequest {
  id: string;
  journalRevision: string;
  expectedRevisions: Record<string, string>;
  decision: "keep-current";
  acknowledgeMalformed?: boolean;
}
