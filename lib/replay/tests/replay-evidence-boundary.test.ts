// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { record as rrwebRecord } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";

import { epicReplayConsent } from "../replay-consent";
import { createReplayDocumentOwners } from "../replay-document-owner";
import { createReplayRecordingPipeline } from "../replay-recording-pipeline";
import { createReplayRootRuntime, type ReplayRootRuntime } from "../replay-root-runtime";
import { replayRegistrationRequestSchema, type ReplayRegistrationRequest } from "../replay-upload-contract";
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
