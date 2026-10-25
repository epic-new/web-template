import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireReplayOwnership, replayRecordingLockName, type ReplayLockManager } from "../replay-ownership";

/** Simulates only the browser lock scheduler; ownership lifecycle is real. */
function lockScheduler(): ReplayLockManager {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, options, callback) {
      const previous = tails.get(name) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return callback({ name });
      });
      tails.set(name, next);
      return next;
    },
  };
}

describe("cooperative replay ownership", () => {
  afterEach(() => vi.useRealTimers());

  it("holds exclusive lifetime ownership until the stopped producer releases", async () => {
    const locks = lockScheduler();
    const name = replayRecordingLockName("recording");
    const first = await acquireReplayOwnership(name, { locks });
    expect(first?.isHeld()).toBe(true);
    let secondAcquired = false;
    const waiting = acquireReplayOwnership(name, { locks }).then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first!.release();
    expect(first!.isHeld()).toBe(false);
    const second = await waiting;
    expect(second?.isHeld()).toBe(true);
    second!.release();
  });

  it("bounds a pending acquisition and never acquires after timeout", async () => {
    vi.useFakeTimers();
    const locks = lockScheduler();
    const first = await acquireReplayOwnership("same", { locks });
    const waiting = acquireReplayOwnership("same", { locks, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toBeNull();
    first!.release();
    await vi.advanceTimersByTimeAsync(0);
    const third = await acquireReplayOwnership("same", { locks });
    expect(third?.isHeld()).toBe(true);
    third!.release();
  });

  it("fails closed for unavailable locks and releases on owner cancellation", async () => {
    expect(await acquireReplayOwnership("same", { locks: null })).toBeNull();
    const controller = new AbortController();
    const locks = lockScheduler();
    const lease = await acquireReplayOwnership("same", { locks, signal: controller.signal });
    controller.abort();
    expect(lease!.isHeld()).toBe(false);
    expect(await acquireReplayOwnership("same", { locks, signal: controller.signal })).toBeNull();
    const next = await acquireReplayOwnership("same", { locks });
    expect(next?.isHeld()).toBe(true);
    next!.release();
  });

  it("normalizes throwing/rejecting browser lock APIs", async () => {
    expect(await acquireReplayOwnership("same", { locks: { request() { throw new Error("blocked"); } } })).toBeNull();
    expect(await acquireReplayOwnership("same", { locks: { request() { return Promise.reject(new Error("blocked")); } } })).toBeNull();
  });
});
