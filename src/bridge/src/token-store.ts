/**
 * TokenStore：凭据持久化接口。
 *
 * 生产路径（P2+）由 Rust 宿主通过控制通道注入/回收凭据，桥接进程自身
 * 不持久化；本文件提供两种实现供原型/测试使用：
 * - MemoryTokenStore：测试。
 * - EncryptedFileTokenStore：P1 独立原型。文件 0600、AES-256-GCM 加密、
 *   原子写（临时文件 + rename）。只允许出现在隔离的临时/开发目录，
 *   不作为生产持久化路径（生产由 keyring + Rust 宿主承担）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TokenSet } from "./types";

export interface TokenStore {
  load(): Promise<TokenSet | null>;
  save(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private value: TokenSet | null = null;
  async load(): Promise<TokenSet | null> {
    return this.value;
  }
  async save(tokens: TokenSet): Promise<void> {
    this.value = tokens;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}

const KEY = Buffer.from("kimi-switch-gui-bridge-token-store-v1", "utf8").subarray(0, 32);

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payload: string, key: Buffer): string {
  const data = Buffer.from(payload, "base64");
  if (data.length < 12 + 16) throw new Error("malformed encrypted token payload");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export class EncryptedFileTokenStore implements TokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<TokenSet | null> {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return JSON.parse(decrypt(raw, KEY)) as TokenSet;
    } catch {
      return null;
    }
  }

  async save(tokens: TokenSet): Promise<void> {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = join(directory, `.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, encrypt(JSON.stringify(tokens), KEY), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // 文件不存在视为已清理
    }
  }
}
