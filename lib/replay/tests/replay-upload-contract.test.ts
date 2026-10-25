import { describe, expect, it } from "vitest";

import {
  replayIdentityRequestSchema,
  replayReportRequestSchema,
  REPLAY_UPLOAD_ERROR_CODES,
  REPLAY_UPLOAD_ERROR_STATUS,
  toReplayPathname,
} from "../replay-upload-contract";

const KEY = "6f1c5a0e-1b0e-4d6f-9a52-2f1b9d9d1c11";
const SESSION_ID = "0123456789abcdef0123456789abcdef";

const report = {
  contractVersion: 1,
  idempotencyKey: KEY,
  reportedAt: 1,
  route: "/",
  release: null,
  evidence: null,
  description: "  broke  ",
};

describe("replay upload contract", () => {
  it("bounds report text and trims it", () => {
    expect(replayReportRequestSchema.parse(report).description).toBe("broke");
    expect(replayReportRequestSchema.safeParse({ ...report, description: "   " }).success).toBe(false);
    expect(replayReportRequestSchema.safeParse({ ...report, description: "x".repeat(5_001) }).success).toBe(false);
  });

  it("accepts a session reference and nothing that names an owner", () => {
    const evidence = {
      sessionId: SESSION_ID,
      startedAt: 1_800_000_000_000,
      offsetMs: 1_200,
      traceId: "a".repeat(32),
      behaviorId: "checkout",
      occurrenceId: "occ-1",
    };
    expect(replayReportRequestSchema.safeParse({ ...report, evidence }).success).toBe(true);
    expect(replayReportRequestSchema.safeParse({ ...report, evidence: { ...evidence, traceId: undefined } }).success).toBe(true);

    for (const bad of [
      { ...evidence, sessionId: SESSION_ID.toUpperCase() },
      { ...evidence, sessionId: "short" },
      { ...evidence, traceId: "xyz" },
      { ...evidence, recordingId: KEY },
      { ...evidence, subjectId: "sub_x" },
    ]) {
      expect(replayReportRequestSchema.safeParse({ ...report, evidence: bad }).success).toBe(false);
    }
    expect(replayReportRequestSchema.safeParse({ ...report, subjectId: "sub_x" }).success).toBe(false);
  });

  it("keeps the recording protocol's error codes out and adds unsupported_media_type to Epic's", () => {
    expect(REPLAY_UPLOAD_ERROR_CODES).toContain("unsupported_media_type");
    for (const removed of ["capability_expired", "invalid_capability", "recording_not_found", "recording_closed", "subject_mismatch"]) {
      expect(REPLAY_UPLOAD_ERROR_CODES).not.toContain(removed);
    }
    expect(REPLAY_UPLOAD_ERROR_STATUS.unsupported_media_type).toBe(415);
  });

  it("rejects unknown keys in the identity handshake", () => {
    expect(replayIdentityRequestSchema.safeParse({ contractVersion: 1, purpose: "capture" }).success).toBe(true);
    expect(replayIdentityRequestSchema.safeParse({ contractVersion: 1, subjectId: "sub_x" }).success).toBe(false);
  });

  it("reduces a location to its pathname", () => {
    expect(toReplayPathname("/a/b?x=1#y")).toBe("/a/b");
    expect(toReplayPathname("//evil.test/x")).toBeNull();
    expect(toReplayPathname("https://evil.test")).toBeNull();
  });
});
