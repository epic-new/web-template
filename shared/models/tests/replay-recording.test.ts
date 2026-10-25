import { describe, expect, it } from "vitest";

import { ReplayRecordingModel } from "../replay-recording";

const registration = (overrides: Partial<Parameters<typeof ReplayRecordingModel.insertRegistering>[0]> = {}) => ({
  id: "local-1",
  subjectId: "sub_a",
  idempotencyKey: "key-1",
  registrationHash: "hash-1",
  registrationPayload: { startedAt: 1 },
  ...overrides,
});

describe("ReplayRecordingModel", () => {
  it("keeps the original row when a subject repeats a key", async () => {
    const first = await ReplayRecordingModel.insertRegistering(registration());
    const second = await ReplayRecordingModel.insertRegistering(
      registration({ id: "local-2", registrationHash: "hash-2", registrationPayload: { startedAt: 2 } }),
    );
    const other = await ReplayRecordingModel.insertRegistering(
      registration({ id: "local-3", subjectId: "sub_b" }),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record).toMatchObject({ id: "local-1", registrationHash: "hash-1", registrationPayload: { startedAt: 1 } });
    expect(other.record.id).toBe("local-3");
  });

  it("binds an Epic recording id once and transitions status conditionally", async () => {
    await ReplayRecordingModel.insertRegistering(registration());

    await expect(ReplayRecordingModel.bindRecordingId("local-1", "rec-1")).resolves.toBe(true);
    await expect(ReplayRecordingModel.bindRecordingId("local-1", "rec-1")).resolves.toBe(true);
    await expect(ReplayRecordingModel.bindRecordingId("local-1", "rec-2")).resolves.toBe(false);

    await expect(ReplayRecordingModel.transitionStatus("rec-1", ["registering"], "open")).resolves.toBe(true);
    await expect(ReplayRecordingModel.transitionStatus("rec-1", ["open"], "quarantined")).resolves.toBe(true);
    await expect(ReplayRecordingModel.transitionStatus("rec-1", ["open"], "closed")).resolves.toBe(false);
    await expect(ReplayRecordingModel.findByRecordingId("rec-1")).resolves.toMatchObject({ status: "quarantined" });
  });

  it("counts a fixed window atomically", async () => {
    const limit = { limit: 2, windowMs: 1_000 };
    const consume = (now: number) => ReplayRecordingModel.consumeRate("sub_a", "batch", { ...limit, now });

    await expect(consume(10_000)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await expect(consume(10_100)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await expect(consume(10_200)).resolves.toEqual({ allowed: false, retryAfterMs: 800 });
    await expect(consume(11_000)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
  });
});
