import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearEpicEnv, jsonResponse, stubEpicEnv } from "@/lib/replay/tests/runtime-config.fixture";
import { db } from "@/db";
import { replayRecording } from "@/db/schema";
import { deriveReplaySubject } from "@/lib/replay/server/replay-subject";
import { ReplayRecordingModel } from "@/shared/models/replay-recording";
import { UploadReplayBatch } from "../upload-replay-batch.service";

const RECORDING_ID = "0a1b2c3d-1b0e-4d6f-9a52-2f1b9d9d1c11";
const BATCH_ID = "6f1c5a0e-1b0e-4d6f-9a52-2f1b9d9d1c11";
const owner = { kind: "user", userId: "user-1" } as const;
const stranger = { kind: "user", userId: "user-2" } as const;

const batch = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  recordingToken: "eprc_1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  batchId: BATCH_ID,
  sequence: 0,
  events: [{ type: 4, timestamp: 1, data: {} }],
  final: false,
  ...overrides,
});

const ack = {
  contractVersion: 1,
  recordingId: RECORDING_ID,
  batchId: BATCH_ID,
  sequence: 0,
  delivery: "accepted",
};

describe("UploadReplayBatch", () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(async () => {
    ReplayRecordingModel.clearOwnershipCache();
    clearEpicEnv();
    stubEpicEnv();
    vi.stubGlobal("fetch", upstream);
    upstream.mockImplementation(async () => jsonResponse(ack));

    const subjectId = deriveReplaySubject(owner, process.env.BETTER_AUTH_SECRET!);
    await ReplayRecordingModel.insertRegistering({
      id: "local-1",
      subjectId,
      idempotencyKey: BATCH_ID,
      registrationHash: "hash",
      registrationPayload: { startedAt: 1 },
    });
    await ReplayRecordingModel.bindRecordingId("local-1", RECORDING_ID);
  });

  afterEach(() => {
    upstream.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("relays the batch with the trusted subject and returns Epic's acknowledgment", async () => {
    const result = await UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch() });

    expect(result).toEqual(ack);
    const sent = JSON.parse(String(upstream.mock.calls[0]![1]?.body));
    expect(sent).toMatchObject({ subjectId: expect.stringMatching(/^sub_/), batchId: BATCH_ID, sequence: 0 });
  });

  it("passes Epic's rate limit through with its retryAfterMs", async () => {
    upstream.mockResolvedValueOnce(
      jsonResponse({ contractVersion: 1, error: "x", code: "rate_limited", retryAfterMs: 2_000 }, 429),
    );
    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch() }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429, extras: { retryAfterMs: 2_000 } });
  });

  it("answers an unknown or foreign recording identically, without relaying", async () => {
    for (const [actor, recordingId] of [
      [stranger, RECORDING_ID],
      [owner, "9a1b2c3d-1b0e-4d6f-9a52-2f1b9d9d1c11"],
    ] as const) {
      await expect(
        UploadReplayBatch.execute({ actor, recordingId, input: batch() }),
      ).rejects.toMatchObject({ code: "recording_not_found", status: 404 });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("bounds the request before relaying", async () => {
    const events = Array.from({ length: 501 }, (_, index) => ({ type: 3, timestamp: index, data: {} }));
    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch({ events }) }),
    ).rejects.toMatchObject({ code: "payload_too_large", status: 413 });
    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch({ events: [] }) }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 422 });
    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch({ subjectId: "sub_x" }) }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps no per-batch state: an accepted batch changes no row", async () => {
    const before = await ReplayRecordingModel.findByRecordingId(RECORDING_ID);
    await UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch() });
    await expect(ReplayRecordingModel.findByRecordingId(RECORDING_ID)).resolves.toEqual(before);
  });

  it("caches a closed recording but still relays a later retry", async () => {
    upstream.mockResolvedValueOnce(
      jsonResponse({ contractVersion: 1, error: "x", code: "recording_closed" }, 409),
    );
    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch() }),
    ).rejects.toMatchObject({ code: "recording_closed", status: 409 });
    await expect(ReplayRecordingModel.findByRecordingId(RECORDING_ID)).resolves.toMatchObject({
      status: "closed",
    });

    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch() }),
    ).resolves.toEqual(ack);
  });

  it("reads ownership once per recording, then trusts the confirmed binding", async () => {
    await UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch() });
    await db.delete(replayRecording);

    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: RECORDING_ID, input: batch({ sequence: 1 }) }),
    ).resolves.toEqual(ack);
    await expect(
      UploadReplayBatch.execute({ actor: stranger, recordingId: RECORDING_ID, input: batch() }),
    ).rejects.toMatchObject({ code: "recording_not_found" });
  });

  it("rejects a malformed recording id without touching the database or Epic", async () => {
    await expect(
      UploadReplayBatch.execute({ actor: owner, recordingId: "../reports", input: batch() }),
    ).rejects.toMatchObject({ code: "recording_not_found", status: 404 });
    expect(upstream).not.toHaveBeenCalled();
  });
});
