import { vi } from "vitest";
import { parseSetCookieHeader } from "better-auth/cookies";
import { headers } from "next/headers";
import { NextRequest } from "next/server";

import { auth } from "@/lib/auth";

/**
 * Route-test helpers for the replay relay. Callers must `vi.mock("next/headers")`
 * so `getUser()` reads the request's own cookies, and sign users up through
 * the real Better Auth API against the in-memory database.
 */

export const APP_ORIGIN = "http://localhost:8080";

export async function signUp(email: string): Promise<{ userId: string; cookie: string }> {
  const response = await auth.api.signUpEmail({
    body: { email, password: "securePassword123", name: email.split("@")[0]! },
    asResponse: true,
  });
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Sign-up did not create a session cookie");
  const cookie = Array.from(parseSetCookieHeader(setCookie).entries())
    .map(([name, attributes]) => `${name}=${attributes.value}`)
    .join("; ");
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie };
}

export function replayRequest(
  path: string,
  {
    body,
    cookie,
    headers: extra = {},
  }: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const requestHeaders = new Headers({
    origin: APP_ORIGIN,
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
    ...extra,
  });
  vi.mocked(headers).mockResolvedValue(requestHeaders as Awaited<ReturnType<typeof headers>>);
  return new NextRequest(`${APP_ORIGIN}/api/epic/replay${path}`, {
    method: "POST",
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const routeParams = (recordingId: string) => ({ params: Promise.resolve({ recordingId }) });
