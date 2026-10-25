/** Cooperative exclusion only. Web Locks do not revoke central capabilities. */
export interface ReplayOwnershipLease {
  readonly name: string;
  isHeld(): boolean;
  release(): void;
}

/** Narrow browser boundary, injectable without replacing ownership logic. */
export interface ReplayLockManager {
  request(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<void>,
  ): Promise<unknown>;
}

export const replayIntentLockName = (idempotencyKey: string) => `epic-replay:intent:${idempotencyKey}`;
export const replayRecordingLockName = (recordingId: string) => `epic-replay:recording:${recordingId}`;

function browserLocks(): ReplayLockManager | null {
  try {
    return typeof navigator === "undefined" ? null : navigator.locks ?? null;
  } catch {
    return null;
  }
}

/**
 * Holds the browser lock until release (or owner cancellation), not merely
 * until this acquisition promise resolves. An unsupported API fails closed.
 * The caller must stop every producer before release; the lease is not a
 * server fence and cannot cancel an already accepted request.
 */
export function acquireReplayOwnership(
  name: string,
  {
    locks = browserLocks(),
    signal,
    timeoutMs = 1_000,
  }: { locks?: ReplayLockManager | null; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReplayOwnershipLease | null> {
  if (!locks || signal?.aborted || !name || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const pending = new AbortController();
    let settled = false;
    let held = false;
    let releaseCallback: (() => void) | undefined;
    const complete = (lease: ReplayOwnershipLease | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(lease);
    };
    const release = () => {
      held = false;
      releaseCallback?.();
      releaseCallback = undefined;
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      pending.abort();
      release();
      complete(null);
    };
    const deadline = setTimeout(cancel, Math.min(timeoutMs, 30_000));
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      void locks.request(name, { mode: "exclusive", signal: pending.signal }, async (lock) => {
        if (!lock || lock.name !== name || settled || signal?.aborted || pending.signal.aborted) {
          complete(null);
          return;
        }
        held = true;
        const lifetime = new Promise<void>((done) => { releaseCallback = done; });
        complete({ name, isHeld: () => held, release });
        await lifetime;
      }).catch(() => {
        release();
        complete(null);
      }).finally(() => {
        if (!held) signal?.removeEventListener("abort", cancel);
      });
    } catch {
      cancel();
    }
  });
}
