import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "@/lib/replay/tests/runtime-config.fixture";
import { EpicClient, EpicPublishingError } from "../epic";
import { RecordingsResource } from "../resources/recordings.resource";

const client = EpicClient.fromEnv({
  EPIC_API_URL: "https://epic.test",
  EPIC_PROJECT_ID: "proj-1",
  EPIC_PUBLISHING_TOKEN: "test-publishing-token",
})!;

const RECORDING_ID = "0a1b2c3d-1b0e-4d6f-9a52-2f1b9d9d1c11";
const limits = {
  maxBatchBytes: 1_048_576,
  maxBatchEvents: 500,
  maxBufferBytes: 5_242_880,
  maxBufferAgeMs: 60_000,
  flushIntervalMs: 20_000,
  flushBytes: 65_536,
  maxAttempts: 3,
};
const recording = {
  contractVersion: 1,
  recordingId: RECORDING_ID,
  recordingToken: "eprc_1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  tokenExpiresAt: 1_800_000_900_000,
  startedAt: 1_800_000_000_000,
  availability: "waiting_for_events",
  limits,
};

describe("RecordingsResource", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the allowlisted headers and the exact body", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(recording, 201));
    vi.stubGlobal("fetch", upstream);

    const result = await RecordingsResource.renewCapability(client, RECORDING_ID, { subjectId: "sub_a" });

    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(`https://epic.test/api/replay/v1/recordings/${RECORDING_ID}/capability`);
    expect([...new Headers(init?.headers).keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(JSON.parse(init?.body as string)).toEqual({ contractVersion: 1, subjectId: "sub_a" });
    expect(result).toMatchObject({ recordingId: RECORDING_ID });
  });

  it("rejects a success carrying fields outside the contract", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...recording, rrwebRecordingId: "x" })));
    await expect(
      RecordingsResource.renewCapability(client, RECORDING_ID, { subjectId: "sub_a" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("preserves the status, code and typed fields of a flat error", async () => {
    const error = { contractVersion: 1, error: "x", code: "rate_limited", retryAfterMs: 1_500 };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(error, 429)));

    const failure = await RecordingsResource.appendBatch(client, RECORDING_ID, {
      contractVersion: 1,
      subjectId: "sub_a",
      recordingToken: "t",
      batchId: RECORDING_ID,
      sequence: 9,
      events: [],
      final: true,
    }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(EpicPublishingError);
    expect(failure).toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: 1_500 });
  });
});
