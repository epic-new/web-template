// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const router = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/transport", () => ({ clearAuthSession: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { adminKeys } from "@/app/admin/admin.query";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { getUser } from "@/lib/auth";
import { clearAuthSession } from "@/lib/auth/transport";
import { PostDB, PreDB } from "@/lib/db-test";
import type { SessionRecord } from "@/shared/models/session";
import {
  createTestClient,
  deferred,
  queryWrapper,
} from "@/shared/tests/test-utils";
import { headers } from "next/headers";
import { useSignOut } from "../use-sign-out.hook";
import { subscribeReplayIdentityBoundary } from "@/lib/replay/replay-identity";

const now = new Date("2026-01-01T00:00:00.000Z");
const actor = {
  id: "admin",
  name: "Admin",
  email: "admin@example.com",
  emailVerified: true,
  role: "admin",
  createdAt: now,
  updatedAt: now,
};
const otherUser = {
  id: "other",
  name: "Other",
  email: "other@example.com",
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const currentSession: SessionRecord = {
  id: "session",
  token: "session-token",
  userId: actor.id,
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  createdAt: now,
  updatedAt: now,
  ipAddress: null,
  userAgent: null,
  impersonatedBy: null,
};

describe("Sign out hook scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers() as never);
    vi.mocked(clearAuthSession).mockResolvedValue(undefined);
  });

  it("revokes the real session, clears admin cache, and navigates", async () => {
    const phases: string[] = [];
    onTestFinished(subscribeReplayIdentityBoundary((event) => phases.push(event.phase)));
    await PreDB(db, schema, {
      user: [actor],
      session: [currentSession],
    });
    const authentication = deferred<Awaited<ReturnType<typeof getUser>>>();
    vi.mocked(getUser).mockImplementation(() => {
      expect(phases).toEqual(["begin"]);
      return authentication.promise;
    });
    const client = createTestClient();
    client.setQueryData(adminKeys.stats(actor.id), {
      totalUsers: 1,
      activeUsers: 1,
      bannedUsers: 0,
    });
    client.setQueryData(["outside-admin"], "preserved");
    const { result } = renderHook(() => useSignOut(), {
      wrapper: queryWrapper(client),
    });

    let request!: ReturnType<typeof result.current.handleSignOut>;
    act(() => {
      request = result.current.handleSignOut();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    await act(async () => {
      authentication.resolve({
        user: actor,
        sessionToken: currentSession.token,
        isImpersonating: false,
        impersonatedBy: null,
        impersonationCredential: null,
      } as never);
      await request;
    });

    expect(client.getQueryData(adminKeys.stats(actor.id))).toBeUndefined();
    expect(client.getQueryData(["outside-admin"])).toBe("preserved");
    expect(router.replace).toHaveBeenCalledWith("/admin");
    expect(router.refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toMatchObject({ isLoading: false, error: null });
    expect(phases).toEqual(["begin", "settled"]);
    await PostDB(db, schema, { session: [] });
  });

  it("preserves cache and database when session authorization fails", async () => {
    const phases: string[] = [];
    onTestFinished(subscribeReplayIdentityBoundary((event) => phases.push(event.phase)));
    await PreDB(db, schema, {
      user: [actor, otherUser],
      session: [currentSession],
    });
    vi.mocked(getUser).mockResolvedValue({
      user: otherUser,
      sessionToken: currentSession.token,
      isImpersonating: false,
      impersonatedBy: null,
      impersonationCredential: null,
    } as never);
    const client = createTestClient();
    const cachedStats = {
      totalUsers: 2,
      activeUsers: 2,
      bannedUsers: 0,
    };
    client.setQueryData(adminKeys.stats(otherUser.id), cachedStats);
    const { result } = renderHook(() => useSignOut(), {
      wrapper: queryWrapper(client),
    });

    await act(async () => {
      await expect(result.current.handleSignOut()).rejects.toThrow("Unauthorized");
    });

    await waitFor(() => expect(result.current.error).toBe("Unauthorized"));
    expect(result.current.error).toBe("Unauthorized");
    expect(client.getQueryData(adminKeys.stats(otherUser.id))).toEqual(cachedStats);
    expect(clearAuthSession).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(phases).toEqual(["begin", "settled"]);
    await PostDB(db, schema, { session: [currentSession] });
  });
});
