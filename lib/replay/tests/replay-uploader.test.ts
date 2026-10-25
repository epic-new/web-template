import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { eventWithTime } from "@rrweb/types";

import { REPLAY_RECORDING_LIMITS } from "../replay-config.contract";
import { replayBatchRequestSchema, type ReplayUploadErrorCode } from "../replay-upload-contract";
import { createReplayUploader, REPLAY_ERROR_ACTIONS, REPLAY_UPLOAD_REQUEST_TIMEOUT_MS, type ReplayUploaderOptions } from "../replay-uploader";
import { replayUploadCheckpointSchema } from "../replay-upload-checkpoint";
import errors from "./fixtures/publishing-errors.v1.json";
import { createSyntheticBrowserFetch, createSyntheticEpi210, type SyntheticFixtureMode } from "./synthetic-epi210.core";

const T0 = 1_800_000_000_000;

function ev(type: number, timestamp: number, data: Record<string, unknown> = {}): eventWithTime {
  return { type, timestamp, data } as eventWithTime;
}

const meta = (ts = T0) => ev(4, ts, { href: "https://app.example/styleguide/replay/upload", width: 390, height: 844 });
const full = (ts = T0 + 1, size = 200) => ev(2, ts, { node: { type: 0, childNodes: [], pad: "x".repeat(size) } });
const incremental = (ts: number) => ev(3, ts, { source: 2, type: 2, id: 1 });

function setup(options: Partial<ReplayUploaderOptions> & { mode?: SyntheticFixtureMode } = {}) {
  const fixture = createSyntheticEpi210();
  if (options.mode) fixture.setMode(options.mode);
  const browser = createSyntheticBrowserFetch(fixture);
  const fetchSpy = vi.fn(browser.fetch);
  let online = true;
  let wallOffset = 0;
  let monoFrozen: number | null = null;
  const lost = vi.fn();
  const uploader = createReplayUploader({
    getLimits: () => ({ ...REPLAY_RECORDING_LIMITS }),
    getConfigVersion: () => "3",
    getDocumentRelease: () => "build-a",
    fetch: fetchSpy,
    monotonicNow: () => monoFrozen ?? Date.now(),
    wallNow: () => Date.now() + wallOffset,
    isOnline: () => online,
    getViewport: () => ({ width: 390, height: 844 }),
    getRoute: () => "/styleguide/replay/upload?token=secret",
    onRecordingLost: lost,
    ...options,
  });
  const batches = () => browser.log.filter((entry) => entry.path.endsWith("/batches"));
  const bodies = () =>
    fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init!.body)) as Record<string, unknown> }));
  return {
    fixture,
    browser,
    fetchSpy,
    uploader,
    lost,
    batches,
    bodies,
    setOnline: (value: boolean) => {
      online = value;
    },
    jumpWallClock: (ms: number) => {
      wallOffset += ms;
    },
    freezeMonotonic: (value: number | null) => {
      monoFrozen = value;
    },
  };
}

// Advances fake time, then lets zero-latency fixture requests started at the
// final instant settle.
async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

describe("createReplayUploader", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports unavailable when registration allocation is blocked, without throwing into capture", () => {
    const { uploader, fetchSpy } = setup({ randomUUID: () => { throw new Error("blocked"); } });
    expect(() => uploader.push(meta(), 1)).not.toThrow();
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "unavailable", current: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    uploader.dispose();
  });

  it("registers before any upload and freezes startedAt to the first event", async () => {
    const { uploader, browser, batches, bodies } = setup({ mode: "delay_registration" });

    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    for (let i = 0; i < 3; i++) uploader.push(incremental(T0 + 10 + i), 1);

    expect(uploader.getState()).toMatchObject({ status: "recorder_started", current: null, bufferedEvents: 5, evidence: "unverified" });
    await flush(1_000);
    expect(batches()).toHaveLength(0);

    await flush(1_000);
    expect(uploader.getState()).toMatchObject({ status: "registered", current: { startedAt: T0, boundary: 1 } });
    expect(bodies().find(({ url }) => url.endsWith("/recordings"))!.body).toEqual({
      contractVersion: 1,
      idempotencyKey: expect.any(String),
      startedAt: T0,
      route: "/styleguide/replay/upload",
      recorderVersion: "2.2.0",
      configVersion: "3",
      release: "build-a",
      viewport: { width: 390, height: 844 },
    });

    await flush(5_000);
    expect(batches()).toEqual([expect.objectContaining({ sequence: 0, eventCount: 5, firstEventTypes: [4, 2], status: 200 })]);
    expect(uploader.getState()).toMatchObject({ status: "pending", bufferedEvents: 0 });
    expect(JSON.stringify(browser.log)).not.toMatch(/subjectId|projectId/);
    for (const { body } of bodies()) expect(Object.keys(body)).not.toContain("subjectId");
  });

  it("uploads one ordered batch at a time", async () => {
    const { uploader, browser, batches } = setup();

    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    for (let i = 0; i < 1_198; i++) uploader.push(incremental(T0 + i + 2), 1);
    await flush(0);
    await flush(5_000);

    expect(batches().map((entry) => [entry.sequence, entry.eventCount])).toEqual([
      [0, 500],
      [1, 500],
      [2, 200],
    ]);
    expect(browser.maxInFlight()).toBe(1);
    expect(uploader.getState().history[0]).toMatchObject({ outcome: "open", acceptedBatches: 3, availability: "events_received" });
  });

  it("retries a lost identity acknowledgment before any registration", async () => {
    let identityCalls = 0;
    const fixture = setup({
      fetch: (async (url, init) => {
        if (String(url).endsWith("/identity") && ++identityCalls === 1) throw new TypeError("response lost");
        return relay(url, init);
      }) as typeof fetch,
    });
    const relay: typeof fetch = fixture.browser.fetch;
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(0);
    expect(fixture.fixture.recordings()).toHaveLength(0);
    await flush(500);
    expect(identityCalls).toBe(2);
    expect(fixture.fixture.recordings()).toHaveLength(1);
    await flush(6_000);
    expect(fixture.uploader.getState()).toMatchObject({ status: "pending" });
    fixture.uploader.dispose();
  });

  it("keeps one request in flight across a closing and a new recording", async () => {
    let inFlight = 0;
    let maximum = 0;
    const fixture = setup({
      fetch: (async (url, init) => {
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        try {
          if (String(url).endsWith("/batches")) await new Promise((resolve) => setTimeout(resolve, 2_000));
          return await relay(url, init);
        } finally {
          inFlight--;
        }
      }) as typeof fetch,
    });
    const relay: typeof fetch = fixture.browser.fetch;
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(5_000);
    fixture.uploader.push(meta(T0 + 5_000), 2);
    fixture.uploader.push(full(T0 + 5_001), 2);
    await flush(20_000);
    expect(maximum).toBe(1);
    expect(fixture.uploader.getState().history).toHaveLength(2);
    fixture.uploader.dispose();
  });

  it("cancels hung requests on deadline and consent withdrawal", async () => {
    const signals: AbortSignal[] = [];
    const hanging = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const { uploader } = setup({ fetch: hanging as unknown as typeof fetch });
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(REPLAY_UPLOAD_REQUEST_TIMEOUT_MS);
    expect(signals[0]!.aborted).toBe(true);
    await flush(500);
    expect(hanging).toHaveBeenCalledTimes(2);
    uploader.clear();
    expect(signals[1]!.aborted).toBe(true);
    expect(uploader.getState()).toMatchObject({ bufferedEvents: 0, bufferedBytes: 0, current: null });
    await flush(60_000);
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it("keeps one private-data budget when a new boundary replaces a pending one", async () => {
    const pendingSignals: AbortSignal[] = [];
    const fixture = setup({
      getLimits: () => ({ ...REPLAY_RECORDING_LIMITS, maxBufferBytes: 1_000 }),
      fetch: (async (url, init) => {
        if (String(url).endsWith("/batches")) {
          const signal = init!.signal!;
          pendingSignals.push(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        const response = await relay(url, init);
        if (!String(url).endsWith("/recordings")) return response;
        const body = await response.json();
        return Response.json({ ...body, limits: { ...body.limits, maxBufferBytes: 1_000 } }, { status: response.status });
      }) as typeof fetch,
    });
    const relay: typeof fetch = fixture.browser.fetch;
    let maximum = 0;
    fixture.uploader.subscribe(() => {
      maximum = Math.max(maximum, fixture.uploader.getState().bufferedBytes);
    });
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(T0 + 1, 500), 1);
    await flush(5_000);
    fixture.uploader.push(meta(T0 + 5_000), 2);
    fixture.uploader.push(full(T0 + 5_001, 500), 2);
    await flush(0);
    expect(maximum).toBeLessThanOrEqual(1_000);
    expect(pendingSignals[0]!.aborted).toBe(true);
    expect(fixture.uploader.getState().history.find((entry) => entry.reference.boundary === 1)).toMatchObject({
      outcome: "incomplete", reason: "buffer_exceeded",
    });
    fixture.uploader.dispose();
  });

  it("freezes producer-owned events before buffering and retry", async () => {
    const { uploader, bodies } = setup();
    const event = full();
    uploader.push(meta(), 1);
    uploader.push(event, 1);
    (event.data as { node: { pad: string } }).node.pad = "changed-after-enqueue";
    await flush(5_000);
    const sent = bodies().find(({ url }) => url.endsWith("/batches"))!.body;
    expect(JSON.stringify(sent)).not.toContain("changed-after-enqueue");
    uploader.dispose();
  });

  it("does not adopt another producer's sequence on the first registration acknowledgment", async () => {
    const fixture = setup({
      fetch: (async (url, init) => {
        const response = await relay(url, init);
        if (String(url).endsWith("/recordings") && response.ok) {
          return Response.json({ ...await response.json(), nextSequence: 4 }, { status: 200 });
        }
        return response;
      }) as typeof fetch,
    });
    const relay: typeof fetch = fixture.browser.fetch;
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(5_000);
    expect(fixture.batches()).toHaveLength(0);
    expect(fixture.lost).toHaveBeenCalledWith("out_of_order");
    expect(fixture.uploader.getState()).toMatchObject({ status: "unavailable", reason: "out_of_order", current: null });
  });

  it("renews an expired capability once and resends the identical batch", async () => {
    const { uploader, fixture, bodies, browser } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(5_000);
    fixture.expireCapabilities();

    uploader.push(incremental(T0 + 100), 1);
    await flush(5_000);

    const paths = browser.log.map((entry) => `${entry.path.replace(/[0-9a-f-]{36}/, ":id")} ${entry.status} ${entry.code ?? ""}`.trim());
    expect(paths).toEqual([
      "/identity 200",
      "/recordings 201",
      "/recordings/:id/batches 200",
      "/recordings/:id/batches 401 capability_expired",
      "/recordings/:id/capability 200",
      "/recordings/:id/batches 200",
    ]);
    const [expired, resent] = bodies().filter(({ url }) => url.endsWith("/batches")).slice(1).map(({ body }) => body);
    const { recordingToken: oldToken, ...expiredRest } = expired!;
    const { recordingToken: newToken, ...resentRest } = resent!;
    expect(resentRest).toEqual(expiredRest);
    expect(newToken).not.toBe(oldToken);
    expect(uploader.getState()).toMatchObject({ status: "pending" });
  });

  it("makes exactly maxAttempts attempts of the same batch, then reports attempts exhausted", async () => {
    const { uploader, fixture, batches } = setup();
    uploader.push(meta(), 1);
    await flush(0);
    fixture.setMode("fail_503");
    uploader.push(full(), 1);
    await flush(5_000);
    await flush(500);
    await flush(1_000);
    await flush(5_000);

    expect(batches()).toHaveLength(3);
    expect(new Set(batches().map((entry) => entry.batchId)).size).toBe(1);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "attempts_exhausted", bufferedEvents: 0 });
  });

  it("buffers offline without spending attempts, then ends at the age or byte bound", async () => {
    const age = setup();
    age.uploader.push(meta(), 1);
    await flush(0);
    age.setOnline(false);
    age.uploader.push(full(), 1);
    await flush(5_000);
    expect(age.uploader.getState()).toMatchObject({ status: "pending", reason: "offline", bufferedEvents: 2 });
    expect(age.batches()).toHaveLength(0);
    await flush(26_000);
    expect(age.uploader.getState()).toMatchObject({ status: "unavailable", reason: "buffer_exceeded", bufferedEvents: 0 });
    expect(age.lost).toHaveBeenCalledWith("buffer_exceeded");

    const bytes = setup();
    bytes.setOnline(false);
    bytes.uploader.push(meta(), 1);
    for (let i = 0; i < 6; i++) bytes.uploader.push(full(T0 + i, 900_000), 1);
    expect(bytes.uploader.getState()).toMatchObject({ status: "unavailable", reason: "buffer_exceeded", bufferedEvents: 0 });
    expect(bytes.lost).toHaveBeenCalledTimes(1);
  });

  it("recovers from a short offline window with no sequence gap", async () => {
    const { uploader, batches, setOnline } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(5_000);
    setOnline(false);
    uploader.push(ev(5, T0 + 200, { tag: "harness", payload: {} }), 1);
    uploader.push(ev(5, T0 + 201, { tag: "harness", payload: {} }), 1);
    await flush(5_000);
    expect(uploader.getState()).toMatchObject({ status: "pending", reason: "offline" });

    setOnline(true);
    await flush(1_000);
    expect(batches().map((entry) => [entry.sequence, entry.eventCount, entry.status])).toEqual([
      [0, 2, 200],
      [1, 2, 200],
    ]);
    expect(uploader.getState()).toMatchObject({ status: "pending", reason: null });
  });

  it("does not let wall-clock jumps or suspension extend retention", async () => {
    const back = setup();
    back.uploader.push(meta(), 1);
    await flush(0);
    back.setOnline(false);
    back.uploader.push(full(), 1);
    back.jumpWallClock(-120_000);
    await flush(31_000);
    expect(back.uploader.getState()).toMatchObject({ reason: "buffer_exceeded" });

    const suspended = setup();
    suspended.uploader.push(meta(), 1);
    await flush(0);
    suspended.setOnline(false);
    suspended.uploader.push(full(), 1);
    suspended.freezeMonotonic(Date.now());
    suspended.jumpWallClock(60_000);
    await flush(1_000);
    expect(suspended.uploader.getState()).toMatchObject({ reason: "buffer_exceeded", bufferedEvents: 0 });
  });

  it("fails an oversized snapshot explicitly, never truncating or sending it", async () => {
    const { uploader, batches, browser } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(T0 + 1, 2 * 1024 * 1024), 1);
    await flush(5_000);

    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "snapshot_too_large", bufferedEvents: 0 });
    expect(batches()).toHaveLength(0);
    expect(browser.log.map((entry) => entry.path)).toEqual(["/identity"]);

    // The recording's own (tiny) limits apply as soon as registration returns them.
    const tiny = setup({ mode: "tiny_batch" });
    tiny.uploader.push(meta(), 1);
    tiny.uploader.push(full(T0 + 1, 4_000), 1);
    await flush(5_000);
    expect(tiny.uploader.getState()).toMatchObject({ status: "unavailable", reason: "snapshot_too_large" });
    expect(tiny.batches()).toHaveLength(0);
  });

  it.each(["local", "negotiated"] as const)("rejects an opening pair that exceeds the %s whole-request budget even when each event fits", async (limitSource) => {
    const fixture = setup({
      mode: "tiny_batch",
      ...(limitSource === "local" ? { getLimits: () => ({ ...REPLAY_RECORDING_LIMITS, maxBatchBytes: 2_048 }) } : {}),
    });
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(T0 + 1, 1_350), 1);
    await flush(5_000);
    expect(fixture.uploader.getState()).toMatchObject({
      status: "unavailable", reason: "snapshot_too_large", current: null, bufferedEvents: 0, bufferedBytes: 0,
    });
    expect(fixture.batches()).toHaveLength(0);
    fixture.uploader.dispose();
  });

  it("requires room for both opening events in the negotiated event-count limit", async () => {
    const fixture = setup({ fetch: (async (url, init) => {
      const response = await relay(url, init);
      if (!String(url).endsWith("/recordings")) return response;
      const body = await response.json();
      return Response.json({ ...body, limits: { ...body.limits, maxBatchEvents: 1 } }, { status: response.status });
    }) as typeof fetch });
    const relay = fixture.browser.fetch;
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(5_000);
    expect(fixture.uploader.getState()).toMatchObject({ reason: "snapshot_too_large", bufferedEvents: 0 });
    expect(fixture.batches()).toHaveLength(0);
    fixture.uploader.dispose();
  });

  it("never uploads a Meta-only opening on a flush tick or pagehide", async () => {
    const fixture = setup();
    fixture.uploader.push(meta(), 1);
    await flush(5_000);
    fixture.uploader.flushOnPageHide();
    await flush(0);
    expect(fixture.batches()).toHaveLength(0);
    fixture.uploader.dispose();
  });

  it("keeps a near-limit opening pair together with immutable receipt recovery", async () => {
    let lost = false;
    const sent: unknown[] = [];
    const fixture = setup({ mode: "tiny_batch", fetch: (async (url, init) => {
      if (String(url).endsWith("/batches")) sent.push(JSON.parse(String(init!.body)));
      const response = await relay(url, init);
      if (String(url).endsWith("/batches") && !lost) {
        lost = true;
        throw new TypeError("accepted receipt lost");
      }
      return response;
    }) as typeof fetch });
    const relay = fixture.browser.fetch;
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(T0 + 1, 1_300), 1);
    fixture.uploader.push(incremental(T0 + 2), 1);
    await flush(500);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    const batch = replayBatchRequestSchema.parse(sent[0]);
    expect(batch.sequence).toBe(0);
    expect(batch.events).toEqual([meta(), full(T0 + 1, 1_300)]);
    // The BFF adds its server-owned subject to this complete JSON envelope.
    expect(new TextEncoder().encode(JSON.stringify({ ...batch, subjectId: `sub_${"x".repeat(43)}` })).byteLength).toBeLessThanOrEqual(2_048);
    expect(fixture.uploader.getProgress()).toMatchObject({ snapshotReceived: true, acceptedBatches: 1 });
    expect(fixture.uploader.getState().bufferedEvents).toBe(1);
    fixture.uploader.dispose();
  });

  it("quarantines on delivery_uncertain: no further request for that recording", async () => {
    const { uploader, fixture, browser, lost } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(5_000);
    const recordingId = uploader.getState().current!.recordingId;
    fixture.setMode("delivery_uncertain_next");
    uploader.push(incremental(T0 + 100), 1);
    await flush(5_000);

    expect(lost).toHaveBeenCalledWith("delivery_uncertain");
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "delivery_uncertain", current: null });
    expect(uploader.getState().history[0]).toMatchObject({ reference: { recordingId }, outcome: "incomplete", reason: "delivery_uncertain" });

    const before = browser.log.length;
    uploader.push(incremental(T0 + 200), 1);
    await flush(30_000);
    expect(browser.log.length).toBe(before);
    expect(browser.log.filter((entry) => entry.code === "delivery_uncertain")).toHaveLength(1);
  });

  it("ends out_of_order as incomplete without renumbering", async () => {
    const { uploader, fixture, batches, lost } = setup();
    uploader.push(meta(), 1);
    await flush(0);
    fixture.scriptBatchAnswers({
      status: 409,
      body: { contractVersion: 1, error: "The batch is out of order", code: "out_of_order", expectedSequence: 4 },
    });
    uploader.push(full(), 1);
    await flush(5_000);
    expect(batches().map((entry) => entry.sequence)).toEqual([0]);
    expect(lost).toHaveBeenCalledWith("out_of_order");
  });

  it("stops on a rejected publishing credential without renewing", async () => {
    const { uploader, fixture, browser, lost } = setup();
    uploader.push(meta(), 1);
    await flush(0);
    fixture.scriptBatchAnswers({
      status: 401,
      body: { contractVersion: 1, error: "The publishing credential was rejected", code: "REPLAY_CREDENTIAL_INVALID" },
    });
    uploader.push(full(), 1);
    await flush(10_000);
    expect(browser.log.some((entry) => entry.path.endsWith("/capability"))).toBe(false);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "REPLAY_CREDENTIAL_INVALID" });
    expect(lost).not.toHaveBeenCalled();
  });

  it("honors retryAfterMs for rate limiting", async () => {
    const { uploader, fixture, batches } = setup();
    uploader.push(meta(), 1);
    await flush(0);
    fixture.scriptBatchAnswers({
      status: 429,
      body: { contractVersion: 1, error: "Too many requests", code: "rate_limited", retryAfterMs: 1_800 },
    });
    uploader.push(full(), 1);
    await flush(5_000);
    expect(batches()).toHaveLength(1);
    await flush(1_700);
    expect(batches()).toHaveLength(1);
    await flush(200);
    expect(batches().map((entry) => entry.status)).toEqual([429, 200]);
  });

  it("finalizes the previous recording when a new boundary starts and discards older boundaries", async () => {
    const { uploader, batches, browser } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(5_000);
    const first = uploader.getState().current!;

    uploader.push(meta(T0 + 1_000), 2);
    uploader.push(incremental(T0 + 1_001), 1);
    await flush(0);
    const finals = batches().filter((entry) => entry.final);
    expect(finals).toEqual([expect.objectContaining({ recordingId: first.recordingId, eventCount: 0, sequence: 1, status: 200 })]);
    expect(uploader.getState().history.find((entry) => entry.reference.recordingId === first.recordingId)).toMatchObject({
      outcome: "closed",
    });
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(uploader.getState()).toMatchObject({ current: { boundary: 2, startedAt: T0 + 1_000 } });
  });

  it("clears queued data on withdrawal and keeps history", async () => {
    const { uploader, browser } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(5_000);
    const reference = uploader.getState().current!;
    uploader.push(incremental(T0 + 300), 1);

    uploader.clear();
    const before = browser.log.length;
    await flush(30_000);

    expect(uploader.getState()).toMatchObject({ status: "idle", current: null, bufferedEvents: 0, evidence: "unverified" });
    expect(uploader.getState().history[0]!.reference).toEqual(reference);
    expect(browser.log.length).toBe(before);
    uploader.push(incremental(T0 + 400), 1);
    await flush(10_000);
    expect(browser.log.length).toBe(before);
  });

  it("sends a small keepalive final on pagehide only when nothing is in flight", async () => {
    const { uploader, fetchSpy } = setup();
    uploader.push(meta(), 1);
    uploader.push(full(), 1);
    await flush(5_000);
    uploader.push(incremental(T0 + 500), 1);

    uploader.flushOnPageHide();
    await flush(0);
    const [, init] = fetchSpy.mock.calls.at(-1)!;
    expect(init).toMatchObject({ keepalive: true });
    expect(JSON.parse(String(init!.body))).toMatchObject({ final: true, sequence: 1 });
  });

  it("continues an acknowledged clean reload under the same recording with a fresh snapshot", async () => {
    const original = setup();
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const reference = original.uploader.getRecordingReference()!;
    const checkpoint = original.uploader.quiesceForHandoff()!;
    expect(checkpoint).toMatchObject({
      recordingId: reference.recordingId, startedAt: T0, nextSequence: 1,
      snapshotReceived: true, lastAcknowledgment: { sequence: 0, nextSequence: 1, delivery: "accepted" },
    });
    expect(JSON.stringify(checkpoint)).not.toMatch(/"recordingToken"|"events"|"visitor"|"subjectId"/);
    expect(replayUploadCheckpointSchema.safeParse({ ...checkpoint, recordingToken: "forbidden" }).success).toBe(false);
    expect(replayUploadCheckpointSchema.safeParse({ ...checkpoint, nextSequence: 10 }).success).toBe(false);
    expect(original.uploader.commitHandoff()).toBe(true);
    original.uploader.flushOnPageHide();
    original.uploader.push(incremental(Date.now()), 1);
    expect(original.fixture.recordings()[0]!.status).toBe("open");

    const successor = setup({
      fetch: original.fetchSpy,
      getRoute: () => "/new-route",
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const resumed = successor.uploader.resumeFromCheckpoint(checkpoint, 1, { deadline: Date.now() + 15_000 });
    expect(successor.uploader.getRecordingReference()).toBeNull();
    await flush(0);
    expect(await resumed).toBe(true);
    expect(successor.uploader.getRecordingReference()).toEqual(reference);
    expect(successor.uploader.getProgress()).toMatchObject({ continuity: "resuming", snapshotReceived: false });
    expect(original.bodies().filter(({ url }) => url.endsWith("/recordings")).map(({ body }) => body))
      .toEqual([checkpoint.registration, checkpoint.registration]);
    expect(original.browser.log.filter((entry) => entry.path === "/identity")).toHaveLength(2);

    successor.uploader.push(meta(Date.now()), 1);
    successor.uploader.push(full(Date.now() + 1), 1);
    await flush(5_000);
    expect(original.fixture.recordings()).toHaveLength(1);
    expect(original.batches()).toEqual([
      expect.objectContaining({ recordingId: reference.recordingId, sequence: 0, final: false }),
      expect.objectContaining({ recordingId: reference.recordingId, sequence: 1, firstEventTypes: [4, 2], final: false }),
    ]);
    expect(successor.uploader.getProgress()).toMatchObject({ continuity: "resumed", snapshotReceived: true });
    await flush(1); // The receipt wake task must settle before a new clean frontier exists.
    expect(successor.uploader.getCheckpoint()).toMatchObject({ nextSequence: 2, startedAt: T0 });
    successor.uploader.dispose();
    original.uploader.dispose();
  });

  it("revalidates only its own quiesced frontier without releasing cooperative ownership", async () => {
    const ended = vi.fn();
    const fixture = setup({ onRecordingEnded: ended });
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(5_000);
    const initial = fixture.uploader.getRecordingReference()!;
    await flush(1);
    const unpaused = fixture.uploader.getCheckpoint()!;
    expect(unpaused).not.toBeNull();
    expect(await fixture.uploader.resumeFromCheckpoint(unpaused, 2, { revalidate: true })).toBe(false);
    const checkpoint = fixture.uploader.quiesceForHandoff()!;
    const revalidated = fixture.uploader.resumeFromCheckpoint(checkpoint, 2, { revalidate: true });
    await flush(0);
    expect(await revalidated).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    expect(fixture.uploader.getRecordingReference()).toMatchObject({
      recordingId: initial.recordingId, startedAt: initial.startedAt, boundary: 2,
    });
    expect(fixture.uploader.getProgress()).toMatchObject({ continuity: "resuming", snapshotReceived: false });
    fixture.uploader.push(meta(Date.now()), 2);
    fixture.uploader.push(full(Date.now() + 1), 2);
    await flush(5_000);
    expect(fixture.fixture.recordings()).toHaveLength(1);
    expect(fixture.batches()).toEqual([
      expect.objectContaining({ sequence: 0, firstEventTypes: [4, 2] }),
      expect.objectContaining({ sequence: 1, firstEventTypes: [4, 2] }),
    ]);
    expect(fixture.uploader.getProgress()).toMatchObject({ continuity: "resumed", snapshotReceived: true });
    expect(fixture.uploader.getState().history).toEqual([
      expect.objectContaining({
        reference: { recordingId: initial.recordingId, startedAt: T0, boundary: 2 },
        acceptedBatches: 2, outcome: "open",
      }),
    ]);
    // Consumers holding the earlier evidence reference retain its local boundary.
    expect(initial).toEqual({ recordingId: checkpoint.recordingId, startedAt: T0, boundary: 1 });
    expect(Object.isFrozen(initial)).toBe(true);
    fixture.uploader.dispose();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith(checkpoint.registration, initial.recordingId);
  });

  it("rejects stale or dirty same-document revalidation without dropping the owned stream", async () => {
    const fixture = setup();
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(5_000);
    await flush(1);
    const checkpoint = fixture.uploader.getCheckpoint()!;
    expect(checkpoint).not.toBeNull();
    fixture.uploader.push(incremental(Date.now()), 1);
    expect(fixture.uploader.quiesceForHandoff()).toBeNull();
    expect(await fixture.uploader.resumeFromCheckpoint(checkpoint, 2, { revalidate: true })).toBe(false);
    await flush(5_000);
    expect(fixture.uploader.quiesceForHandoff()!.nextSequence).toBe(2);
    expect(await fixture.uploader.resumeFromCheckpoint(checkpoint, 2, { revalidate: true })).toBe(false);
    expect(fixture.uploader.getRecordingReference()?.recordingId).toBe(checkpoint.recordingId);
    expect(fixture.batches()).toHaveLength(2);
    fixture.uploader.dispose();
  });

  it.each([1_300, 1_350])("keeps the resumed opening pair atomic at %i snapshot padding bytes", async (size) => {
    const original = setup({ mode: "tiny_batch" });
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const checkpoint = original.uploader.quiesceForHandoff()!;
    original.uploader.commitHandoff();
    const successor = setup({ fetch: original.browser.fetch });
    const resumed = successor.uploader.resumeFromCheckpoint(checkpoint);
    await flush(0);
    expect(await resumed).toBe(true);
    successor.uploader.push(meta(Date.now()), 1);
    successor.uploader.push(full(Date.now() + 1, size), 1);
    await flush(5_000);
    if (size === 1_300) {
      expect(original.batches()).toHaveLength(2);
      expect(original.batches()[1]).toMatchObject({ sequence: 1, eventCount: 2, firstEventTypes: [4, 2] });
      expect(successor.uploader.getProgress()).toMatchObject({ continuity: "resumed", snapshotReceived: true });
    } else {
      expect(original.batches()).toHaveLength(1);
      expect(successor.uploader.getState()).toMatchObject({ reason: "snapshot_too_large", current: null, bufferedEvents: 0 });
      expect(successor.uploader.getProgress().continuity).not.toBe("resumed");
    }
    successor.uploader.dispose();
    original.uploader.dispose();
  });

  it("does not reopen when registration succeeds but the first resumed append is closed", async () => {
    const original = setup();
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const checkpoint = original.uploader.quiesceForHandoff()!;
    original.uploader.commitHandoff();
    const successor = setup({ fetch: original.browser.fetch });
    const resumed = successor.uploader.resumeFromCheckpoint(checkpoint);
    await flush(0);
    expect(await resumed).toBe(true);
    expect(original.fixture.closeRecording(checkpoint.recordingId)).toBe(true);
    successor.uploader.push(meta(Date.now()), 1);
    successor.uploader.push(full(Date.now() + 1), 1);
    await flush(5_000);
    expect(successor.uploader.getState()).toMatchObject({ status: "unavailable", reason: "recording_closed", current: null, bufferedEvents: 0 });
    expect(successor.uploader.getProgress()).toMatchObject({ continuity: "resuming", snapshotReceived: false });
    expect(original.batches()).toHaveLength(2);
    expect(original.batches()[1]).toMatchObject({ sequence: 1, code: "recording_closed" });
    expect(original.fixture.recordings()).toMatchObject([{ recordingId: checkpoint.recordingId, status: "closed", nextSequence: 1 }]);
    successor.uploader.push(incremental(Date.now()), 1);
    await flush(10_000);
    expect(original.browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(original.batches()).toHaveLength(2);
    successor.uploader.dispose();
    original.uploader.dispose();
  });

  it.each(["higher", "lower", "different_id", "different_start", "changed_limits", "closed"] as const)(
    "rejects a clean resume acknowledgment with %s without adopting a server cursor",
    async (mismatch) => {
      const original = setup();
      original.uploader.push(meta(), 1);
      original.uploader.push(full(), 1);
      await flush(5_000);
      const checkpoint = original.uploader.quiesceForHandoff()!;
      original.uploader.commitHandoff();
      const resumedFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const response = await original.browser.fetch(url, init);
        if (!String(url).endsWith("/recordings")) return response;
        if (mismatch === "closed") return Response.json({ contractVersion: 1, error: "Closed", code: "recording_closed" }, { status: 409 });
        const body = await response.json();
        return Response.json({ ...body,
          ...(mismatch === "higher" ? { nextSequence: checkpoint.nextSequence + 1 } : {}),
          ...(mismatch === "lower" ? { nextSequence: checkpoint.nextSequence - 1 } : {}),
          ...(mismatch === "different_id" ? { recordingId: crypto.randomUUID() } : {}),
          ...(mismatch === "different_start" ? { startedAt: checkpoint.startedAt + 1 } : {}),
          ...(mismatch === "changed_limits" ? { limits: { ...body.limits, maxBatchBytes: 2_048 } } : {}),
        });
      });
      const successor = setup({ fetch: resumedFetch });
      const result = successor.uploader.resumeFromCheckpoint(checkpoint);
      await flush(0);
      expect(await result).toBe(false);
      expect(successor.uploader.getRecordingReference()).toBeNull();
      expect(successor.lost).not.toHaveBeenCalled(); // Root owns the one-shot fallback budget.
      successor.uploader.push(meta(Date.now()), 1);
      successor.uploader.push(full(Date.now() + 1), 1);
      await flush(10_000);
      expect(original.batches()).toHaveLength(1);
      expect(resumedFetch.mock.calls.filter(([url]) => String(url).endsWith("/recordings"))).toHaveLength(1);
      successor.uploader.dispose();
      original.uploader.dispose();
    },
  );

  it("checkpoints negotiated recording limits rather than the runtime policy limits", async () => {
    const original = setup({ mode: "tiny_batch" });
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const checkpoint = original.uploader.quiesceForHandoff()!;
    expect(checkpoint.limits).toEqual({ ...REPLAY_RECORDING_LIMITS, maxBatchBytes: 2_048 });
    expect(replayUploadCheckpointSchema.safeParse({ ...checkpoint, limits: { ...checkpoint.limits, unknown: true } }).success).toBe(false);
    original.uploader.commitHandoff();
    const successor = setup({ fetch: original.browser.fetch });
    const resumed = successor.uploader.resumeFromCheckpoint(checkpoint);
    await flush(0);
    expect(await resumed).toBe(true);
    successor.uploader.push(meta(Date.now()), 1);
    successor.uploader.push(full(Date.now() + 1), 1);
    await flush(5_000);
    expect(successor.uploader.quiesceForHandoff()!.limits).toEqual(checkpoint.limits);
    successor.uploader.dispose();
    original.uploader.dispose();
  });

  it("does not checkpoint queued, unacknowledged or unsettled work, and preserves fallback finalization", async () => {
    const original = setup();
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    expect(original.uploader.getCheckpoint()).toBeNull();
    let inspectedContinuation = false;
    original.uploader.subscribe(() => {
      if (!inspectedContinuation && original.uploader.getProgress().snapshotReceived) {
        inspectedContinuation = true;
        expect(original.uploader.quiesceForHandoff()).toBeNull();
      }
    });
    await flush(5_000);
    expect(inspectedContinuation).toBe(true);
    expect(original.uploader.getCheckpoint()).not.toBeNull();
    original.uploader.push(incremental(Date.now()), 1);
    expect(original.uploader.quiesceForHandoff()).toBeNull();
    expect(original.uploader.getState().bufferedEvents).toBe(1);
    await flush(5_000);
    expect(original.uploader.quiesceForHandoff()).not.toBeNull();
    // Metadata persistence failed: the old bounded final behavior is retained.
    original.uploader.flushOnPageHide();
    await flush(0);
    expect(original.batches().at(-1)).toMatchObject({ final: true });
    expect(original.uploader.getCheckpoint()).toBeNull();
    original.uploader.dispose();
  });

  it("cannot checkpoint accepted data whose acknowledgment was lost", async () => {
    const original = setup({ fetch: (async (url, init) => {
      const response = await relay(url, init);
      if (String(url).endsWith("/batches")) throw new TypeError("lost acknowledgment");
      return response;
    }) as typeof fetch });
    const relay: typeof fetch = original.browser.fetch;
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    expect(original.fixture.recordings()[0]!.nextSequence).toBe(1);
    expect(original.uploader.quiesceForHandoff()).toBeNull();
    expect(original.uploader.getProgress().snapshotReceived).toBe(false);
    expect(original.uploader.getState().bufferedEvents).toBe(2);
    original.uploader.dispose();
  });

  it("bounds repeated lost resumed snapshot receipts without changing the batch or claiming continuity", async () => {
    const original = setup();
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const checkpoint = original.uploader.quiesceForHandoff()!;
    expect(original.uploader.commitHandoff()).toBe(true);
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await original.browser.fetch(url, init);
      if (String(url).endsWith("/batches")) throw new TypeError("accepted resumed snapshot receipt lost");
      return response;
    });
    const successor = setup({ fetch });
    const resumed = successor.uploader.resumeFromCheckpoint(checkpoint);
    await flush(0);
    expect(await resumed).toBe(true);
    successor.uploader.push(meta(Date.now()), 1);
    successor.uploader.push(full(Date.now() + 1), 1);
    await flush(6_500);
    expect(successor.uploader.getState()).toMatchObject({ status: "unavailable", reason: "attempts_exhausted",
      current: null, bufferedEvents: 0, bufferedBytes: 0,
      history: [expect.objectContaining({ outcome: "incomplete", reason: "attempts_exhausted", acceptedBatches: 1 })] });
    expect(successor.uploader.getProgress()).toMatchObject({ continuity: "resuming", snapshotReceived: false });
    expect(successor.uploader.getCheckpoint()).toBeNull();
    expect(successor.lost).not.toHaveBeenCalled();
    const attempts = fetch.mock.calls.filter(([url]) => String(url).endsWith("/batches"));
    expect(attempts).toHaveLength(REPLAY_RECORDING_LIMITS.maxAttempts);
    expect(new Set(attempts.map(([, init]) => init!.body)).size).toBe(1);
    expect(JSON.parse(String(attempts[0]![1]!.body))).toMatchObject({ sequence: checkpoint.nextSequence, final: false });
    expect(original.fixture.recordings()).toEqual([expect.objectContaining({ recordingId: checkpoint.recordingId,
      status: "open", nextSequence: checkpoint.nextSequence + 1 })]);
    await flush(30_000);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/batches"))).toHaveLength(REPLAY_RECORDING_LIMITS.maxAttempts);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/recordings"))).toHaveLength(1);
    successor.uploader.dispose(); original.uploader.dispose();
  });

  it("bounds and cancels resume identity work without admitting recorder events", async () => {
    const original = setup();
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const checkpoint = original.uploader.quiesceForHandoff()!;
    original.uploader.commitHandoff();
    const signals: AbortSignal[] = [];
    const successor = setup({ fetch: ((_url, init) => new Promise<Response>((_resolve, reject) => {
      signals.push(init!.signal!);
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as typeof fetch });
    const result = successor.uploader.resumeFromCheckpoint(checkpoint, 1, { deadline: Date.now() + 100 });
    successor.uploader.push(meta(Date.now()), 1);
    successor.uploader.push(full(Date.now() + 1), 1);
    expect(successor.uploader.getState().bufferedEvents).toBe(0);
    await flush(100);
    expect(await result).toBe(false);
    expect(signals[0]!.aborted).toBe(true);
    expect(successor.uploader.getCheckpoint()).toBeNull();
    successor.uploader.dispose();
    original.uploader.dispose();
  });

  it("acquires cooperative intent and recording ownership before registration and upload", async () => {
    let releaseIntent!: (value: boolean) => void;
    let releaseRecording!: (value: boolean) => void;
    const ended = vi.fn();
    const original = setup({
      beforeRegistration: () => new Promise<boolean>((resolve) => { releaseIntent = resolve; }),
      acquireOwnership: () => new Promise<boolean>((resolve) => { releaseRecording = resolve; }),
      onRecordingEnded: ended,
    });
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(0);
    expect(original.fixture.recordings()).toHaveLength(0);
    releaseIntent(true);
    await flush(0);
    expect(original.fixture.recordings()).toHaveLength(1);
    expect(original.uploader.getRecordingReference()).toBeNull();
    expect(original.batches()).toHaveLength(0);
    releaseRecording(true);
    await flush(5_000);
    expect(original.batches()).toHaveLength(1);
    original.uploader.dispose();
    await flush(0);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("releases an acquired recording lease even when cancelled before reference binding", async () => {
    const ended = vi.fn();
    let acquiredId: string | undefined;
    let finish!: (value: boolean) => void;
    const original = setup({
      acquireOwnership: (_intent, id) => { acquiredId = id; return new Promise<boolean>((resolve) => { finish = resolve; }); },
      onRecordingEnded: ended,
    });
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(0);
    expect(acquiredId).toBeTruthy();
    expect(original.uploader.getRecordingReference()).toBeNull();
    original.uploader.clear();
    finish(true);
    await flush(0);
    expect(ended).toHaveBeenCalledWith(expect.anything(), acquiredId);
    expect(original.batches()).toHaveLength(0);
    original.uploader.dispose();
  });

  it("keeps resumed ownership until an aborted request actually settles", async () => {
    const original = setup();
    original.uploader.push(meta(), 1);
    original.uploader.push(full(), 1);
    await flush(5_000);
    const checkpoint = original.uploader.quiesceForHandoff()!;
    original.uploader.commitHandoff();
    let finishRequest!: (response: Response) => void;
    const ended = vi.fn();
    const successor = setup({
      fetch: () => new Promise<Response>((resolve) => { finishRequest = resolve; }),
      onRecordingEnded: ended,
    });
    const controller = new AbortController();
    const resumed = successor.uploader.resumeFromCheckpoint(checkpoint, 1, { signal: controller.signal });
    controller.abort();
    expect(await resumed).toBe(false);
    expect(successor.uploader.hasPendingWork()).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    finishRequest(Response.json({ contractVersion: 1 }));
    await flush(0);
    expect(successor.uploader.hasPendingWork()).toBe(false);
    expect(ended).toHaveBeenCalledWith(expect.anything(), checkpoint.recordingId);
    successor.uploader.dispose();
    original.uploader.dispose();
  });

  it("serializes recorder emissions between ownership resolution and registration continuation", async () => {
    let intents = 0;
    let bindings = 0;
    const emitBetweenContinuations = () => {
      // Run after own() clears its transport busy flag but before its awaiting
      // register() continuation. The whole operation must still own the pump.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        fixture.uploader.push(incremental(Date.now()), 1);
      })));
    };
    const fixture: ReturnType<typeof setup> = setup({
      beforeRegistration: async () => {
        intents++;
        await Promise.resolve();
        if (intents === 1) emitBetweenContinuations();
        return true;
      },
      acquireOwnership: async () => {
        bindings++;
        await Promise.resolve();
        if (bindings === 1) emitBetweenContinuations();
        return true;
      },
    });
    fixture.uploader.push(meta(), 1);
    fixture.uploader.push(full(), 1);
    await flush(5_000);
    expect(intents).toBe(1);
    expect(bindings).toBe(1);
    expect(fixture.browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(1);
    expect(fixture.browser.maxInFlight()).toBe(1);
    expect(fixture.uploader.getState()).toMatchObject({ status: "pending", bufferedEvents: 0 });
    expect(fixture.batches()[0]).toMatchObject({ eventCount: 4, firstEventTypes: [4, 2] });
    fixture.uploader.dispose();
  });

  it("never throws into callers and keeps a stable state snapshot", async () => {
    const uploader = createReplayUploader({
      getLimits: () => ({ ...REPLAY_RECORDING_LIMITS }),
      getConfigVersion: () => "v1",
      fetch: (() => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
      getRoute: () => "/",
      getViewport: () => null,
    });
    uploader.subscribe(() => {
      throw new Error("listener");
    });
    expect(() => uploader.push(meta(), 1)).not.toThrow();
    const snapshot = uploader.getState();
    expect(uploader.getState()).toBe(snapshot);
    await flush(10_000);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "attempts_exhausted" });
    uploader.dispose();
  });

  it("follows the shared v1 action table", () => {
    for (const { body, action } of errors.valid) {
      expect(REPLAY_ERROR_ACTIONS[body.code as ReplayUploadErrorCode], body.code).toBe(action);
    }
  });
});
