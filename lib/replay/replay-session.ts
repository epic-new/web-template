import { REPLAY_SESSION_ID_PATTERN } from "./replay-upload-contract";

/**
 * The browser session id ClickStack groups a visit by: 32 lowercase hex
 * characters from `crypto.getRandomValues`, kept in sessionStorage with its
 * start and last activity. A reload within the idle window reuses it; a tab
 * idle for 15 minutes, or a session older than 4 hours, gets a new one.
 *
 * The per-session record counters live beside it, so `rr-web.offset` keeps
 * growing across reloads of the same session. Storage that is blocked only
 * costs continuity: the session then lives in memory for this page.
 */

export const REPLAY_SESSION_IDLE_MS = 15 * 60_000;
export const REPLAY_SESSION_MAX_AGE_MS = 4 * 60 * 60_000;

const STORAGE_KEY = "epic-replay:session";
// Activity is written at most this often; reads decide expiry from memory first.
const TOUCH_WRITE_MS = 5_000;

export interface ReplaySessionInfo {
  id: string;
  startedAt: number;
}

interface StoredSession extends ReplaySessionInfo {
  lastActivityAt: number;
  /** Next `rr-web.offset` (per record) and `rr-web.event` (per event). */
  offset: number;
  event: number;
}

export interface ReplaySessionStoreOptions {
  storage?: Storage | null;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function createReplaySessionStore({
  storage = defaultStorage(),
  now = () => Date.now(),
  randomBytes = defaultRandomBytes,
}: ReplaySessionStoreOptions = {}) {
  let memory: StoredSession | null = null;
  let writtenAt = 0;

  function read(): StoredSession | null {
    if (memory) return memory;
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (
        typeof parsed.id === "string" &&
        REPLAY_SESSION_ID_PATTERN.test(parsed.id) &&
        Number.isFinite(parsed.startedAt) &&
        Number.isFinite(parsed.lastActivityAt)
      ) {
        memory = {
          id: parsed.id,
          startedAt: parsed.startedAt!,
          lastActivityAt: parsed.lastActivityAt!,
          offset: Number.isInteger(parsed.offset) ? parsed.offset! : 0,
          event: Number.isInteger(parsed.event) ? parsed.event! : 0,
        };
        return memory;
      }
    } catch {
      // Unreadable or corrupted: a new session starts.
    }
    return null;
  }

  function write(session: StoredSession, force = false) {
    memory = session;
    const at = now();
    if (!force && at - writtenAt < TOUCH_WRITE_MS) return;
    writtenAt = at;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Kept in memory for this page's lifetime.
    }
  }

  function expired(session: StoredSession, at: number): boolean {
    return (
      at - session.lastActivityAt >= REPLAY_SESSION_IDLE_MS || at - session.startedAt >= REPLAY_SESSION_MAX_AGE_MS
    );
  }

  function mint(): string {
    return Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return {
    /** The live session, rotating it first when it went idle or reached its maximum age. */
    current({ touch = true }: { touch?: boolean } = {}): ReplaySessionInfo {
      const at = now();
      let session = read();
      if (!session || expired(session, at)) {
        session = { id: mint(), startedAt: at, lastActivityAt: at, offset: 0, event: 0 };
        write(session, true);
      } else if (touch) {
        write({ ...session, lastActivityAt: at });
      }
      return { id: session.id, startedAt: session.startedAt };
    },

    /** Whether `id` is still the live session (not rotated, not expired). Never rotates. */
    isLive(id: string): boolean {
      const session = read();
      return session !== null && session.id === id && !expired(session, now());
    },

    /** Reserves `records` consecutive offsets and one event index for an event of the session `id`. */
    reserve(id: string, records: number): { offset: number; event: number } | null {
      const session = read();
      if (!session || session.id !== id) return null;
      const reserved = { offset: session.offset, event: session.event };
      write({ ...session, offset: session.offset + records, event: session.event + 1, lastActivityAt: now() }, true);
      return reserved;
    },

    /** Persists the latest activity now, e.g. as the page hides. */
    flush(): void {
      if (memory) write(memory, true);
    },

    clear(): void {
      memory = null;
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export type ReplaySessionStore = ReturnType<typeof createReplaySessionStore>;

let shared: ReplaySessionStore | null = null;

/** The tab's one store, created on first use so a module import never touches storage. */
export const replaySessions: ReplaySessionStore = {
  current: (options) => (shared ??= createReplaySessionStore()).current(options),
  isLive: (id) => (shared ??= createReplaySessionStore()).isLive(id),
  reserve: (id, records) => (shared ??= createReplaySessionStore()).reserve(id, records),
  flush: () => (shared ??= createReplaySessionStore()).flush(),
  clear: () => (shared ??= createReplaySessionStore()).clear(),
};
