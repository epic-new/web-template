import { describe, expect, it } from "vitest";

import {
  createIndexedDBReplayHandoffLedger,
  createReplayHandoff,
  REPLAY_HANDOFF_MAX_RECORDS,
  REPLAY_HANDOFF_STORAGE_KEY,
  type ReplayHandoffContext,
  type ReplayHandoffLedger,
  type ReplayHandoffLedgerRecord,
  type ReplayReloadNavigation,
} from "../replay-handoff";
import { replayRecordingLockName, type ReplayOwnershipLease } from "../replay-ownership";
import type { ReplayUploadCheckpoint } from "../replay-upload-checkpoint";
import { REPLAY_RECORDING_LIMITS } from "../replay-config.contract";

const T0 = 1_800_000_000_000;
const RECORDING = "10000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reload: ReplayReloadNavigation = { type: "reload", opener: false };

function checkpoint(): ReplayUploadCheckpoint {
  return {
    registration: { contractVersion: 1, idempotencyKey: uuid(2), startedAt: T0 - 10_000, route: "/styleguide/replay/upload", recorderVersion: "2.2.0", configVersion: "1", release: "build-A", viewport: { width: 390, height: 844 } },
    recordingId: RECORDING,
    startedAt: T0 - 10_000,
    nextSequence: 5,
    acceptedBatches: 5,
    snapshotReceived: true,
    limits: { ...REPLAY_RECORDING_LIMITS },
    lastAcknowledgment: { contractVersion: 1, recordingId: RECORDING, batchId: uuid(3), sequence: 4, nextSequence: 5, delivery: "accepted", availability: "events_received" },
  };
}

function context(): ReplayHandoffContext {
  return { fingerprint: "policy-C-environment-preview-limits-default", documentRelease: "build-A", remainingDurationMs: 120_000, remainingInactivityMs: 60_000, recoveryDebt: 2 };
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

/** Browser persistence boundary: the transaction consumes before yielding. */
class Ledger implements ReplayHandoffLedger {
  rows = new Map<string, ReplayHandoffLedgerRecord>();
  async arm(record: ReplayHandoffLedgerRecord, now: number) {
    for (const [id, row] of this.rows) if (row.expiresAt <= now) this.rows.delete(id);
    if (this.rows.has(record.generation) || this.rows.size >= REPLAY_HANDOFF_MAX_RECORDS) return false;
    this.rows.set(record.generation, structuredClone(record));
    return true;
  }
  async consume(generation: string, proof: string, now: number) {
    const row = this.rows.get(generation);
    if (!row || row.consumed || row.expiresAt <= now || row.proof !== proof) return false;
    row.consumed = true;
    return true;
  }
  async remove(generation: string) { this.rows.delete(generation); }
}

function lease(recordingId = RECORDING): ReplayOwnershipLease {
  let held = true;
  return { name: replayRecordingLockName(recordingId), isHeld: () => held, release: () => { held = false; } };
}

function setup() {
  let wall = T0;
  let mono = 100;
  let generation = 10;
  const ledger = new Ledger();
  const local = storage();
  const create = (target = local, overrides: Partial<Parameters<typeof createReplayHandoff>[0]> = {}) => createReplayHandoff({
    storage: target, ledger, now: () => wall, monotonicNow: () => mono, epochNow: () => T0 + mono, randomUUID: () => uuid(generation++), ...overrides,
  });
  return {
    ledger, local, create,
    advance: (ms: number) => { wall += ms; mono += ms; },
    jump: (ms: number) => { wall += ms; },
    jumpMonotonic: (ms: number) => { mono += ms; },
  };
}

describe("clean reload handoff metadata", () => {
  it("prearms without a session candidate, then continues the exact acknowledged recording once", async () => {
    const s = setup();
    const predecessor = s.create();
    const original = checkpoint();
    const prepared = await predecessor.prepare(original, context());
    expect(prepared).not.toBeNull();
    expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
    s.advance(5_000);
    const ownership = lease();
    expect(predecessor.offer(prepared!, original, context(), ownership)).toBe(true);
    const encoded = s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)!;
    expect(encoded).not.toMatch(/recordingToken|visitorId|subjectId|"events"|"consent"/);
    ownership.release();
    s.advance(10_000);
    const successor = s.create();
    const candidate = successor.peek(reload)!;
    // The 15-second reload window starts at offer, not at async preparation.
    expect(candidate.expiresAt - candidate.offeredAt).toBe(15_000);
    const consumed = await successor.consume(candidate, context(), lease());
    expect(consumed?.candidate.prepared.upload).toEqual(original);
    expect(consumed?.remaining).toMatchObject({ remainingDurationMs: 105_000, remainingInactivityMs: 45_000, recoveryDebt: 2 });
    expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
    s.local.setItem(REPLAY_HANDOFF_STORAGE_KEY, encoded);
    expect(await s.create().consume(candidate, context(), lease())).toBeNull();
    expect(s.ledger.rows.get(prepared!.generation)?.consumed).toBe(true);
  });

  it("permits only one indistinguishable cloned candidate to consume a generation", async () => {
    const s = setup();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    const copy = storage();
    copy.setItem(REPLAY_HANDOFF_STORAGE_KEY, s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)!);
    const a = s.create();
    const b = s.create(copy);
    const results = await Promise.all([
      a.consume(a.peek(reload)!, context(), lease()),
      b.consume(b.peek(reload)!, context(), lease()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(s.ledger.rows.get(prepared!.generation)?.consumed).toBe(true);
    // This proves one cooperative consumer, not physical-tab identity.
  });

  it.each([
    { type: "navigate", opener: false },
    { type: "back_forward", opener: false },
    { type: "reload", opener: true },
    { ...reload, persisted: true },
    { ...reload, discarded: true },
    { ...reload, prerendering: true },
  ])("rejects and clears identified unsupported navigation %j", async (navigation) => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    expect(manager.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    expect(s.create().peek(navigation)).toBeNull();
    expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it("refuses changed frontier, context, release, debt, unknown release and capability persistence", async () => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    const advanced = checkpoint();
    advanced.nextSequence++;
    advanced.lastAcknowledgment.sequence++;
    advanced.lastAcknowledgment.nextSequence++;
    expect(manager.offer(prepared!, advanced, context(), lease())).toBe(false);
    expect(manager.offer(prepared!, checkpoint(), { ...context(), fingerprint: "changed privacy" }, lease())).toBe(false);
    expect(manager.offer(prepared!, checkpoint(), { ...context(), documentRelease: "build-B" }, lease())).toBe(false);
    expect(manager.offer(prepared!, checkpoint(), { ...context(), recoveryDebt: 3 }, lease())).toBe(false);
    const unknownRelease = checkpoint();
    unknownRelease.registration.release = null;
    expect(await manager.prepare(unknownRelease, context())).toBeNull();
    expect(await manager.prepare({ ...checkpoint(), recordingToken: "must-not-persist" } as ReplayUploadCheckpoint, context())).toBeNull();
    const unsafeRoute = checkpoint();
    unsafeRoute.registration.route += "?secret=synthetic";
    expect(await manager.prepare(unsafeRoute, context())).toBeNull();
  });

  it("requires the matching held lifetime lock and never checkpoints BFCache", async () => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    expect(manager.offer(prepared!, checkpoint(), context(), lease(uuid(99)))).toBe(false);
    const released = lease();
    released.release();
    expect(manager.offer(prepared!, checkpoint(), context(), released)).toBe(false);
    expect(manager.offer(prepared!, checkpoint(), context(), lease(), { persisted: true })).toBe(false);
    expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
    expect(manager.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    const successor = s.create();
    const candidate = successor.peek(reload)!;
    expect(await successor.consume(candidate, context(), released)).toBeNull();
  });

  it("expires locally without finalizing central state and rejects backward/drifting clocks", async () => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    s.jump(-1);
    expect(manager.offer(prepared!, checkpoint(), context(), lease())).toBe(false);
    s.jump(2_000);
    expect(manager.offer(prepared!, checkpoint(), context(), lease())).toBe(false);
    s.jump(-1_999);
    expect(manager.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    s.advance(15_000);
    expect(s.create().peek(reload)).toBeNull();
    // No cleanup/finalization network operation exists in this module.
    expect(s.ledger.rows.get(prepared!.generation)?.consumed).toBe(false);
  });

  it("rejects an expired cross-document handoff when the wall clock moves back", async () => {
    const s = setup();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    s.advance(20_000);
    s.jump(-10_000);
    // Only ten wall-clock seconds passed, but the 15-second window is spent.
    expect(s.create().peek(reload)).toBeNull();
    expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it.each([
    { wallAdjustment: -500, elapsed: 1_000 },
    { wallAdjustment: 500, elapsed: 1_500 },
  ])("subtracts the larger valid elapsed delta across documents: %j", async ({ wallAdjustment, elapsed }) => {
    const s = setup();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    s.advance(1_000);
    s.jump(wallAdjustment);
    // A successor has a new local time origin. Only epoch-relative time is
    // comparable with the predecessor; its local performance.now can be zero.
    const successor = s.create(s.local, { monotonicNow: () => 0 });
    const candidate = successor.peek(reload)!;
    expect(successor.remainingWindowMs(candidate)).toBe(15_000 - elapsed);
    const consumed = await successor.consume(candidate, context(), lease());
    expect(consumed?.remaining).toMatchObject({
      remainingDurationMs: 120_000 - elapsed,
      remainingInactivityMs: 60_000 - elapsed,
      recoveryDebt: 2,
    });
    s.advance(15_000 - elapsed);
    expect(successor.remainingWindowMs(candidate)).toBe(0);
  });

  it.each([NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1])("refuses unavailable or invalid epoch-relative clocks: %s", async (epochAt) => {
    const s = setup();
    expect(await s.create(s.local, { epochNow: () => epochAt }).prepare(checkpoint(), context())).toBeNull();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    expect(s.create(s.local, { epochNow: () => epochAt }).peek(reload)).toBeNull();
  });

  it.each(["preparedEpochMs", "offeredEpochMs"] as const)("rejects metadata missing the %s clock proof", async (field) => {
    const s = setup();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    const candidate = JSON.parse(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)!);
    if (field === "preparedEpochMs") delete candidate.prepared.preparedEpochMs;
    else delete candidate.offeredEpochMs;
    s.local.setItem(REPLAY_HANDOFF_STORAGE_KEY, JSON.stringify(candidate));
    expect(s.create().peek(reload)).toBeNull();
    expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it.each([-1, 1_001])("rejects backward or inconsistent cross-document monotonic progression: %s", async (adjustment) => {
    const s = setup();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    s.jumpMonotonic(adjustment);
    expect(s.create().peek(reload)).toBeNull();
  });

  it("spends a generation when its consume transaction outlives the monotonic window", async () => {
    const s = setup();
    const predecessor = s.create();
    const prepared = await predecessor.prepare(checkpoint(), context());
    expect(predecessor.offer(prepared!, checkpoint(), context(), lease())).toBe(true);
    const originalConsume = s.ledger.consume.bind(s.ledger);
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    s.ledger.consume = async (...args) => {
      const result = await originalConsume(...args);
      await delayed;
      return result;
    };
    const successor = s.create();
    const candidate = successor.peek(reload)!;
    const result = successor.consume(candidate, context(), lease());
    s.advance(20_000);
    s.jump(-10_000);
    finish();
    expect(await result).toBeNull();
    expect(s.ledger.rows.get(prepared!.generation)?.consumed).toBe(true);
    expect(successor.remainingWindowMs(candidate)).toBe(0);
  });

  it("rejects evicted generations, corrupted metadata and context changes before network", async () => {
    for (const failure of ["missing", "context", "corrupt", "oversized"] as const) {
      const s = setup();
      const manager = s.create();
      const prepared = await manager.prepare(checkpoint(), context());
      manager.offer(prepared!, checkpoint(), context(), lease());
      if (failure === "missing") s.ledger.rows.clear();
      if (failure === "corrupt") s.local.setItem(REPLAY_HANDOFF_STORAGE_KEY, "{broken");
      if (failure === "oversized") s.local.setItem(REPLAY_HANDOFF_STORAGE_KEY, "x".repeat(8_193));
      const next = s.create();
      const candidate = next.peek(reload);
      if (candidate) expect(await next.consume(candidate, failure === "context" ? { ...context(), fingerprint: "different environment" } : context(), lease())).toBeNull();
      else expect(["corrupt", "oversized"]).toContain(failure);
      expect(s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
    }
  });

  it("never resets shorter lifecycle limits or recovery debt", async () => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    manager.offer(prepared!, checkpoint(), { ...context(), remainingDurationMs: 10_000 }, lease());
    s.advance(1_000);
    const next = s.create();
    const candidate = next.peek(reload);
    // Applying a shorter limit cannot lengthen the original inactivity budget.
    expect(candidate).toBeNull();
    const second = await manager.prepare(checkpoint(), context());
    expect(manager.offer(second!, checkpoint(), context(), lease())).toBe(true);
    const accepted = await next.consume(next.peek(reload)!, { ...context(), recoveryDebt: 3, remainingInactivityMs: 5_000 }, lease());
    expect(accepted?.remaining).toMatchObject({ recoveryDebt: 3, remainingInactivityMs: 5_000 });
  });

  it("spends a consumed generation even when cancellation wins after its transaction", async () => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    manager.offer(prepared!, checkpoint(), context(), lease());
    const encoded = s.local.getItem(REPLAY_HANDOFF_STORAGE_KEY)!;
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const base = s.ledger.consume.bind(s.ledger);
    s.ledger.consume = async (...args) => { const result = await base(...args); await wait; return result; };
    const controller = new AbortController();
    const next = s.create();
    const consuming = next.consume(next.peek(reload)!, context(), lease(), controller.signal);
    controller.abort();
    finish();
    expect(await consuming).toBeNull();
    expect(s.ledger.rows.get(prepared!.generation)?.consumed).toBe(true);
    s.local.setItem(REPLAY_HANDOFF_STORAGE_KEY, encoded);
    expect(await next.consume(next.peek(reload)!, context(), lease())).toBeNull();
  });

  it("invalidates stale preparation and fails safely with inaccessible storage/ledger", async () => {
    const s = setup();
    const manager = s.create();
    const prepared = await manager.prepare(checkpoint(), context());
    manager.invalidate();
    expect(manager.offer(prepared!, checkpoint(), context(), lease())).toBe(false);
    expect(await s.create(s.local, { storage: null }).prepare(checkpoint(), context())).toBeNull();
    const broken = storage();
    broken.setItem = () => { throw new Error("storage blocked"); };
    const unavailable = s.create(broken);
    const armed = await unavailable.prepare(checkpoint(), context());
    expect(unavailable.offer(armed!, checkpoint(), context(), lease())).toBe(false);
    const deniedLedger: ReplayHandoffLedger = { arm: async () => false, consume: async () => false, remove: async () => {} };
    expect(await s.create(s.local, { ledger: deniedLedger }).prepare(checkpoint(), context())).toBeNull();
    const native = createIndexedDBReplayHandoffLedger(null);
    expect(await native.consume(uuid(10), "missing", T0)).toBe(false);
    const throws = createIndexedDBReplayHandoffLedger({ open() { throw new Error("blocked"); } } as unknown as IDBFactory);
    expect(await throws.consume(uuid(10), "missing", T0)).toBe(false);
  });
});
