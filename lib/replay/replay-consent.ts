/**
 * The host application's explicit replay consent. See docs/replay-privacy.md.
 *
 * It starts `"unknown"`, and nothing records until the host calls `grant()`:
 * consent is never inferred from the policy, the environment or a provider
 * being mounted. Held in memory only, on purpose: the host's own consent and
 * disclosure policy decides what to remember and re-grants on load.
 *
 * Listeners run synchronously, so a capture session stops inside `withdraw()`.
 */

export type ReplayConsentState = "unknown" | "granted" | "withdrawn";

type Listener = (state: ReplayConsentState) => void;

let state: ReplayConsentState = "unknown";
const listeners = new Set<Listener>();

function set(next: ReplayConsentState) {
  if (state === next) return;
  state = next;
  for (const listener of [...listeners]) listener(state);
}

export interface ReplayConsentSource {
  getSnapshot(): ReplayConsentState;
  subscribe(listener: Listener): () => void;
}

export const epicReplayConsent = {
  grant(): void {
    set("granted");
  },

  withdraw(): void {
    set("withdrawn");
  },

  getSnapshot(): ReplayConsentState {
    return state;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  // Tests only.
  reset(): void {
    state = "unknown";
    listeners.clear();
  },
};
