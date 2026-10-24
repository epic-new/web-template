/**
 * Session sampling: whether a recording happens at all, decided once.
 *
 * Not rrweb's event-detail sampling (mousemove/scroll/input throttling in
 * replay-record-options.ts), which only thins events inside a recording that
 * is already sampled in. A decision is kept for its policy's `configVersion`
 * and rate, so renders, events and refreshes of the same policy never
 * resample; only a changed policy draws again, once.
 */

const STORAGE_KEY = "epic-replay:sample";

interface StoredDecision {
  configVersion: string | null;
  rate: number;
  sampled: boolean;
}

export interface ReplaySampler {
  decide(policy: { configVersion: string | null; sessionSampleRate: number }): boolean;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function createReplaySampler({
  storage = defaultStorage(),
  random = Math.random,
}: { storage?: Storage | null; random?: () => number } = {}): ReplaySampler {
  let memory: StoredDecision | null = null;

  function read(): StoredDecision | null {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return memory;
      const parsed = JSON.parse(raw) as Partial<StoredDecision>;
      if (typeof parsed.rate === "number" && typeof parsed.sampled === "boolean") {
        return {
          configVersion: typeof parsed.configVersion === "string" ? parsed.configVersion : null,
          rate: parsed.rate,
          sampled: parsed.sampled,
        };
      }
    } catch {
      // Storage unavailable or corrupted: the in-memory decision stands.
    }
    return memory;
  }

  function write(decision: StoredDecision) {
    memory = decision;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(decision));
    } catch {
      // Kept in memory for this tab's lifetime.
    }
  }

  return {
    decide({ configVersion, sessionSampleRate }) {
      const stored = read();
      if (stored && stored.configVersion === configVersion && stored.rate === sessionSampleRate) {
        return stored.sampled;
      }
      const sampled =
        sessionSampleRate <= 0 ? false : sessionSampleRate >= 1 ? true : random() < sessionSampleRate;
      write({ configVersion, rate: sessionSampleRate, sampled });
      return sampled;
    },
  };
}

let defaultSampler: ReplaySampler | null = null;

// Created on first use, so a module import never touches storage.
export const replaySampler: ReplaySampler = {
  decide(policy) {
    defaultSampler ??= createReplaySampler();
    return defaultSampler.decide(policy);
  },
};
