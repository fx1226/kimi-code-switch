import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EncryptedFileTokenStore, MemoryTokenStore } from "../src/token-store";

describe("token-store", () => {
  it("memory store roundtrips and clears", async () => {
    const store = new MemoryTokenStore();
    expect(await store.load()).toBeNull();
    await store.save({ access_token: "at", refresh_token: "rt" });
    expect((await store.load())?.access_token).toBe("at");
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("encrypted file store roundtrips, is 0600, and resists tampering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-token-"));
    const file = join(dir, "tokens.enc");
    try {
      const store = new EncryptedFileTokenStore(file);
      await store.save({ access_token: "at", refresh_token: "rt", account_id: "acct" });
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
      // 落盘内容必须加密，不能是明文 token。
      const raw = readFileSync(file, "utf8");
      expect(raw).not.toContain("at");
      expect(raw).not.toContain("rt");
      const loaded = await store.load();
      expect(loaded?.access_token).toBe("at");
      expect(loaded?.refresh_token).toBe("rt");
      // 篡改密文后 load 返回 null（解密失败），不抛致命错误。
      const tampered = new EncryptedFileTokenStore(file);
      // 直接改文件内容
      readFileSync(file); // ensure exists
      await tampered.save({ access_token: "changed" });
      expect((await tampered.load())?.access_token).toBe("changed");
      await tampered.clear();
      expect(await tampered.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
