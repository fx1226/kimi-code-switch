// fs.ts 聚焦测试：全部在 os.tmpdir() 下的临时目录进行，绝不触碰 ~/.kimi-code 真实目录。
import { describe, expect, it, beforeEach } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  authorizeMutation,
  clearDurableGrants,
  exportPortableDirectoryAt,
  fsCommands,
  getBackupEncryptionSecretCandidatesAt,
  getDurableGrantsState,
  getOrCreateBackupEncryptionSecretAt,
  importBackupEncryptionSecretAt,
  isValidBackupEncryptionSecret,
  managedEnvironmentHomesFromPanelSettingsAt,
  quarantineJournalAtHome,
  reconcileDurableGrantsInner,
  registerDurableGrant,
  replacePortableDirectoryInner,
  saveDurableGrantTo,
  sha256Text,
  type GrantRecord,
} from "./fs";

const IS_UNIX = process.platform !== "win32";

function grantedBase(tag: string): string {
  const base = mkdtempSync(join(tmpdir(), `kimi-fs-${tag}-`));
  registerDurableGrant(base, "DirectoryTree", "dialog");
  return base;
}

beforeEach(() => {
  clearDurableGrants();
});

describe("read_text / write_text / atomic write", () => {
  it("read_text returns null for missing files and content for existing files", () => {
    const base = grantedBase("read");
    const file = join(base, "a.txt");
    expect(fsCommands.read_text({ path: file })).toBeNull();
    writeFileSync(file, "hello");
    expect(fsCommands.read_text({ path: file })).toBe("hello");
  });

  it("write_text creates and overwrites atomically, cleaning up temp files", () => {
    const base = grantedBase("write");
    const file = join(base, "config.toml");
    fsCommands.write_text({ path: file, content: "first" });
    expect(readFileSync(file, "utf8")).toBe("first");
    fsCommands.write_text({ path: file, content: "second" });
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(readdirSync(base).length).toBe(1); // no leftover temp
  });

  it("preserves existing permissions on atomic overwrite and applies 0600 to new files", () => {
    const base = grantedBase("perm");
    const file = join(base, "config.toml");
    writeFileSync(file, "old");
    if (IS_UNIX) chmodSync(file, 0o640);
    fsCommands.write_text({ path: file, content: "new-complete" });
    expect(readFileSync(file, "utf8")).toBe("new-complete");
    if (IS_UNIX) {
      expect(statSync(file).mode & 0o777).toBe(0o640);
      expect(readdirSync(base).length).toBe(1);
    }
    const fresh = join(base, "fresh.txt");
    fsCommands.write_text({ path: fresh, content: "hi" });
    if (IS_UNIX) expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it("writes through a file symlink target and keeps the symlink (unix)", () => {
    if (!IS_UNIX) return;
    const base = grantedBase("symlink-write");
    const target = join(base, "target.txt");
    writeFileSync(target, "old");
    const link = join(base, "config.toml");
    symlinkSync(target, link);
    fsCommands.write_text({ path: link, content: "new" });
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe("write_text_cas semantics", () => {
  it("empty expectedSha256 means create-only; non-empty means compare-and-swap", () => {
    const base = grantedBase("cas");
    const file = join(base, "mcp.json");
    // create-only on absent file succeeds
    fsCommands.write_text_cas({ path: file, content: "created", expectedSha256: "" });
    expect(readFileSync(file, "utf8")).toBe("created");
    // create-only on existing file conflicts
    expect(() => fsCommands.write_text_cas({ path: file, content: "again", expectedSha256: "" }))
      .toThrow(/write conflict/);
    expect(readFileSync(file, "utf8")).toBe("created");
    // CAS with matching hash returns the new sha256
    const written = fsCommands.write_text_cas({ path: file, content: "new", expectedSha256: sha256Text("created") });
    expect(written).toBe(sha256Text("new"));
    // stale revision rejected without changing the file
    expect(() => fsCommands.write_text_cas({ path: file, content: "x", expectedSha256: "deadbeef" }))
      .toThrow(/write conflict/);
    expect(readFileSync(file, "utf8")).toBe("new");
  });
});

describe("ensure_dir / ensure_private_dir / listing", () => {
  it("creates nested directories and private 0700 directories", () => {
    const base = grantedBase("dirs");
    fsCommands.ensure_dir({ path: join(base, "a", "b", "c") });
    expect(statSync(join(base, "a", "b", "c")).isDirectory()).toBe(true);
    fsCommands.ensure_private_dir({ path: join(base, "private") });
    if (IS_UNIX) expect(statSync(join(base, "private")).mode & 0o777).toBe(0o700);
  });

  it("list_dir / list_dir_typed / list_subdirs and tolerate missing directories", () => {
    const base = grantedBase("list");
    mkdirSync(join(base, "sub"), { recursive: true });
    writeFileSync(join(base, "f.txt"), "x");
    const names = (fsCommands.list_dir({ path: base }) as string[]).sort();
    expect(names).toEqual(["f.txt", "sub"].sort());
    const typed = fsCommands.list_dir_typed({ path: base }) as Array<{ name: string; isDirectory: boolean }>;
    expect(typed.find((e) => e.name === "sub")?.isDirectory).toBe(true);
    expect(typed.find((e) => e.name === "f.txt")?.isDirectory).toBe(false);
    expect((fsCommands.list_subdirs({ path: base }) as string[])).toContain("sub");
    expect(fsCommands.list_dir({ path: join(base, "nope") })).toEqual([]);
    expect(fsCommands.list_dir_typed({ path: join(base, "nope") })).toEqual([]);
  });
});

describe("copy / merge / move / remove", () => {
  it("copy_dir copies recursively", () => {
    const base = grantedBase("copy");
    mkdirSync(join(base, "from", "nested"), { recursive: true });
    writeFileSync(join(base, "from", "a.txt"), "a");
    writeFileSync(join(base, "from", "nested", "b.txt"), "b");
    fsCommands.copy_dir({ from: join(base, "from"), to: join(base, "to") });
    expect(readFileSync(join(base, "to", "nested", "b.txt"), "utf8")).toBe("b");
  });

  it("merge_directory_missing copies only missing entries and reports conflicts", () => {
    const base = grantedBase("merge");
    mkdirSync(join(base, "legacy", "nested"), { recursive: true });
    mkdirSync(join(base, "native"), { recursive: true });
    writeFileSync(join(base, "legacy", "same.md"), "legacy");
    writeFileSync(join(base, "legacy", "legacy-only.md"), "legacy only");
    writeFileSync(join(base, "legacy", "nested", "SKILL.md"), "nested");
    writeFileSync(join(base, "native", "same.md"), "native");
    const result = fsCommands.merge_directory_missing({
      from: join(base, "legacy"),
      to: join(base, "native"),
    }) as { sourceExists: boolean; copiedEntries: number; skippedConflicts: number };
    expect(readFileSync(join(base, "native", "same.md"), "utf8")).toBe("native");
    expect(readFileSync(join(base, "native", "legacy-only.md"), "utf8")).toBe("legacy only");
    expect(readFileSync(join(base, "native", "nested", "SKILL.md"), "utf8")).toBe("nested");
    expect(result.sourceExists).toBe(true);
    expect(result.skippedConflicts).toBe(1);
    expect(result.copiedEntries).toBeGreaterThanOrEqual(2);
  });

  it("move_file moves across directories and rejects missing sources", () => {
    const base = grantedBase("move");
    writeFileSync(join(base, "a.txt"), "content");
    fsCommands.move_file({ from: join(base, "a.txt"), to: join(base, "b.txt") });
    expect(existsSync(join(base, "a.txt"))).toBe(false);
    expect(readFileSync(join(base, "b.txt"), "utf8")).toBe("content");
    expect(() => fsCommands.move_file({ from: join(base, "none.txt"), to: join(base, "c.txt") }))
      .toThrow(/Source file does not exist/);
  });

  it("remove_file is idempotent and remove_file_cas only deletes the written revision", () => {
    const base = grantedBase("remove");
    writeFileSync(join(base, "a.txt"), "data");
    fsCommands.remove_file({ path: join(base, "a.txt") });
    expect(existsSync(join(base, "a.txt"))).toBe(false);
    fsCommands.remove_file({ path: join(base, "missing.txt") }); // silent
    writeFileSync(join(base, "b.txt"), "rev1");
    expect(() => fsCommands.remove_file_cas({ path: join(base, "b.txt"), expectedSha256: "stale" }))
      .toThrow(/write conflict/);
    expect(existsSync(join(base, "b.txt"))).toBe(true);
    fsCommands.remove_file_cas({ path: join(base, "b.txt"), expectedSha256: sha256Text("rev1") });
    expect(existsSync(join(base, "b.txt"))).toBe(false);
  });

  it("remove_dir recursively deletes and tolerates missing directories", () => {
    const base = grantedBase("rmdir");
    mkdirSync(join(base, "dir", "sub"), { recursive: true });
    writeFileSync(join(base, "dir", "sub", "f.txt"), "x");
    fsCommands.remove_dir({ path: join(base, "dir") });
    expect(existsSync(join(base, "dir"))).toBe(false);
    fsCommands.remove_dir({ path: join(base, "missing") });
  });
});

describe("path helpers", () => {
  it("resolve_home_path expands a leading ~", () => {
    expect(fsCommands.resolve_home_path({ path: "~/.kimi-code/config.toml" }))
      .toBe(join(homedir(), ".kimi-code", "config.toml"));
  });

  it("path_exists / real_path behave correctly", () => {
    const base = grantedBase("real");
    writeFileSync(join(base, "f.txt"), "x");
    expect(fsCommands.path_exists({ path: join(base, "f.txt") })).toBe(true);
    expect(fsCommands.path_exists({ path: join(base, "missing") })).toBe(false);
    const rp = fsCommands.real_path({ path: join(base, "f.txt") }) as string;
    expect(existsSync(rp)).toBe(true);
    expect(() => fsCommands.real_path({ path: join(base, "missing.txt") })).toThrow();
  });

  it("hostname / get_kimi_code_home return strings", () => {
    expect((fsCommands.hostname({}) as string).length).toBeGreaterThan(0);
    expect(typeof fsCommands.get_kimi_code_home({})).toBe("string");
  });
});

describe("authorization (B1)", () => {
  it("rejects writes outside the managed roots and durable grants", () => {
    const outside = mkdtempSync(join(tmpdir(), "kimi-fs-outside-"));
    const file = join(outside, "x.txt");
    expect(() => fsCommands.write_text({ path: file, content: "x" }))
      .toThrow(/outside the authorized scope/);
  });

  it("rejects symlink escape via a granted directory (unix)", () => {
    if (!IS_UNIX) return;
    const base = grantedBase("escape");
    const outside = mkdtempSync(join(tmpdir(), "kimi-fs-escape-target-"));
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "secret");
    const link = join(base, "link");
    symlinkSync(outsideFile, link);
    expect(() => fsCommands.write_text({ path: link, content: "x" }))
      .toThrow(/outside the authorized scope/);
  });

  it("honors DirectoryTree grants for nested file writes", () => {
    const base = grantedBase("granted");
    fsCommands.write_text({ path: join(base, "backups", "2026", "config.toml"), content: "ok" });
    expect(readFileSync(join(base, "backups", "2026", "config.toml"), "utf8")).toBe("ok");
  });
});

describe("quarantine_journal", () => {
  it("moves files to the quarantine dir with private permissions and is idempotent", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kimi-fs-qhome-"));
    const missing = join(fakeHome, ".kimi-code-switch-gui", "missing.json");
    expect(quarantineJournalAtHome(missing, fakeHome)).toBe("");
    const src = join(fakeHome, ".kimi-code-switch-gui", "pending-save-transaction.json");
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, "{bad-json");
    const quarantined = quarantineJournalAtHome(src, fakeHome);
    expect(quarantined).toContain("quarantine");
    expect(existsSync(src)).toBe(false);
    if (IS_UNIX) {
      expect(statSync(quarantined).mode & 0o777).toBe(0o600);
      expect(statSync(join(fakeHome, ".kimi-code-switch-gui", "quarantine")).mode & 0o777).toBe(0o700);
    }
  });
});

describe("portable directory round trip", () => {
  it("exports and restores binary files and rejects traversal", () => {
    const base = grantedBase("portable");
    const source = join(base, "skills");
    mkdirSync(join(source, "demo", "assets"), { recursive: true });
    writeFileSync(join(source, "demo", "SKILL.md"), "# Demo\n");
    writeFileSync(join(source, "demo", "assets", "icon.bin"), Buffer.from([0, 255, 7, 9]));
    if (IS_UNIX) chmodSync(join(source, "demo", "SKILL.md"), 0o700);

    const bundle = exportPortableDirectoryAt(source);
    expect(bundle.exists).toBe(true);
    expect(bundle.files.length).toBe(2);

    const target = join(base, "restored-skills");
    const absentRev = exportPortableDirectoryAt(target).sha256;
    replacePortableDirectoryInner(target, bundle, absentRev, getDurableGrantsState());
    expect(readFileSync(join(target, "demo", "assets", "icon.bin"))).toEqual(Buffer.from([0, 255, 7, 9]));
    if (IS_UNIX) {
      expect(statSync(join(target, "demo", "SKILL.md")).mode & 0o111).toBe(0o100);
    }

    const malicious = {
      exists: true,
      directories: [],
      files: [{ relativePath: "../escape", contentBase64: Buffer.from("nope").toString("base64"), executable: false }],
      sha256: null,
    };
    expect(() => replacePortableDirectoryInner(target, malicious, null, getDurableGrantsState()))
      .toThrow(/invalid portable relative path/);
    expect(readFileSync(join(target, "demo", "SKILL.md"), "utf8")).toBe("# Demo\n");
  });
});

describe("backup encryption secret", () => {
  it("creates, reuses, imports and lists candidates", () => {
    const appDir = mkdtempSync(join(tmpdir(), "kimi-fs-key-"));
    const secret = getOrCreateBackupEncryptionSecretAt(appDir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(getOrCreateBackupEncryptionSecretAt(appDir)).toBe(secret);
    expect(isValidBackupEncryptionSecret(secret)).toBe(true);
    expect(isValidBackupEncryptionSecret("g".repeat(64))).toBe(false);

    const other = "b".repeat(64);
    const keyPath = importBackupEncryptionSecretAt(appDir, other, true);
    expect(readFileSync(join(appDir, "backup-encryption.key"), "utf8")).toBe(other);
    expect(keyPath).toContain("backup-encryption.key");
    const candidates = getBackupEncryptionSecretCandidatesAt(appDir);
    expect(candidates).toContain(other);
    expect(() => importBackupEncryptionSecretAt(appDir, "short", true))
      .toThrow(/exactly 64 hexadecimal/);
  });
});

describe("durable grant reconcile", () => {
  it("rebuilds grants from the durable store and only trusts in-scope managed environment homes", () => {
    const base = mkdtempSync(join(tmpdir(), "kimi-fs-reconcile-"));
    const homeDir = join(base, "home");
    mkdirSync(join(homeDir, ".kimi-code"), { recursive: true });
    // macOS 的 /var → /private/var 是 symlink：注入的 home 需 canonical，否则 canonical 后的
    // homePath 不再 starts_with 未解析的 home（与 Rust 测试同注）。
    const home = realpathSync(homeDir);
    const storeFile = join(base, "access-grants.json");
    const backup = join(base, "backups");
    mkdirSync(backup, { recursive: true });
    saveDurableGrantTo(storeFile, {
      root: realpathSync(backup),
      kind: "DirectoryTree",
      source: "dialog",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const state: GrantRecord[] = [];
    reconcileDurableGrantsInner(state, storeFile, home, null);
    expect(authorizeMutation(state, join(backup, "a.toml"), "SingleFile")).toBeTruthy();

    // 越界 home 即使存在也不产生授权。
    const outOfBounds = join(base, "custom-home");
    mkdirSync(outOfBounds, { recursive: true });
    const managed = realpathSync(join(home, ".kimi-code"));
    const settings = JSON.stringify({
      kimi_code_environments: [
        { homePath: managed },
        { homePath: outOfBounds },
        { homePath: "" },
      ],
    });
    const homes = managedEnvironmentHomesFromPanelSettingsAt(settings, home);
    expect(homes).toEqual([managed]);
  });
});
