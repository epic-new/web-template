import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PreDB } from "@/lib/db-test";
import { registrationBody, setupSyntheticCentral } from "@/lib/replay/tests/replay-relay.fixture";
import { replayRequest, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { POST as register } from "../../recordings/route";
import { POST, DELETE } from "../route";

const identityRequest = (cookie?: string) => replayRequest("/identity", { body: { contractVersion: 1 }, cookie });
const responseCookie = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

describe("Replay identity bootstrap", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("retries a lost bootstrap response without creating central state", async () => {
    const { central, fixture } = setupSyntheticCentral();
    vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");
    // The first response, including its cookie, never reaches the browser.
    expect((await POST(identityRequest())).status).toBe(200);
    const identity = await POST(identityRequest());
    expect(identity.status).toBe(200);
    expect(central.calls).toHaveLength(0);
    expect(await db.select().from(schema.replayRecording)).toHaveLength(0);

    const registered = await register(replayRequest("/recordings", { body: registrationBody(), cookie: responseCookie(identity) }));
    expect(registered.status).toBe(201);
    expect(fixture.recordings()).toHaveLength(1);
  });

  it("recovers the same registration after its response is lost", async () => {
    const { fixture } = setupSyntheticCentral();
    vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");
    const cookie = responseCookie(await POST(identityRequest()));
    const body = registrationBody();
    const lost = await register(replayRequest("/recordings", { body, cookie }));
    const original = await lost.json();
    const retried = await register(replayRequest("/recordings", { body, cookie }));
    expect(lost.status).toBe(201);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ recordingId: original.recordingId, startedAt: original.startedAt });
    expect(fixture.recordings()).toHaveLength(1);
    expect(await db.select().from(schema.replayRecording)).toHaveLength(1);
  });

  it("fails closed when the browser cannot retain the acknowledged cookie", async () => {
    const { central } = setupSyntheticCentral();
    vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");
    expect((await POST(identityRequest())).status).toBe(200);
    const response = await register(replayRequest("/recordings", { body: registrationBody() }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "identity_required" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(central.calls).toHaveLength(0);
  });

  it("keeps signed-in identity independent of the anonymous cookie and resets only the latter", async () => {
    const { central } = setupSyntheticCentral();
    const user = await signUp("identity@example.test");
    const identity = await POST(identityRequest(user.cookie));
    expect(identity.status).toBe(200);
    expect(identity.headers.get("set-cookie")).toBeNull();
    expect(await identity.json()).toEqual({ contractVersion: 1 });
    const reset = await DELETE(identityRequest(user.cookie));
    expect(reset.headers.get("set-cookie")).toContain("epic-replay-visitor=; Path=/api/epic/replay; Max-Age=0;");
    expect(reset.headers.get("set-cookie")).not.toContain("better-auth");
    expect(central.calls).toHaveLength(0);
  });

  it("requires the host's anonymous permission and same-origin request", async () => {
    const { central } = setupSyntheticCentral();
    expect((await POST(identityRequest())).status).toBe(401);
    const foreign = replayRequest("/identity", { body: { contractVersion: 1 }, headers: { origin: "https://other.example" } });
    expect((await POST(foreign)).status).toBe(403);
    expect(central.calls).toHaveLength(0);
  });
});
