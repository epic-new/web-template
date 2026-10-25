import { EventType, type eventWithTime } from "@rrweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLAY_RECORDING_LIMITS, type PublicReplayConfig } from "../replay-config.contract";
import { EVIDENCE_EVENTS, type OtlpLogRecord, type OtlpLogsRequest } from "../replay-otlp";
import { createReplaySessionStore, REPLAY_SESSION_IDLE_MS, type ReplaySessionStore } from "../replay-session";
import { createReplayUploader, type ReplayUploader } from "../replay-uploader";

const T = 1_800_000_000_000;

const meta = (timestamp = T): eventWithTime =>
  ({ type: EventType.Meta, timestamp, data: { href: "http://app.test/checkout?token=1#frag", width: 390, height: 844 } }) as eventWithTime;
const snapshot = (timestamp = T + 1): eventWithTime =>
  ({ type: EventType.FullSnapshot, timestamp, data: { node: {}, initialOffset: { left: 0, top: 0 } } }) as unknown as eventWithTime;
const custom = (timestamp: number, payload: unknown = {}): eventWithTime =>
  ({ type: EventType.Custom, timestamp, data: { tag: "epic.test", payload } }) as eventWithTime;

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

let counter = 0;
const randomBytes = (length: number) => new Uint8Array(length).fill(++counter);

function sessionStore(storage = new MemoryStorage()): ReplaySessionStore {
  return createReplaySessionStore({ storage: storage as unknown as Storage, now: () => Date.now(), randomBytes });
}

const attr = (record: OtlpLogRecord, key: string) => record.attributes.find((entry) => entry.key === key)?.value.stringValue;
const recordsOf = (request: OtlpLogsRequest) =>
  request.resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords));

type Logged = { path: string; body: OtlpLogsRequest; keepalive: boolean | undefined };

// A synthetic stand-in for the app relay answering the way Epic's ingest does.
function createFixture() {
  const log: Logged[] = [];
  const mode = { reply: "accept" as string, once: false };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const error = (code: string, status: number, extra: Record<string, unknown> = {}) =>
    json({ contractVersion: 1, error: "x", code, ...extra }, status);

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    log.push({
      path: String(input).replace("/api/epic/replay", ""),
      body: JSON.parse(String(init?.body)) as OtlpLogsRequest,
      keepalive: init?.keepalive,
    });
    if (mode.reply === "fail_503") return error("unavailable", 503);
    if (mode.reply === "capture_disabled") return error("capture_disabled", 403);
    if (mode.reply === "too_large") return error("payload_too_large", 413);
    if (mode.reply === "rate_limited_once" && !mode.once) {
      mode.once = true;
      return error("rate_limited", 429, { retryAfterMs: 3_000 });
    }
    if (mode.reply === "lost_ack_once" && !mode.once) {
      mode.once = true;
      throw new TypeError("network");
    }
    return json({ partialSuccess: {} });
  });

  return { fetchFn, log, mode };
}

function setup(
  limits: PublicReplayConfig["recording"]["limits"] = { ...REPLAY_RECORDING_LIMITS },
  { random = () => 0, sessions = sessionStore() }: { random?: () => number; sessions?: ReplaySessionStore } = {},
) {
  const fixture = createFixture();
  const onRecordingLost = vi.fn();
  const uploader: ReplayUploader = createReplayUploader({
    getLimits: () => limits,
    getDocumentRelease: () => "build-a",
    sessions,
    fetch: fixture.fetchFn as unknown as typeof fetch,
    monotonicNow: () => Date.now(),
    isOnline: () => true,
    random,
    onRecordingLost,
  });
  return { fixture, uploader, onRecordingLost, sessions };
}

const settle = (ms = 100) => vi.advanceTimersByTimeAsync(ms);
const INTERVAL = REPLAY_RECORDING_LIMITS.flushIntervalMs + 100;

describe("createReplayUploader", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends events as ClickStack log records in order, under one session id", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    for (const offset of [2, 3]) uploader.push(custom(T + offset), 1);
    await settle();
    expect(fixture.log).toHaveLength(0);

    await settle(INTERVAL);
    expect(fixture.log).toHaveLength(1);
    const [{ path, body }] = fixture.log;
    expect(path).toBe("/telemetry");

    const resource = body.resourceLogs[0]!.resource.attributes;
    const sessionId = resource.find((entry) => entry.key === "rum.sessionId")!.value.stringValue;
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(resource.find((entry) => entry.key === "service.version")!.value.stringValue).toBe("build-a");
    expect(body.resourceLogs[0]!.scopeLogs.map((scope) => scope.scope.name)).toEqual(["rum.rr-web"]);

    const records = recordsOf(body);
    expect(records.map((record) => record.timeUnixNano)).toEqual([T, T + 1, T + 2, T + 3].map((ms) => `${ms}000000`));
    expect(records.map((record) => attr(record, "rr-web.offset"))).toEqual(["0", "1", "2", "3"]);
    expect(records.map((record) => attr(record, "rr-web.event"))).toEqual(["0", "1", "2", "3"]);
    expect(records.map((record) => attr(record, "rr-web.chunk"))).toEqual(["1", "1", "1", "1"]);
    expect(records.map((record) => attr(record, "rr-web.total-chunks"))).toEqual(["1", "1", "1", "1"]);

    const first = JSON.parse(records[0]!.body.stringValue) as { type: number; data: { href: string } };
    expect(Object.keys(first)[0]).toBe("type");
    // A query or fragment can carry tokens; the recording keeps the path.
    expect(first.data.href).toBe("http://app.test/checkout");
  });

  it("never sends subject, Epic ids or scope attributes from the browser", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.flushNow();
    await settle();

    const text = JSON.stringify(fixture.log);
    for (const field of ["subjectId", "epic.subject.id", "epic.project.id", "epic.application.id", "deployment.environment.name", "service.name"]) {
      expect(text).not.toContain(field);
    }
  });

  it("splits an event larger than maxChunkBytes on character boundaries", async () => {
    const maxChunkBytes = 200;
    const { fixture, uploader } = setup({ ...REPLAY_RECORDING_LIMITS, maxChunkBytes });
    const text = "ação 😀 ".repeat(120);
    uploader.push(custom(T, { text }), 1);
    uploader.flushNow();
    await settle();

    const records = recordsOf(fixture.log[0]!.body);
    expect(records.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    for (const [index, record] of records.entries()) {
      expect(encoder.encode(record.body.stringValue).length).toBeLessThanOrEqual(maxChunkBytes);
      expect(attr(record, "rr-web.chunk")).toBe(String(index + 1));
      expect(attr(record, "rr-web.total-chunks")).toBe(String(records.length));
      expect(attr(record, "rr-web.event")).toBe("0");
      expect(attr(record, "rr-web.offset")).toBe(String(index));
      expect(record.timeUnixNano).toBe(`${T}000000`);
    }
    const joined = records.map((record) => record.body.stringValue).join("");
    expect(joined).toBe(JSON.stringify(custom(T, { text })));
    expect(joined).not.toContain("�");
  });

  it("keeps one request under maxBatchBytes of event bytes, in order", async () => {
    const limits = { ...REPLAY_RECORDING_LIMITS, maxBatchBytes: 4_000, flushBytes: 1_000 };
    const { fixture, uploader } = setup(limits);
    for (let index = 0; index < 20; index++) uploader.push(custom(T + index, { text: "x".repeat(500) }), 1);
    await settle(10_000);

    const batches = fixture.log.map((entry) => recordsOf(entry.body));
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.reduce((total, record) => total + record.body.stringValue.length, 0)).toBeLessThanOrEqual(4_000);
    }
    expect(batches.flat().map((record) => attr(record, "rr-web.offset"))).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index)),
    );
  });

  it("sends evidence as its own scope, whatever the replay is doing", async () => {
    const { fixture, uploader } = setup();
    uploader.pushEvidence({
      event: EVIDENCE_EVENTS.behaviorFailed,
      at: T,
      route: "/checkout",
      body: "behavior.failed pay",
      behaviorName: "pay",
      occurrence: "occ-1",
    });
    uploader.flushNow();
    await settle();

    const [{ body }] = fixture.log;
    expect(body.resourceLogs[0]!.scopeLogs.map((scope) => scope.scope.name)).toEqual(["epic.evidence"]);
    const [record] = recordsOf(body);
    expect(attr(record!, "epic.event")).toBe("behavior.failed");
    expect(attr(record!, "epic.behavior.name")).toBe("pay");
    expect(attr(record!, "epic.behavior.occurrence")).toBe("occ-1");
    expect(attr(record!, "epic.route")).toBe("/checkout");
    expect(record!.body.stringValue).toBe("behavior.failed pay");
    expect(attr(record!, "rr-web.offset")).toBeUndefined();
  });

  it("continues the same session and offsets after a reload within the idle window", async () => {
    const storage = new MemoryStorage();
    const first = setup(undefined, { sessions: sessionStore(storage) });
    first.uploader.push(meta(), 1);
    first.uploader.push(snapshot(), 1);
    first.uploader.flushNow();
    await settle();
    first.uploader.dispose();

    await settle(60_000);
    const second = setup(undefined, { sessions: sessionStore(storage) });
    second.uploader.push(meta(T + 60_000), 1);
    second.uploader.push(snapshot(T + 60_001), 1);
    second.uploader.flushNow();
    await settle();

    const id = (log: Logged[]) => log[0]!.body.resourceLogs[0]!.resource.attributes[0]!.value.stringValue;
    expect(id(second.fixture.log)).toBe(id(first.fixture.log));
    expect(recordsOf(second.fixture.log[0]!.body).map((record) => attr(record, "rr-web.offset"))).toEqual(["2", "3"]);
  });

  it("asks for a fresh boundary once the session has gone idle", async () => {
    const { fixture, uploader, onRecordingLost } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.flushNow();
    await settle();
    const before = fixture.log.length;

    await settle(REPLAY_SESSION_IDLE_MS + 1_000);
    uploader.push(custom(T + REPLAY_SESSION_IDLE_MS + 1_000), 1);
    uploader.push(custom(T + REPLAY_SESSION_IDLE_MS + 1_001), 1);
    uploader.flushNow();
    await settle(INTERVAL);

    expect(onRecordingLost).toHaveBeenCalledTimes(1);
    expect(onRecordingLost).toHaveBeenCalledWith("session_rotated");
    expect(fixture.log).toHaveLength(before);

    uploader.push(meta(T + REPLAY_SESSION_IDLE_MS + 2_000), 2);
    uploader.push(snapshot(T + REPLAY_SESSION_IDLE_MS + 2_001), 2);
    uploader.flushNow();
    await settle();
    const ids = fixture.log.map((entry) => entry.body.resourceLogs[0]!.resource.attributes[0]!.value.stringValue);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(recordsOf(fixture.log[1]!.body).map((record) => attr(record, "rr-web.offset"))).toEqual(["0", "1"]);
  });

  it("stops after exactly maxAttempts of the same batch", async () => {
    const { fixture, uploader, onRecordingLost } = setup();
    fixture.mode.reply = "fail_503";
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.flushNow();
    await settle(10_000);

    expect(fixture.log).toHaveLength(3);
    expect(new Set(fixture.log.map((entry) => JSON.stringify(entry.body))).size).toBe(1);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "attempts_exhausted", bufferedEvents: 0 });
    expect(onRecordingLost).toHaveBeenCalledWith("attempts_exhausted");
    expect(uploader.shouldRestart("attempts_exhausted")).toBe(true);
  });

  it("stops for good on capture_disabled and sends nothing more until resumed", async () => {
    const { fixture, uploader, onRecordingLost } = setup();
    fixture.mode.reply = "capture_disabled";
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.flushNow();
    await settle();
    expect(onRecordingLost).toHaveBeenCalledWith("capture_disabled");
    expect(uploader.shouldRestart("capture_disabled")).toBe(false);

    const sent = fixture.log.length;
    uploader.push(custom(T + 2), 1);
    uploader.pushEvidence({ event: EVIDENCE_EVENTS.browserError, at: T, route: "/", body: "Error: x" });
    uploader.flushNow();
    await settle(INTERVAL);
    expect(fixture.log).toHaveLength(sent);

    fixture.mode.reply = "accept";
    uploader.resume();
    uploader.pushEvidence({ event: EVIDENCE_EVENTS.browserError, at: T, route: "/", body: "Error: x" });
    uploader.flushNow();
    await settle();
    expect(fixture.log).toHaveLength(sent + 1);
  });

  it("stops without retrying on payload_too_large", async () => {
    const { fixture, uploader, onRecordingLost } = setup();
    fixture.mode.reply = "too_large";
    uploader.push(meta(), 1);
    uploader.flushNow();
    await settle(10_000);

    expect(fixture.log).toHaveLength(1);
    expect(onRecordingLost).toHaveBeenCalledWith("payload_too_large");
  });

  it("retries the identical batch after a lost answer", async () => {
    const { fixture, uploader } = setup();
    fixture.mode.reply = "lost_ack_once";
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.flushNow();
    await settle(2_000);

    expect(fixture.log).toHaveLength(2);
    expect(fixture.log[1]!.body).toEqual(fixture.log[0]!.body);
    expect(uploader.getState()).toMatchObject({ status: "idle", acceptedBatches: 1 });
  });

  it("waits retryAfterMs after rate_limited, then resends the same batch", async () => {
    const { fixture, uploader } = setup();
    fixture.mode.reply = "rate_limited_once";
    uploader.push(meta(), 1);
    uploader.flushNow();
    await settle(1_000);
    expect(fixture.log).toHaveLength(1);

    await settle(3_000);
    expect(fixture.log).toHaveLength(2);
    expect(fixture.log[1]!.body).toEqual(fixture.log[0]!.body);
  });

  it("sends a batch once flushBytes are queued, before the interval", async () => {
    const { fixture, uploader } = setup({ ...REPLAY_RECORDING_LIMITS, flushBytes: 2_000 });
    uploader.push(meta(), 1);
    await settle();
    expect(fixture.log).toHaveLength(0);

    uploader.push(custom(T + 2, { text: "x".repeat(2_500) }), 1);
    await settle();
    expect(fixture.log).toHaveLength(1);
  });

  it("sends a hidden-tab flush as keepalive, and a large one without it", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.flushNow();
    await settle();
    expect(fixture.fetchFn.mock.calls.at(-1)![1]?.keepalive).toBe(true);

    uploader.push(custom(T + 2, { text: "x".repeat(80_000) }), 1);
    uploader.flushNow();
    await settle();
    expect(fixture.fetchFn.mock.calls.at(-1)![1]?.keepalive).toBe(false);
  });

  it("closeForUnload sends what is queued as one keepalive request", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.closeForUnload();
    await settle();

    expect(fixture.log).toHaveLength(1);
    expect(fixture.fetchFn.mock.calls[0]![1]?.keepalive).toBe(true);
    expect(uploader.getState().bufferedEvents).toBe(0);
  });

  it("fails explicitly when one record cannot fit a batch", async () => {
    const { fixture, uploader } = setup({ ...REPLAY_RECORDING_LIMITS, maxBatchBytes: 2_048 });
    uploader.push(meta(), 1);
    uploader.push(
      { ...snapshot(), data: { node: { text: "x".repeat(4_000) }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime,
      1,
    );
    uploader.flushNow();
    await settle();

    expect(fixture.log.length).toBeLessThanOrEqual(1);
    expect(uploader.getState()).toMatchObject({ status: "unavailable", reason: "snapshot_too_large" });
  });

  it("drops queued events on clear, synchronously", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    uploader.push(snapshot(), 1);
    uploader.clear();
    expect(uploader.getState().bufferedEvents).toBe(0);
    await settle(INTERVAL);

    expect(fixture.log).toHaveLength(0);
    expect(uploader.getState()).toMatchObject({ status: "idle", bufferedEvents: 0 });
  });

  it("flush resolves once what was queued has been sent", async () => {
    const { fixture, uploader } = setup();
    uploader.push(meta(), 1);
    let done = false;
    void uploader.flush().then(() => (done = true));
    await settle();

    expect(done).toBe(true);
    expect(fixture.log).toHaveLength(1);
  });

  it("reports the session it sent for, only while that session is live", async () => {
    const { uploader } = setup();
    expect(uploader.getReference()).toBeNull();
    uploader.push(meta(), 1);
    expect(uploader.getReference()).toMatchObject({ startedAt: T, boundary: 1 });
    expect(uploader.getReference()!.sessionId).toMatch(/^[0-9a-f]{32}$/);

    await settle(REPLAY_SESSION_IDLE_MS + 1_000);
    expect(uploader.getReference()).toBeNull();
  });

  it("spreads a retry past the base backoff and never beyond one and a half times it", async () => {
    const { fixture, uploader } = setup({ ...REPLAY_RECORDING_LIMITS }, { random: () => 0.999 });
    fixture.mode.reply = "lost_ack_once";
    uploader.push(meta(), 1);
    uploader.flushNow();
    await settle(600);
    expect(fixture.log).toHaveLength(1);

    await settle(200);
    expect(fixture.log).toHaveLength(2);
  });
});
