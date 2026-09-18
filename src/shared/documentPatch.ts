import parseToml from "@iarna/toml/parse-string.js";

export type DocumentFormat = "toml" | "json";

export interface DocumentEdit {
  readonly op: "set" | "delete";
  readonly path: readonly string[];
  readonly value?: unknown;
}

export interface DocumentPatchResult {
  content: string;
  changed: boolean;
}

export type DocumentPatchErrorCode =
  | "INVALID_DOCUMENT"
  | "INVALID_EDIT"
  | "AMBIGUOUS_EDIT"
  | "UNSUPPORTED_STRUCTURE"
  | "UNREPRESENTABLE_VALUE"
  | "PATCH_VERIFICATION_FAILED";

/** Diagnostics intentionally omit document contents and edited values. */
export class DocumentPatchError extends Error {
  readonly code: DocumentPatchErrorCode;
  readonly path?: readonly string[];

  constructor(code: DocumentPatchErrorCode, message: string, path?: readonly string[]) {
    super(message);
    this.name = "DocumentPatchError";
    this.code = code;
    this.path = path ? [...path] : undefined;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function owns(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isPrefix(left, right);
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date &&
      Object.is(left.getTime(), right.getTime()) && String(left) === String(right) &&
      equal(Object.entries(left), Object.entries(right));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => equal(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => owns(right, key) && equal(left[key], right[key]));
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) return value;
  const result: RecordValue = Object.create(null);
  for (const key of Object.keys(value)) result[key] = clone(value[key]);
  return result;
}

function validateValue(value: unknown, format: DocumentFormat, ancestors = new Set<unknown>()): void {
  if (value === null && format === "json") return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (!Array.isArray(value) && (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "The requested value cannot be represented without loss.");
  }
  if (ancestors.has(value)) throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "Cyclic values are unsupported.");
  ancestors.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "Symbol properties are unsupported.");
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "Named array properties are unsupported.");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor) {
        throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "Sparse arrays are unsupported.");
      }
      if (!("value" in descriptor)) throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "Accessor properties are unsupported.");
      validateValue(descriptor.value, format, ancestors);
    }
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "Accessor properties are unsupported.");
      validateValue(descriptor.value, format, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateEdits(edits: readonly DocumentEdit[], format: DocumentFormat): void {
  if (!Array.isArray(edits)) throw new DocumentPatchError("INVALID_EDIT", "Edits must be an array.");
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (!edit || !["set", "delete"].includes(edit.op) || !Array.isArray(edit.path) ||
      edit.path.length === 0 || Array.from(edit.path).some((part) => typeof part !== "string")) {
      throw new DocumentPatchError("INVALID_EDIT", "Edits require a nonempty path of string keys and a set/delete operation.");
    }
    for (const previous of edits.slice(0, index)) {
      if (isPrefix(previous.path, edit.path) || isPrefix(edit.path, previous.path)) {
        throw new DocumentPatchError("AMBIGUOUS_EDIT", "Repeated or overlapping edit paths are unsupported.", edit.path);
      }
    }
    if (edit.op === "set") validateValue(edit.value, format);
  }
}

function parseDocument(format: DocumentFormat, content: string): RecordValue {
  try {
    const parsed: unknown = format === "toml" ? parseToml(content) : JSON.parse(content);
    if (!isRecord(parsed)) throw new Error("Expected an object document.");
    return parsed;
  } catch {
    throw new DocumentPatchError("INVALID_DOCUMENT", `The existing ${format.toUpperCase()} document is invalid, is not an object, or uses syntax unsupported by the local parser.`);
  }
}

function applySemanticEdit(document: RecordValue, edit: DocumentEdit): { expected: RecordValue; changed: boolean } {
  const expected = clone(document) as RecordValue;
  let parent = expected;
  for (const key of edit.path.slice(0, -1)) {
    if (!owns(parent, key)) {
      if (edit.op === "delete") return { expected, changed: false };
      parent[key] = Object.create(null);
    }
    if (!isRecord(parent[key])) {
      throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "An edit path cannot traverse an array or scalar value.", edit.path);
    }
    parent = parent[key] as RecordValue;
  }
  const key = edit.path[edit.path.length - 1];
  if (edit.op === "delete") {
    if (!owns(parent, key)) return { expected, changed: false };
    delete parent[key];
  } else {
    if (owns(parent, key) && equal(parent[key], edit.value)) return { expected, changed: false };
    parent[key] = clone(edit.value);
  }
  return { expected, changed: true };
}

function newlineOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function replace(content: string, start: number, end: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(end);
}

function lineIndent(content: string, position: number): string {
  const start = content.lastIndexOf("\n", position - 1) + 1;
  return /^[\t ]*/.exec(content.slice(start, position))?.[0] ?? "";
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key).replace(/\u007f/g, "\\u007f");
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isRecord(value)) return `{ ${Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`).join(", ")} }`;
  throw new DocumentPatchError("UNREPRESENTABLE_VALUE", "The requested value is unsupported by TOML.");
}

interface TomlAssignment {
  path: string[];
  scope: string[];
  start: number;
  valueStart: number;
  valueEnd: number;
  end: number;
  comments: string[];
}

interface TomlTable {
  path: string[];
  headerStart: number;
  start: number;
  end: number;
  array: boolean;
}

function nextLine(content: string, position: number): number {
  const newline = content.indexOf("\n", position);
  return newline < 0 ? content.length : newline + 1;
}

function parseTomlKeyPath(raw: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < raw.length) {
    while (/[\t ]/.test(raw[index] ?? "\0")) index += 1;
    const start = index;
    if (raw[index] === "\"" || raw[index] === "'") {
      const quote = raw[index++];
      while (index < raw.length) {
        if (quote === "\"" && raw[index] === "\\") { index += 2; continue; }
        if (raw[index++] === quote) break;
      }
    } else {
      while (/[A-Za-z0-9_-]/.test(raw[index] ?? "\0")) index += 1;
    }
    if (start === index) throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "A TOML key cannot be located safely.");
    try {
      keys.push(Object.keys(parseToml(`${raw.slice(start, index)} = 0`))[0]);
    } catch {
      throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "A TOML key cannot be located safely.");
    }
    while (/[\t ]/.test(raw[index] ?? "\0")) index += 1;
    if (index === raw.length) break;
    if (raw[index++] !== ".") throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "A TOML key cannot be located safely.");
  }
  return keys;
}

function findOutsideQuotes(content: string, start: number, target: string): number {
  let quote = "";
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (quote === "\"" && char === "\\") index += 1;
      else if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === target) return index;
    else if (char === "\n" || char === "\r" || char === "#") break;
  }
  throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "A TOML statement cannot be located safely.");
}

function tomlValueEnd(content: string, start: number): { end: number; comments: string[] } {
  let index = start;
  let depth = 0;
  let quote = "";
  let multiline = false;
  const comments: string[] = [];
  while (index < content.length) {
    const char = content[index];
    if (quote) {
      if (quote === "\"" && char === "\\") { index += 2; continue; }
      if (char === quote) {
        if (!multiline) { quote = ""; index += 1; continue; }
        if (content.slice(index, index + 3) === quote.repeat(3)) {
          while (content[index] === quote) index += 1;
          quote = "";
          continue;
        }
      }
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      multiline = content.slice(index, index + 3) === char.repeat(3);
      index += multiline ? 3 : 1;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "#") {
      if (depth === 0) break;
      const end = nextLine(content, index);
      comments.push(content.slice(index, end).replace(/[\r\n]+$/, ""));
      index = end;
      continue;
    }
    if ((char === "\n" || char === "\r") && depth === 0) break;
    index += 1;
  }
  if (quote || depth !== 0) throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "A TOML value boundary cannot be located safely.");
  while (index > start && /\s/.test(content[index - 1])) index -= 1;
  return { end: index, comments };
}

function scanToml(content: string): { assignments: TomlAssignment[]; tables: TomlTable[] } {
  const assignments: TomlAssignment[] = [];
  const tables: TomlTable[] = [{ path: [], headerStart: 0, start: 0, end: content.length, array: false }];
  let table = tables[0];
  let index = 0;
  const arrayPaths: string[][] = [];
  while (index < content.length) {
    const lineStart = index;
    while (/[\t ]/.test(content[index] ?? "\0")) index += 1;
    if (content[index] === "#" || content[index] === "\r" || content[index] === "\n" || index === content.length) {
      index = nextLine(content, index);
      continue;
    }
    if (content[index] === "[") {
      const array = content[index + 1] === "[";
      const keyStart = index + (array ? 2 : 1);
      const close = findOutsideQuotes(content, keyStart, "]");
      const path = parseTomlKeyPath(content.slice(keyStart, close).trim());
      if (array) arrayPaths.push(path);
      table.end = lineStart;
      index = nextLine(content, close);
      table = { path, headerStart: lineStart, start: index, end: content.length, array: array || arrayPaths.some((prefix) => isPrefix(prefix, path)) };
      tables.push(table);
      continue;
    }
    const equals = findOutsideQuotes(content, index, "=");
    const path = [...table.path, ...parseTomlKeyPath(content.slice(index, equals).trim())];
    let valueStart = equals + 1;
    while (/[\t ]/.test(content[valueStart] ?? "\0")) valueStart += 1;
    const value = tomlValueEnd(content, valueStart);
    index = nextLine(content, value.end);
    assignments.push({ path, scope: table.path, start: lineStart, valueStart, valueEnd: value.end, end: index, comments: value.comments });
  }
  return { assignments, tables };
}

function patchToml(content: string, edit: DocumentEdit, document: RecordValue): string {
  const { assignments, tables } = scanToml(content);
  const matching = assignments.filter((assignment) => samePath(assignment.path, edit.path));
  if (matching.length > 1) throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "The TOML target has multiple source ranges.", edit.path);
  const target = matching[0];
  if (target) {
    if (edit.op === "set") {
      if (target.comments.length) {
        throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "Replacing this value cannot safely preserve the comments attached to its items.", edit.path);
      }
      return replace(content, target.valueStart, target.valueEnd, tomlValue(edit.value));
    }
    const indent = lineIndent(content, target.valueStart);
    const trailing = content.slice(target.valueEnd, target.end);
    const inline = /^[\t ]*(#[^\r\n]*)/.exec(trailing)?.[1];
    const comments = [...target.comments, ...(inline ? [inline] : [])];
    const ending = /\r?\n$/.exec(trailing)?.[0] ?? "";
    const replacement = comments.length ? comments.map((comment) => indent + comment).join(newlineOf(content)) + ending : "";
    return replace(content, target.start, target.end, replacement);
  }
  if (assignments.some((assignment) => isPrefix(assignment.path, edit.path))) {
    throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "Editing inside a TOML inline value is unsupported; edit the whole value instead.", edit.path);
  }
  let current: unknown = document;
  for (const part of edit.path) current = isRecord(current) && owns(current, part) ? current[part] : undefined;
  if (edit.op === "delete" && (isRecord(current) || Array.isArray(current))) {
    const newline = newlineOf(content);
    const ranges: Array<{ start: number; end: number; replacement: string }> = [];
    for (const assignment of assignments.filter((item) => isPrefix(edit.path, item.path))) {
      const trailing = content.slice(assignment.valueEnd, assignment.end);
      const inline = /^[\t ]*(#[^\r\n]*)/.exec(trailing)?.[1];
      const comments = [...assignment.comments, ...(inline ? [inline] : [])];
      ranges.push({ start: assignment.start, end: assignment.end, replacement: comments.length ? comments.join(newline) + newline : "" });
    }
    for (const table of tables.filter((item) => item.path.length > 0 && isPrefix(edit.path, item.path))) {
      let headerIndex = table.headerStart;
      while (/[\t ]/.test(content[headerIndex] ?? "\0")) headerIndex++;
      const close = findOutsideQuotes(content, headerIndex + (content[headerIndex + 1] === "[" ? 2 : 1), "]");
      const comment = /^[\]\t ]*(#[^\r\n]*)/.exec(content.slice(close + 1, table.start))?.[1];
      ranges.push({ start: table.headerStart, end: table.start, replacement: comment ? comment + newline : "" });
    }
    if (ranges.length === 0) throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "The table source ranges cannot be located safely.", edit.path);
    let result = content;
    for (const range of ranges.sort((left, right) => right.start - left.start)) result = replace(result, range.start, range.end, range.replacement);
    // TOML creates parent tables implicitly. Retain an emptied parent table so
    // the semantic change is exactly the requested subtree deletion.
    const parentPath = edit.path.slice(0, -1);
    if (parentPath.length) {
      let parent: unknown = parseDocument("toml", result);
      for (const part of parentPath) parent = isRecord(parent) && owns(parent, part) ? parent[part] : undefined;
      if (parent === undefined) result += (result && !result.endsWith("\n") ? newline : "") + `[${parentPath.map(tomlKey).join(".")}]` + newline;
    }
    return result;
  }
  if (current !== undefined || edit.op === "delete") {
    throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "Replacing or deleting a TOML table requires explicit field edits.", edit.path);
  }
  if (isRecord(edit.value)) {
    const newline = newlineOf(content);
    const renderTable = (path: readonly string[], value: RecordValue): string => {
      const entries = Object.entries(value);
      const scalar = entries.filter(([, item]) => !isRecord(item));
      const children = entries.filter(([, item]) => isRecord(item));
      return `[${path.map(tomlKey).join(".")}]` + newline + scalar.map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`).join(newline)
        + (scalar.length ? newline : "") + children.map(([key, item]) => newline + renderTable([...path, key], item as RecordValue)).join("");
    };
    const separator = content.length === 0 ? "" : content.endsWith("\n") ? newline : newline + newline;
    return content + separator + renderTable(edit.path, edit.value);
  }
  const parentPath = edit.path.slice(0, -1);
  const exactTable = tables.find((table) => !table.array && samePath(table.path, parentPath));
  let parent: unknown = document;
  for (const part of parentPath) parent = isRecord(parent) && owns(parent, part) ? parent[part] : undefined;
  const newline = newlineOf(content);
  if (!exactTable && parent === undefined && parentPath.length > 0) {
    const separator = content.length === 0 ? "" : content.endsWith("\n") ? newline : newline + newline;
    return content + separator + `[${parentPath.map(tomlKey).join(".")}]` + newline +
      `${tomlKey(edit.path[edit.path.length - 1])} = ${tomlValue(edit.value)}` + newline;
  }
  const table = exactTable ?? tables.filter((item) => !item.array && isPrefix(item.path, parentPath))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!table) throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "The TOML insertion scope cannot be located safely.", edit.path);
  const inTable = assignments.filter((assignment) => assignment.start >= table.start && assignment.start < table.end);
  const insertion = inTable.length ? inTable[inTable.length - 1].end : table.start;
  const prefix = insertion > 0 && content[insertion - 1] !== "\n" ? newline : "";
  const line = `${edit.path.slice(table.path.length).map(tomlKey).join(".")} = ${tomlValue(edit.value)}`;
  return replace(content, insertion, insertion, prefix + line + newline);
}

interface JsonProperty {
  key: string;
  start: number;
  value: JsonNode;
}

interface JsonNode {
  kind: "object" | "array" | "value";
  start: number;
  end: number;
  properties: JsonProperty[];
}

/** JSON.parse validates grammar; this pass records ranges and rejects duplicate decoded keys. */
function scanJson(content: string): JsonNode {
  let position = 0;
  const whitespace = () => { while (/\s/.test(content[position] ?? "\0")) position += 1; };
  const stringEnd = () => {
    position += 1;
    while (position < content.length) {
      if (content[position] === "\\") position += 2;
      else if (content[position++] === "\"") return;
    }
  };
  const visit = (): JsonNode => {
    whitespace();
    const start = position;
    const properties: JsonProperty[] = [];
    if (content[position] === "{") {
      position += 1;
      whitespace();
      const keys = new Set<string>();
      while (content[position] !== "}") {
        whitespace();
        const propertyStart = position;
        stringEnd();
        const key: string = JSON.parse(content.slice(propertyStart, position));
        if (keys.has(key)) throw new DocumentPatchError("INVALID_DOCUMENT", "Duplicate JSON object keys make a local patch ambiguous.");
        keys.add(key);
        whitespace();
        position += 1;
        const value = visit();
        properties.push({ key, start: propertyStart, value });
        whitespace();
        if (content[position] !== ",") break;
        position += 1;
      }
      position += 1;
      return { kind: "object", start, end: position, properties };
    }
    if (content[position] === "[") {
      position += 1;
      whitespace();
      while (content[position] !== "]") {
        visit();
        whitespace();
        if (content[position] !== ",") break;
        position += 1;
      }
      position += 1;
      return { kind: "array", start, end: position, properties };
    }
    if (content[position] === "\"") stringEnd();
    else while (position < content.length && !/[\s,\]}]/.test(content[position])) position += 1;
    return { kind: "value", start, end: position, properties };
  };
  return visit();
}

function serializeJson(value: unknown, unit: string, depth = 0): string {
  if (typeof value === "number" && Object.is(value, -0)) return "-0";
  if (!Array.isArray(value) && !isRecord(value)) return JSON.stringify(value);
  const items = Array.isArray(value)
    ? value.map((item) => serializeJson(item, unit, depth + 1))
    : Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${unit ? " " : ""}${serializeJson(item, unit, depth + 1)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (items.length === 0) return open + close;
  if (!unit) return open + items.join(",") + close;
  return open + "\n" + unit.repeat(depth + 1) + items.join(",\n" + unit.repeat(depth + 1)) + "\n" + unit.repeat(depth) + close;
}

function formatJsonValue(content: string, value: unknown, indent: string, pretty: boolean): string {
  const unit = /\n([\t ]+)\S/.exec(content)?.[1] ?? "  ";
  return serializeJson(value, pretty ? unit : "").replace(/\n/g, newlineOf(content) + indent);
}

function patchJson(content: string, edit: DocumentEdit, root: JsonNode): string {
  let parent = root;
  for (let index = 0; index < edit.path.length; index += 1) {
    if (parent.kind !== "object") throw new DocumentPatchError("UNSUPPORTED_STRUCTURE", "An edit path cannot traverse an array or scalar value.", edit.path);
    const key = edit.path[index];
    const propertyIndex = parent.properties.findIndex((item) => item.key === key);
    const target = parent.properties[propertyIndex];
    if (target && index < edit.path.length - 1) { parent = target.value; continue; }
    if (target) {
      if (edit.op === "set") {
        const pretty = content.slice(parent.start, parent.end).includes("\n");
        return replace(content, target.value.start, target.value.end,
          formatJsonValue(content, edit.value, lineIndent(content, target.start), pretty));
      }
      const next = parent.properties[propertyIndex + 1];
      const previous = parent.properties[propertyIndex - 1];
      return replace(content, next ? target.start : previous ? previous.value.end : target.start,
        next ? next.start : target.value.end, "");
    }
    if (edit.op === "delete") return content;
    let value = edit.value;
    for (const nestedKey of edit.path.slice(index + 1).reverse()) {
      const wrapper: RecordValue = Object.create(null);
      wrapper[nestedKey] = value;
      value = wrapper;
    }
    const pretty = content.slice(parent.start, parent.end).includes("\n");
    const parentIndent = lineIndent(content, parent.start);
    const indent = parent.properties.length ? lineIndent(content, parent.properties[0].start) : parentIndent + "  ";
    const entry = `${JSON.stringify(key)}: ${formatJsonValue(content, value, indent, pretty)}`;
    if (parent.properties.length === 0) {
      const replacement = pretty ? newlineOf(content) + indent + entry + newlineOf(content) + parentIndent : entry;
      return replace(content, parent.start + 1, parent.end - 1, replacement);
    }
    const last = parent.properties[parent.properties.length - 1];
    return replace(content, last.value.end, last.value.end, "," + (pretty ? newlineOf(content) + indent : " ") + entry);
  }
  throw new DocumentPatchError("INVALID_EDIT", "The edit target is missing.");
}

/**
 * Patch only requested source ranges. Unsupported syntax never falls back to a
 * document serializer. Missing resources plus deletion remain a no-op (content "").
 * Array indices, inline-table children and whole TOML table replacement are unsupported.
 */
export function applyDocumentPatch(format: DocumentFormat, source: string | null, edits: readonly DocumentEdit[]): DocumentPatchResult {
  if (format !== "toml" && format !== "json") throw new DocumentPatchError("INVALID_EDIT", "Unsupported document format.");
  validateEdits(edits, format);
  let content = source ?? (format === "json" ? "{}" : "");
  // The native MCP loader treats a blank file as an empty object. Keep its
  // whitespace and return the original bytes below when the edit is a no-op.
  if (format === "json" && !content.trim()) content += "{}";
  let document = parseDocument(format, content);
  let json = format === "json" ? scanJson(content) : undefined;
  let changed = false;
  for (const edit of edits) {
    const mutation = applySemanticEdit(document, edit);
    if (!mutation.changed) continue;
    const result = format === "toml" ? patchToml(content, edit, document) : patchJson(content, edit, json!);
    let parsed: RecordValue;
    try { parsed = parseDocument(format, result); }
    catch { throw new DocumentPatchError("PATCH_VERIFICATION_FAILED", "The local patch did not produce a valid document.", edit.path); }
    if (!equal(parsed, mutation.expected)) {
      throw new DocumentPatchError("PATCH_VERIFICATION_FAILED", "The local patch would change values outside the requested edit.", edit.path);
    }
    content = result;
    document = parsed;
    json = format === "json" ? scanJson(content) : undefined;
    changed = true;
  }
  return { content: changed ? content : source ?? "", changed };
}
