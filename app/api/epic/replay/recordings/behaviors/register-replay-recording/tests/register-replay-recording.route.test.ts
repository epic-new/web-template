import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { deriveReplaySubject } from "@/lib/replay/server/replay-subject";
import { IPHONE_SAFARI, registrationBody, setupSyntheticCentral } from "@/lib/replay/tests/replay-relay.fixture";
import { APP_ORIGIN, replayRequest, routeParams, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { POST as register } from "../../../route";
import { POST as establishIdentity } from "@/app/api/epic/replay/identity/route";
import { POST as renew } from "../../../[recordingId]/capability/route";
import { POST as upload } from "../../../[recordingId]/batches/route";

const subjectOf = (userId: string) =>
  deriveReplaySubject({ kind: "user", userId }, process.env.BETTER_AUTH_SECRET!).subjectId;

function streamed(bytes: number) {
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

describe("POST /api/epic/replay/recordings", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers a signed-in user end to end without forwarding incoming headers", async () => {
    const { central, fixture } = setupSyntheticCentral();
    const { userId, cookie } = await signUp("user1@example.com");

    const response = await register(
      replayRequest("/recordings", {
        body: registrationBody(),
        cookie,
        headers: {
          "user-agent": IPHONE_SAFARI,
          referer: `${APP_ORIGIN}/orders/42?token=secret`,
          "x-forwarded-for": "203.0.113.7",
        },
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(text)).toMatchObject({ availability: "waiting_for_events", nextSequence: 0 });
    for (const leak of ["subjectId", "sub_", "test-publishing-token", "proj-1", userId]) expect(text).not.toContain(leak);
    expect(text).not.toContain(fixture.recordings()[0]!.cloudId);

    const upstream = central.calls[0]!;
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "user-agent"]) {
      expect(upstream.headers.has(name)).toBe(false);
    }
    expect(JSON.stringify(upstream.body)).not.toContain("203.0.113.7");
    await PostDB(db, schema, { replay_recording: [{ subjectId: subjectOf(userId), status: "open" }] });
  });

  it("rejects cross-origin, non-JSON and oversized writes before anything is relayed", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    const { cookie } = await signUp("user1@example.com");

    const crossOrigin = await register(
      replayRequest("/recordings", { body: registrationBody(), cookie, headers: { origin: "https://evil.example" } }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ contractVersion: 1, code: "cross_origin" });

    const text = await register(
      replayRequest("/recordings", { body: "{}", cookie, headers: { "content-type": "text/plain" } }),
    );
    expect(text.status).toBe(415);

    const base = replayRequest(`/recordings/${crypto.randomUUID()}/batches`, { cookie, headers: { "content-length": "10" } });
    const lying = new Request(base.url, { method: "POST", headers: base.headers, body: streamed(2 * 1024 * 1024), duplex: "half" } as RequestInit);
    const oversized = await upload(new (await import("next/server")).NextRequest(lying), routeParams(crypto.randomUUID()));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "payload_too_large" });

    expect(fetchSpy).not.toHaveBeenCalled();
    await PostDB(db, schema, { replay_recording: [] });
  });

  it("captures anonymously only when allowed, with a protected visitor cookie", async () => {
    setupSyntheticCentral();

    const denied = await register(replayRequest("/recordings", { body: registrationBody() }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "identity_required" });
    await PostDB(db, schema, { replay_recording: [] });

    vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");
    const identity = await establishIdentity(replayRequest("/identity", { body: { contractVersion: 1 } }));
    expect(identity.status).toBe(200);
    const setCookie = identity.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^epic-replay-visitor=[^;]+; Path=\/api\/epic\/replay; Max-Age=2592000; HttpOnly/);
    const visitorCookie = setCookie.split(";")[0]!;
    const first = await register(replayRequest("/recordings", { body: registrationBody(), cookie: visitorCookie }));
    expect(first.status).toBe(201);

    const reload = await register(replayRequest("/recordings", { body: registrationBody(), cookie: visitorCookie }));
    expect(reload.status).toBe(201);
    expect(reload.headers.get("set-cookie")).toBeNull();

    const tampered = await register(
      replayRequest("/recordings", { body: registrationBody(), cookie: `${visitorCookie.slice(0, -2)}xx` }),
    );
    expect(tampered.status).toBe(401);
    expect(tampered.headers.get("set-cookie")).toBeNull();
    const replacement = await establishIdentity(replayRequest("/identity", { body: { contractVersion: 1 }, cookie: `${visitorCookie.slice(0, -2)}xx` }));
    const replacementCookie = replacement.headers.get("set-cookie")!.split(";")[0]!;
    expect((await register(replayRequest("/recordings", { body: registrationBody(), cookie: replacementCookie }))).status).toBe(201);

    const rows = await db.select().from(schema.replayRecording);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.subjectId).toBe(rows[1]!.subjectId);
    expect(rows[2]!.subjectId).not.toBe(rows[0]!.subjectId);
    // Capability renewal never mints a cookie: without one there is no actor.
    const renewal = await renew(
      replayRequest(`/recordings/${rows[0]!.recordingId}/capability`, { body: { contractVersion: 1 } }),
      routeParams(rows[0]!.recordingId!),
    );
    expect(renewal.status).toBe(401);
    expect(renewal.headers.get("set-cookie")).toBeNull();
    const owned = await renew(
      replayRequest(`/recordings/${rows[0]!.recordingId}/capability`, { body: { contractVersion: 1 }, cookie: visitorCookie }),
      routeParams(rows[0]!.recordingId!),
    );
    expect(owned.status).toBe(200);
    expect(owned.headers.get("set-cookie")).toBeNull();
  });

  it("keeps a recording with its subject when the user changes and rejects a forged old subject", async () => {
    setupSyntheticCentral();
    const one = await signUp("user1@example.com");
    const two = await signUp("user2@example.com");

    const registered = await (await register(replayRequest("/recordings", { body: registrationBody(), cookie: one.cookie }))).json();
    const recordingId = registered.recordingId as string;

    const foreign = await renew(
      replayRequest(`/recordings/${recordingId}/capability`, { body: { contractVersion: 1 }, cookie: two.cookie }),
      routeParams(recordingId),
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ contractVersion: 1, error: "Recording not found", code: "recording_not_found" });

    const forged = await upload(
      replayRequest(`/recordings/${recordingId}/batches`, {
        body: {
          contractVersion: 1,
          recordingToken: registered.recordingToken,
          batchId: crypto.randomUUID(),
          sequence: 0,
          events: [{ type: 4, timestamp: 1, data: {} }],
          final: false,
          subjectId: subjectOf(one.userId),
        },
        cookie: two.cookie,
      }),
      routeParams(recordingId),
    );
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ code: "invalid_request" });

    await PostDB(db, schema, { replay_recording: [{ recordingId, subjectId: subjectOf(one.userId), status: "open" }] });
  });

  it("answers not_configured honestly and still rejects forged fields when unconfigured", async () => {
    const { fetchSpy } = setupSyntheticCentral({ configured: false });
    const { cookie } = await signUp("user1@example.com");

    const unconfigured = await register(replayRequest("/recordings", { body: registrationBody(), cookie }));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ contractVersion: 1, error: "Replay upload is not configured", code: "not_configured" });

    const forged = await register(
      replayRequest("/recordings", { body: registrationBody({ subjectId: "sub_x", projectId: "p" }), cookie }),
    );
    expect(forged.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
