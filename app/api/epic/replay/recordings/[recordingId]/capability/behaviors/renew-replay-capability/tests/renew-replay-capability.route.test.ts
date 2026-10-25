import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PreDB } from "@/lib/db-test";
import { registrationBody, setupSyntheticCentral } from "@/lib/replay/tests/replay-relay.fixture";
import { replayRequest, routeParams, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { POST as register } from "@/app/api/epic/replay/recordings/route";
import { POST as renew } from "../../../route";

const renewal = (recordingId: string, cookie: string, body: unknown = { contractVersion: 1 }) =>
  renew(replayRequest(`/recordings/${recordingId}/capability`, { body, cookie }), routeParams(recordingId));

describe("POST /api/epic/replay/recordings/[recordingId]/capability", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("renews the owner's capability with the complete registration shape", async () => {
    setupSyntheticCentral();
    const { cookie } = await signUp("user1@example.com");
    const created = await (await register(replayRequest("/recordings", { body: registrationBody(), cookie }))).json();

    const response = await renewal(created.recordingId, cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(created).sort());
    expect(body).toMatchObject({ recordingId: created.recordingId, startedAt: created.startedAt, nextSequence: 0 });
  });

  it("answers unknown and foreign ids identically and 503 when unconfigured", async () => {
    const { fetchSpy } = setupSyntheticCentral();
    const one = await signUp("user1@example.com");
    const two = await signUp("user2@example.com");
    const created = await (await register(replayRequest("/recordings", { body: registrationBody(), cookie: one.cookie }))).json();
    fetchSpy.mockClear();

    const foreign = await renewal(created.recordingId, two.cookie);
    const unknown = await renewal(crypto.randomUUID(), one.cookie);
    expect([foreign.status, unknown.status]).toEqual([404, 404]);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(fetchSpy).not.toHaveBeenCalled();

    setupSyntheticCentral({ configured: false });
    const unconfigured = await renewal(crypto.randomUUID(), one.cookie);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ code: "not_configured" });
  });
});
