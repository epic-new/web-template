import { describe, expect, it } from "vitest";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { ReplayRecordingModel } from "../replay-recording";

const now = new Date("2026-01-01T00:00:00.000Z");

function row(overrides: Record<string, unknown>) {
  return {
    subjectId: "sub_a",
    idempotencyKey: "k1",
    registrationHash: "h1",
    registrationPayload: "{}",
    recordingId: null,
    status: "registering",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("ReplayRecordingModel", () => {
  it("keeps one registration per subject and key, preserving the original hash and payload", async () => {
    await PreDB(db, schema, { replay_recording: [row({ id: "r1", registrationPayload: '{"a":1}' })] });

    const existing = await ReplayRecordingModel.insertRegistering({
      id: "r2",
      subjectId: "sub_a",
      idempotencyKey: "k1",
      registrationHash: "h2",
      registrationPayload: "{}",
      createdAt: now,
      updatedAt: now,
    });
    expect(existing).toMatchObject({ id: "r1", registrationHash: "h1", registrationPayload: '{"a":1}' });
    expect(await ReplayRecordingModel.findByIdempotencyKey("sub_a", "k1")).toMatchObject({ id: "r1" });

    const created = await ReplayRecordingModel.insertRegistering({
      id: "r3",
      subjectId: "sub_b",
      idempotencyKey: "k1",
      registrationHash: "h3",
      registrationPayload: "{}",
      createdAt: now,
      updatedAt: now,
    });
    expect(created).toMatchObject({ id: "r3", status: "registering" });

    await PostDB(db, schema, {
      replay_recording: [
        { id: "r1", subjectId: "sub_a", registrationHash: "h1", recordingId: null, status: "registering" },
        { id: "r3", subjectId: "sub_b", registrationHash: "h3", recordingId: null, status: "registering" },
      ],
    });
  });

  it("binds a recording id once and opens the row", async () => {
    await PreDB(db, schema, { replay_recording: [row({ id: "r1" })] });

    expect(await ReplayRecordingModel.bindRecordingId("r1", "rec-1")).toMatchObject({
      recordingId: "rec-1",
      status: "open",
    });
    expect(await ReplayRecordingModel.bindRecordingId("r1", "rec-1")).toMatchObject({ status: "open" });
    expect(await ReplayRecordingModel.bindRecordingId("r1", "rec-2")).toBeNull();
    expect(await ReplayRecordingModel.findByRecordingId("rec-1")).toMatchObject({ id: "r1" });
  });

  it("transitions status only from the expected states", async () => {
    await PreDB(db, schema, {
      replay_recording: [row({ id: "r1", recordingId: "rec-1", status: "quarantined" })],
    });

    expect(await ReplayRecordingModel.transitionStatus("rec-1", ["open"], "closed")).toBeNull();
    expect(
      await ReplayRecordingModel.transitionStatus("rec-1", ["quarantined"], "closed"),
    ).toMatchObject({ status: "closed" });

    await PostDB(db, schema, {
      replay_recording: [{ id: "r1", recordingId: "rec-1", status: "closed" }],
    });
  });

  it("counts requests in a fixed window", async () => {
    await PreDB(db, schema, { replay_rate_limit: [] });
    const at = 1_000_000;
    const consume = (now: number) =>
      ReplayRecordingModel.consumeRate("sub_a", "register", { limit: 2, windowMs: 60_000, now });

    expect([await consume(at), await consume(at + 1), await consume(at + 2)]).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: false, retryAfterMs: 59_998 },
    ]);
    expect(await consume(at + 60_000)).toEqual({ allowed: true });
    expect(
      await ReplayRecordingModel.consumeRate("sub_a", "batch", { limit: 1, windowMs: 60_000, now: at }),
    ).toEqual({ allowed: true });

    await PostDB(db, schema, {
      replay_rate_limit: [
        { subjectId: "sub_a", bucket: "register", windowStartedAt: at + 60_000, count: 1 },
        { subjectId: "sub_a", bucket: "batch", windowStartedAt: at, count: 1 },
      ],
    });
  });
});
