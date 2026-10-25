import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseReplayRequest,
  parseReplayUploadError,
  MAX_REPLAY_SEQUENCE,
  REPLAY_RECORDER_VERSION,
  replayBatchRequestSchema,
  replayBatchAcknowledgmentSchema,
  replayRecordingCapabilitySchema,
  replayRegistrationRequestSchema,
  safeReplayPathname,
  ReplayUploadError,
  retryAfterSeconds,
} from "../replay-upload-contract";
import errors from "./fixtures/publishing-errors.v1.json";

const registration = {
  contractVersion: 1,
  idempotencyKey: "0b9a3d52-5a8f-4a4e-9a51-2f4f8f0e2a11",
  startedAt: 1_800_000_000_000,
  route: "/styleguide/replay/upload",
  recorderVersion: "2.2.0",
  configVersion: "3",
  release: null,
  viewport: { width: 390, height: 844 },
};

function codeAndStatus(run: () => unknown) {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ReplayUploadError ? { code: error.code, status: error.status } : "unexpected";
  }
}

describe("replay upload contract", () => {
  it("pins the installed recorder version", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "node_modules/@rrweb/record/package.json"), "utf8"),
    ) as { version: string };
    expect(REPLAY_RECORDER_VERSION).toBe(pkg.version);
  });

  it("rejects forged ownership fields as a 400 shape violation and bad values as 422", () => {
    expect(parseReplayRequest(replayRegistrationRequestSchema, registration)).toEqual(registration);
    for (const forged of ["subjectId", "projectId", "applicationId", "environment", "captureContext", "rrwebRecordingId", "url"]) {
      expect(codeAndStatus(() => parseReplayRequest(replayRegistrationRequestSchema, { ...registration, [forged]: "x" }))).toEqual({
        code: "invalid_request",
        status: 400,
      });
    }
    expect(codeAndStatus(() => parseReplayRequest(replayRegistrationRequestSchema, { ...registration, release: " " }))).toEqual({
      code: "invalid_request",
      status: 422,
    });
    expect(codeAndStatus(() => parseReplayRequest(replayRegistrationRequestSchema, "nope"))).toEqual({
      code: "invalid_request",
      status: 400,
    });
  });

  it("shares one full shape between registration and renewal and checks batch acknowledgments", () => {
    const capability = {
      contractVersion: 1,
      recordingId: "8d0e9a52-1d4c-4a8f-9a51-2f4f8f0e2a11",
      recordingToken: "cap",
      tokenExpiresAt: 1,
      startedAt: 1,
      availability: "waiting_for_events",
      nextSequence: 0,
      limits: { maxBatchBytes: 1_048_576, maxBatchEvents: 500, maxBufferBytes: 5_242_880, maxBufferAgeMs: 30_000, flushIntervalMs: 5_000, maxAttempts: 3 },
    };
    expect(replayRecordingCapabilitySchema.safeParse(capability).success).toBe(true);
    expect(replayRecordingCapabilitySchema.safeParse({ ...capability, rrwebRecordingId: "x" }).success).toBe(false);
    expect(replayRecordingCapabilitySchema.safeParse({ ...capability, availability: "ready" }).success).toBe(false);

    const ack = {
      contractVersion: 1,
      recordingId: capability.recordingId,
      batchId: "1d0e9a52-1d4c-4a8f-9a51-2f4f8f0e2a11",
      sequence: 2,
      delivery: "finalized",
      availability: "events_received",
      nextSequence: 3,
    };
    expect(replayBatchAcknowledgmentSchema.safeParse(ack).success).toBe(true);
    expect(replayBatchAcknowledgmentSchema.safeParse({ ...ack, nextSequence: 4 }).success).toBe(false);
    expect(replayBatchAcknowledgmentSchema.safeParse({ ...ack, delivery: "playable" }).success).toBe(false);
  });

  it("matches the central version, path, release, capability and sequence bounds", () => {
    for (const overrides of [
      { route: `/${"a".repeat(512)}` },
      { configVersion: "prod-v3" },
      { recorderVersion: "2.1.7" },
      { release: "unsafe release" },
    ]) expect(replayRegistrationRequestSchema.safeParse({ ...registration, ...overrides }).success).toBe(false);
    expect(safeReplayPathname("/orders\nprivate")).toBeNull();
    expect(safeReplayPathname("/orders?token=secret#fragment")).toBe("/orders");
    const batch = {
      contractVersion: 1, recordingToken: "cap", batchId: registration.idempotencyKey,
      sequence: MAX_REPLAY_SEQUENCE, events: [], final: true,
    };
    expect(replayBatchRequestSchema.safeParse(batch).success).toBe(true);
    expect(replayBatchRequestSchema.safeParse({ ...batch, sequence: MAX_REPLAY_SEQUENCE + 1 }).success).toBe(false);
    expect(replayBatchRequestSchema.safeParse({ ...batch, recordingToken: "x".repeat(257) }).success).toBe(false);
  });

  it("parses every shared v1 error case with exact status, case and typed fields", () => {
    for (const { status, body, retryAfter } of errors.valid) {
      const parsed = parseReplayUploadError(status, body);
      expect(parsed, body.code).toEqual(body);
      const error = new ReplayUploadError(parsed!.code, {
        status,
        expectedSequence: parsed!.expectedSequence,
        retryAfterMs: parsed!.retryAfterMs,
      });
      expect(error.status).toBe(status);
      expect(error.toBody()).toEqual(body);
      expect(error.headers()["Retry-After"] ?? null).toBe(retryAfter);
      expect(error.headers()["Cache-Control"]).toBe("no-store");
    }
    for (const { status, body, reason } of errors.invalid) {
      expect(parseReplayUploadError(status, body), reason).toBeNull();
    }
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
  });
});
