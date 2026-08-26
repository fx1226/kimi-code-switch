import type { AppState } from "@shared/types";

/**
 * C1 保存请求串行化 / latest-wins 协调器。
 *
 * 设计（对应当前单笔 save journal 约束）：
 * - 队列在任何时刻只有一笔 active save（drain 逐项串行执行）。
 * - immediate（即时偏好）在队尾合并：若队尾是 immediate 则整体覆盖为最新，中间版本不落盘。
 * - explicit（显式 Save）不可丢弃：追加进队，且返回的 Promise 以该笔真实落盘结果 resolve。
 * - 一笔完成/失败后队列若还有后项，立即继续，不重复保存中间版本。
 * - `waitForExplicitFlush` 供关闭窗口/环境切换前等待全部显式保存确认。
 *
 * 纯 TS、无 React/DOM 依赖，便于单测。
 */

export type PendingSave =
  | { kind: "immediate"; visible: AppState; saved: AppState }
  | { kind: "explicit"; state: AppState };

interface QueueItem {
  save: PendingSave;
  /** 仅 explicit 存在：真实落盘结果回调。 */
  resolve?: (ok: boolean) => void;
}

export interface SaveCoordinator {
  readonly hasPendingWork: boolean;
  /** explicit 返回 Promise<boolean>；immediate 返回 void。 */
  submit(save: PendingSave): Promise<boolean> | void;
  /** 等待已提交的显式保存全部确认（供关闭/环境切换前调用）。 */
  waitForExplicitFlush(): Promise<void>;
  readonly pendingCount: number;
}

interface CoordinatorState {
  queue: QueueItem[];
  running: boolean;
  flushWaiters: Array<() => void>;
}

export function createSaveCoordinator(
  execute: (save: PendingSave) => Promise<boolean>,
): SaveCoordinator {
  const state: CoordinatorState = {
    queue: [],
    running: false,
    flushWaiters: [],
  };

  const notifyFlush = (): void => {
    const waiters = state.flushWaiters;
    state.flushWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const drain = async (): Promise<void> => {
    while (state.queue.length > 0) {
      const item = state.queue.shift()!;
      let okay = false;
      try {
        okay = await execute(item.save);
      } catch {
        okay = false;
      }
      // 显式保存必须把结果回传给调用方。
      if (item.resolve) {
        item.resolve(okay);
      }
    }
    state.running = false;
    if (state.queue.length === 0) {
      notifyFlush();
    }
  };

  const kick = (): void => {
    if (state.running) {
      return;
    }
    state.running = true;
    // 延迟到微任务之后开始 drain，让同一同步批次内的 immediate 合并先完成。
    queueMicrotask(() => {
      void drain();
    });
  };

  return {
    get hasPendingWork(): boolean {
      return state.running || state.queue.length > 0;
    },
    get pendingCount(): number {
      return state.queue.length + (state.running ? 1 : 0);
    },

    submit(save: PendingSave): Promise<boolean> | void {
      if (save.kind === "explicit") {
        const promise = new Promise<boolean>((resolve) => {
          state.queue.push({ save, resolve });
        });
        kick();
        return promise;
      }

      // immediate：队尾若也是 immediate 则合并为最新（config 序列化相同类型）。
      const tail = state.queue[state.queue.length - 1];
      if (tail && tail.save.kind === "immediate") {
        tail.save = save;
      } else {
        state.queue.push({ save });
      }
      kick();
      return undefined;
    },

    async waitForExplicitFlush(): Promise<void> {
      if (!state.running && state.queue.length === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        state.flushWaiters = [...state.flushWaiters, resolve];
      });
    },
  };
}
