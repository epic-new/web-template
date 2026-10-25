import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearEpicEnv,
  jsonResponse,
  stubEpicEnv,
} from "@/lib/replay/tests/runtime-config.fixture";
import type { UserAgentInfo } from "@/lib/replay/server/capture-context";
import { ReplayRecordingModel } from "@/shared/models/replay-recording";
import { RegisterReplayRecording } from "../register-replay-recording.service";

const KEY = "6f1c5a0e-1b0e-4d6f-9a52-2f1b9d9d1c11";
const RECORDING_ID = "0a1b2c3d-1b0e-4d6f-9a52-2f1b9d9d1c11";
const actor = { kind: "user", userId: "user-1" } as const;

const input = {
  contractVersion: 1,
  idempotencyKey: KEY,
  startedAt: 1_800_000_000_000,
  route: "/checkout",
  recorderVersion: "2.2.0",
  configVersion: "3",
  release: "build-a",
  viewport: { width: 390, height: 844 },
};

const iphone: UserAgentInfo = {
  browser: { name: "Mobile Safari", version: "17.4.1" },
  os: { name: "iOS", version: "17.4" },
  device: { type: "mobile" },
};
const desktop: UserAgentInfo = {
  browser: { name: "Chrome", version: "130.0" },
  os: { name: "Windows", version: "11" },
  device: {},
};

const limits = {
  maxBatchBytes: 1_048_576,
  maxBatchEvents: 500,
  maxBufferBytes: 5_242_880,
  maxBufferAgeMs: 30_000,
  flushIntervalMs: 5_000,
  maxAttempts: 3,
};
const recording = {
  contractVersion: 1,
  recordingId: RECORDING_ID,
  recordingToken: "eprc_token",
  tokenExpiresAt: 1_800_000_900_000,
  startedAt: input.startedAt,
  availability: "waiting_for_events",
  nextSequence: 0,
  limits,
};

describe("RegisterReplayRecording", () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearEpicEnv();
    stubEpicEnv();
    vi.stubGlobal("fetch", upstream);
    upstream.mockResolvedValue(jsonResponse(recording, 201));
  });

  afterEach(() => {
    upstream.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const sent = (call = 0) => JSON.parse(String(upstream.mock.calls[call]![1]?.body));

  it("relays the frozen intent with the trusted subject and coarse context", async () => {
    const result = await RegisterReplayRecording.execute({ actor, input, userAgent: iphone });

    expect(result.created).toBe(true);
    expect(result.registration).toMatchObject({ availability: "waiting_for_events", nextSequence: 0 });
    expect(sent()).toMatchObject({
      subjectId: expect.stringMatching(/^sub_/),
      route: "/checkout",
      release: "build-a",
      captureContext: {
        browser: { name: "Safari", majorVersion: "17" },
        os: { name: "iOS", majorVersion: "17" },
        deviceClass: "mobile",
        viewport: { width: 390, height: 844 },
      },
    });
    expect(JSON.stringify(sent())).not.toContain("user-1");
    await expect(ReplayRecordingModel.findByRecordingId(RECORDING_ID)).resolves.toMatchObject({ status: "open" });
  });

  it("resends the stored payload on a retry, whatever the User-Agent now says", async () => {
    await RegisterReplayRecording.execute({ actor, input, userAgent: iphone });
    upstream.mockResolvedValue(jsonResponse(recording, 200));
    const retry = await RegisterReplayRecording.execute({ actor, input, userAgent: desktop });

    expect(retry.created).toBe(false);
    expect(sent(1)).toEqual(sent(0));
  });

  it("refuses the same key with different immutable content", async () => {
    await RegisterReplayRecording.execute({ actor, input, userAgent: iphone });
    upstream.mockClear();

    for (const changed of [{ startedAt: input.startedAt + 1 }, { release: "build-b" }, { viewport: null }]) {
      await expect(
        RegisterReplayRecording.execute({ actor, input: { ...input, ...changed }, userAgent: iphone }),
      ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects ownership fields, a missing identity and missing configuration", async () => {
    await expect(
      RegisterReplayRecording.execute({ actor, input: { ...input, subjectId: "sub_x" }, userAgent: iphone }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(
      RegisterReplayRecording.execute({ actor: null, input, userAgent: iphone }),
    ).rejects.toMatchObject({ code: "identity_required", status: 401 });

    clearEpicEnv();
    await expect(
      RegisterReplayRecording.execute({ actor, input, userAgent: iphone }),
    ).rejects.toMatchObject({ code: "not_configured", status: 503 });
    expect(upstream).not.toHaveBeenCalled();
    await expect(ReplayRecordingModel.findByIdempotencyKey("sub_none", KEY)).resolves.toBeNull();
  });

  it("preserves a central refusal exactly", async () => {
    upstream.mockResolvedValue(
      jsonResponse({ contractVersion: 1, error: "x", code: "REPLAY_CREDENTIAL_INVALID" }, 401),
    );
    await expect(
      RegisterReplayRecording.execute({ actor, input, userAgent: iphone }),
    ).rejects.toMatchObject({ code: "REPLAY_CREDENTIAL_INVALID", status: 401 });
  });
});
