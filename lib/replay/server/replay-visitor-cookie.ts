import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const REPLAY_VISITOR_COOKIE = "epic_replay_visitor";
export const REPLAY_VISITOR_COOKIE_PATH = "/api/epic/replay";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_DOMAIN = "epic-replay-visitor:v1";

function sign(visitorId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${COOKIE_DOMAIN}:${visitorId}`).digest("base64url");
}

export function mintReplayVisitorId(): string {
  return randomBytes(32).toString("base64url");
}

export function signReplayVisitorCookie(visitorId: string, secret: string): string {
  return `${visitorId}.${sign(visitorId, secret)}`;
}

/** The visitor id of a correctly signed cookie, else null (tampering is ignored). */
export function verifyReplayVisitorCookie(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const [visitorId, signature, extra] = value.split(".");
  if (!visitorId || !signature || extra !== undefined) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(visitorId)) return null;

  const expected = Buffer.from(sign(visitorId, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return visitorId;
}

// Follows the auth cookies: an https app is embedded cross-site by the Epic
// preview, which needs Secure + SameSite=None + Partitioned; plain http
// (localhost) cannot set Secure cookies at all.
function attributes(maxAge: number): string {
  const secure = (process.env.NEXT_PUBLIC_BASE_URL ?? "").startsWith("https://");
  return [
    `Path=${REPLAY_VISITOR_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    ...(secure ? ["Secure", "SameSite=None", "Partitioned"] : ["SameSite=Lax"]),
  ].join("; ");
}

export function replayVisitorSetCookie(visitorId: string, secret: string): string {
  return `${REPLAY_VISITOR_COOKIE}=${signReplayVisitorCookie(visitorId, secret)}; ${attributes(MAX_AGE_SECONDS)}`;
}

export function replayVisitorClearCookie(): string {
  return `${REPLAY_VISITOR_COOKIE}=; ${attributes(0)}`;
}
