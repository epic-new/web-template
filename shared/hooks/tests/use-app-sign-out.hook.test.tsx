// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/;307;" }); }),
}));

import { SIGNIN_URL, SIGNUP_URL } from "@/app.config";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { auth } from "@/lib/auth";
import { PreDB, PostDB } from "@/lib/db-test";
import { subscribeReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { createTestClient, queryWrapper } from "@/shared/tests/test-utils";
import { parseSetCookieHeader } from "better-auth/cookies";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { useAppSignOut } from "../use-app-sign-out.hook";

describe("application sign-out replay boundary", () => {
  let requestHeaders: Headers;
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [] });
    const response = await auth.api.signUpEmail({
      body: { email: "replay-logout@example.test", name: "Replay logout", password: crypto.randomUUID() },
      asResponse: true,
    });
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) throw new Error("Synthetic authentication did not create a session");
    const cookie = Array.from(parseSetCookieHeader(setCookie).entries())
      .map(([name, attributes]) => `${name}=${attributes.value}`).join("; ");
    requestHeaders = new Headers({ cookie });
    vi.mocked(redirect).mockClear();
  });

  it.each([SIGNIN_URL, SIGNUP_URL])("closes replay before real sign-out and preserves redirect to %s", async (destination) => {
    const phases: string[] = [];
    onTestFinished(subscribeReplayIdentityBoundary((event) => phases.push(event.phase)));
    vi.mocked(headers).mockImplementation(async () => {
      expect(phases).toEqual(["begin"]);
      return requestHeaders as never;
    });
    const { result } = renderHook(() => useAppSignOut(destination), {
      wrapper: queryWrapper(createTestClient()),
    });
    await act(async () => { await result.current.handleSignOut(); });
    expect(phases).toEqual(["begin", "settled"]);
    expect(redirect).toHaveBeenCalledWith(destination);
    expect(result.current.error).toBeNull();
    await PostDB(db, schema, { session: [] });
  });

  it("settles replay and exposes ordinary authentication failure without swallowing it", async () => {
    const phases: string[] = [];
    onTestFinished(subscribeReplayIdentityBoundary((event) => phases.push(event.phase)));
    vi.mocked(headers).mockRejectedValue(new Error("Authentication transport unavailable"));
    const { result } = renderHook(() => useAppSignOut(), {
      wrapper: queryWrapper(createTestClient()),
    });
    await act(async () => {
      await expect(result.current.handleSignOut()).rejects.toThrow("Authentication transport unavailable");
    });
    await waitFor(() => expect(result.current.error).toBe("Authentication transport unavailable"));
    expect(phases).toEqual(["begin", "settled"]);
    expect(redirect).not.toHaveBeenCalled();
  });
});
