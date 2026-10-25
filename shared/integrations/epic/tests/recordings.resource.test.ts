import { afterEach, describe, expect, it, vi } from "vitest";

import errors from "@/lib/replay/tests/fixtures/publishing-errors.v1.json";
import { jsonResponse } from "@/lib/replay/tests/runtime-config.fixture";
import { createSyntheticCentralFetch, createSyntheticEpi210 } from "@/lib/replay/tests/synthetic-epi210.core";
import { EpicClient, EpicIntegrationError } from "../epic";
import type { RecordingRegistrationPayload } from "../resources";
import { RecordingsResource } from "../resources/recordings.resource";

const env = {
  EPIC_API_URL: "https://epic.test",
  EPIC_PROJECT_ID: "proj-1",
  EPIC_PUBLISHING_TOKEN: "test-publishing-token",
};

const payload: RecordingRegistrationPayload = {
  contractVersion: 1,
  idempotencyKey: "0b9a3d52-5a8f-4a4e-9a51-2f4f8f0e2a11",
  startedAt: 1_800_000_000_000,
  route: "/styleguide/replay/upload",
  recorderVersion: "2.2.0",
  configVersion: "3",
  release: "build-a",
  subjectId: "sub_test",
  captureContext: {
    browser: { name: "Safari", majorVersion: "17" },
    os: { name: "iOS", majorVersion: "17" },
    deviceClass: "mobile",
    viewport: { width: 390, height: 844 },
  },
};

function setup() {
  const fixture = createSyntheticEpi210();
  const central = createSyntheticCentralFetch(fixture, { apiUrl: env.EPIC_API_URL, tokens: [env.EPIC_PUBLISHING_TOKEN] });
  vi.stubGlobal("fetch", vi.fn(central.fetch));
  return { fixture, central, client: EpicClient.fromEnv(env)! };
}

async function rejectionOf(run: () => Promise<unknown>) {
  const error = await run().catch((e) => e);
  expect(error).toBeInstanceOf(EpicIntegrationError);
  return error as EpicIntegrationError;
}

describe("RecordingsResource", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only allowlisted headers and the exact body", async () => {
    const { central, client } = setup();

    const registered = await RecordingsResource.register(client, payload);

    expect(registered).toMatchObject({ created: true, recording: { availability: "waiting_for_events", nextSequence: 0 } });
    const [call] = central.calls;
    expect(call!.url).toBe("https://epic.test/api/replay/v1/recordings");
    expect([...call!.headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(call!.body).toEqual(payload);

    const again = await RecordingsResource.register(client, payload);
    expect(again).toMatchObject({ created: false, recording: { recordingId: registered.recording.recordingId } });
  });

  it("renews with the full shape and appends with typed acknowledgments", async () => {
    const { client, fixture } = setup();
    const { recording } = await RecordingsResource.register(client, payload);

    const renewed = await RecordingsResource.renewCapability(client, recording.recordingId, { subjectId: "sub_test" });
    expect(renewed).toMatchObject({ recordingId: recording.recordingId, startedAt: payload.startedAt, nextSequence: 0 });
    expect(renewed.recordingToken).not.toBe(recording.recordingToken);

    const batch = {
      contractVersion: 1 as const,
      recordingToken: renewed.recordingToken,
      batchId: "1d0e9a52-1d4c-4a8f-9a51-2f4f8f0e2a11",
      sequence: 0,
      events: [{ type: 4, timestamp: payload.startedAt, data: { href: "https://app.example/" } }],
      final: false,
      subjectId: "sub_test",
    };
    expect(await RecordingsResource.appendBatch(client, recording.recordingId, batch)).toMatchObject({
      delivery: "accepted",
      availability: "events_received",
      nextSequence: 1,
    });

    fixture.scriptBatchAnswers({
      status: 409,
      body: { contractVersion: 1, error: "Delivery of this batch is uncertain", code: "delivery_uncertain" },
    });
    const uncertain = await rejectionOf(() =>
      RecordingsResource.appendBatch(client, recording.recordingId, { ...batch, batchId: "2d0e9a52-1d4c-4a8f-9a51-2f4f8f0e2a11", sequence: 1 }),
    );
    expect(uncertain.code).toBe("rejected");
    expect(uncertain.rejection).toEqual({ status: 409, code: "delivery_uncertain" });
  });

  it("rejects success bodies that carry anything outside v1", async () => {
    const { client } = setup();
    const { recording } = await RecordingsResource.register(client, payload);

    for (const extra of [{ rrwebRecordingId: "cloud" }, { privateKey: "secret" }]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...recording, ...extra }, 201)));
      expect((await rejectionOf(() => RecordingsResource.register(client, payload))).code).toBe("invalid_response");
    }
  });

  it("maps every shared v1 error to its exact status, code and typed fields", async () => {
    const client = EpicClient.fromEnv(env)!;
    for (const { status, body } of errors.valid) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
      const error = await rejectionOf(() => RecordingsResource.register(client, payload));
      expect(error.code, body.code).toBe("rejected");
      const typed: Record<string, unknown> = { ...body };
      delete typed.error;
      delete typed.contractVersion;
      expect(error.rejection).toEqual({ status, ...typed });
      expect(JSON.stringify(error)).not.toContain(body.error);
    }
    for (const { status, body } of errors.invalid) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
      const error = await rejectionOf(() => RecordingsResource.register(client, payload));
      expect(error.rejection).toBeUndefined();
      expect(["unauthorized", "unavailable"]).toContain(error.code);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("down"); }));
    expect((await rejectionOf(() => RecordingsResource.register(client, payload))).code).toBe("unavailable");
  });
});
