import "server-only";

import { createHmac, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

import { getUser } from "@/lib/auth";

/**
 * The app's one door to Epic, and all of Epic that lives in this app besides
 * `instrumentation.ts` and the script tag in the root layout. Epic's runtime
 * in the page calls `/api/epic/<path>`; this forwards the request to Epic with
 * the app's publishing token and a pseudonym of the person, and hands back
 * Epic's answer. It knows no endpoint, header or policy of Epic's, so nothing
 * Epic adds or changes needs an edit here.
 *
 * Epic never learns who the person is: it sees `sub_` and an HMAC of their id
 * under this app's secret. A visitor who is not signed in is named by a random
 * id in an HttpOnly cookie, set only when the runtime asks (`x-epic-visitor:
 * mint`), which it does only where the environment records or takes reports
 * from visitors. Nothing that locates the person — cookies, the address, the
 * platform's own headers — is forwarded, the country aside.
 *
 * Unconfigured (no `EPIC_API_URL` or `EPIC_PUBLISHING_TOKEN`), every call
 * answers 503 and the app works as if Epic did not exist.
 */
export const dynamic = "force-dynamic";

/** The one line that knows this app: who is signed in, or nobody. */
const currentUserId = async () => (await getUser()).user?.id ?? null;

const VISITOR_COOKIE = "epic_replay_visitor";
// The session, credentials, connection details and the address never leave.
// Platform headers (`x-…`, `cf-…`) can carry tokens or the address, so of
// those only the country goes on.
const WITHHELD =
  /^(cookie|authorization|proxy-|host$|connection$|keep-alive$|te$|trailer$|transfer-encoding$|upgrade$|content-length$|forwarded$|via$|true-client-ip$|x-|cf-|cdn-|cloudfront-|fastly-|akamai-|fly-)/;
const COUNTRY = new Set(["x-vercel-ip-country", "cf-ipcountry", "cloudfront-viewer-country"]);
// `fetch` has already decoded the body, so its encoding and length no longer apply.
const NOT_RELAYED = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"]);

type Params = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, { params }: Params): Promise<Response> {
  const apiUrl = process.env.EPIC_API_URL;
  const token = process.env.EPIC_PUBLISHING_TOKEN;
  const secret = process.env.EPIC_REPLAY_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!apiUrl || !token || !secret) return failure("not_configured", 503);
  if (request.method !== "GET" && request.headers.get("sec-fetch-site") !== "same-origin") {
    return failure("cross_origin", 403);
  }

  const headers = new Headers({ authorization: `Bearer ${token}`, "x-epic-pipe": "2" });
  request.headers.forEach((value, name) => {
    if (name === "content-type" || name === "content-encoding") headers.set(name, value);
    else if (!WITHHELD.test(name) || COUNTRY.has(name)) headers.set(`x-epic-fwd-${name}`, value);
  });
  const release = process.env.EPIC_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
  if (release) headers.set("x-epic-release", release);
  const bypass = process.env.EPIC_VERCEL_PROTECTION_BYPASS;
  if (bypass) headers.set("x-vercel-protection-bypass", bypass);

  const userId = await currentUserId();
  let visitorId = userId ? null : (request.cookies.get(VISITOR_COOKIE)?.value.match(/^[\w-]{43}$/)?.[0] ?? null);
  const minted = !userId && !visitorId && request.headers.get("x-epic-visitor") === "mint";
  if (minted) visitorId = randomBytes(32).toString("base64url");
  const subject = userId ? `user:${userId}` : visitorId ? `anonymous:${visitorId}` : null;
  if (subject) {
    const digest = createHmac("sha256", secret).update(`epic-replay-subject:v1:${subject}`).digest("base64url");
    headers.set("x-epic-subject", `sub_${digest}`);
    headers.set("x-epic-subject-kind", userId ? "user" : "visitor");
  }

  let response: Response;
  try {
    const path = (await params).path.map(encodeURIComponent).join("/");
    response = await fetch(new URL(`/api/replay/v1/relay/${path}`, apiUrl), {
      method: request.method,
      headers,
      ...(request.body ? { body: request.body, duplex: "half" } : {}),
      // The token must never follow a redirect to another host.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
  } catch {
    return failure("unavailable", 503);
  }

  const relayed = new Headers({ "cache-control": "no-store" });
  response.headers.forEach((value, name) => {
    if (!NOT_RELAYED.has(name)) relayed.set(name, value);
  });
  if (minted && visitorId) relayed.set("set-cookie", visitorCookie(visitorId));
  return new Response(response.body, { status: response.status, headers: relayed });
}

// Follows the auth cookies: an https app may be framed cross-site, which needs
// Secure + SameSite=None + Partitioned; plain http cannot set Secure at all.
function visitorCookie(visitorId: string): string {
  const secure = (process.env.NEXT_PUBLIC_BASE_URL ?? "").startsWith("https://");
  const attributes = secure ? "Secure; SameSite=None; Partitioned" : "SameSite=Lax";
  return `${VISITOR_COOKIE}=${visitorId}; Path=/api/epic; Max-Age=2592000; HttpOnly; ${attributes}`;
}

function failure(code: string, status: number): Response {
  return Response.json({ error: code, code }, { status, headers: { "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
