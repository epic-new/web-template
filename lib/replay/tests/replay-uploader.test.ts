import { EventType, type eventWithTime } from "@rrweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLAY_RECORDING_LIMITS, type PublicReplayConfig } from "../replay-config.contract";
import { createReplayUploader, type ReplayUploader } from "../replay-uploader";

const T = 1_800_000_000_000;
const RECORDING_ID = "0a1b2c3d-1b0e-4d6f-9a52-2f1b9d9d1c11";

const meta = (timestamp = T): eventWithTime =>
  ({ type: EventType.Meta, timestamp, data: { href: "http://app.test/checkout?token=1#frag", width: 390, height: 844 } }) as eventWithTime;
const snapshot = (timestamp = T + 1): eventWithTime =>
  ({ type: EventType.FullSnapshot, timestamp, data: { node: {}, initialOffset: { left: 0, top: 0 } } }) as unknown as eventWithTime;
const custom = (timestamp: number): eventWithTime =>
  ({ type: EventType.Custom, timestamp, data: { tag: "epic.test", payload: {} } }) as eventWithTime;

type Logged = { path: string; body: Record<string, unknown> };

// A synthetic stand-in for the app relay answering with Epic's EPI-210 shapes.
function createFixture() {
  const log: Logged[] = [];
  const mode = { registration: null as Promise<void> | null, batch: "accept" as string, expireBefore: -1 };
  let token = 1;
  let expired = false;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const error = (code: string, status: number, extra: Record<string, unknown> = {}) =>
    json({ contractVersion: 1, error: "x", code, ...extra }, status);
  const recording = () => ({
    contractVersion: 1,
    recordingId: RECORDING_ID,
    recordingToken: `eprc_${token}`,
    tokenExpiresAt: T + 900_000,
    startedAt: T,
    availability: "waiting_for_events",
    nextSequence: 0,
    limits: REPLAY_RECORDING_LIMITS,
  });

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace("/api/epic/replay", "");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    log.push({ path, body });

    if (path === "/identity") return json({ contractVersion: 1 });
    if (path === "/recordings") {
      await mode.registration;
      return json(recording(), 201);
    }
    if (path.endsWith("/capability")) {
      token += 1;
      expired = false;
      return json(recording());
    }
    if (body.sequence === mode.expireBefore && !expired && body.recordingToken === "eprc_1") {
      expired = true;
      return error("capability_expired", 401);
    }
    if (mode.batch === "fail_503") return error("unavailable", 503);
    if (mode.batch === "uncertain" && body.sequence === 1) return error("delivery_uncertain", 409);
    return json({
      contractVersion: 1,
      recordingId: RECORDING_ID,
      batchId: body.batchId,
      sequence: body.sequence,
      delivery: "accepted",
      availability: "events_received",
      nextSequence: (body.sequence as number) + 1,
    });
  });

  return { fetchFn, log, mode, batches: () => log.filter((entry) => entry.path.endsWith("/batches")) };
}

function setup(limits: PublicReplayConfig["recording"]["limits"] = { ...REPLAY_RECORDING_LIMITS }) {
  const fixture = createFixture();
  const onRecordingLost = vi.fn();
  const uploader: ReplayUploader = createReplayUploader({
    getLimits: () => limits,
    getConfigVersion: () => "3",
    getDocumentRelease: () => "build-a",
    fetch: fixture.fetchFn as unknown as typeof fetch,
    monotonicNow: () => Date.now(),
    isOnline: () => true,
    getViewport: () => ({ width: 390, height: 844 }),
    getPathname: () => "/checkout",
    onRecordingLost,
  });
  return { fixture, uploader, onRecordingLost };
}

const settle = (ms = 100) => vi.advanceTimersByTimeAsync(ms);

describe("createReplayUploader", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers before uploading and sends the buffered events in order", async () => {
    const { fixture, uploader } = setup();
    let release!: () => void;
    fixture.mode.registration = new Promise<void>((resolve) => (release = resolve));

    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    for (const offset of [2, 3, 4]) uploader.push(custom(T + offset), 1);
    await settle();

    expect(uploader.getState()).toMatchObject({ status: "recorder_started", current: null, evidence: "unverified" });
    expect(fixture.batches()).toHaveLength(0);

    release();
    await settle();

    const [first] = fixture.batches();
    expect(first!.body).toMatchObject({ sequence: 0, final: false });
    expect((first!.body.events as eventWithTime[]).map((event) => event.timestamp)).toEqual([T, T + 1, T + 2, T + 3, T + 4]);
    // Epic rejects a Meta href with a query or fragment.
    expect(((first!.body.events as eventWithTime[])[0]!.data as { href: string }).href).toBe("http://app.test/checkout");
    expect(fixture.log.find((entry) => entry.path === "/recordings")!.body).toMatchObject({
      startedAt: T,
      route: "/checkout",
      release: "build-a",
      configVersion: "3",
      viewport: { width: 390, height: 844 },
    });
    expect(uploader.getState()).toMatchObject({
      status: "pending",
      current: { recordingId: RECORDING_ID, startedAt: T, boundary: 1 },
    });
  });

  it("never sends subject or Epic ids from the browser", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    await settle();

    const text = JSON.stringify(fixture.log);
    for (const field of ["subjectId", "projectId", "applicationId", "environment", "captureContext"]) {
      expect(text).not.toContain(`"${field}"`);
    }
  });

  it("keeps one request in flight and numbers batches in order", async () => {
    const limits = { ...REPLAY_RECORDING_LIMITS, maxBatchEvents: 500 };
    const { fixture, uploader } = setup(limits);
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    for (let index = 0; index < 1_200; index++) uploader.push(custom(T + 2 + index), 1);
    await settle(20_000);

    expect(fixture.batches().map((entry) => entry.body.sequence)).toEqual([0, 1, 2]);
  });

  it("renews an expired capability and resends the identical batch", async () => {
    const { fixture, uploader } = setup();
    fixture.mode.expireBefore = 0;
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    await settle();

    const batches = fixture.batches();
    expect(fixture.log.filter((entry) => entry.path.endsWith("/capability"))).toHaveLength(1);
    expect(batches).toHaveLength(2);
    expect({ ...batches[1]!.body, recordingToken: undefined }).toEqual({ ...batches[0]!.body, recordingToken: undefined });
    expect(batches[0]!.body.recordingToken).not.toBe(batches[1]!.body.recordingToken);
    expect(uploader.getState().status).toBe("pending");
  });

  it("stops after exactly maxAttempts of the same batch", async () => {
    const { fixture, uploader, onRecordingLost } = setup();
    fixture.mode.batch = "fail_503";
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    await settle(10_000);

    const batches = fixture.batches();
    expect(batches).toHaveLength(3);
    expect(new Set(batches.map((entry) => entry.body.batchId)).size).toBe(1);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "attempts_exhausted", bufferedEvents: 0 });
    expect(onRecordingLost).toHaveBeenCalledWith("attempts_exhausted");
  });

  it("quarantines an uncertain delivery and sends nothing more for it", async () => {
    const { fixture, uploader, onRecordingLost } = setup();
    fixture.mode.batch = "uncertain";
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    await settle();
    uploader.push(custom(T + 2), 1);
    await settle(6_000);
    const sent = fixture.log.length;
    uploader.push(custom(T + 3), 1);
    await settle(6_000);

    expect(fixture.log).toHaveLength(sent);
    expect(uploader.getState().history[0]).toMatchObject({ outcome: "incomplete", acceptedBatches: 1 });
    expect(onRecordingLost).toHaveBeenCalledWith("delivery_uncertain");
  });

  it("fails explicitly when a snapshot cannot fit one batch", async () => {
    const { fixture, uploader } = setup({ ...REPLAY_RECORDING_LIMITS, maxBatchBytes: 2_048 });
    uploader.push(meta(), 1);
    uploader.push(
      { ...snapshot(), data: { node: { text: "x".repeat(4_000) }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime,
      1,
    );
    await settle();

    expect(fixture.batches()).toHaveLength(0);
    expect(fixture.log.some((entry) => entry.path === "/recordings")).toBe(true);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "snapshot_too_large" });
  });

  it("drops queued events on clear and keeps the earlier reference", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    await settle();
    uploader.push(custom(T + 2), 1);
    uploader.clear();
    const sent = fixture.log.length;
    await settle(10_000);

    expect(fixture.log).toHaveLength(sent);
    expect(uploader.getState()).toMatchObject({ status: "idle", bufferedEvents: 0, current: null });
    expect(uploader.getState().history[0]!.reference.recordingId).toBe(RECORDING_ID);
  });

  it("registers a new recording for a new boundary with its own key", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    await settle();
    uploader.push(meta(T + 10_000), 2);
    uploader.push(snapshot(T + 10_001), 2);
    await settle(10_000);

    const keys = fixture.log.filter((entry) => entry.path === "/recordings").map((entry) => entry.body.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
