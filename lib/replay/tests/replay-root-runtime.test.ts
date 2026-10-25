// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { record as rrwebRecord } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
import { createReplayRootRuntime } from "../replay-root-runtime";
import { createReplayDocumentOwners } from "../replay-document-owner";
import { createReplayRecordingPipeline } from "../replay-recording-pipeline";
import { createReplayHandoff, REPLAY_HANDOFF_STORAGE_KEY, type ReplayHandoffLedger, type ReplayHandoffLedgerRecord } from "../replay-handoff";
import type { ReplayLockManager } from "../replay-ownership";
import { epicReplayConsent } from "../replay-consent";
import { activeReplayPolicy } from "./replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "./synthetic-epi210.core";

function recorder() {
  let emit: ((event: eventWithTime) => void) | undefined;
  const record = vi.fn((options?: { emit?: (event: eventWithTime) => void }) => {
    emit = options?.emit;
    emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
    emit?.({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime);
    return () => { emit = undefined; };
  }) as unknown as typeof rrwebRecord;
  return { record, event: () => emit?.({ type: 5, timestamp: Date.now(), data: { tag: "synthetic", payload: {} } } as eventWithTime) };
}
async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
}
function ownershipFixture() {
  const held = new Set<string>();
  const locks: ReplayLockManager = { async request(name, _options, callback) {
    if (held.has(name)) throw new Error("contended");
    held.add(name);
    try { await callback({ name }); } finally { held.delete(name); }
  } };
  const rows = new Map<string, ReplayHandoffLedgerRecord>();
  const ledger: ReplayHandoffLedger = {
    async arm(row) { if (rows.has(row.generation)) return false; rows.set(row.generation, { ...row }); return true; },
    async consume(generation, proof, now) { const row = rows.get(generation); if (!row || row.consumed || row.proof !== proof || row.expiresAt <= now) return false; row.consumed = true; return true; },
    async remove(generation) { rows.delete(generation); },
  };
  return { locks, ledger };
}

describe("one root replay lifecycle", () => {
  const runtimes: ReturnType<typeof createReplayRootRuntime>[] = [];
  beforeEach(() => { vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); window.history.replaceState({}, "", "/styleguide/replay/upload"); sessionStorage.clear(); });
  afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); epicReplayConsent.reset(); vi.useRealTimers(); vi.restoreAllMocks(); });
  function setup(overrides: Partial<Parameters<typeof createReplayRootRuntime>[0]> = {}) {
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const fake = recorder();
    const loadPipeline = vi.fn(async () => ({ createReplayRecordingPipeline }));
    const policy = activeReplayPolicy();
    const runtime = createReplayRootRuntime({ documentRelease: "build-A", getPolicy: () => policy, subscribePolicy: () => () => {},
      fetch: browser.fetch, pipelineOptions: { record: fake.record }, loadPipeline, owners: createReplayDocumentOwners(), locks: null,
      monotonicNow: () => Date.now(), ...overrides });
    runtimes.push(runtime);
    return { runtime, browser, fake, loadPipeline, policy };
  }

  it("direct and embedded applications wait for identity and consent before loading capture", async () => {
    let resolve!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const { runtime, loadPipeline, fake } = setup({ fetch: request });
    runtime.setIdentity(null);
    const detach = runtime.attach();
    await flush();
    expect(request).not.toHaveBeenCalled();
    epicReplayConsent.grant();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(loadPipeline).not.toHaveBeenCalled();
    epicReplayConsent.withdraw();
    resolve(Response.json({ contractVersion: 1 }));
    await flush();
    expect(fake.record).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().reference).toBeNull();
    detach();
  });

  it("keeps immutable document release and stable public context across captured events", async () => {
    const { runtime, browser, fake, policy } = setup();
    runtime.setIdentity("user-1"); runtime.attach(); epicReplayConsent.grant();
    await flush(5_100);
    expect(runtime.getSnapshot()).toMatchObject({ status: "capturing", snapshotReceived: true, evidence: "unverified" });
    const snapshot = runtime.getSnapshot();
    const changed = vi.fn(); runtime.subscribe(changed);
    for (let i = 0; i < 20; i++) fake.event();
    expect(runtime.getSnapshot()).toBe(snapshot);
    expect(changed).not.toHaveBeenCalled();
    policy.release = "build-B";
    runtime.stop(); runtime.start();
    await flush(5_100);
    expect(runtime.getSnapshot().reference?.recordingId).not.toBe(snapshot.reference?.recordingId);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(runtime.getSnapshot().snapshotReceived).toBe(true);
  });

  it("does not load the recorder until DOM readiness and cancels that wait on withdrawal", async () => {
    let readiness: DocumentReadyState = "loading";
    vi.spyOn(document, "readyState", "get").mockImplementation(() => readiness);
    const { runtime, loadPipeline, fake } = setup();
    runtime.setIdentity(null); runtime.attach(); epicReplayConsent.grant();
    await flush();
    expect(loadPipeline).not.toHaveBeenCalled();
    epicReplayConsent.withdraw();
    readiness = "interactive";
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush(1);
    expect(fake.record).not.toHaveBeenCalled();
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it("keeps the shared recovery budget when every new recording fails after its initial batch", async () => {
    const fixture = createSyntheticEpi210();
    const browser = createSyntheticBrowserFetch(fixture);
    const { runtime, fake } = setup({ fetch: browser.fetch });
    runtime.setIdentity("user-1"); runtime.attach(); epicReplayConsent.grant(); await flush(5_100);
    for (let i = 0; i < 5; i++) {
      fixture.setMode("delivery_uncertain_next"); fake.event(); await flush(10_100);
    }
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(4);
    expect(runtime.getSnapshot()).toMatchObject({ status: "unavailable", reason: "delivery_uncertain" });
    expect(runtime.getDiagnostics().recoveryDebt).toBe(3);
  });

  it("stops at inactivity and starts a fresh boundary only after user activity", async () => {
    const { runtime, browser } = setup({ lifecycle: { maxDurationMs: 60_000, inactivityMs: 30_000 } });
    runtime.setIdentity(null); runtime.attach(); epicReplayConsent.grant(); await flush(5_100);
    const before = runtime.getSnapshot().reference;
    await flush(30_000);
    expect(runtime.getSnapshot()).toMatchObject({ status: "waiting", reason: "inactive", reference: null });
    const count = browser.log.filter((entry) => entry.path === "/recordings").length;
    await flush(60_000);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(count);
    runtime.activity(); await flush(5_100);
    expect(runtime.getSnapshot().reference?.recordingId).not.toBe(before?.recordingId);
    expect(runtime.getSnapshot().status).toBe("capturing");
  });

  it("rotates an active recording at maximum duration without creating a per-tick recording storm", async () => {
    const { runtime, browser, fake } = setup({ lifecycle: { maxDurationMs: 60_000, inactivityMs: 30_000 } });
    runtime.setIdentity("user-1"); runtime.attach(); epicReplayConsent.grant(); await flush(5_100);
    const original = runtime.getSnapshot().reference!;
    for (let i = 0; i < 3; i++) {
      await flush(15_000);
      runtime.activity();
    }
    await flush(15_600);
    const next = runtime.getSnapshot();
    expect(next).toMatchObject({ status: "capturing", continuity: "new_recording", snapshotReceived: true });
    expect(next.reference).not.toBeNull();
    expect(next.reference!.recordingId).not.toBe(original.recordingId);
    expect(next.reference!.startedAt - original.startedAt).toBeGreaterThanOrEqual(60_000);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(browser.log.find((entry) => entry.recordingId === next.reference!.recordingId && entry.path.endsWith("/batches")))
      .toMatchObject({ sequence: 0, firstEventTypes: [4, 2], status: 200 });
    await flush(10_000);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(fake.record).toHaveBeenCalledTimes(2);
  });

  it("stops synchronously at an identity barrier and waits for the new resolved account", async () => {
    const { runtime, fake, browser } = setup();
    runtime.setIdentity("user-1"); runtime.attach(); epicReplayConsent.grant(); await flush(5_100);
    const previous = runtime.getSnapshot().reference;
    runtime.beginIdentityChange(); fake.event();
    expect(runtime.getSnapshot().reference).toBeNull();
    const count = browser.log.length;
    await flush(10_000);
    expect(browser.log).toHaveLength(count);
    runtime.setIdentity("user-2"); await flush(5_100);
    expect(runtime.getSnapshot().reference?.recordingId).not.toBe(previous?.recordingId);
  });

  it("keeps recorder failures terminal without repeating identity bootstrap on timer ticks", async () => {
    const record = vi.fn(() => { throw new Error("blocked recorder"); }) as unknown as typeof rrwebRecord;
    const { runtime, browser } = setup({ pipelineOptions: { record } });
    runtime.setIdentity(null); runtime.attach(); epicReplayConsent.grant(); await flush(1_000);
    expect(runtime.getSnapshot()).toMatchObject({ status: "unavailable", reason: "recorder_unavailable", reference: null });
    const requests = browser.log.length;
    await flush(30_000);
    expect(browser.log).toHaveLength(requests);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("continues a clean reload under the same durable recording and consumes its checkpoint once", async () => {
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const { locks, ledger } = ownershipFixture();
    const handoff = () => createReplayHandoff({ storage: sessionStorage, ledger, now: Date.now, monotonicNow: () => Date.now() });
    const original = setup({ fetch: browser.fetch, locks, handoff: handoff(), navigation: { type: "navigate", opener: false } }).runtime;
    original.setIdentity("user-1"); original.attach(); epicReplayConsent.grant();
    await flush(5_100);
    expect(original.getDiagnostics().eligibleHandoff).toBe(true);
    const reference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(original.getSnapshot().continuity).toBe("handoff");
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).not.toBeNull();
    original.dispose();
    epicReplayConsent.reset();
    const successor = setup({ fetch: browser.fetch, locks, handoff: handoff(), navigation: { type: "reload", opener: false } }).runtime;
    successor.setIdentity("user-1"); successor.attach(); epicReplayConsent.grant();
    await flush(5_100);
    expect(successor.getSnapshot()).toMatchObject({ reference: { recordingId: reference.recordingId, startedAt: reference.startedAt }, continuity: "resumed", snapshotReceived: true });
    expect(browser.log.filter((entry) => entry.path.endsWith("/batches")).every((entry) => !entry.final)).toBe(true);
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it("rejects an advanced resume cursor and rotates without adopting it", async () => {
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const { locks, ledger } = ownershipFixture();
    const handoff = () => createReplayHandoff({ storage: sessionStorage, ledger, now: Date.now, monotonicNow: () => Date.now() });
    const original = setup({ fetch: browser.fetch, locks, handoff: handoff(), navigation: { type: "navigate", opener: false } }).runtime;
    original.setIdentity("user-1"); original.attach(); epicReplayConsent.grant(); await flush(5_100);
    const reference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide")); original.dispose(); epicReplayConsent.reset();
    let firstRegistration = true;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await browser.fetch(input, init);
      if (String(input).endsWith("/recordings") && firstRegistration) {
        firstRegistration = false;
        const payload = await response.json();
        return Response.json({ ...payload, nextSequence: payload.nextSequence + 1 });
      }
      return response;
    }) as typeof globalThis.fetch;
    const successor = setup({ fetch, locks, handoff: handoff(), navigation: { type: "reload", opener: false } }).runtime;
    successor.setIdentity("user-1"); successor.attach(); epicReplayConsent.grant(); await flush(5_100);
    expect(successor.getSnapshot()).toMatchObject({ status: "capturing", continuity: "new_recording", snapshotReceived: true });
    expect(successor.getSnapshot().reference).not.toBeNull();
    expect(successor.getSnapshot().reference?.recordingId).not.toBe(reference.recordingId);
    expect(successor.getDiagnostics().recoveryDebt).toBe(1);
    const originalBatches = browser.log.filter((entry) => entry.recordingId === reference.recordingId && entry.path.endsWith("/batches"));
    expect(originalBatches).toHaveLength(1);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(3);
  });

  it("reports a new registered recording after a resumed stream later becomes delivery-uncertain", async () => {
    const fixture = createSyntheticEpi210();
    const browser = createSyntheticBrowserFetch(fixture);
    const { locks, ledger } = ownershipFixture();
    const handoff = () => createReplayHandoff({ storage: sessionStorage, ledger, now: Date.now, monotonicNow: () => Date.now() });
    const original = setup({ fetch: browser.fetch, locks, handoff: handoff(), navigation: { type: "navigate", opener: false } }).runtime;
    original.setIdentity("user-1"); original.attach(); epicReplayConsent.grant(); await flush(5_100);
    const originalReference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide")); original.dispose(); epicReplayConsent.reset();
    const { runtime: successor, fake } = setup({ fetch: browser.fetch, locks, handoff: handoff(), navigation: { type: "reload", opener: false } });
    successor.setIdentity("user-1"); successor.attach(); epicReplayConsent.grant(); await flush(5_100);
    expect(successor.getSnapshot()).toMatchObject({
      reference: { recordingId: originalReference.recordingId, startedAt: originalReference.startedAt },
      continuity: "resumed", snapshotReceived: true,
    });

    fixture.setMode("delivery_uncertain_next");
    fake.event();
    await flush(10_100);

    const next = successor.getSnapshot();
    expect(next).toMatchObject({ status: "capturing", continuity: "new_recording", snapshotReceived: true });
    expect(next.reference).not.toBeNull();
    expect(next.reference!.recordingId).not.toBe(originalReference.recordingId);
    expect(successor.getDiagnostics().recoveryDebt).toBe(1);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(3);
    expect(browser.log.find((entry) => entry.recordingId === next.reference!.recordingId && entry.path.endsWith("/batches")))
      .toMatchObject({ sequence: 0, firstEventTypes: [4, 2], status: 200 });
    const uncertain = browser.log.findIndex((entry) => entry.code === "delivery_uncertain");
    expect(uncertain).toBeGreaterThan(-1);
    expect(browser.log.slice(uncertain + 1).some((entry) => entry.recordingId === originalReference.recordingId)).toBe(false);
  });

  it("falls back fresh when a handoff expires while its identity acknowledgment is delayed", async () => {
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const { locks, ledger } = ownershipFixture();
    const handoff = () => createReplayHandoff({ storage: sessionStorage, ledger, now: Date.now, monotonicNow: () => Date.now() });
    const original = setup({ fetch: browser.fetch, locks, handoff: handoff(), navigation: { type: "navigate", opener: false } }).runtime;
    original.setIdentity("user-1"); original.attach(); epicReplayConsent.grant(); await flush(5_100);
    const originalReference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide")); original.dispose(); epicReplayConsent.reset();

    let firstIdentity = true;
    let releaseIdentity!: () => void;
    const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await browser.fetch(input, init);
      if (String(input).endsWith("/identity") && firstIdentity) {
        firstIdentity = false;
        // Deliberately late network completion: cancellation must not grant permission.
        await new Promise<void>((resolve) => { releaseIdentity = resolve; });
      }
      return response;
    }) as typeof fetch;
    const { runtime: successor, fake } = setup({ fetch: delayedFetch, locks, handoff: handoff(), navigation: { type: "reload", opener: false } });
    successor.setIdentity("user-1"); successor.attach(); epicReplayConsent.grant(); await flush();
    await flush(16_000); // The runtime tick has already removed the 15-second candidate.
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();
    expect(fake.record).not.toHaveBeenCalled();
    expect(successor.getSnapshot().reference).toBeNull();

    releaseIdentity();
    await flush(5_100);

    expect(successor.getSnapshot()).toMatchObject({ status: "capturing", continuity: "new_recording", snapshotReceived: true });
    expect(successor.getSnapshot().reference).not.toBeNull();
    expect(successor.getSnapshot().reference!.recordingId).not.toBe(originalReference.recordingId);
    expect(successor.getDiagnostics().recoveryDebt).toBe(1);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(browser.log.filter((entry) => entry.recordingId === originalReference.recordingId && entry.path.endsWith("/batches"))).toHaveLength(1);
  });

  it.each(["duration", "inactivity"] as const)("never captures the resumed stream after its remaining %s expires during registration", async (bound) => {
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const { locks, ledger } = ownershipFixture();
    const handoff = () => createReplayHandoff({ storage: sessionStorage, ledger, now: Date.now, monotonicNow: () => Date.now() });
    const lifecycle = bound === "duration"
      ? { maxDurationMs: 60_000, inactivityMs: 60_000 }
      : { maxDurationMs: 120_000, inactivityMs: 30_000 };
    const { runtime: original, fake: originalRecorder } = setup({
      fetch: browser.fetch, lifecycle, locks, handoff: handoff(), navigation: { type: "navigate", opener: false },
    });
    original.setIdentity("user-1"); original.attach(); epicReplayConsent.grant(); await flush(5_100);
    if (bound === "duration") {
      await flush(24_900);
      original.activity(); originalRecorder.event();
      await flush(5_100); // Refresh the acknowledged frontier after activity.
      await flush(24_650); // Only 250 ms of the original duration remains.
    } else {
      await flush(24_650); // Only 250 ms of inactivity allowance remains.
    }
    expect(original.getDiagnostics().eligibleHandoff).toBe(true);
    const originalReference = original.getSnapshot().reference!;
    const originalBatchCount = browser.log.filter((entry) => entry.recordingId === originalReference.recordingId && entry.path.endsWith("/batches")).length;
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).not.toBeNull();
    original.dispose(); epicReplayConsent.reset();

    let firstRegistration = true;
    let releaseRegistration!: () => void;
    const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await browser.fetch(input, init);
      if (String(input).endsWith("/recordings") && firstRegistration) {
        firstRegistration = false;
        await new Promise<void>((resolve) => { releaseRegistration = resolve; });
      }
      return response;
    }) as typeof fetch;
    const { runtime: successor, fake } = setup({
      fetch: delayedFetch, lifecycle, locks, handoff: handoff(), navigation: { type: "reload", opener: false },
    });
    successor.setIdentity("user-1"); successor.attach(); epicReplayConsent.grant(); await flush();
    expect(firstRegistration).toBe(false);
    expect(fake.record).not.toHaveBeenCalled();
    await flush(1_000);
    expect(fake.record).not.toHaveBeenCalled();
    releaseRegistration();
    await flush(5_100);

    const next = successor.getSnapshot();
    expect(next).toMatchObject({ status: "capturing", continuity: "new_recording", snapshotReceived: true });
    expect(next.reference).not.toBeNull();
    expect(next.reference!.recordingId).not.toBe(originalReference.recordingId);
    expect(fake.record).toHaveBeenCalledTimes(1); // Only the new permitted boundary was initialized.
    expect(successor.getDiagnostics().recoveryDebt).toBe(1);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(3);
    expect(browser.log.filter((entry) => entry.recordingId === originalReference.recordingId && entry.path.endsWith("/batches")))
      .toHaveLength(originalBatchCount);
    expect(browser.log.find((entry) => entry.recordingId === next.reference!.recordingId && entry.path.endsWith("/batches")))
      .toMatchObject({ sequence: 0, firstEventTypes: [4, 2], status: 200 });
  });
});
