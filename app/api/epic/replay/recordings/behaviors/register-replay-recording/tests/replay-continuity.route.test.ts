import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSetCookieHeader } from "better-auth/cookies";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { deriveReplaySubject } from "@/lib/replay/server/replay-subject";
import { readReplayVisitorId, REPLAY_VISITOR_COOKIE } from "@/lib/replay/server/replay-visitor-cookie";
import { batchBody, DESKTOP_CHROME, IPHONE_SAFARI, registrationBody, setupSyntheticCentral } from "@/lib/replay/tests/replay-relay.fixture";
import { APP_ORIGIN, replayRequest, routeParams, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { PREVIEW_TOKEN, PRODUCTION_TOKEN } from "@/lib/replay/tests/runtime-config.fixture";
import { POST as register } from "../../../route";
import { POST as upload } from "../../../[recordingId]/batches/route";
import { POST as renew } from "../../../[recordingId]/capability/route";
import { POST as establishIdentity, DELETE as resetIdentity } from "@/app/api/epic/replay/identity/route";
import { POST as authenticate } from "@/app/api/auth/[...all]/route";
import { GET as signOut } from "@/app/auth/signout/route";

const subjectOf = (userId: string) =>
  deriveReplaySubject({ kind: "user", userId }, process.env.BETTER_AUTH_SECRET!).subjectId;

function authRequest(path: string, body: unknown, cookie?: string) {
  return new NextRequest(`${APP_ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function responseCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Expected an acknowledged identity cookie");
  return [...parseSetCookieHeader(setCookie)].map(([name, attributes]) => `${name}=${attributes.value}`).join("; ");
}

describe("Replay continuity through the real registration Route, Service and Model", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("retries the frozen build-A registration unchanged when backend release, UA and publishing credential change independently", async () => {
    const { central, fixture } = setupSyntheticCentral();
    const { userId, cookie } = await signUp("continuity-user@example.test");
    const intent = registrationBody({ release: "build-A" });
    const firstResponse = await register(replayRequest("/recordings", {
      body: intent, cookie, headers: { "user-agent": IPHONE_SAFARI },
    }));
    expect(firstResponse.status).toBe(201);
    const original = await firstResponse.json();
    const [stored] = await db.select().from(schema.replayRecording);
    const frozenPayload = JSON.parse(stored!.registrationPayload);
    expect(frozenPayload).toMatchObject({
      release: "build-A", startedAt: intent.startedAt, subjectId: subjectOf(userId),
      captureContext: { deviceClass: "mobile", browser: { name: "Safari" }, os: { name: "iOS" } },
    });

    for (const change of ["backend_release", "user_agent", "publishing_credential"] as const) {
      vi.stubEnv("EPIC_RELEASE", change === "backend_release" ? "build-B" : undefined);
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", change === "backend_release" ? "sha-B" : undefined);
      vi.stubEnv("EPIC_PUBLISHING_TOKEN", change === "publishing_credential" ? PREVIEW_TOKEN : PRODUCTION_TOKEN);
      const response = await register(replayRequest("/recordings", {
        body: intent, cookie,
        headers: { "user-agent": change === "user_agent" ? DESKTOP_CHROME : IPHONE_SAFARI },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        recordingId: original.recordingId, startedAt: original.startedAt, nextSequence: 0,
      });
      expect(central.calls.at(-1)!.body).toEqual(frozenPayload);
    }

    expect(central.calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${PREVIEW_TOKEN}`);
    expect(fixture.recordings()).toHaveLength(1);
    await PostDB(db, schema, { replay_recording: [{
      recordingId: original.recordingId,
      subjectId: subjectOf(userId),
      registrationHash: stored!.registrationHash,
      registrationPayload: stored!.registrationPayload,
      status: "open",
    }] });
  });

  it("returns an advanced central cursor through the actual route without rewriting the original registration or the local receipt", async () => {
    const { central, fixture } = setupSyntheticCentral();
    const { cookie } = await signUp("advanced-cursor@example.test");
    const intent = registrationBody({ release: "build-A" });
    const registered = await register(replayRequest("/recordings", { body: intent, cookie }));
    expect(registered.status).toBe(201);
    const original = await registered.json();
    const opening = await upload(replayRequest(`/recordings/${original.recordingId}/batches`, {
      cookie,
      body: batchBody(original.recordingToken, 0, { events: [
        { type: 4, timestamp: intent.startedAt, data: { href: `${APP_ORIGIN}/styleguide/replay/upload`, width: 390, height: 844 } },
        { type: 2, timestamp: intent.startedAt + 1, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } },
      ] }),
    }), routeParams(original.recordingId));
    expect(opening.status).toBe(200);
    const acknowledged = Object.freeze(await opening.json());
    expect(acknowledged).toMatchObject({ sequence: 0, nextSequence: 1, delivery: "accepted" });
    const [stored] = await db.select().from(schema.replayRecording);

    // Another cooperating producer's progress cannot be relabeled as a locally
    // acknowledged batch. The BFF preserves the central response for the
    // browser's exact-frontier proof to reject; it does not repair the cursor.
    expect(fixture.advanceCursor(original.recordingId)).toBe(true);
    const retried = await register(replayRequest("/recordings", { body: intent, cookie }));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      recordingId: original.recordingId, startedAt: original.startedAt, nextSequence: 2,
    });
    expect(acknowledged.nextSequence).toBe(1);
    expect(central.calls.at(-1)!.body).toEqual(central.calls[0]!.body);
    expect(fixture.recordings()).toHaveLength(1);
    expect(fixture.providerAppends).toHaveLength(1);
    await PostDB(db, schema, { replay_recording: [{
      recordingId: original.recordingId, registrationHash: stored!.registrationHash,
      registrationPayload: stored!.registrationPayload, status: "open",
    }] });
  });

  it("keeps user-1, anonymous and user-2 recordings distinct through real auth and replay identity endpoints", async () => {
    const { central, fixture } = setupSyntheticCentral();
    // A controlled test host permits anonymous capture; production defaults
    // remain unchanged. Both users are created by Better Auth in real SQLite.
    vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");
    const two = await signUp("continuity-two@example.test");
    expect((await authenticate(authRequest("sign-out", {}, two.cookie))).status).toBe(200);
    const one = await signUp("continuity-one@example.test");
    expect((await establishIdentity(replayRequest("/identity", { cookie: one.cookie, body: { contractVersion: 1 } }))).status).toBe(200);
    const registeredOne = await register(replayRequest("/recordings", { cookie: one.cookie, body: registrationBody() }));
    expect(registeredOne.status).toBe(201);
    const recordingOne = await registeredOne.json();

    const resetOne = await resetIdentity(replayRequest("/identity", { cookie: one.cookie, body: { contractVersion: 1 } }));
    expect(resetOne.status).toBe(200);
    expect(resetOne.headers.get("set-cookie")).toContain("epic-replay-visitor=;");
    const signedOut = await signOut(new NextRequest(`${APP_ORIGIN}/auth/signout?redirect=/auth/signin`));
    expect(signedOut.status).toBe(307);
    expect(signedOut.headers.get("Location")).toBe("/auth/signin");
    await PostDB(db, schema, { session: [] });

    // Even the stale host cookie now resolves anonymous, because its real
    // application session was revoked. Identity ACKs carry no subject id.
    const anonymousIdentity = await establishIdentity(replayRequest("/identity", { cookie: one.cookie, body: { contractVersion: 1 } }));
    expect(await anonymousIdentity.clone().json()).toEqual({ contractVersion: 1 });
    const visitorCookie = responseCookie(anonymousIdentity);
    const visitorValue = visitorCookie.slice(`${REPLAY_VISITOR_COOKIE}=`.length);
    const visitorId = readReplayVisitorId(visitorValue, process.env.BETTER_AUTH_SECRET!);
    expect(visitorId).not.toBeNull();
    const anonymousSubject = deriveReplaySubject({ kind: "anonymous", visitorId: visitorId! }, process.env.BETTER_AUTH_SECRET!).subjectId;
    const registeredAnonymous = await register(replayRequest("/recordings", { cookie: visitorCookie, body: registrationBody({ route: "/auth/signin" }) }));
    expect(registeredAnonymous.status).toBe(201);
    const recordingAnonymous = await registeredAnonymous.json();

    expect((await resetIdentity(replayRequest("/identity", { cookie: visitorCookie, body: { contractVersion: 1 } }))).status).toBe(200);
    const signedIn = await authenticate(authRequest("sign-in/email", { email: "continuity-two@example.test", password: "securePassword123" }));
    expect(signedIn.status).toBe(200);
    const twoCookie = responseCookie(signedIn);
    const identityTwo = await establishIdentity(replayRequest("/identity", { cookie: twoCookie, body: { contractVersion: 1 } }));
    expect(await identityTwo.json()).toEqual({ contractVersion: 1 });
    const registeredTwo = await register(replayRequest("/recordings", { cookie: twoCookie, body: registrationBody() }));
    expect(registeredTwo.status).toBe(201);
    const recordingTwo = await registeredTwo.json();

    for (const old of [recordingOne, recordingAnonymous]) {
      const foreign = await renew(replayRequest(`/recordings/${old.recordingId}/capability`, {
        cookie: twoCookie, body: { contractVersion: 1 },
      }), routeParams(old.recordingId));
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ code: "recording_not_found" });
    }
    expect(central.calls).toHaveLength(3); // Identity/auth and denied renewals never write centrally.
    expect(new Set(fixture.recordings().map((recording) => recording.recordingId)).size).toBe(3);
    expect(new Set(fixture.recordings().map((recording) => recording.subjectId)).size).toBe(3);
    await PostDB(db, schema, {
      session: [{ userId: two.userId }],
      replay_recording: [
        { recordingId: recordingOne.recordingId, subjectId: subjectOf(one.userId), status: "open" },
        { recordingId: recordingAnonymous.recordingId, subjectId: anonymousSubject, status: "open" },
        { recordingId: recordingTwo.recordingId, subjectId: subjectOf(two.userId), status: "open" },
      ],
    });
  });
});
