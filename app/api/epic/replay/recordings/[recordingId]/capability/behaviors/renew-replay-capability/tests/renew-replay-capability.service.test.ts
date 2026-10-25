import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { ReplayUploadError } from "@/lib/replay/replay-upload-contract";
import { PREVIEW_TOKEN } from "@/lib/replay/tests/runtime-config.fixture";
import { IPHONE_SAFARI, registrationBody, setupSyntheticCentral, uaOf } from "@/lib/replay/tests/replay-relay.fixture";
import { RegisterReplayRecording } from "@/app/api/epic/replay/recordings/behaviors/register-replay-recording/register-replay-recording.service";
import { RenewReplayCapability } from "../renew-replay-capability.service";

const user1 = { kind: "user" as const, userId: "user-1" };
const user2 = { kind: "user" as const, userId: "user-2" };

async function register() {
  const input = registrationBody();
  const { recording } = await RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(IPHONE_SAFARI) });
  return { input, recording };
}

describe("RenewReplayCapability", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns the complete shape with a fresh capability for the owner", async () => {
    setupSyntheticCentral();
    const { input, recording } = await register();
    const [before] = await db.select().from(schema.replayRecording);

    const renewed = await RenewReplayCapability.execute({ actor: user1, recordingId: recording.recordingId, input: { contractVersion: 1 } });

    expect(renewed).toEqual({
      contractVersion: 1,
      recordingId: recording.recordingId,
      recordingToken: expect.any(String),
      tokenExpiresAt: expect.any(Number),
      startedAt: input.startedAt,
      availability: "waiting_for_events",
      nextSequence: 0,
      limits: recording.limits,
    });
    expect(renewed.recordingToken).not.toBe(recording.recordingToken);
    const [after] = await db.select().from(schema.replayRecording);
    expect(after).toEqual(before);
  });

  it("answers an identical 404 for unknown and foreign recordings without relaying", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    const { recording } = await register();
    fetchSpy.mockClear();

    const bodies = [];
    for (const [actor, recordingId] of [
      [user2, recording.recordingId],
      [user1, crypto.randomUUID()],
      [user1, "not-a-uuid"],
    ] as const) {
      const error = await RenewReplayCapability.execute({ actor, recordingId, input: { contractVersion: 1 } }).catch((e) => e);
      expect(error).toBeInstanceOf(ReplayUploadError);
      bodies.push({ status: error.status, body: error.toBody() });
    }
    expect(bodies[0]).toEqual({ status: 404, body: { contractVersion: 1, error: "Recording not found", code: "recording_not_found" } });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(fetchSpy).not.toHaveBeenCalled();
    await PostDB(db, schema, { replay_recording: [{ recordingId: recording.recordingId, status: "open" }] });
  });

  it("keeps the stable subject across publishing-token rotation and rejects browser subject fields", async () => {
    setupSyntheticCentral();
    const { recording } = await register();

    vi.stubEnv("EPIC_PUBLISHING_TOKEN", PREVIEW_TOKEN);
    await expect(
      RenewReplayCapability.execute({ actor: user1, recordingId: recording.recordingId, input: { contractVersion: 1 } }),
    ).resolves.toMatchObject({ recordingId: recording.recordingId });

    const forged = await RenewReplayCapability.execute({
      actor: user1,
      recordingId: recording.recordingId,
      input: { contractVersion: 1, subjectId: "sub_other" },
    }).catch((e) => e);
    expect(forged).toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("preserves central closed outcomes over the local cache", async () => {
    const { fixture } = setupSyntheticCentral();
    const { recording } = await register();
    fixture.setMode("delivery_uncertain_next");
    const { UploadReplayBatch } = await import(
      "@/app/api/epic/replay/recordings/[recordingId]/batches/behaviors/upload-replay-batch/upload-replay-batch.service"
    );
    await UploadReplayBatch.execute({
      actor: user1,
      recordingId: recording.recordingId,
      input: { contractVersion: 1, recordingToken: recording.recordingToken, batchId: crypto.randomUUID(), sequence: 0, events: [{ type: 4, timestamp: 1, data: {} }], final: false },
    }).catch(() => null);

    const error = await RenewReplayCapability.execute({ actor: user1, recordingId: recording.recordingId, input: { contractVersion: 1 } }).catch((e) => e);
    expect(error).toMatchObject({ code: "delivery_uncertain", status: 409 });
  });
});
