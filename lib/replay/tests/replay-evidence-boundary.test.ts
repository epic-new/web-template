// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { record as rrwebRecord } from "@rrweb/record";
import { EventType, type eventWithTime } from "@rrweb/types";

import { epicReplayConsent } from "../replay-consent";
import { createReplayDocumentOwners } from "../replay-document-owner";
import { parseReplayMarker } from "../replay-marker.contract";
import { createReplayRecordingPipeline } from "../replay-recording-pipeline";
import { createReplayRootRuntime, type ReplayRootRuntime } from "../replay-root-runtime";
import { replayBatchRequestSchema, replayRegistrationRequestSchema, type ReplayRegistrationRequest } from "../replay-upload-contract";
import { activeReplayPolicy } from "./replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "./synthetic-epi210.core";

const T0 = 1_800_000_000_000;

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
}

describe("frozen replay evidence boundary", () => {
  let runtime: ReplayRootRuntime | undefined;
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    sessionStorage.clear();
  });
  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    epicReplayConsent.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["stop/restart", "consent withdrawal"] as const)("drops late report acknowledgments after %s without retagging frozen evidence or the replacement recording", async (transition) => {
    // This is an injected recorder/consumer boundary test. Real pinned-rrweb
    // capture is covered separately in replay-capture.test.ts.
    let emit: ((event: eventWithTime) => void) | undefined;
    const record = ((options?: { emit?: (event: eventWithTime) => void }) => {
      emit = options?.emit;
      emit?.({ type: EventType.Meta, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
      emit?.({ type: EventType.FullSnapshot, timestamp: Date.now(), data: {
        node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 },
      } } as unknown as eventWithTime);
      return () => { emit = undefined; };
    }) as typeof rrwebRecord;
    record.addCustomEvent = (tag, payload) => emit?.({ type: EventType.Custom, timestamp: Date.now(), data: { tag, payload } } as eventWithTime);
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const receivedReports: { recordingId: string; reportId: string; timestamp: number }[] = [];
    const policy = activeReplayPolicy({}, { release: "build-A", configVersion: "1" });
    runtime = createReplayRootRuntime({
      documentRelease: "build-A", getPolicy: () => policy, subscribePolicy: () => () => {},
      owners: createReplayDocumentOwners(), locks: null, monotonicNow: () => Date.now(),
      pipelineOptions: { record }, loadPipeline: async () => ({ createReplayRecordingPipeline }),
      fetch: async (input, init) => {
        const response = await browser.fetch(input, init);
        if (response.ok && String(input).endsWith("/batches")) {
          const batch = replayBatchRequestSchema.parse(JSON.parse(String(init?.body)));
          const recordingId = new URL(String(input), location.origin).pathname.match(/\/recordings\/([^/]+)\/batches$/)![1]!;
          for (const event of batch.events) {
            const parsed = event.type === EventType.Custom && parseReplayMarker(event.data);
            if (parsed && parsed.success && parsed.marker.tag === "epic.bug.reported") {
              receivedReports.push({ recordingId, reportId: parsed.marker.payload.reportId, timestamp: event.timestamp });
            }
          }
        }
        return response;
      },
    });
    runtime.setIdentity("synthetic-user-1"); runtime.attach(); epicReplayConsent.grant();
    await settle(5_100);
    const frozen = runtime.getEvidenceReference()!;
    expect(frozen).toMatchObject({ startedAt: T0, capturedAt: T0 + 5_100, offsetMs: 5_100, release: "build-A", configVersion: "1" });
    expect(Object.isFrozen(frozen)).toBe(true);
    const originalBytes = JSON.stringify(frozen);
    const lateAcknowledgment = { durable: true, reportId: "synthetic-late-report" };

    if (transition === "stop/restart") runtime.stop();
    else epicReplayConsent.withdraw();
    expect(runtime.getEvidenceReference()).toBeNull();
    expect(runtime.trackAcknowledgedReport(lateAcknowledgment, frozen)).toEqual({ status: "dropped", reason: "capture_not_permitted" });
    expect(runtime.getDiagnostics().pipeline?.upload.bufferedEvents).toBe(0);
    const sentWhileUnavailable = browser.log.length;
    await settle(1_000);
    expect(browser.log).toHaveLength(sentWhileUnavailable);
    expect(receivedReports).toEqual([]);

    if (transition === "stop/restart") runtime.restart();
    else epicReplayConsent.grant();
    await settle(5_100);
    const replacement = runtime.getEvidenceReference()!;
    expect(runtime.getSnapshot()).toMatchObject({ status: "capturing", snapshotReceived: true });
    expect(replacement.recordingId).not.toBe(frozen.recordingId);
    expect(replacement.startedAt).toBeGreaterThan(frozen.startedAt);
    const bufferedBeforeLateRetry = runtime.getDiagnostics().pipeline!.upload.bufferedEvents;
    expect(runtime.trackAcknowledgedReport(lateAcknowledgment, frozen)).toEqual({ status: "dropped", reason: "stale_reference" });
    expect(runtime.getDiagnostics().pipeline!.upload.bufferedEvents).toBe(bufferedBeforeLateRetry);
    expect(runtime.getDiagnostics().markers.filter((marker) => marker.tag === "epic.bug.reported")).toEqual([]);
    expect(JSON.stringify(frozen)).toBe(originalBytes);

    // The replacement remains usable for an acknowledgment frozen against its
    // own boundary; the old report never becomes a deferred retry there.
    await settle(100);
    const acknowledgedAt = Date.now();
    expect(runtime.trackAcknowledgedReport({ durable: true, reportId: "synthetic-current-report" }, replacement)).toEqual({ status: "emitted" });
    await settle(5_000);
    expect(receivedReports).toEqual([{ recordingId: replacement.recordingId, reportId: "synthetic-current-report", timestamp: acknowledgedAt }]);
    expect(JSON.stringify(frozen)).toBe(originalBytes);
  });

  it("submits and retries the original recording, build-A release and millisecond offset after policy refresh to build-B", async () => {
    const browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    const registrations: ReplayRegistrationRequest[] = [];
    let policy = activeReplayPolicy({}, { configVersion: "1", release: "build-A" });
    const policyListeners = new Set<() => void>();
    const record = ((options?: { emit?: (event: eventWithTime) => void }) => {
      options?.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
      options?.emit?.({ type: 2, timestamp: Date.now(), data: {
        node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 },
      } } as unknown as eventWithTime);
      return () => {};
    }) as typeof rrwebRecord;
    runtime = createReplayRootRuntime({
      documentRelease: "build-A", getPolicy: () => policy,
      subscribePolicy: (listener) => { policyListeners.add(listener); return () => { policyListeners.delete(listener); }; },
      owners: createReplayDocumentOwners(), locks: null, monotonicNow: () => Date.now(),
      pipelineOptions: { record }, loadPipeline: async () => ({ createReplayRecordingPipeline }),
      fetch: async (input, init) => {
        if (String(input).endsWith("/recordings")) registrations.push(replayRegistrationRequestSchema.parse(JSON.parse(String(init?.body))));
        return browser.fetch(input, init);
      },
    });
    runtime.setIdentity("synthetic-user-1");
    runtime.attach();
    epicReplayConsent.grant();
    await settle(5_100);
    const selected = runtime.getSnapshot();
    expect(selected).toMatchObject({ status: "capturing", snapshotReceived: true, evidence: "unverified" });
    expect(selected.reference).not.toBeNull();
    expect(Object.isFrozen(selected.reference)).toBe(true);
    const evidence = Object.freeze({
      recordingId: selected.reference!.recordingId,
      startedAt: selected.reference!.startedAt,
      release: registrations[0]!.release,
      offsetMs: Date.now() - selected.reference!.startedAt,
    });
    expect(evidence).toEqual({ recordingId: expect.any(String), startedAt: T0, release: "build-A", offsetMs: 5_100 });

    // A genuine effective config change rotates the runtime; its new policy's
    // backend release cannot retag this already-loaded document.
    policy = activeReplayPolicy({}, { configVersion: "2", release: "build-B" });
    for (const listener of policyListeners) listener();
    await settle(5_100);
    const current = runtime.getSnapshot();
    expect(current.reference?.recordingId).not.toBe(evidence.recordingId);
    expect(current.reference?.startedAt).toBeGreaterThan(evidence.startedAt);
    expect(registrations.map(({ release, configVersion }) => ({ release, configVersion }))).toEqual([
      { release: "build-A", configVersion: "1" },
      { release: "build-A", configVersion: "2" },
    ]);
    expect(selected.reference).toMatchObject({ recordingId: evidence.recordingId, startedAt: evidence.startedAt });

    // There is no report-submission Controller in WEB-4. This explicit external
    // consumer fixture exercises frozen input and a lost-response retry without
    // inventing a production report API or implying WEB-7/8 acceptance.
    const submitted: string[] = [];
    const submitEvidence = async (input: typeof evidence) => {
      submitted.push(JSON.stringify(input));
      if (submitted.length === 1) throw new TypeError("synthetic response lost after receipt");
      return { accepted: true };
    };
    await expect(submitEvidence(evidence)).rejects.toThrow("synthetic response lost");
    await settle(1_000);
    await expect(submitEvidence(evidence)).resolves.toEqual({ accepted: true });
    expect(submitted.map((body) => JSON.parse(body))).toEqual([evidence, evidence]);
    expect(submitted[1]).toBe(submitted[0]);
    expect(JSON.parse(submitted[1]!)).toEqual({
      recordingId: selected.reference!.recordingId, startedAt: T0, release: "build-A", offsetMs: 5_100,
    });
    expect(runtime.getSnapshot().evidence).toBe("unverified");
  });
});
