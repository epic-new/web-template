// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { record as rrwebRecord } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
import { createReplayRootRuntime, type ReplayRootRuntime } from "../replay-root-runtime";
import { createReplayDocumentOwners } from "../replay-document-owner";
import { createReplayRecordingPipeline } from "../replay-recording-pipeline";
import { epicReplayConsent } from "../replay-consent";
import { parseReplayMarker, REPLAY_MARKER_MAX_BYTES } from "../replay-marker.contract";
import { jsonByteLength } from "../replay-redaction";
import { replayBatchRequestSchema, replayRecordingCapabilitySchema, REPLAY_SUBJECT_ALLOWANCE_BYTES, type ReplayBatchRequest } from "../replay-upload-contract";
import { activeReplayPolicy } from "./replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "./synthetic-epi210.core";

const T0 = 1_800_000_000_000;
const start = { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "synthetic.example", occurrenceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 15; i++) await vi.advanceTimersByTimeAsync(0);
}
function rejection(reason: unknown) {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
  return event;
}

describe("provider-owned Epic markers", () => {
  const runtimes: ReplayRootRuntime[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    sessionStorage.clear();
  });
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    epicReplayConsent.reset(); vi.useRealTimers(); vi.restoreAllMocks();
  });
  function setup({ maxBatchBytes }: { maxBatchBytes?: number } = {}) {
    let emit: ((event: eventWithTime) => void) | undefined;
    const record = ((options?: { emit?: (event: eventWithTime) => void }) => {
      emit = options?.emit;
      emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
      emit?.({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime);
      return () => { emit = undefined; };
    }) as typeof rrwebRecord;
    record.addCustomEvent = (tag, payload) => emit?.({ type: 5, timestamp: Date.now(), data: { tag, payload } } as eventWithTime);
    const fixture = createSyntheticEpi210();
    if (maxBatchBytes !== undefined) fixture.setMode("tiny_batch");
    const browser = createSyntheticBrowserFetch(fixture);
    const batches: ReplayBatchRequest[] = [];
    let policy = activeReplayPolicy();
    const changes = new Set<() => void>();
    const runtime = createReplayRootRuntime({ documentRelease: "build-A", getPolicy: () => policy,
      subscribePolicy: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
      fetch: async (input, init) => {
        if (maxBatchBytes === undefined) return browser.fetch(input, init);
        const path = String(input);
        if (path.endsWith("/batches")) batches.push(replayBatchRequestSchema.parse(JSON.parse(String(init?.body))));
        const response = await browser.fetch(input, init);
        if (!path.endsWith("/recordings") || !response.ok) return response;
        const capability = replayRecordingCapabilitySchema.parse(await response.json());
        // The fixture's usual 2,048 bytes fits every allowed ordinary marker.
        // Negotiate a smaller, schema-valid capability at this external seam;
        // keep the real parser, root, capture, preflight and uploader intact.
        const negotiated = replayRecordingCapabilitySchema.parse({ ...capability,
          limits: { ...capability.limits, maxBatchBytes } });
        return Response.json(negotiated, { status: response.status });
      }, pipelineOptions: { record }, loadPipeline: async () => ({ createReplayRecordingPipeline }),
      owners: createReplayDocumentOwners(), locks: null, monotonicNow: () => Date.now() });
    runtimes.push(runtime);
    runtime.setIdentity("user-1");
    return { runtime, record, browser, batches, refresh: () => {
      policy = activeReplayPolicy({}, { release: "build-B", configVersion: "2" });
      for (const listener of changes) listener();
    } };
  }

  it("drops a valid public marker beyond negotiated tiny capacity without ending the recording (injected recorder)", async () => {
    const maxBatchBytes = 900;
    const { runtime, record, browser, batches } = setup({ maxBatchBytes });
    runtime.attach(); epicReplayConsent.grant(); await settle(5_100);
    expect(runtime.getSnapshot()).toMatchObject({ status: "capturing", snapshotReceived: true });
    const reference = runtime.getSnapshot().reference!;
    expect(reference).not.toBeNull();
    expect(batches[0]!.events.slice(0, 2).map((event) => event.type)).toEqual([4, 2]);

    const oversized = { tag: "epic.behavior.failed", payload: { version: 1,
      behaviorId: "b".repeat(128), code: "c".repeat(128), occurrenceId: start.payload.occurrenceId } };
    expect(parseReplayMarker(oversized)).toEqual({ success: true, marker: oversized });
    expect(jsonByteLength(oversized)).toBeLessThan(REPLAY_MARKER_MAX_BYTES);
    // It fits the marker and even the bare event budgets; the negotiated full
    // batch envelope, maximum token and subject allowance make it unfit.
    expect(jsonByteLength({ type: 5, timestamp: Date.now(), data: oversized })).toBeLessThan(maxBatchBytes);
    const before = runtime.getDiagnostics();
    const addCustomEvent = vi.spyOn(record, "addCustomEvent");
    expect(runtime.track(oversized)).toEqual({ status: "dropped", reason: "marker_too_large" });
    expect(addCustomEvent).not.toHaveBeenCalled();
    expect(runtime.getDiagnostics().markers).toEqual(before.markers);
    expect(runtime.getDiagnostics().pipeline!.upload).toEqual(before.pipeline!.upload);
    expect(runtime.getSnapshot()).toMatchObject({ status: "capturing", reference, snapshotReceived: true });

    expect(runtime.track(start)).toEqual({ status: "emitted" });
    await settle(5_100);
    const delivered = batches.flatMap((batch) => batch.events).filter((event) => event.type === 5);
    expect(delivered).toContainEqual({ type: 5, timestamp: T0 + 5_100, data: start });
    expect(delivered.some((event) => (event.data as { tag?: string }).tag === oversized.tag)).toBe(false);
    expect(batches.every((batch) => jsonByteLength(batch) + REPLAY_SUBJECT_ALLOWANCE_BYTES <= maxBatchBytes)).toBe(true);
    expect(browser.log.filter((entry) => entry.path.endsWith("/batches")).every((entry) => entry.status === 200)).toBe(true);
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(1);
    expect(runtime.getSnapshot()).toMatchObject({ status: "capturing", reference });
    expect(runtime.getDiagnostics().pipeline!.upload).toMatchObject({ reason: null, bufferedEvents: 0, bufferedBytes: 0 });
    expect(runtime.getDiagnostics().pipeline!.upload.history).toEqual([
      expect.objectContaining({ reference, outcome: "open", reason: null, availability: "events_received" }),
    ]);
  });

  it("covers disabled/withdrawn tracking and a paired behavior occurrence without volatile public snapshots", async () => {
    const { runtime, browser } = setup();
    runtime.attach();
    const getter = vi.fn(() => { throw Error("private"); });
    const unsafe = Object.defineProperty({}, "tag", { get: getter });
    expect(runtime.track(unsafe)).toMatchObject({ status: "dropped" });
    expect(getter).not.toHaveBeenCalled();
    expect(browser.log).toHaveLength(0);
    epicReplayConsent.grant(); await settle(5_100);
    const snapshot = runtime.getSnapshot();
    const changed = vi.fn(); runtime.subscribe(changed);
    expect(runtime.track(start)).toEqual({ status: "emitted" });
    expect(runtime.track({ ...start, tag: "epic.behavior.succeeded" })).toEqual({ status: "emitted" });
    expect(runtime.getSnapshot()).toBe(snapshot);
    expect(changed).not.toHaveBeenCalled();
    expect(runtime.getDiagnostics().markers.filter((marker) => marker.tag.startsWith("epic.behavior.")))
      .toEqual([expect.objectContaining({ ...start, offsetMs: 5_100 }), expect.objectContaining({ tag: "epic.behavior.succeeded", offsetMs: 5_100 })]);
    epicReplayConsent.withdraw();
    const sent = browser.log.length;
    expect(runtime.track(start)).toMatchObject({ status: "dropped" });
    expect(runtime.getEvidenceReference()).toBeNull();
    await settle(10_000); expect(browser.log).toHaveLength(sent);
  });

  it("marks committed allowed navigation once and ignores query/hash, exclusions and stale callbacks", async () => {
    const { runtime } = setup();
    runtime.attach(); epicReplayConsent.grant(); await settle(5_100);
    const screens = () => runtime.getDiagnostics().markers.filter((marker) => marker.tag === "epic.screen.viewed");
    expect(screens()).toHaveLength(1);
    const first = runtime.getEvidenceReference()!;
    window.history.pushState({}, "", "/styleguide/replay/upload/second?token=private#secret"); await settle(1);
    expect(screens()).toHaveLength(2);
    expect(screens()[1]).toMatchObject({ payload: { route: "/styleguide/replay/upload/second" }, recordingId: first.recordingId });
    window.history.replaceState({}, "", "/styleguide/replay/upload/second?changed=yes#other"); await settle(1);
    expect(screens()).toHaveLength(2);
    window.history.replaceState({}, "", "/styleguide/replay/upload"); window.dispatchEvent(new PopStateEvent("popstate")); await settle(1);
    expect(screens()).toHaveLength(3);
    window.history.pushState({}, "", "/excluded");
    expect(runtime.track(start)).toMatchObject({ status: "dropped" }); await settle(1);
    expect(screens()).toHaveLength(3);
    window.history.pushState({}, "", "/styleguide/replay/upload"); await settle(5_100);
    expect(screens()).toHaveLength(4);
    expect(screens()[3]!.recordingId).not.toBe(first.recordingId);
    expect(JSON.stringify(screens())).not.toMatch(/private|secret|changed=yes/);
  });

  it("captures safe browser failures once through remounts and prevents recursive telemetry", async () => {
    const { runtime, record } = setup();
    const detach = runtime.attach(); const detachSecond = runtime.attach();
    epicReplayConsent.grant(); await settle(5_100);
    const errors = () => runtime.getDiagnostics().markers.filter((marker) => marker.tag.startsWith("epic.browser."));
    const error = new ErrorEvent("error", { error: new TypeError("raw private message"), message: "raw private message", cancelable: true });
    window.dispatchEvent(error); window.dispatchEvent(error);
    expect(error.defaultPrevented).toBe(false);
    expect(rejection({ userSecret: "raw rejection" }).defaultPrevented).toBe(false);
    expect(errors()).toHaveLength(2);
    expect(JSON.stringify(errors())).not.toMatch(/raw|userSecret/);
    detachSecond(); detach();
    // An ordinary host listener keeps a deliberate ErrorEvent from becoming a
    // runner-level uncaught exception after the telemetry listener is removed.
    const hostErrorListener = () => {};
    window.addEventListener("error", hostErrorListener);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("detached"), message: "detached" }));
    window.removeEventListener("error", hostErrorListener);
    expect(errors()).toHaveLength(2);
    runtime.attach(); await settle(5_100);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("later"), message: "later" }));
    expect(errors()).toHaveLength(3);
    const original = record.addCustomEvent;
    record.addCustomEvent = (tag, payload) => {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("recursive"), message: "recursive" }));
      original(tag, payload);
    };
    expect(runtime.track(start)).toEqual({ status: "emitted" });
    expect(errors()).toHaveLength(3);
    runtime.dispose();
    rejection(new Error("after dispose"));
    expect(errors()).toHaveLength(3);
  });

  it("freezes build-A evidence and gates durable report markers through retry, replacement and forged references", async () => {
    const { runtime, refresh } = setup();
    runtime.attach(); epicReplayConsent.grant(); await settle(5_100);
    const frozen = runtime.getEvidenceReference()!;
    const bytes = JSON.stringify(frozen);
    const ack = { durable: true, reportId: "synthetic-report-1", text: "never transmit" };
    expect(runtime.track({ tag: "epic.bug.reported", payload: { version: 1, reportId: ack.reportId } })).toMatchObject({ status: "dropped" });
    expect(runtime.trackAcknowledgedReport({ ...ack, durable: false }, frozen)).toMatchObject({ status: "dropped" });
    expect(runtime.trackAcknowledgedReport(ack, { ...frozen })).toMatchObject({ status: "dropped", reason: "stale_reference" });
    await settle(100);
    expect(runtime.trackAcknowledgedReport(ack, frozen)).toEqual({ status: "emitted" });
    expect(runtime.trackAcknowledgedReport(ack, frozen)).toMatchObject({ status: "dropped", reason: "duplicate" });
    const marker = runtime.getDiagnostics().markers.find((item) => item.tag === "epic.bug.reported")!;
    expect(marker).toMatchObject({ payload: { version: 1, reportId: ack.reportId }, offsetMs: 5_200, release: "build-A" });
    expect(JSON.stringify(marker)).not.toContain("never transmit");
    refresh(); await settle(5_100);
    expect(runtime.getEvidenceReference()).toMatchObject({ release: "build-A", configVersion: "2" });
    expect(runtime.trackAcknowledgedReport({ ...ack, reportId: "late" }, frozen)).toMatchObject({ status: "dropped", reason: "stale_reference" });
    expect(JSON.stringify(frozen)).toBe(bytes);
    const current = runtime.getEvidenceReference()!;
    runtime.beginIdentityChange(); runtime.setIdentity("user-2"); await settle(5_100);
    expect(runtime.trackAcknowledgedReport({ ...ack, reportId: "other-user" }, current)).toMatchObject({ status: "dropped", reason: "stale_reference" });
    expect(runtime.getDiagnostics().markers.filter((item) => item.tag === "epic.bug.reported")).toHaveLength(1);
  });
});
