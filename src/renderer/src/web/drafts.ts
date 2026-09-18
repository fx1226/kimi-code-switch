import { redactDocumentText } from "@shared/configSafety";
import type { DocumentEdit, NativeResource, ResourceSnapshot } from "@shared/resourceProtocol";
import type { Profile } from "@shared/types";
import type { ResourceKind } from "./ResourceForms";

export interface ResourceDraft {
  key: string;
  targetId: string;
  kind: ResourceKind;
  originalName: string | null;
  name: string;
  base: Record<string, unknown>;
  value: Record<string, unknown>;
  revision: string;
  resource?: NativeResource;
  scope?: string;
  path?: string;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function resourceGroup(kind: ResourceKind): string {
  return kind === "provider" ? "providers" : kind === "model" ? "models" : "mcpServers";
}
export function resourceEntries(
  snapshot: ResourceSnapshot | undefined,
  kind: ResourceKind,
): Record<string, unknown> {
  return record(record(snapshot?.data)[resourceGroup(kind)]);
}
export function draftKey(targetId: string, kind: ResourceKind, name: string, scope?: string): string {
  return JSON.stringify(scope ? [targetId, kind, name, scope] : [targetId, kind, name]);
}
export function changedFields(
  base: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string[],
): DocumentEdit[] {
  const changes: DocumentEdit[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(value[key])) continue;
    if (value[key] === undefined) changes.push({ op: "delete", path: [...path, key] });
    else changes.push({ op: "set", path: [...path, key], value: value[key] });
  }
  return changes;
}
export function draftChanges(draft: ResourceDraft): DocumentEdit[] {
  const path = [resourceGroup(draft.kind), draft.name.trim()];
  if (!draft.originalName) return [{ op: "set", path, value: draft.value }];
  return changedFields(draft.base, draft.value, path);
}
export function capturePreset(name: string, data: unknown): Profile {
  const config = record(data);
  const nativeEdits: DocumentEdit[] = [];
  for (const key of [
    "default_model",
    "default_plan_mode",
    "default_permission_mode",
    "merge_all_available_skills",
  ]) {
    if (Object.hasOwn(config, key)) nativeEdits.push({ op: "set", path: [key], value: config[key] });
  }
  const thinking = record(config.thinking);
  for (const key of ["enabled", "effort"]) {
    if (Object.hasOwn(thinking, key))
      nativeEdits.push({ op: "set", path: ["thinking", key], value: thinking[key] });
  }
  return {
    name,
    label: name,
    nativeEdits,
    default_model: typeof config.default_model === "string" ? config.default_model : "",
    // Legacy display metadata is not applied: nativeEdits is the authoritative
    // new-preset contract and intentionally omits every absent native field.
    default_plan_mode: config.default_plan_mode === true,
    default_permission_mode:
      typeof config.default_permission_mode === "string"
        ? (config.default_permission_mode as Profile["default_permission_mode"])
        : "",
    merge_all_available_skills: config.merge_all_available_skills !== false,
    ...(typeof thinking.enabled === "boolean" ? { thinking_enabled: thinking.enabled } : {}),
    ...(typeof thinking.effort === "string" ? { thinking_effort: thinking.effort } : {}),
  };
}
/** Rebase only the user's changed fields after an explicit reload; never apply another draft. */
export function rebaseDraft(draft: ResourceDraft, snapshot: ResourceSnapshot): ResourceDraft {
  if (!draft.originalName) return { ...draft, revision: snapshot.revision };
  const base = record(resourceEntries(snapshot, draft.kind)[draft.originalName]);
  const value = { ...base };
  for (const edit of changedFields(draft.base, draft.value, [])) {
    if (edit.op === "delete") delete value[edit.path[0]!];
    else value[edit.path[0]!] = edit.value;
  }
  return { ...draft, base, value, revision: snapshot.revision };
}
/** Source views are read only and hide credential-bearing lines, including multiline strings. */
export function redactSource(source: string | null): string {
  if (!source) return "";
  const secretKey =
    /(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie|client[_-]?secret|headers|^env$)/i;
  if (source.trimStart().startsWith("{")) {
    try {
      const redact = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(redact)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  secretKey.test(key) ? "[redacted]" : redact(item),
                ]),
              )
            : value;
      return redactDocumentText(JSON.stringify(redact(JSON.parse(source)), null, 2)).text;
    } catch {
      /* Fall through to line redaction for a malformed source. */
    }
  }
  let secretBlock = false;
  let multiline: string | null = null;
  const closesMultiline = (text: string, delimiter: string): boolean => {
    for (let index = text.indexOf(delimiter); index !== -1; index = text.indexOf(delimiter, index + 1)) {
      if (delimiter === "'''") return true;
      let escapes = 0;
      for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) escapes += 1;
      if (escapes % 2 === 0) return true;
    }
    return false;
  };
  const redacted = source
    .split("\n")
    .map((line) => {
      if (multiline) {
        if (closesMultiline(line, multiline)) multiline = null;
        return "# [redacted]";
      }
      if (/^\s*\[/.test(line)) secretBlock = /(?:oauth|credential|headers|env)(?:\.|\])/i.test(line);
      if (
        (secretBlock && /^\s*[^#\s[][^=]*=/.test(line)) ||
        /(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie|client[_-]?secret|headers|\benv)["']?\s*[:=]/i.test(
          line,
        )
      ) {
        const triple = line.match(/(?:=|:)\s*("""|''')/);
        if (triple && !closesMultiline(line.slice(triple.index! + triple[0].length), triple[1]!)) multiline = triple[1]!;
        return line.replace(/([:=])\s*.*/, '$1 "[redacted]"');
      }
      return line;
    })
    .join("\n");
  return redactDocumentText(redacted).text;
}
