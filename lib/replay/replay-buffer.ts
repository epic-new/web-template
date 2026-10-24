import type { eventWithTime } from "@rrweb/types";

import type { PublicReplayConfig } from "./replay-config.contract";
import { jsonByteLength } from "./replay-redaction";

/**
 * Where a capture session puts admitted, sanitized events. The memory buffer
 * below is bounded by the policy's recording limits and only ever drops whole
 * boundaries, so a consumer never holds incremental events without the
 * FullSnapshot they depend on. WEB-3's upload transport drains a sink like it.
 */

export interface ReplayEventSink {
  push(event: eventWithTime, boundary: number): void;
  clear(): void;
}

export interface ReplayBufferEntry {
  boundary: number;
  event: eventWithTime;
}

type Limits = PublicReplayConfig["recording"]["limits"];

export function createReplayMemoryBuffer(limits: Limits) {
  const maxEntries = limits.maxBatchEvents * 10;
  let entries: (ReplayBufferEntry & { bytes: number })[] = [];
  let bytes = 0;
  let snapshot: readonly ReplayBufferEntry[] = [];
  const overflowed = new Set<number>();
  const listeners = new Set<() => void>();

  // UTF-8 bytes of the retained events serialized as one JSON array: `[`, `]`
  // and a comma between entries (counted per entry, minus the last one).
  function serializedBytes() {
    return entries.length === 0 ? 0 : bytes + 1;
  }

  function changed() {
    snapshot = entries.map(({ boundary, event }) => ({ boundary, event }));
    for (const listener of [...listeners]) listener();
  }

  function dropBoundary(boundary: number) {
    entries = entries.filter((entry) => {
      if (entry.boundary !== boundary) return true;
      bytes -= entry.bytes;
      return false;
    });
  }

  return {
    push(event: eventWithTime, boundary: number): void {
      if (overflowed.has(boundary)) return;
      // Each entry also costs its separator in the serialized array.
      const size = jsonByteLength(event) + 1;
      entries.push({ boundary, event, bytes: size });
      bytes += size;
      while (entries.length > maxEntries || serializedBytes() > limits.maxBufferBytes) {
        const oldest = entries[0]!.boundary;
        if (oldest === boundary) {
          // The current boundary alone is too large: keep none of it.
          dropBoundary(boundary);
          overflowed.add(boundary);
          break;
        }
        dropBoundary(oldest);
      }
      changed();
    },

    clear(): void {
      if (entries.length === 0) return;
      entries = [];
      bytes = 0;
      changed();
    },

    /** Stable between changes, so it can back `useSyncExternalStore`. */
    events(): readonly ReplayBufferEntry[] {
      return snapshot;
    },

    /** UTF-8 bytes of `JSON.stringify` of the retained events. */
    byteSize(): number {
      return serializedBytes();
    },

    isOverflowed(boundary: number): boolean {
      return overflowed.has(boundary);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ReplayMemoryBuffer = ReturnType<typeof createReplayMemoryBuffer>;
