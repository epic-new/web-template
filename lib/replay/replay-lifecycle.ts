import {
  disabledReplayConfig,
  MAX_POLICY_TTL_MS,
  type PublicReplayConfig,
} from "./replay-config.contract";

/**
 * The one place that knows the effective replay policy. A later recorder
 * subscribes here and must consult `getSnapshot()` before recording; nothing
 * in this module starts capture.
 *
 * Expiry is bound to the monotonic clock at the moment a response was
 * received: its lifetime is `expiresAt - fetchedAt` (both server timestamps),
 * clamped to `MAX_POLICY_TTL_MS`, counted from `performance.now()` at receipt.
 * The browser's wall clock is never compared to server time, so a client clock
 * behind the server, or a backward jump after receipt, cannot extend it.
 */

type Listener = (config: PublicReplayConfig) => void;

export interface ReplayPolicyReceipt {
  /** `performance.now()` when the response reached the browser. */
  receivedAt: number;
}

const monotonicNow = () => performance.now();

function unavailable(): PublicReplayConfig {
  return disabledReplayConfig({
    reason: "unavailable",
    environment: null,
    release: null,
    now: Date.now(),
  });
}

let applied: { config: PublicReplayConfig; json: string; receivedAt: number; deadline: number } | null =
  null;
// Set when elapsed time can no longer be trusted (resume, suspension, clock
// jump). Only a policy received after it can enable anything again.
let gatedAt: number | null = null;
let current: PublicReplayConfig = unavailable();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();
const gateListeners = new Set<() => void>();

function effective(): PublicReplayConfig {
  if (!applied) return current.reason === "unavailable" ? current : unavailable();
  const { config, receivedAt, deadline } = applied;
  if (config.status !== "active") return config;
  if (monotonicNow() >= deadline) {
    return disabledReplayConfig({
      reason: "expired",
      environment: config.environment,
      release: config.release,
      now: config.expiresAt,
    });
  }
  if (gatedAt !== null && receivedAt < gatedAt) {
    return disabledReplayConfig({
      reason: "unavailable",
      environment: config.environment,
      release: config.release,
      now: config.fetchedAt,
    });
  }
  return config;
}

function notify() {
  for (const listener of listeners) listener(current);
}

// Recomputes the effective policy. Returns true when it changed.
function evaluate(): boolean {
  const next = effective();
  // Compare the whole policy, not just enablement or version, so a change to
  // routes, privacy, diagnostics, limits or expiry still reaches listeners.
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  current = next;
  return true;
}

function scheduleExpiry() {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  // Keeps running while a gated policy waits, so its expiry still reaches
  // listeners as `expired`.
  if (!applied || applied.config.status !== "active" || monotonicNow() >= applied.deadline) return;
  expiryTimer = setTimeout(
    () => {
      if (evaluate()) notify();
    },
    Math.max(applied.deadline - monotonicNow(), 0),
  );
}

export const replayLifecycle = {
  /**
   * Holds a policy received from the server. Without a receipt it counts as
   * received now. Reapplying the same policy keeps its original receipt, so a
   * stale resource can never extend its own lifetime.
   */
  apply(config: PublicReplayConfig, receipt?: ReplayPolicyReceipt): void {
    const json = JSON.stringify(config);
    if (applied?.json !== json) {
      const receivedAt = receipt?.receivedAt ?? monotonicNow();
      const lifetime = Math.min(Math.max(config.expiresAt - config.fetchedAt, 0), MAX_POLICY_TTL_MS);
      applied = { config, json, receivedAt, deadline: receivedAt + lifetime };
    }
    const changed = evaluate();
    scheduleExpiry();
    if (changed) notify();
  },

  /**
   * Withholds capture until a policy received from now on is applied. Called
   * on resume or any transition whose elapsed time cannot be trusted.
   */
  gate(): void {
    // The host closes event admission before policy subscribers observe the
    // temporary gate, preserving only an eligible immutable revalidation frontier.
    for (const listener of [...gateListeners]) {
      try { listener(); } catch { /* Replay must still fail closed if a host observer fails. */ }
    }
    gatedAt = monotonicNow();
    const changed = evaluate();
    scheduleExpiry();
    if (changed) notify();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  subscribeGate(listener: () => void): () => void {
    gateListeners.add(listener);
    return () => { gateListeners.delete(listener); };
  },

  // Checks expiry synchronously, so a suspended timer cannot keep capture on.
  // Listeners hear about it on the next microtask, never during the read.
  getSnapshot(): PublicReplayConfig {
    if (evaluate()) {
      scheduleExpiry();
      queueMicrotask(notify);
    }
    return current;
  },

  // Tests only.
  reset(): void {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    applied = null;
    gatedAt = null;
    current = unavailable();
    listeners.clear();
    gateListeners.clear();
  },
};
