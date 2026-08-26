// WebDAV 备份（前端版，移植自 main/modules/webdav.ts）。
// 标准 fetch 不支持 MKCOL/PROPFIND，故通过 Rust http_request 发请求。
import { invoke } from "@tauri-apps/api/core";

import type { PanelSettings } from "@shared/types";

interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

interface EncryptedBackupEnvelope {
  format: "kimi-code-switch-gui-encrypted-v1" | "kimi-code-switch-gui-encrypted-v2" | "kimi-code-switch-gui-encrypted-v3";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

const BACKUP_KDF_ITERATIONS = 210_000;

function backupAdditionalData(url: string, format: EncryptedBackupEnvelope["format"]): Uint8Array {
  if (format === "kimi-code-switch-gui-encrypted-v1") {
    return new TextEncoder().encode(url);
  }
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean).slice(-2).map(decodeURIComponent);
  return new TextEncoder().encode(`kimi-code-switch-gui:${segments.join("/")}`);
}

function http(method: string, url: string, headers?: Record<string, string>, body?: string): Promise<HttpResponse> {
  return invoke<HttpResponse>("http_request", { method, url, headers: headers ?? null, body: body ?? null });
}

export function getWebDavAuthHeader(settings: PanelSettings): string {
  const credentials = `${settings.backup_webdav_username}:${settings.backup_webdav_password}`;
  return `Basic ${btoa(credentials)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveBackupKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (!password) throw new Error("WebDAV password is required for encrypted backups.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function backupEncryptionMaterials(
  settings: PanelSettings,
  format: EncryptedBackupEnvelope["format"],
  legacyEncryptionPassword?: string,
): Promise<string[]> {
  const localSecrets = await invoke<string[]>("get_backup_encryption_secret_candidates");
  if (!Array.isArray(localSecrets) || localSecrets.some((secret) => !/^[0-9a-f]{64}$/i.test(secret))) {
    throw new Error("Local backup encryption key is unavailable.");
  }
  // v1/v2 compatibility: historical files used the mutable WebDAV login
  // password as part of their encryption material. v3 intentionally uses only
  // the independent recovery key so changing server credentials cannot make
  // future backups unreadable.
  if (format === "kimi-code-switch-gui-encrypted-v1" || format === "kimi-code-switch-gui-encrypted-v2") {
    const password = legacyEncryptionPassword || settings.backup_webdav_password;
    if (!password) throw new Error("The original WebDAV password is required to decrypt this legacy backup.");
    return localSecrets.map((secret) => `${password}\0${secret}`);
  }
  return localSecrets;
}

async function encryptBackupContent(settings: PanelSettings, content: string, url: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const format = "kimi-code-switch-gui-encrypted-v3" as const;
  const [material] = await backupEncryptionMaterials(settings, format);
  const key = await deriveBackupKey(material, salt, BACKUP_KDF_ITERATIONS);
  const additionalData = backupAdditionalData(url, format);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData },
    key,
    new TextEncoder().encode(content),
  );
  const envelope: EncryptedBackupEnvelope = {
    format,
    kdf: "PBKDF2-SHA256",
    iterations: BACKUP_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

async function decryptBackupContent(
  settings: PanelSettings,
  content: string,
  url: string,
  allowLegacyPlaintext: boolean,
  legacyEncryptionPassword?: string,
): Promise<string> {
  let envelope: Partial<EncryptedBackupEnvelope>;
  try {
    envelope = JSON.parse(content) as Partial<EncryptedBackupEnvelope>;
  } catch {
    if (allowLegacyPlaintext) return content;
    throw new Error("WebDAV backup is not encrypted; refusing plaintext downgrade.");
  }
  if (
    envelope.format !== "kimi-code-switch-gui-encrypted-v1"
    && envelope.format !== "kimi-code-switch-gui-encrypted-v2"
    && envelope.format !== "kimi-code-switch-gui-encrypted-v3"
  ) {
    if (allowLegacyPlaintext) return content;
    throw new Error("WebDAV backup is not encrypted; refusing plaintext downgrade.");
  }
  if (
    envelope.kdf !== "PBKDF2-SHA256"
    || envelope.iterations !== BACKUP_KDF_ITERATIONS
    || typeof envelope.salt !== "string"
    || typeof envelope.iv !== "string"
    || typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Encrypted WebDAV backup envelope is invalid.");
  }
  if (envelope.ciphertext.length > 64 * 1024 * 1024) {
    throw new Error("Encrypted WebDAV backup is too large.");
  }
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error("invalid encryption parameters");
    const additionalData = backupAdditionalData(url, envelope.format);
    const materials = await backupEncryptionMaterials(settings, envelope.format, legacyEncryptionPassword);
    for (const material of materials) {
      try {
        const key = await deriveBackupKey(material, salt, envelope.iterations);
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: iv as BufferSource, additionalData },
          key,
          base64ToBytes(envelope.ciphertext) as BufferSource,
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        // Try the preserved previous recovery key before reporting failure.
      }
    }
    throw new Error("no recovery key matched");
  } catch {
    throw new Error("Unable to decrypt WebDAV backup. Check the configured password.");
  }
}

export function getWebDavBaseUrl(settings: PanelSettings): string {
  const baseUrl = settings.backup_webdav_url.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("WebDAV URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("WebDAV URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("WebDAV URL must use HTTPS because backups contain credentials.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function getWebDavPathSegments(settings: PanelSettings, additional: string[] = []): string[] {
  const segments = settings.backup_webdav_path.split("/").map((s) => s.trim()).filter(Boolean);
  return [...segments, ...additional];
}

export function buildWebDavUrl(settings: PanelSettings, additional: string[] = []): string {
  const baseUrl = getWebDavBaseUrl(settings);
  const segments = getWebDavPathSegments(settings, additional).map(encodeURIComponent);
  return segments.length ? `${baseUrl}/${segments.join("/")}` : baseUrl;
}

export async function ensureWebDavCollection(settings: PanelSettings, additional: string[] = []): Promise<string> {
  let currentUrl = getWebDavBaseUrl(settings);
  const headers = { Authorization: getWebDavAuthHeader(settings) };
  for (const segment of getWebDavPathSegments(settings, additional)) {
    currentUrl = `${currentUrl}/${encodeURIComponent(segment)}`;
    const resp = await http("MKCOL", currentUrl, headers);
    if (![200, 201, 204, 301, 405].includes(resp.status)) {
      throw new Error(`WebDAV MKCOL failed: ${resp.status}`);
    }
  }
  return currentUrl;
}

export async function uploadWebDavFile(
  settings: PanelSettings,
  url: string,
  content: string,
  options: { encrypt?: boolean } = {},
): Promise<void> {
  const body = options.encrypt === false ? content : await encryptBackupContent(settings, content, url);
  const resp = await http("PUT", url, {
    Authorization: getWebDavAuthHeader(settings),
    "Content-Type": "application/octet-stream",
  }, body);
  if (!resp.ok) throw new Error(`WebDAV upload failed: ${resp.status}`);
}

export async function deleteWebDavPath(settings: PanelSettings, url: string): Promise<void> {
  const resp = await http("DELETE", url, { Authorization: getWebDavAuthHeader(settings) });
  if (![200, 204, 404].includes(resp.status)) throw new Error(`WebDAV delete failed: ${resp.status}`);
}

export async function readWebDavManifest(settings: PanelSettings, manifestUrl: string): Promise<Array<{ name: string; createdAt: string }>> {
  const resp = await http("GET", manifestUrl, { Authorization: getWebDavAuthHeader(settings) });
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`WebDAV manifest read failed: ${resp.status}`);
  const payload = JSON.parse(resp.body) as { backups?: Array<{ name?: string; createdAt?: string }> };
  return Array.isArray(payload.backups)
    ? payload.backups
        .filter((e) => typeof e.name === "string" && typeof e.createdAt === "string")
        .map((e) => ({ name: e.name as string, createdAt: e.createdAt as string }))
    : [];
}

export async function downloadWebDavFile(
  settings: PanelSettings,
  url: string,
  options: { allowLegacyPlaintext?: boolean; legacyEncryptionPassword?: string } = {},
): Promise<string | null> {
  const resp = await http("GET", url, { Authorization: getWebDavAuthHeader(settings) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`WebDAV download failed: ${resp.status}`);
  return decryptBackupContent(
    settings,
    resp.body,
    url,
    options.allowLegacyPlaintext === true,
    options.legacyEncryptionPassword,
  );
}

export async function pruneWebDavBackups(
  settings: PanelSettings,
  manifestUrl: string,
  currentEntries: Array<{ name: string; createdAt: string }>,
): Promise<void> {
  const sorted = [...currentEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const obsolete = sorted.slice(settings.backup_retention_count);
  await Promise.all(obsolete.map((e) => deleteWebDavPath(settings, buildWebDavUrl(settings, [e.name]))));
  const kept = sorted.slice(0, settings.backup_retention_count);
  await uploadWebDavFile(settings, manifestUrl, JSON.stringify({ backups: kept }, null, 2), { encrypt: false });
}

export async function testWebDavConnection(settings: PanelSettings): Promise<{ ok: true; target: string }> {
  const target = buildWebDavUrl(settings);
  const resp = await http("PROPFIND", target, { Authorization: getWebDavAuthHeader(settings), Depth: "0" });
  if (resp.status === 404) {
    const ensured = await ensureWebDavCollection(settings);
    return { ok: true, target: ensured };
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`WebDAV 认证失败 (${resp.status})：请检查用户名和密码。`);
  }
  if (resp.status === 429) {
    throw new Error("WebDAV 服务器限流 (429)：请求过于频繁，请稍后再试。");
  }
  if (!resp.ok) throw new Error(`WebDAV test failed: ${resp.status}`);
  return { ok: true, target };
}
