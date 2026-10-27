import "server-only";

import {
  anonymousPurposes,
  clearVisitorCookie,
  identitySecret,
  mintVisitorCookie,
  ownOrigins,
  pseudonymOf,
  resolveSubject,
} from "./identity";

/**
 * The app's pipe to Epic. Its pages call `/api/epic/<path>`; everything but
 * `identity` is forwarded as received to Epic's relay namespace, with this
 * app's publishing token and the visitor's pseudonym, and Epic decides what
 * the path means and what the request may carry. Nothing here knows which
 * endpoints Epic has, so a new one needs no change to this file.
 *
 * Unconfigured (no `EPIC_API_URL` or `EPIC_PUBLISHING_TOKEN`), every call
 * answers 503 `not_configured` and the app works as if Epic did not exist.
 */

/** Under Vercel's 4.5 MB request ceiling; Epic bounds what it accepts itself. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const FORWARDED_HEADERS = ["content-type", "content-encoding"];
const RELAYED_RESPONSE_HEADERS = ["content-type", "retry-after"];

type Cookies = { get(name: string): { value: string } | undefined };

export async function relayToEpic(request: Request, path: string[], cookies: Cookies): Promise<Response> {
  if (request.method !== "GET" && !isSameOrigin(request)) return failure("cross_origin", 403);
  if (path.join("/") === "identity") return identity(request, cookies);

  const apiUrl = process.env.EPIC_API_URL;
  const token = process.env.EPIC_PUBLISHING_TOKEN;
  const secret = identitySecret();
  if (!apiUrl || !token || !secret) return failure("not_configured", 503);

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return failure("payload_too_large", 413);

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const subject = await resolveSubject(cookies);
  if (subject) {
    headers.set("x-epic-subject", pseudonymOf(subject, secret));
    headers.set("x-epic-subject-kind", subject.kind);
  }
  const anonymous = anonymousPurposes();
  if (anonymous.length > 0) headers.set("x-epic-anonymous", anonymous.join(","));
  headers.set("x-epic-user-agent", request.headers.get("user-agent") ?? "");
  const release = process.env.EPIC_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
  if (release) headers.set("x-epic-release", release);
  const bypass = process.env.EPIC_VERCEL_PROTECTION_BYPASS;
  if (bypass) headers.set("x-vercel-protection-bypass", bypass);

  const upstream = new URL(`/api/replay/v1/relay/${path.map(encodeURIComponent).join("/")}`, apiUrl);
  let response: Response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      ...(request.body ? { body: bounded(request.body, MAX_BODY_BYTES), duplex: "half" } : {}),
      // The token must never follow a redirect to another host.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    } as RequestInit);
  } catch (error) {
    if (error instanceof BodyTooLargeError || (error as { cause?: unknown })?.cause instanceof BodyTooLargeError) {
      return failure("payload_too_large", 413);
    }
    return failure("unavailable", 503);
  }

  const relayed = new Headers({ "cache-control": "no-store" });
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) relayed.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: relayed });
}

/**
 * Who the page's requests will be attributed to, minting a visitor cookie when
 * this deployment allows anonymous recording or reporting and none is set.
 * DELETE forgets the visitor, at an account change.
 */
async function identity(request: Request, cookies: Cookies): Promise<Response> {
  const anonymous = anonymousPurposes();
  if (request.method === "DELETE") return json({ contractVersion: 1, kind: null, anonymous }, { "set-cookie": clearVisitorCookie() });
  if (request.method !== "POST") return failure("not_found", 404);

  const subject = await resolveSubject(cookies);
  if (subject) return json({ contractVersion: 1, kind: subject.kind, anonymous });

  const secret = identitySecret();
  if (anonymous.length === 0 || !secret) return json({ contractVersion: 1, kind: null, anonymous });
  return json({ contractVersion: 1, kind: "visitor", anonymous }, { "set-cookie": mintVisitorCookie(secret) });
}

function isSameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return ownOrigins(request).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

class BodyTooLargeError extends Error {}

/** The body as it streams, aborted the moment it passes the cap rather than trusting `Content-Length`. */
function bounded(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) controller.error(new BodyTooLargeError());
        else controller.enqueue(chunk);
      },
    }),
  );
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { headers: { "cache-control": "no-store", ...headers } });
}

function failure(code: string, status: number): Response {
  return Response.json({ contractVersion: 1, error: code, code }, { status, headers: { "cache-control": "no-store" } });
}
