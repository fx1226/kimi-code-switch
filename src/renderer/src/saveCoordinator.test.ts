import { describe, expect, it, vi } from "vitest";

import { createSaveCoordinator } from "./saveCoordinator";
import type { PendingSave } from "./saveCoordinator";

function makeState(marker: string): { marker: string } {
  return { marker };
}

describe("createSaveCoordinator (C1 serialization / latest-wins)", () => {
  it("runs explicit saves sequentially and resolves each with its real result", async () => {
    const executed: string[] = [];
    let counter = 0;
    const coordinator = createSaveCoordinator(async (save) => {
      if (save.kind === "explicit") {
        const marker = (save.state as { marker: string }).marker;
        executed.push(marker);
        counter += 1;
        return counter >= 2 ? false : true;
      }
      return true;
    });

    const first = coordinator.submit({ kind: "explicit", state: makeState("a") }) as Promise<boolean>;
    const second = coordinator.submit({ kind: "explicit", state: makeState("b") }) as Promise<boolean>;

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(executed).toEqual(["a", "b"]);
  });

  it("coalesces a burst of immediate saves into the final value only (latest-wins)", async () => {
    const executed: Array<string | undefined> = [];
    const coordinator = createSaveCoordinator(async (save) => {
      if (save.kind === "immediate") {
        executed.push((save.visible as { marker: string }).marker);
      }
      return true;
    });

    // 同步提交 100 次高频即时偏好，只有最终值应落盘。
    for (let index = 0; index < 100; index += 1) {
      coordinator.submit({ kind: "immediate", visible: makeState(`v${index}`), saved: makeState(`v${index}`) });
    }
    await coordinator.waitForExplicitFlush();
    expect(executed).toEqual(["v99"]);
  });

  it("writes the latest state again when a new state arrives while a save is in flight", async () => {
    const executed: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const coordinator = createSaveCoordinator((save) => {
      if (save.kind === "immediate") {
        executed.push((save.visible as { marker: string }).marker);
        if (executed.length === 1) {
          return new Promise<boolean>((resolve) => {
            releaseFirst = () => resolve(true);
          });
        }
      }
      return Promise.resolve(true);
    });

    coordinator.submit({ kind: "immediate", visible: makeState("first"), saved: makeState("first") });
    // 等第一笔真正进入执行（in-flight）后再提交第二笔。
    await vi.waitFor(() => expect(executed).toEqual(["first"]));
    coordinator.submit({ kind: "immediate", visible: makeState("second"), saved: makeState("second") });
    releaseFirst?.();
    await coordinator.waitForExplicitFlush();
    expect(executed).toEqual(["first", "second"]);
  });

  it("first save fails but the second update is still persisted", async () => {
    const executed: string[] = [];
    const coordinator = createSaveCoordinator(async (save) => {
      if (save.kind === "explicit") {
        const marker = (save.state as { marker: string }).marker;
        executed.push(marker);
        return marker === "first";
      }
      return true;
    });

    const first = coordinator.submit({ kind: "explicit", state: makeState("first") }) as Promise<boolean>;
    const second = coordinator.submit({ kind: "explicit", state: makeState("second") }) as Promise<boolean>;
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(executed).toEqual(["first", "second"]);
  });

  it("tracks pending work and flushes waiters", async () => {
    const coordinator = createSaveCoordinator(async () => true);
    coordinator.submit({ kind: "immediate", visible: makeState("x"), saved: makeState("x") });
    expect(coordinator.hasPendingWork).toBe(true);
    await coordinator.waitForExplicitFlush();
    expect(coordinator.hasPendingWork).toBe(false);
  });

  it("rejects a thrown executor without dropping the queue", async () => {
    const spy = vi.fn<(save: PendingSave) => Promise<boolean>>();
    spy.mockRejectedValueOnce(new Error("disk full"));
    const coordinator = createSaveCoordinator(spy);
    const first = coordinator.submit({ kind: "explicit", state: makeState("a") }) as Promise<boolean>;
    await expect(first).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
