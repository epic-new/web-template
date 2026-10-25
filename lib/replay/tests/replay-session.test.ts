import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReplaySessionStore,
  REPLAY_SESSION_IDLE_MS,
  REPLAY_SESSION_MAX_AGE_MS,
} from "../replay-session";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const T = 1_800_000_000_000;
let clock = T;
let counter = 0;

function store(storage = new MemoryStorage()) {
  return createReplaySessionStore({
    storage: storage as unknown as Storage,
    now: () => clock,
    randomBytes: (length) => new Uint8Array(length).fill(++counter),
  });
}

describe("createReplaySessionStore", () => {
  beforeEach(() => {
    clock = T;
  });
  afterEach(() => vi.restoreAllMocks());

  it("mints 32 lowercase hex characters from random bytes", () => {
    const { id, startedAt } = store().current();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(startedAt).toBe(T);
  });

  it("reuses the session after a reload within 15 minutes of inactivity", () => {
    const storage = new MemoryStorage();
    const first = store(storage).current();
    clock += REPLAY_SESSION_IDLE_MS - 1_000;
    expect(store(storage).current()).toEqual(first);
  });

  it("rotates after 15 minutes idle", () => {
    const storage = new MemoryStorage();
    const first = store(storage).current();
    clock += REPLAY_SESSION_IDLE_MS;
    const second = store(storage).current();
    expect(second.id).not.toBe(first.id);
    expect(second.startedAt).toBe(clock);
  });

  it("rotates at the 4 hour maximum age even while active", () => {
    const sessions = store();
    const first = sessions.current();
    while (clock - T + 5 * 60_000 < REPLAY_SESSION_MAX_AGE_MS) {
      clock += 5 * 60_000;
      expect(sessions.current().id).toBe(first.id);
    }
    clock = T + REPLAY_SESSION_MAX_AGE_MS;
    expect(sessions.current().id).not.toBe(first.id);
  });

  it("keeps offsets and event counters monotonic across reloads, per session", () => {
    const storage = new MemoryStorage();
    const first = store(storage);
    const { id } = first.current();
    expect(first.reserve(id, 3)).toEqual({ offset: 0, event: 0 });
    expect(first.reserve(id, 1)).toEqual({ offset: 3, event: 1 });

    const reloaded = store(storage);
    reloaded.current();
    expect(reloaded.reserve(id, 1)).toEqual({ offset: 4, event: 2 });

    clock += REPLAY_SESSION_IDLE_MS;
    const next = reloaded.current();
    expect(reloaded.reserve(id, 1)).toBeNull();
    expect(reloaded.reserve(next.id, 1)).toEqual({ offset: 0, event: 0 });
  });

  it("knows whether a session is still live without rotating it", () => {
    const sessions = store();
    const { id } = sessions.current();
    expect(sessions.isLive(id)).toBe(true);
    clock += REPLAY_SESSION_IDLE_MS;
    expect(sessions.isLive(id)).toBe(false);
  });

  it("falls back to memory when storage is blocked", () => {
    const blocked = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const sessions = createReplaySessionStore({ storage: blocked, now: () => clock });
    const first = sessions.current();
    expect(sessions.current().id).toBe(first.id);
  });
});
