import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDurableGrants, registerDurableGrant } from "../native/fs";
import { createConfigurationService } from "./index";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  clearDurableGrants();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
it("keeps the recovery gate when an earlier rolled-back file changes before the batch rollback ends", async () => {
  root = fs.mkdtempSync(join(tmpdir(), "kimi-rollback-race-"));
  const home = join(root, "native");
  const dataDir = join(root, "private");
  fs.mkdirSync(home);
  registerDurableGrant(root, "DirectoryTree", "dialog");
  const config = join(home, "config.toml");
  const tui = join(home, "tui.toml");
  const original = 'fixture_label = "old"\n';
  fs.writeFileSync(config, original);
  fs.writeFileSync(tui, original);
  const service = createConfigurationService({ dataDir, fault(point) {
    if (point === "before-complete") throw new Error("injected finalization failure");
  } });
  const requests = await Promise.all((["config", "tui"] as const).map(async resource => ({
    resource, expectedRevision: (await service.read({ home }, resource)).revision,
    changes: [{ op: "set" as const, path: ["fixture_label"], value: "new" }],
  })));
  const plan = await service.planBatch({ home }, requests);
  const realRename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    realRename(from, to);
    // Reverse rollback restores tui first, then config. Simulate an external
    // editor changing tui while the last file is being restored.
    if (String(to) === fs.realpathSync(config) && fs.readFileSync(config, "utf8") === original) {
      fs.writeFileSync(tui, 'fixture_label = "external"\n');
    }
  });
  const operation = await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
  expect(operation.status).toBe("recovery-required");
  expect(fs.readFileSync(config, "utf8")).toBe(original);
  expect(fs.readFileSync(tui, "utf8")).toContain('"external"');
  expect(fs.existsSync(join(dataDir, "configuration-journals", `${plan.id}.json`))).toBe(true);
  expect((await service.getRecoveryState()).blocked).toBe(true);
});
