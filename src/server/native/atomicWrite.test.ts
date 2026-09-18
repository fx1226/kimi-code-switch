import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, sha256Text } from "./fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});

let directory: string;
let target: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "switch-atomic-"));
  target = join(directory, "config.toml");
  fs.writeFileSync(target, "before");
});
afterEach(() => { vi.resetAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe("atomic write external changes", () => {
  it("rechecks the expected hash after staging and preserves the external edit", async () => {
    const original = (await vi.importActual<typeof import("node:fs")>("node:fs")).fsyncSync;
    let once = true;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      original(fd);
      if (once) { once = false; fs.writeFileSync(target, "external"); }
    });
    expect(() => atomicWriteText(target, "ours", sha256Text("before"))).toThrow(/write conflict/);
    expect(fs.readFileSync(target, "utf8")).toBe("external");
    expect(fs.readdirSync(directory)).toEqual(["config.toml"]);
  });
  it("reports a post-rename change instead of claiming successful persistence", async () => {
    const original = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      original(source, destination);
      fs.writeFileSync(target, "external-after");
    });
    expect(() => atomicWriteText(target, "ours", sha256Text("before"))).toThrow(/write verification failed/);
    expect(fs.readFileSync(target, "utf8")).toBe("external-after");
  });
});
