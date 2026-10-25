import { describe, expect, it } from "vitest";

import type { ReplayRecordingRecord } from "@/shared/models/replay-recording";
import { ReplayRecordingPolicy } from "../replay-recording.policy";

const now = new Date("2026-01-01T00:00:00.000Z");

function recordOf(
  subjectId: string,
  status: ReplayRecordingRecord["status"],
  recordingId: string | null = "rec-1",
): ReplayRecordingRecord {
  return {
    id: "r1",
    subjectId,
    idempotencyKey: "k1",
    registrationHash: "h1",
    registrationPayload: "{}",
    recordingId,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ReplayRecordingPolicy", () => {
  it("lets the owner relay to open and quarantined bindings", () => {
    expect(ReplayRecordingPolicy.canRelay({ subjectId: "sub_a" }, recordOf("sub_a", "open"))).toBe(true);
    // Cached local status never preempts central receipt replay.
    expect(ReplayRecordingPolicy.canRelay({ subjectId: "sub_a" }, recordOf("sub_a", "quarantined"))).toBe(true);
    expect(ReplayRecordingPolicy.canRelay({ subjectId: "sub_a" }, recordOf("sub_a", "closed"))).toBe(true);
  });

  it("refuses another subject, an unbound row, or none", () => {
    expect(ReplayRecordingPolicy.canRelay({ subjectId: "sub_b" }, recordOf("sub_a", "open"))).toBe(false);
    expect(ReplayRecordingPolicy.canRelay({ subjectId: "sub_a" }, recordOf("sub_a", "registering", null))).toBe(false);
    expect(ReplayRecordingPolicy.canRelay({ subjectId: "sub_a" }, null)).toBe(false);
  });

  it("keeps quarantined and closed recordings attachable by their owner only", () => {
    expect(ReplayRecordingPolicy.canAttach({ subjectId: "sub_a" }, recordOf("sub_a", "quarantined"))).toBe(true);
    expect(ReplayRecordingPolicy.canAttach({ subjectId: "sub_a" }, recordOf("sub_a", "closed"))).toBe(true);
    expect(ReplayRecordingPolicy.canAttach({ subjectId: "sub_b" }, recordOf("sub_a", "closed"))).toBe(false);
    expect(ReplayRecordingPolicy.canAttach({ subjectId: "sub_a" }, recordOf("sub_a", "registering", null))).toBe(false);
    expect(ReplayRecordingPolicy.canAttach({ subjectId: "sub_a" }, null)).toBe(false);
  });
});
