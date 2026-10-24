import {
  disabledReplayConfig,
  type PublicReplayConfig,
} from "./replay-config.contract";

/**
 * The one place that knows the effective replay policy. A later recorder
 * subscribes here; nothing in this module starts capture.
 */

type Listener = (config: PublicReplayConfig) => void;

function unavailable(): PublicReplayConfig {
  return disabledReplayConfig({
    reason: "unavailable",
    environment: "development",
    release: null,
    now: Date.now(),
  });
}

function expired(config: PublicReplayConfig): PublicReplayConfig {
  return disabledReplayConfig({
    reason: "expired",
    environment: config.environment,
    release: config.release,
    now: config.expiresAt,
  });
}

let current: PublicReplayConfig = unavailable();
const listeners = new Set<Listener>();

function effective(config: PublicReplayConfig): PublicReplayConfig {
  if (config.status === "active" && config.expiresAt <= Date.now()) {
    return expired(config);
  }
  return config;
}

export const replayLifecycle = {
  apply(config: PublicReplayConfig): void {
    const next = effective(config);
    // Compare the whole policy, not just enablement or version, so a change to
    // routes, privacy, diagnostics, limits or expiry still reaches listeners.
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    for (const listener of listeners) listener(current);
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  // Checks expiry synchronously, so a suspended timer cannot keep capture on.
  getSnapshot(): PublicReplayConfig {
    const next = effective(current);
    if (next !== current) {
      current = next;
      for (const listener of listeners) listener(current);
    }
    return current;
  },

  // Tests only.
  reset(): void {
    current = unavailable();
    listeners.clear();
  },
};
