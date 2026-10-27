import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getUser } from "@/lib/auth";

/**
 * Who a request to Epic is made on behalf of. The only part of Epic's
 * integration that cannot leave this app: it needs this app's session and its
 * secret, and Epic must never learn the person's own id. Epic sees a `sub_…`
 * value — an HMAC of the id under this app's secret — and nothing else.
 */

export type EpicAnonymousPurpose = "capture" | "report";
export type EpicSubject = { kind: "user" | "visitor"; id: string };

const SUBJECT_DOMAIN = "epic-replay-subject:v1";
const COOKIE_DOMAIN = "epic-replay-visitor:v1";
export const VISITOR_COOKIE = "epic_replay_visitor";
const VISITOR_COOKIE_PATH = "/api/epic";
const VISITOR_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The purposes a visitor who is not signed in may be recorded or report for,
 * from `EPIC_REPLAY_ANONYMOUS_CAPTURE` / `EPIC_REPLAY_ANONYMOUS_REPORTING`
 * set to `allow`. Off by default: this deployment's owner opts in.
 */
export function anonymousPurposes(): EpicAnonymousPurpose[] {
  return [
    ...(process.env.EPIC_REPLAY_ANONYMOUS_CAPTURE === "allow" ? (["capture"] as const) : []),
    ...(process.env.EPIC_REPLAY_ANONYMOUS_REPORTING === "allow" ? (["report"] as const) : []),
  ];
}

/**
 * The key subjects and visitor cookies are derived under: `EPIC_REPLAY_SECRET`
 * when set, else the auth secret, so the auth secret can rotate without
 * re-keying every subject.
 */
export function identitySecret(): string | null {
  return process.env.EPIC_REPLAY_SECRET || process.env.BETTER_AUTH_SECRET || null;
}

/** The signed-in user, else a visitor with a valid cookie when this deployment allows any anonymous purpose. */
export async function resolveSubject(cookies: { get(name: string): { value: string } | undefined }): Promise<EpicSubject | null> {
  const { user } = await getUser();
  if (user) return { kind: "user", id: user.id };
  if (anonymousPurposes().length === 0) return null;
  const visitorId = verifyVisitorCookie(cookies.get(VISITOR_COOKIE)?.value);
  return visitorId ? { kind: "visitor", id: visitorId } : null;
}

/** What Epic is told: `sub_` and a base64url HMAC-SHA256, stable across token rotation. */
export function pseudonymOf(subject: EpicSubject, secret: string): string {
  const kind = subject.kind === "user" ? "user" : "anonymous";
  return `sub_${createHmac("sha256", secret).update(`${SUBJECT_DOMAIN}:${kind}:${subject.id}`).digest("base64url")}`;
}

export function mintVisitorCookie(secret: string): string {
  const visitorId = randomBytes(32).toString("base64url");
  return `${VISITOR_COOKIE}=${visitorId}.${sign(visitorId, secret)}; ${cookieAttributes(VISITOR_MAX_AGE_SECONDS)}`;
}

export function clearVisitorCookie(): string {
  return `${VISITOR_COOKIE}=; ${cookieAttributes(0)}`;
}

function verifyVisitorCookie(value: string | undefined): string | null {
  const secret = identitySecret();
  if (!value || !secret) return null;
  const [visitorId, signature, extra] = value.split(".");
  if (!visitorId || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(visitorId)) return null;
  const expected = Buffer.from(sign(visitorId, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? visitorId : null;
}

function sign(visitorId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${COOKIE_DOMAIN}:${visitorId}`).digest("base64url");
}

// Follows the auth cookies: an https app may be framed cross-site, which needs
// Secure + SameSite=None + Partitioned; plain http cannot set Secure at all.
function cookieAttributes(maxAge: number): string {
  const secure = (process.env.NEXT_PUBLIC_BASE_URL ?? "").startsWith("https://");
  return [
    `Path=${VISITOR_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    ...(secure ? ["Secure", "SameSite=None", "Partitioned"] : ["SameSite=Lax"]),
  ].join("; ");
}

/** The origins this app's own pages are served from, for the same-origin check. */
export function ownOrigins(request: Request): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin]);
  const configured = originOf(process.env.NEXT_PUBLIC_BASE_URL);
  if (configured) origins.add(configured);
  // Behind a proxy the app listens on a loopback address while the browser's
  // Origin is the public host.
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";
    const forwarded = originOf(`${proto}://${host}`);
    if (forwarded) origins.add(forwarded);
  }
  return origins;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
