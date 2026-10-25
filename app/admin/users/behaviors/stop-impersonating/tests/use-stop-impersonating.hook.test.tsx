// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  unstable_rethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
  }),
}));
vi.mock("@/lib/auth", async () => ({
  ...(await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")),
  getUser: vi.fn(),
}));
import { db } from "@/db";
import * as schema from "@/db/schema";
import { getUser } from "@/lib/auth";
import { PreDB } from "@/lib/db-test";
import { SessionModel } from "@/shared/models/session";
import { createTestClient, queryWrapper } from "@/shared/tests/test-utils";
import { defaultUsersParams, usersKeys } from "../../../users.query";
import {
  createAdminAuth,
  createImpersonationAuth,
  sessionResult,
  signUpUser,
} from "../../../tests/fixtures";
import { useStopImpersonating } from "../use-stop-impersonating.hook";
import { subscribeReplayIdentityBoundary } from "@/lib/replay/replay-identity";

describe("useStopImpersonating hook scenarios", () => {
  it("stops the real session, clears admin cache, and redirects", async () => {
    const phases: string[] = [];
    onTestFinished(subscribeReplayIdentityBoundary((event) => phases.push(event.phase)));
    await PreDB(db, schema, { user: [], account: [], session: [] });
    const admin = await createAdminAuth();
    const target = await signUpUser({ email: "target@example.com" });
    const impersonation = await createImpersonationAuth(admin, target);
    vi.mocked(getUser).mockResolvedValue(
      sessionResult(
        target,
        admin.actor.id,
        impersonation.sessionToken,
        impersonation.impersonationCredential,
      ),
    );
    const client = createTestClient();
    const key = usersKeys.list(admin.actor.id, defaultUsersParams);
    client.setQueryData(key, { users: [target], total: 1 });
    const { result } = renderHook(() => useStopImpersonating(), {
      wrapper: queryWrapper(client),
    });
    await act(async () => {
      await expect(result.current.handleStopImpersonating()).rejects.toThrow(
        "NEXT_REDIRECT",
      );
    });
    expect(client.getQueryData(key)).toBeUndefined();
    expect(phases).toEqual(["begin", "settled"]);
    expect((await SessionModel.listByUser(target.id)).every((entry) => !entry.impersonatedBy))
      .toBe(true);
  });
});
