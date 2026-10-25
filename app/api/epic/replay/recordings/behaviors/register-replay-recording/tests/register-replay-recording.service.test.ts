import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { ReplayUploadError } from "@/lib/replay/replay-upload-contract";
import { deriveReplaySubject } from "@/lib/replay/server/replay-subject";
import { PREVIEW_TOKEN } from "@/lib/replay/tests/runtime-config.fixture";
import {
  DESKTOP_CHROME,
  IPHONE_SAFARI,
  registrationBody,
  setupSyntheticCentral,
  uaOf,
} from "@/lib/replay/tests/replay-relay.fixture";
import { RegisterReplayRecording } from "../register-replay-recording.service";

const user1 = { kind: "user" as const, userId: "user-1" };
const subject1 = () => deriveReplaySubject(user1, process.env.BETTER_AUTH_SECRET!).subjectId;

async function failure(run: () => Promise<unknown>) {
  const error = await run().catch((e) => e);
  expect(error).toBeInstanceOf(ReplayUploadError);
  return { code: (error as ReplayUploadError).code, status: (error as ReplayUploadError).status };
}

describe("RegisterReplayRecording", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers a user recording with an opaque subject and coarse context only", async () => {
    const { central } = setupSyntheticCentral();
    const input = registrationBody({ route: "/orders/42?access_token=secret#frag" });

    const result = await RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(IPHONE_SAFARI) });

    expect(result.created).toBe(true);
    expect(result.recording).toMatchObject({ availability: "waiting_for_events", nextSequence: 0, startedAt: input.startedAt });
    const sent = central.calls[0]!.body as Record<string, unknown>;
    const { viewport: _viewport, ...centralInput } = input;
    expect(sent).toEqual({
      ...centralInput,
      route: "/orders/42",
      subjectId: subject1(),
      captureContext: {
        browser: { name: "Safari", majorVersion: "17" },
        os: { name: "iOS", majorVersion: "17" },
        deviceClass: "mobile",
        viewport: { width: 390, height: 844 },
      },
    });
    expect(sent).not.toHaveProperty("viewport");
    const text = JSON.stringify(sent);
    for (const leak of ["user-1", "Mozilla", "secret", "user1@example.com"]) expect(text).not.toContain(leak);

    await PostDB(db, schema, {
      replay_recording: [
        { subjectId: subject1(), idempotencyKey: input.idempotencyKey, recordingId: result.recording.recordingId, status: "open" },
      ],
    });
  });

  it("reuses the stored payload when the UA, deployment release or publishing token changed", async () => {
    const { central } = setupSyntheticCentral();
    const input = registrationBody({ release: "build-a" });
    const first = await RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(IPHONE_SAFARI) });

    // Same document (build-A) retries after the BFF moved to build-B with a
    // rotated publishing token.
    vi.stubEnv("EPIC_RELEASE", "build-b");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "sha-b");
    vi.stubEnv("EPIC_PUBLISHING_TOKEN", PREVIEW_TOKEN);
    const retry = await RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(DESKTOP_CHROME) });

    expect(retry.created).toBe(false);
    expect(retry.recording.recordingId).toBe(first.recording.recordingId);
    expect(central.calls[1]!.body).toEqual(central.calls[0]!.body);
    expect(central.calls[1]!.body).toMatchObject({ release: "build-a", subjectId: subject1() });
  });

  it("keeps an unknown release null, never the server's", async () => {
    const { central } = setupSyntheticCentral();
    vi.stubEnv("EPIC_RELEASE", "server-sha");
    await RegisterReplayRecording.execute({ actor: user1, input: registrationBody({ release: null }), userAgent: uaOf(IPHONE_SAFARI) });
    expect(central.calls[0]!.body).toMatchObject({ release: null });
  });

  it("answers 409 for changed immutable input under a key without overwriting or disclosing", async () => {
    const { central } = setupSyntheticCentral();
    const input = registrationBody();
    await RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(IPHONE_SAFARI) });

    for (const change of [
      { startedAt: input.startedAt + 1 },
      { release: "build-b" },
      { viewport: { width: 1024, height: 768 } },
      { route: "/elsewhere" },
    ]) {
      const error = await RegisterReplayRecording.execute({
        actor: user1,
        input: { ...input, ...change },
        userAgent: uaOf(IPHONE_SAFARI),
      }).catch((e) => e);
      expect(error).toBeInstanceOf(ReplayUploadError);
      expect(error.toBody()).toEqual({ contractVersion: 1, error: expect.any(String), code: "idempotency_conflict" });
    }
    expect(central.calls).toHaveLength(1);
    await PostDB(db, schema, { replay_recording: [{ idempotencyKey: input.idempotencyKey, status: "open" }] });
  });

  it("rejects forged ownership fields, a missing actor and absent configuration before any write", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    for (const forged of [{ subjectId: "sub_x" }, { projectId: "p" }, { environment: "production" }, { rrwebRecordingId: crypto.randomUUID() }]) {
      expect(
        await failure(() =>
          RegisterReplayRecording.execute({ actor: user1, input: registrationBody(forged), userAgent: uaOf(IPHONE_SAFARI) }),
        ),
      ).toEqual({ code: "invalid_request", status: 400 });
    }
    expect(
      await failure(() => RegisterReplayRecording.execute({ actor: null, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) })),
    ).toEqual({ code: "identity_required", status: 401 });

    setupSyntheticCentral({ configured: false });
    expect(
      await failure(() => RegisterReplayRecording.execute({ actor: user1, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) })),
    ).toEqual({ code: "not_configured", status: 503 });
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    stubEnvConfigured();
    expect(
      await failure(() => RegisterReplayRecording.execute({ actor: user1, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) })),
    ).toEqual({ code: "not_configured", status: 503 });

    expect(fetchSpy).not.toHaveBeenCalled();
    await PostDB(db, schema, { replay_recording: [] });
  });

  it("preserves a central credential rejection and limits the register rate", async () => {
    setupSyntheticCentral();
    vi.stubEnv("EPIC_PUBLISHING_TOKEN", "revoked-token");
    expect(
      await failure(() => RegisterReplayRecording.execute({ actor: user1, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) })),
    ).toEqual({ code: "REPLAY_CREDENTIAL_INVALID", status: 401 });

    setupSyntheticCentral();
    for (let i = 1; i < 10; i++) {
      await RegisterReplayRecording.execute({ actor: user1, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) });
    }
    const limited = await RegisterReplayRecording.execute({ actor: user1, input: registrationBody(), userAgent: uaOf(IPHONE_SAFARI) }).catch((e) => e);
    expect(limited).toMatchObject({ code: "rate_limited", status: 429 });
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.headers()["Retry-After"]).toBe(String(Math.ceil(limited.retryAfterMs / 1000)));
  });

  it("answers unavailable on a network failure and succeeds on the same-key retry", async () => {
    setupSyntheticCentral();
    const input = registrationBody();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("down"); }));
    expect(
      await failure(() => RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(IPHONE_SAFARI) })),
    ).toEqual({ code: "unavailable", status: 503 });

    setupSyntheticCentral();
    const retried = await RegisterReplayRecording.execute({ actor: user1, input, userAgent: uaOf(DESKTOP_CHROME) });
    expect(retried.created).toBe(true);
    // The first derivation (iPhone) stays frozen.
    await PostDB(db, schema, { replay_recording: [{ idempotencyKey: input.idempotencyKey, status: "open" }] });
    const [row] = await db.select().from(schema.replayRecording);
    expect(JSON.parse(row!.registrationPayload).captureContext.deviceClass).toBe("mobile");
  });
});

function stubEnvConfigured() {
  vi.stubEnv("EPIC_API_URL", "https://epic.test");
  vi.stubEnv("EPIC_PROJECT_ID", "proj-1");
  vi.stubEnv("EPIC_PUBLISHING_TOKEN", "test-publishing-token");
}
