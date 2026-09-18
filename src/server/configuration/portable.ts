import { exportPortableDirectoryAt, portableDirectoryHash } from "../native/fs";
import type { NativeResource } from "../../shared/resourceProtocol";
import type { PortableDirectoryBundle } from "../../shared/types";

export function isDirectoryResource(resource: NativeResource): boolean {
  return resource === "skills-directory" || resource === "plugins-directory";
}
function invalid(): never { throw new Error("The directory snapshot is invalid or exceeds the portable restore limits."); }
/** Validate without writing a staging directory or trusting hashes from an import. */
export function parsePortableContent(content: string | null): PortableDirectoryBundle {
  const raw: unknown = content === null ? { exists: false, directories: [], files: [] } : JSON.parse(content);
  if (!raw || typeof raw !== "object") return invalid();
  const value = raw as PortableDirectoryBundle;
  if (typeof value.exists !== "boolean" || !Array.isArray(value.directories) || !Array.isArray(value.files)
    || value.directories.length > 4_000 || value.files.length > 4_000
    || (!value.exists && (value.directories.length > 0 || value.files.length > 0))) return invalid();
  const seen = new Set<string>();
  const files = new Set<string>();
  const validatePath = (path: unknown): string => {
    if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return invalid();
    const segments = path.split("/");
    if (segments.length > 32 || segments.some((part) => !part || part === "." || part === "..") || seen.has(path)) return invalid();
    seen.add(path);
    return path;
  };
  const directories = value.directories.map(validatePath).sort();
  let bytes = 0;
  const entries = value.files.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.contentBase64 !== "string" || typeof entry.executable !== "boolean") return invalid();
    const relativePath = validatePath(entry.relativePath);
    files.add(relativePath);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)) return invalid();
    const decoded = Buffer.from(entry.contentBase64, "base64");
    bytes += decoded.length;
    if (bytes > 64 * 1024 * 1024 || decoded.toString("base64") !== entry.contentBase64) return invalid();
    return { relativePath, contentBase64: entry.contentBase64, executable: entry.executable };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const path of seen) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (files.has(parent) || !directories.includes(parent)) return invalid();
    }
  }
  const bundle: PortableDirectoryBundle & { sha256: string } = { exists: value.exists, directories, files: entries, sha256: "" };
  bundle.sha256 = portableDirectoryHash(bundle);
  if (value.sha256 !== undefined && value.sha256 !== null && value.sha256 !== bundle.sha256) return invalid();
  return bundle;
}
export function portableContent(content: string | null): string { return JSON.stringify(parsePortableContent(content)); }
export function readPortableContent(path: string): string { return portableContent(JSON.stringify(exportPortableDirectoryAt(path))); }
export function portablePreview(content: string | null): string {
  const bundle = parsePortableContent(content);
  return JSON.stringify({ exists: bundle.exists, directories: bundle.directories, files: bundle.files.map((file) => ({ path: file.relativePath, bytes: Buffer.from(file.contentBase64, "base64").length, executable: file.executable })) }, null, 2);
}
