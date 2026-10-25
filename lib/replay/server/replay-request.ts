import "server-only";

import { replaySecret } from "@/lib/replay/server/replay-subject";
import type { NextRequest } from "next/server";

import { getUser } from "@/lib/auth";
import { ReplayUploadError } from "./replay-upload-error";
import { type ReplayActor } from "./replay-subject";
import { REPLAY_VISITOR_COOKIE, verifyReplayVisitorCookie } from "./replay-visitor-cookie";

export type ReplayIdentityPurpose = "capture" | "report";

const NO_STORE = { "Cache-Control": "no-store" };

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function allowedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>();
  const configured = originOf(process.env.NEXT_PUBLIC_BASE_URL);
  if (configured) origins.add(configured);
  origins.add(request.nextUrl.origin);

  // Behind the Epic proxy the app listens on a loopback address while the
  // browser's Origin is the public preview host.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? request.nextUrl.protocol.replace(":", "");
    const forwarded = originOf(`${proto}://${host.split(",")[0]!.trim()}`);
    if (forwarded) origins.add(forwarded);
  }
  return origins;
}

/** Rejects a write that is not from this application's own pages. */
export function assertSameOrigin(request: NextRequest): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ReplayUploadError("cross_origin");
  }
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(request).has(originOf(origin) ?? "")) {
    throw new ReplayUploadError("cross_origin");
  }
}

/**
 * Reads a JSON request body, counting the bytes actually streamed rather than
 * trusting `Content-Length`, and cancels the stream the moment it overruns.
 */
export async function readJsonBody(request: NextRequest, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || request.headers.has("content-encoding")) {
    throw new ReplayUploadError("unsupported_media_type");
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new ReplayUploadError("payload_too_large");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new ReplayUploadError("invalid_request", { status: 400 });

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ReplayUploadError("payload_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReplayUploadError("invalid_request", { status: 400 });
  }
}

/** Default off: the host must opt in per purpose. */
export function isAnonymousReplayAllowed(purpose: ReplayIdentityPurpose): boolean {
  const flag =
    purpose === "capture"
      ? process.env.EPIC_REPLAY_ANONYMOUS_CAPTURE
      : process.env.EPIC_REPLAY_ANONYMOUS_REPORTING;
  return flag === "allow";
}

/** The signed-in user, from the template's own session. */
export async function resolveReplayUser(): Promise<{ userId: string } | null> {
  const { user } = await getUser();
  return user ? { userId: user.id } : null;
}

/** The acknowledged visitor of a correctly signed cookie; never mints one. */
export function resolveReplayVisitor(request: NextRequest): string | null {
  const secret = replaySecret();
  if (!secret) return null;
  return verifyReplayVisitorCookie(request.cookies.get(REPLAY_VISITOR_COOKIE)?.value, secret);
}

/**
 * The trusted actor for a request: the signed-in user, else an acknowledged
 * visitor when the host allows anonymous replay for this purpose.
 */
export async function resolveReplayActor(
  request: NextRequest,
  purpose: ReplayIdentityPurpose,
): Promise<ReplayActor | null> {
  const user = await resolveReplayUser();
  if (user) return { kind: "user", userId: user.userId };
  if (!isAnonymousReplayAllowed(purpose)) return null;
  const visitorId = resolveReplayVisitor(request);
  return visitorId ? { kind: "anonymous", visitorId } : null;
}

export function replayJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** The flat, no-store error envelope with `Retry-After` in whole seconds. */
export function replayErrorResponse(error: unknown): Response {
  if (error instanceof ReplayUploadError) {
    const retryAfterMs = error.extras.retryAfterMs;
    return replayJson(
      error.toBody(),
      error.status,
      retryAfterMs ? { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } : {},
    );
  }
  console.warn("[replay-upload]", "unexpected_failure");
  return replayErrorResponse(new ReplayUploadError("unavailable"));
}
