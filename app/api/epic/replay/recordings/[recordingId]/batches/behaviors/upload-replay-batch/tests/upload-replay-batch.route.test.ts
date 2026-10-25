import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PreDB } from "@/lib/db-test";
import errors from "@/lib/replay/tests/fixtures/publishing-errors.v1.json";
import { batchBody, registrationBody, setupSyntheticCentral } from "@/lib/replay/tests/replay-relay.fixture";
import { replayRequest, routeParams, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { POST as register } from "@/app/api/epic/replay/recordings/route";
import { POST as renew } from "../../../../capability/route";
import { POST as upload } from "../../../route";

async function registered(cookie: string) {
  return (await (await register(replayRequest("/recordings", { body: registrationBody(), cookie }))).json()) as {
    recordingId: string;
    recordingToken: string;
    startedAt: number;
  };
}

const post = (recordingId: string, body: unknown, cookie: string) =>
  upload(replayRequest(`/recordings/${recordingId}/batches`, { body, cookie }), routeParams(recordingId));

describe("POST /api/epic/replay/recordings/[recordingId]/batches", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("relays every shared central outcome with exact status, flat body, no-store and Retry-After seconds", async () => {
    const { fixture } = setupSyntheticCentral();
    const { cookie } = await signUp("user1@example.com");
    const recording = await registered(cookie);

    for (const { status, body, retryAfter } of errors.valid) {
      fixture.scriptBatchAnswers({ status, body });
      const response = await post(recording.recordingId, batchBody(recording.recordingToken, 0), cookie);
      expect(response.status, body.code).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
    }
    // Malformed central errors are never passed through as typed outcomes.
    fixture.scriptBatchAnswers({ status: 409, body: { contractVersion: 1, error: { code: "delivery_uncertain" } } });
    const malformed = await post(recording.recordingId, batchBody(recording.recordingToken, 0), cookie);
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toMatchObject({ code: "unavailable" });

    const accepted = await post(recording.recordingId, batchBody(recording.recordingToken, 0), cookie);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ delivery: "accepted", sequence: 0, nextSequence: 1 });
  });

  it("renews through the capability route and resends the identical batch exactly once", async () => {
    const { fixture } = setupSyntheticCentral();
    const { cookie } = await signUp("user1@example.com");
    const recording = await registered(cookie);
    await post(recording.recordingId, batchBody(recording.recordingToken, 0), cookie);
    fixture.expireCapabilities();

    const pending = batchBody(recording.recordingToken, 1);
    const expired = await post(recording.recordingId, pending, cookie);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ code: "capability_expired" });

    const renewal = await renew(
      replayRequest(`/recordings/${recording.recordingId}/capability`, { body: { contractVersion: 1 }, cookie }),
      routeParams(recording.recordingId),
    );
    expect(renewal.status).toBe(200);
    const capability = await renewal.json();
    expect(capability).toMatchObject({ recordingId: recording.recordingId, startedAt: recording.startedAt, nextSequence: 1 });

    const resent = await post(recording.recordingId, { ...pending, recordingToken: capability.recordingToken }, cookie);
    expect(await resent.json()).toMatchObject({ batchId: pending.batchId, sequence: 1, delivery: "accepted" });
    expect(fixture.providerAppends.map((append) => append.sequence)).toEqual([0, 1]);
  });

  it("bounds the complete request at the browser hop and the augmented request at the central hop", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    const { cookie } = await signUp("user1@example.com");
    const recording = await registered(cookie);
    fetchSpy.mockClear();

    const base = batchBody(recording.recordingToken, 0, { events: [{ type: 3, timestamp: 1, data: { text: "" } }] });
    const baseBytes = new TextEncoder().encode(JSON.stringify(base)).length;
    const withPad = (pad: number) => ({ ...base, events: [{ type: 3, timestamp: 1, data: { text: "x".repeat(pad) } }] });

    // One byte over 1 MiB as sent: the stream limit, no 8 KiB allowance.
    const over = await post(recording.recordingId, withPad(1_048_576 - baseBytes + 1), cookie);
    expect(over.status).toBe(413);
    // Under 1 MiB as sent, over once the trusted subject is injected.
    const augmented = await post(recording.recordingId, withPad(1_048_576 - baseBytes - 10), cookie);
    expect(augmented.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
