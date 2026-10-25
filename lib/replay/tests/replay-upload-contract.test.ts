import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  REPLAY_RECORDER_VERSION,
  replayBatchRequestSchema,
  replayRegistrationRequestSchema,
  replayReportRequestSchema,
  toReplayPathname,
} from "../replay-upload-contract";

const registration = {
  contractVersion: 1,
  idempotencyKey: "6f1c5a0e-1b0e-4d6f-9a52-2f1b9d9d1c11",
  startedAt: 1_800_000_000_000,
  route: "/checkout",
  recorderVersion: REPLAY_RECORDER_VERSION,
  configVersion: "3",
  release: "abc123",
  viewport: { width: 390, height: 844 },
};

describe("replay upload contract", () => {
  it("pins the recorder version to the installed package", () => {
    const installed = JSON.parse(readFileSync("node_modules/@rrweb/record/package.json", "utf8")).version;
    expect(REPLAY_RECORDER_VERSION).toBe(installed);
  });

  it("rejects ownership fields and unknown keys from the browser", () => {
    expect(replayRegistrationRequestSchema.safeParse(registration).success).toBe(true);
    for (const extra of [
      { subjectId: "sub_x" },
      { projectId: "proj-1" },
      { applicationId: "app-1" },
      { environment: "production" },
      { captureContext: {} },
      { cloudRecordingId: "6f1c5a0e-1b0e-4d6f-9a52-2f1b9d9d1c11" },
    ]) {
      expect(replayRegistrationRequestSchema.safeParse({ ...registration, ...extra }).success).toBe(false);
    }
    expect(replayRegistrationRequestSchema.safeParse({ ...registration, route: "/a?token=1" }).success).toBe(false);
    expect(replayRegistrationRequestSchema.safeParse({ ...registration, route: "//evil" }).success).toBe(false);
  });

  it("bounds batches and report text", () => {
    const batch = {
      contractVersion: 1,
      recordingToken: "eprc_1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      batchId: registration.idempotencyKey,
      sequence: 0,
      events: [],
      final: true,
    };
    expect(replayBatchRequestSchema.safeParse(batch).success).toBe(true);
    expect(replayBatchRequestSchema.safeParse({ ...batch, subjectId: "sub_x" }).success).toBe(false);

    const report = {
      contractVersion: 1,
      idempotencyKey: registration.idempotencyKey,
      reportedAt: 1,
      route: "/",
      release: null,
      evidence: null,
      description: "  broke  ",
    };
    expect(replayReportRequestSchema.parse(report).description).toBe("broke");
    expect(replayReportRequestSchema.safeParse({ ...report, description: "   " }).success).toBe(false);
    expect(replayReportRequestSchema.safeParse({ ...report, description: "x".repeat(5_001) }).success).toBe(false);
  });

  it("reduces a location to its pathname", () => {
    expect(toReplayPathname("/a/b?x=1#y")).toBe("/a/b");
    expect(toReplayPathname("//evil.test/x")).toBeNull();
    expect(toReplayPathname("https://evil.test")).toBeNull();
  });
});
