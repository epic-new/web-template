import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcknowledgeReplayIdentity } from "../acknowledge-replay-identity.service";

const input = { contractVersion: 1 };

describe("AcknowledgeReplayIdentity", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints anonymous visitors only up to the per-address budget", async () => {
    const clientAddress = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
    const acknowledge = () =>
      AcknowledgeReplayIdentity.execute({ user: null, visitorId: null, clientAddress, input });

    for (let i = 0; i < 20; i++) expect(await acknowledge()).toEqual({ mintVisitor: true });

    await expect(acknowledge()).rejects.toMatchObject({ code: "rate_limited" });
    expect(
      await AcknowledgeReplayIdentity.execute({ user: null, visitorId: null, clientAddress: `${clientAddress}-other`, input }),
    ).toEqual({ mintVisitor: true });
  });

  it("never spends the budget for a signed-in user or a visitor who already has a cookie", async () => {
    const clientAddress = randomUUID();
    for (let i = 0; i < 25; i++) {
      expect(await AcknowledgeReplayIdentity.execute({ user: { userId: "u1" }, visitorId: null, clientAddress, input })).toEqual({ mintVisitor: false });
      expect(await AcknowledgeReplayIdentity.execute({ user: null, visitorId: "v1", clientAddress, input })).toEqual({ mintVisitor: false });
    }
  });
});
