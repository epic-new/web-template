import type { PublicReplayConfig } from "./replay-config.contract";

/** Pilot defaults, configurable locally; not additions to the strict central v1 schema. */
export interface ReplayLifecycleOptions {
  maxDurationMs: number;
  inactivityMs: number;
  handoffWindowMs: number;
}
export const REPLAY_LIFECYCLE_DEFAULTS: Readonly<ReplayLifecycleOptions> = Object.freeze({
  maxDurationMs: 30 * 60_000, inactivityMs: 5 * 60_000, handoffWindowMs: 15_000,
});

export function replayLifecycleOptions(input: Partial<ReplayLifecycleOptions> = {}): ReplayLifecycleOptions {
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
    Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
  const maxDurationMs = bounded(input.maxDurationMs, REPLAY_LIFECYCLE_DEFAULTS.maxDurationMs, 60_000, 60 * 60_000);
  return Object.freeze({
    maxDurationMs,
    inactivityMs: Math.min(maxDurationMs, bounded(input.inactivityMs, REPLAY_LIFECYCLE_DEFAULTS.inactivityMs, 30_000, 15 * 60_000)),
    handoffWindowMs: bounded(input.handoffWindowMs, REPLAY_LIFECYCLE_DEFAULTS.handoffWindowMs, 1_000, 30_000),
  });
}

export function publicDocumentRelease(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._+\-/]+$/.test(value) ? value : null;
}

/** Refreshed receipt times and the backend's release never retag document context. */
export function replayContextFingerprint(policy: PublicReplayConfig, options: ReplayLifecycleOptions): string {
  return JSON.stringify({
    configVersion: policy.configVersion, environment: policy.environment,
    capture: policy.capture, recording: policy.recording, lifecycle: options,
  });
}

export interface ReplayRecoveryBudget {
  debt: number;
  take(limit: number): boolean;
  acknowledged(recordingId: string, acceptedBatches: number, postOpeningBatches: number, now: number): void;
  interrupt(): void;
  reset(): void;
}

export function createReplayRecoveryBudget(initialDebt = 0): ReplayRecoveryBudget {
  let healthy: { id: string; since: number } | null = null;
  return {
    debt: Math.max(0, Math.min(3, initialDebt)),
    take(limit) {
      healthy = null;
      if (this.debt >= Math.min(3, limit)) return false;
      this.debt++;
      return true;
    },
    acknowledged(id, accepted, postOpening, now) {
      if (!healthy || healthy.id !== id) healthy = { id, since: now };
      if (accepted >= 3 && postOpening > 0 && now - healthy.since >= 30_000) this.reset();
    },
    // Retain recovery debt across pauses, but never count unresolved identity
    // or detached capture toward a healthy recording's progress threshold.
    interrupt() { healthy = null; },
    reset() { this.debt = 0; healthy = null; },
  };
}
