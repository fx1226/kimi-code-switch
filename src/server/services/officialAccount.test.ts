import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOfficialAccountStatus } from "./officialAccount";

let directory: string;
let home: string;
const nowMs = 1_800_000_000_000;
const token = { access_token: "test-access-do-not-return", refresh_token: "test-refresh-do-not-return", expires_at: nowMs / 1000 + 3600, scope: "openid", token_type: "Bearer", expires_in: 3600 };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "switch-account-state-"));
  home = join(directory, "native");
  mkdirSync(home);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
function read(extra: Partial<Parameters<typeof readOfficialAccountStatus>[0]> = {}) {
  return readOfficialAccountStatus({ homePath: home, cliVersion: "2.0.0", nowMs, env: {}, ...extra });
}
function saveToken(name = "kimi-code", value: unknown = token): string {
  mkdirSync(join(home, "credentials"), { recursive: true });
  const path = join(home, "credentials", `${name}.json`);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

describe("official local account state", () => {
  it("reports missing without creating files or invoking a network request", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    expect(await read()).toMatchObject({ status: "missing", source: "official-2.0-local-files", remoteValidated: false });
    expect(readdirSync(home)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it("reports stored credentials without revealing or rewriting them", async () => {
    const path = saveToken();
    const before = readFileSync(path);
    const metadata = statSync(path);
    const state = await read();
    expect(state).toMatchObject({ status: "stored", remoteValidated: false });
    expect(Object.keys(state).sort()).toEqual(["message", "remoteValidated", "source", "status"]);
    expect(JSON.stringify(state)).not.toMatch(/test-access|test-refresh|openid|Bearer/);
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mtimeMs).toBe(metadata.mtimeMs);
  });

  it("distinguishes expired, official revoked tombstones and invalid documents", async () => {
    saveToken("kimi-code", { ...token, expires_at: nowMs / 1000 });
    expect((await read()).status).toBe("expired");
    saveToken("kimi-code", { ...token, access_token: "", refresh_token: "", expires_at: 0, expires_in: 0 });
    expect((await read()).status).toBe("revoked");
    saveToken("kimi-code", { access_token: "test-secret-in-invalid-shape" });
    const invalid = await read();
    expect(invalid.status).toBe("invalid");
    expect(JSON.stringify(invalid)).not.toContain("test-secret");
    writeFileSync(join(home, "credentials", "kimi-code.json"), '{"access_token":"test-corrupt-secret"');
    expect(JSON.stringify(await read())).not.toContain("test-corrupt-secret");
  });

  it("uses the official global endpoint slot, including a stale configured key", async () => {
    writeFileSync(join(home, "config.toml"), '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\noauth = { storage = "file", key = "oauth/kimi-code", oauth_host = "https://auth.kimi.ai" }\n');
    saveToken();
    expect((await read()).status).toBe("missing");
    // Pinned upstream resolveKimiCodeOAuthKey fixture: sha256 of ordered endpoint object.
    saveToken("kimi-code-env-0e4f99c69cc27850");
    expect((await read()).status).toBe("stored");
  });

  it("applies runtime endpoint overrides without exposing or probing the endpoint", async () => {
    saveToken();
    const env = { KIMI_CODE_BASE_URL: "https://api.example.test/v1/", KIMI_CODE_OAUTH_HOST: "https://auth.example.test/" };
    expect((await read({ env })).status).toBe("missing");
    saveToken("kimi-code-env-ce535bc545683646");
    const state = await read({ env });
    expect(state.status).toBe("stored");
    expect(JSON.stringify(state)).not.toContain("example.test");
  });

  it("leaves unsupported storage and unverified versions to the official client", async () => {
    writeFileSync(join(home, "config.toml"), '[providers."managed:kimi-code"]\noauth = { storage = "keyring", key = "oauth/kimi-code" }\n');
    saveToken();
    expect((await read()).status).toBe("unavailable");
    expect((await read({ cliVersion: "2.0.1" })).status).toBe("unavailable");
    expect((await read({ cliVersion: null })).status).toBe("unavailable");
  });

  it("does not mistake unreadable config or an escaping symlink for a logged-out account", async () => {
    writeFileSync(join(home, "config.toml"), 'secret = "test-invalid-config-secret');
    let state = await read();
    expect(state.status).toBe("invalid");
    expect(JSON.stringify(state)).not.toContain("test-invalid");
    rmSync(join(home, "config.toml"));
    const outside = join(directory, "outside.json");
    writeFileSync(outside, JSON.stringify(token));
    mkdirSync(join(home, "credentials"));
    symlinkSync(outside, join(home, "credentials", "kimi-code.json"));
    state = await read();
    expect(state.status).toBe("unavailable");
    expect(JSON.stringify(state)).not.toContain(token.access_token);
  });
});
