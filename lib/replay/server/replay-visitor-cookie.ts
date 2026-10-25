import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The protected anonymous visitor identity, used only when the host allows
 * anonymous capture. The cookie is HttpOnly and scoped to the replay routes;
 * its id is random and signed with the application's identity secret, so a
 * browser can keep its own identity across reloads but never pick another.
 */

export const REPLAY_VISITOR_COOKIE = "epic-replay-visitor";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const VISITOR_ID = /^[A-Za-z0-9_-]{43}$/;

function sign(visitorId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`epic-replay-visitor:v1:${visitorId}`)
    .digest("base64url");
}

/** The verified visitor id in a cookie value, or null when absent or tampered. */
export function readReplayVisitorId(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const [visitorId, signature, extra] = value.split(".");
  if (!visitorId || !signature || extra !== undefined || !VISITOR_ID.test(visitorId)) return null;
  const expected = Buffer.from(sign(visitorId, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return visitorId;
}

export function mintReplayVisitor(secret: string, secureContext: boolean) {
  const visitorId = randomBytes(32).toString("base64url");
  const attributes = [
    `${REPLAY_VISITOR_COOKIE}=${visitorId}.${sign(visitorId, secret)}`,
    "Path=/api/epic/replay",
    `Max-Age=${MAX_AGE_SECONDS}`,
    "HttpOnly",
    // Matches lib/auth: the Epic preview is served cross-site over HTTPS.
    ...(secureContext ? ["SameSite=None", "Secure", "Partitioned"] : ["SameSite=Lax"]),
  ];
  return { visitorId, setCookie: attributes.join("; ") };
}
