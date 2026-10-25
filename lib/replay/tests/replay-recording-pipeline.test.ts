// @vitest-environment jsdom
import type { record as rrwebRecord } from "@rrweb/record";
import { EventType, type eventWithTime } from "@rrweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { epicReplayConsent } from "../replay-consent";
import { createReplayRecordingPipeline } from "../replay-recording-pipeline";
import { activeReplayPolicy } from "./replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "./synthetic-epi210.core";

const T0 = 1_800_000_000_000;

function fakeRecord() {
  let emit: ((event: eventWithTime) => void) | undefined;
  const record = vi.fn((options?: { emit?: (event: eventWithTime) => void }) => {
    emit = options?.emit;
    emit?.({ type: EventType.Meta, timestamp: Date.now(), data: { href: location.href, width: 1, height: 1 } } as eventWithTime);
    emit?.({ type: EventType.FullSnapshot, timestamp: Date.now() + 1, data: { node: {} } } as unknown as eventWithTime);
    return vi.fn();
  }) as unknown as typeof rrwebRecord;
  return {
    record,
    emit: () =>
      emit?.({ type: EventType.Custom, timestamp: Date.now(), data: { tag: "harness", payload: {} } } as unknown as eventWithTime),
  };
}

async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

function setup() {
  const fixture = createSyntheticEpi210();
  const browser = createSyntheticBrowserFetch(fixture);
  const fake = fakeRecord();
  const policy = activeReplayPolicy();
  const pipeline = createReplayRecordingPipeline({
    getPolicy: () => policy,
    subscribePolicy: () => () => {},
    sampler: { decide: () => true },
    record: fake.record,
    fetch: browser.fetch,
    monotonicNow: () => Date.now(),
    getViewport: () => ({ width: 390, height: 844 }),
  });
  return { fixture, browser, fake, pipeline };
}

describe("createReplayRecordingPipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    window.history.replaceState({}, "", "/styleguide/replay/upload");
  });

  afterEach(() => {
    epicReplayConsent.reset();
    vi.useRealTimers();
  });

  it("starts a fresh recording with a new key and a new snapshot after delivery_uncertain", async () => {
    const { fixture, browser, fake, pipeline } = setup();
    epicReplayConsent.grant();
    pipeline.start();
    await flush(5_000);
    const first = pipeline.getRecordingReference()!;
    expect(pipeline.getState().upload).toMatchObject({ status: "pending", evidence: "unverified" });

    fixture.setMode("delivery_uncertain_next");
    fake.emit();
    await flush(5_000);
    await flush(6_000);

    const registrations = browser.log.filter((entry) => entry.path === "/recordings");
    expect(registrations).toHaveLength(2);
    expect(new Set(registrations.map((entry) => entry.recordingId)).size).toBe(2);
    const second = pipeline.getRecordingReference()!;
    expect(second.recordingId).not.toBe(first.recordingId);
    expect(second.boundary).toBe(first.boundary + 1);
    expect(browser.log.filter((entry) => entry.recordingId === first.recordingId && entry.code === "delivery_uncertain")).toHaveLength(1);
    const after = browser.log.findIndex((entry) => entry.code === "delivery_uncertain");
    expect(browser.log.slice(after + 1).some((entry) => entry.recordingId === first.recordingId)).toBe(false);
    const firstBatchOfSecond = browser.log.find((entry) => entry.recordingId === second.recordingId && entry.path.endsWith("/batches"));
    expect(firstBatchOfSecond).toMatchObject({ sequence: 0, firstEventTypes: [EventType.Meta, EventType.FullSnapshot] });
    expect(pipeline.getState().upload.history.find((entry) => entry.reference.recordingId === first.recordingId)).toMatchObject({
      outcome: "incomplete",
      reason: "delivery_uncertain",
    });
    pipeline.dispose();
  });

  it("restarts at most maxAttempts times, then stays unavailable", async () => {
    const { fixture, browser, fake, pipeline } = setup();
    epicReplayConsent.grant();
    pipeline.start();
    await flush(5_000);

    for (let i = 0; i < 5; i++) {
      fixture.setMode("delivery_uncertain_next");
      fake.emit();
      await flush(5_000);
      await flush(5_000);
    }

    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(4);
    expect(pipeline.getState().upload).toMatchObject({ status: "unavailable", reason: "delivery_uncertain" });
    pipeline.dispose();
  });

  it("clears queued data on consent withdrawal without further requests and keeps history", async () => {
    const { browser, fake, pipeline } = setup();
    epicReplayConsent.grant();
    pipeline.start();
    await flush(5_000);
    const reference = pipeline.getRecordingReference()!;
    fake.emit();

    epicReplayConsent.withdraw();
    const before = browser.log.length;
    await flush(30_000);

    expect(pipeline.getState().capture).toMatchObject({ status: "blocked" });
    expect(pipeline.getState().upload).toMatchObject({ status: "idle", bufferedEvents: 0, current: null });
    expect(pipeline.getState().upload.history[0]!.reference).toEqual(reference);
    expect(browser.log.length).toBe(before);
    pipeline.dispose();
  });

  it("stops rrweb on terminal rejection while preserving the upload failure", async () => {
    const { fixture, browser, fake, pipeline } = setup();
    epicReplayConsent.grant();
    pipeline.start();
    await flush(5_000);
    fixture.scriptBatchAnswers({
      status: 403,
      body: { contractVersion: 1, error: "Capture disabled", code: "capture_disabled" },
    });
    fake.emit();
    await flush(5_000);
    expect(pipeline.getState()).toMatchObject({
      capture: { status: "blocked", reason: "transport_unavailable" },
      upload: { status: "unavailable", reason: "capture_disabled", bufferedEvents: 0 },
    });
    const requests = browser.log.length;
    fake.emit();
    await flush(30_000);
    expect(browser.log).toHaveLength(requests);
    pipeline.start(); // Explicit user restart, distinct from automatic boundary rotation.
    await flush(5_000);
    expect(pipeline.getState().capture.status).toBe("capturing");
    pipeline.dispose();
  });
});
