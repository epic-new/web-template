import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { ReplayUploadError, type ReplayRecordingCapability } from "@/lib/replay/replay-upload-contract";
import { deriveReplaySubject } from "@/lib/replay/server/replay-subject";
import { batchBody, IPHONE_SAFARI, registrationBody, setupSyntheticCentral, uaOf } from "@/lib/replay/tests/replay-relay.fixture";
import { RegisterReplayRecording } from "@/app/api/epic/replay/recordings/behaviors/register-replay-recording/register-replay-recording.service";
import { RenewReplayCapability } from "@/app/api/epic/replay/recordings/[recordingId]/capability/behaviors/renew-replay-capability/renew-replay-capability.service";
import { UploadReplayBatch } from "../upload-replay-batch.service";

const user1 = { kind: "user" as const, userId: "user-1" };
const user2 = { kind: "user" as const, userId: "user-2" };

async function register(): Promise<ReplayRecordingCapability> {
  const { recording } = await RegisterReplayRecording.execute({ actor: user1, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) });
  return recording;
}

const upload = (recording: ReplayRecordingCapability, input: unknown, actor = user1) =>
  UploadReplayBatch.execute({ actor, recordingId: recording.recordingId, input });

async function failure(run: () => Promise<unknown>) {
  const error = await run().catch((e) => e);
  expect(error).toBeInstanceOf(ReplayUploadError);
  return error as ReplayUploadError;
}

describe("UploadReplayBatch", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("relays ordered batches with only the trusted subject added", async () => {
    const { fixture, central } = setupSyntheticCentral();
    const recording = await register();

    const first = batchBody(recording.recordingToken, 0);
    expect(await upload(recording, first)).toEqual({
      contractVersion: 1,
      recordingId: recording.recordingId,
      batchId: first.batchId,
      sequence: 0,
      delivery: "accepted",
      availability: "events_received",
      nextSequence: 1,
    });
    await upload(recording, batchBody(recording.recordingToken, 1));

    expect(fixture.providerAppends.map((append) => append.sequence)).toEqual([0, 1]);
    expect(central.calls[1]!.body).toEqual({
      ...first,
      subjectId: deriveReplaySubject(user1, process.env.BETTER_AUTH_SECRET!).subjectId,
    });
  });

  it("renews an expired capability and resends the same batch to the provider once", async () => {
    const { fixture } = setupSyntheticCentral();
    const recording = await register();
    await upload(recording, batchBody(recording.recordingToken, 0));
    fixture.expireCapabilities();

    const pending = batchBody(recording.recordingToken, 1);
    expect((await failure(() => upload(recording, pending))).code).toBe("capability_expired");
    const renewed = await RenewReplayCapability.execute({ actor: user1, recordingId: recording.recordingId, input: { contractVersion: 1 } });
    // Renewal's nextSequence is diagnostic: the pending batch keeps sequence 1.
    expect(renewed).toMatchObject({ nextSequence: 1, startedAt: recording.startedAt });
    expect(await upload(recording, { ...pending, recordingToken: renewed.recordingToken })).toMatchObject({
      batchId: pending.batchId,
      sequence: 1,
      delivery: "accepted",
    });
    expect(fixture.providerAppends.filter((append) => append.batchId === pending.batchId)).toHaveLength(1);
  });

  it("recovers accepted and finalized receipts after the local row closed", async () => {
    const { fixture } = setupSyntheticCentral();
    const recording = await register();
    const finalBatch = batchBody(recording.recordingToken, 0, { final: true });
    const ack = await upload(recording, finalBatch);
    await PostDB(db, schema, { replay_recording: [{ recordingId: recording.recordingId, status: "closed" }] });

    expect(await upload(recording, finalBatch)).toEqual(ack);
    expect(fixture.providerAppends).toHaveLength(1);
    expect((await failure(() => upload(recording, batchBody(recording.recordingToken, 1)))).code).toBe("recording_closed");

    const second = await register();
    await upload(second, batchBody(second.recordingToken, 0));
    fixture.setCaptureDisabled(true);
    const empty = batchBody(second.recordingToken, 1, { events: [], final: true });
    const finalized = await upload(second, empty);
    expect(finalized).toMatchObject({ delivery: "finalized", availability: "events_received", sequence: 1, nextSequence: 2 });
    expect(await upload(second, empty)).toEqual(finalized);
    expect(fixture.providerAppends.filter((append) => append.recordingId === second.recordingId)).toHaveLength(1);
  });

  it("quarantines on delivery_uncertain without a second provider dispatch or later finalization", async () => {
    const { fixture } = setupSyntheticCentral();
    const recording = await register();
    fixture.setMode("delivery_uncertain_next");
    const uncertain = batchBody(recording.recordingToken, 0);

    expect(await failure(() => upload(recording, uncertain))).toMatchObject({ code: "delivery_uncertain", status: 409 });
    await PostDB(db, schema, { replay_recording: [{ recordingId: recording.recordingId, status: "quarantined" }] });
    expect((await failure(() => upload(recording, uncertain))).code).toBe("delivery_uncertain");
    expect((await failure(() => upload(recording, batchBody(recording.recordingToken, 0, { events: [], final: true })))).code).toBe(
      "delivery_uncertain",
    );
    expect(fixture.providerAppends).toHaveLength(0);
  });

  it("bounds count and the full augmented wire size before relaying", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    const recording = await register();
    fetchSpy.mockClear();

    const many = batchBody(recording.recordingToken, 0, {
      events: Array.from({ length: 501 }, (_, i) => ({ type: 3, timestamp: i, data: {} })),
    });
    expect(await failure(() => upload(recording, many))).toMatchObject({ code: "payload_too_large", status: 413 });

    // A browser body just under 1 MiB that the injected subject pushes over.
    const base = batchBody(recording.recordingToken, 0, { events: [{ type: 3, timestamp: 1, data: { text: "" } }] });
    const pad = 1_048_576 - new TextEncoder().encode(JSON.stringify(base)).length - 10;
    const nearLimit = { ...base, events: [{ type: 3, timestamp: 1, data: { text: "x".repeat(pad) } }] };
    expect(new TextEncoder().encode(JSON.stringify(nearLimit)).length).toBeLessThan(1_048_576);
    expect(await failure(() => upload(recording, nearLimit))).toMatchObject({ code: "payload_too_large", status: 413 });

    expect(await failure(() => upload(recording, batchBody(recording.recordingToken, 0, { events: [] })))).toMatchObject({
      code: "invalid_request",
      status: 422,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves typed order, in-progress and rate-limit timing", async () => {
    const { fixture } = setupSyntheticCentral();
    const recording = await register();

    const outOfOrder = await failure(() => upload(recording, batchBody(recording.recordingToken, 3)));
    expect(outOfOrder.toBody()).toMatchObject({ code: "out_of_order", expectedSequence: 0 });

    fixture.scriptBatchAnswers({
      status: 409,
      body: { contractVersion: 1, error: "An upload for this recording is in progress", code: "upload_in_progress", retryAfterMs: 1500 },
    });
    const inProgress = await failure(() => upload(recording, batchBody(recording.recordingToken, 0)));
    expect(inProgress.toBody()).toMatchObject({ code: "upload_in_progress", retryAfterMs: 1500 });
    expect(inProgress.headers()["Retry-After"]).toBe("2");

    const subjectId = deriveReplaySubject(user1, process.env.BETTER_AUTH_SECRET!).subjectId;
    await PreDB(db, schema, {
      replay_rate_limit: [{ subjectId, bucket: "batch", windowStartedAt: Date.now(), count: 120 }],
    });
    const limited = await failure(() => upload(recording, batchBody(recording.recordingToken, 0)));
    expect(limited).toMatchObject({ code: "rate_limited", status: 429 });
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates subjects and rejects browser subject fields", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    const recording = await register();
    fetchSpy.mockClear();

    expect(await failure(() => upload(recording, batchBody(recording.recordingToken, 0), user2))).toMatchObject({
      code: "recording_not_found",
      status: 404,
    });
    const forgedSubject = deriveReplaySubject(user1, process.env.BETTER_AUTH_SECRET!).subjectId;
    expect(
      await failure(() => upload(recording, batchBody(recording.recordingToken, 0, { subjectId: forgedSubject }), user2)),
    ).toMatchObject({ code: "invalid_request", status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
