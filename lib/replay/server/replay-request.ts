import "server-only";

import type { NextRequest } from "next/server";

import { getUser } from "@/lib/auth";
import { ReplayUploadError } from "@/lib/replay/replay-upload-contract";
import { mintReplayVisitor, readReplayVisitorId, REPLAY_VISITOR_COOKIE } from "./replay-visitor-cookie";
import type { ReplayActor } from "./replay-subject";

/**
 * Transport protections shared by the replay upload routes: same-origin
 * writes, JSON only, byte limits enforced on what is actually streamed, and
 * actor resolution from the application's own authentication.
 */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

function baseOrigin(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_BASE_URL ?? "").origin;
  } catch {
    return null;
  }
}

/** Throws `cross_origin` unless the write comes from this application's origin. */
export function assertSameOrigin(request: NextRequest): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new ReplayUploadError("cross_origin");
  const origin = request.headers.get("origin");
  if (!origin) throw new ReplayUploadError("cross_origin");
  const allowed = new Set([request.nextUrl.origin, baseOrigin()].filter(Boolean));
  if (!allowed.has(origin)) throw new ReplayUploadError("cross_origin");
}

/**
 * Reads the JSON body, counting the bytes actually received and stopping past
 * `maxBytes` whatever `Content-Length` claims.
 */
export async function readJsonBody(request: NextRequest, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    throw new ReplayUploadError("unsupported_media_type");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ReplayUploadError("payload_too_large");
  if (!request.body) throw ReplayUploadError.malformed();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      throw ReplayUploadError.malformed();
    }
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ReplayUploadError("payload_too_large");
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw ReplayUploadError.malformed();
  }
}

export function anonymousCaptureAllowed(): boolean {
  return process.env.EPIC_REPLAY_ANONYMOUS_CAPTURE === "allow";
}

/**
 * The signed-in user, else the verified anonymous visitor when the host allows
 * anonymous capture. Only the identity bootstrap may mint a cookie; registration
 * requires it already, so a lost registration response cannot change its subject.
 */
export async function resolveReplayActor(
  request: NextRequest,
  { mint = false }: { mint?: boolean } = {},
): Promise<{ actor: ReplayActor | null; setCookie: string | null }> {
  const { user } = await getUser();
  if (user) return { actor: { kind: "user", userId: user.id }, setCookie: null };

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!anonymousCaptureAllowed() || !secret || secret.length < 32) return { actor: null, setCookie: null };

  const visitorId = readReplayVisitorId(request.cookies.get(REPLAY_VISITOR_COOKIE)?.value, secret);
  if (visitorId) return { actor: { kind: "anonymous", visitorId }, setCookie: null };
  if (!mint) return { actor: null, setCookie: null };

  const secure = (process.env.NEXT_PUBLIC_BASE_URL ?? "").startsWith("https://");
  const minted = mintReplayVisitor(secret, secure);
  return { actor: { kind: "anonymous", visitorId: minted.visitorId }, setCookie: minted.setCookie };
}

/**
 * The flat, no-store v1 error response for a failure, with `Retry-After` in
 * whole seconds when the error carries `retryAfterMs`. Unknown errors never
 * leak detail: they answer 503 `unavailable`.
 */
export function replayErrorResponse(error: unknown, label: string): Response {
  const known = error instanceof ReplayUploadError ? error : new ReplayUploadError("unavailable");
  if (!(error instanceof ReplayUploadError)) console.warn(`[${label}]`, "unexpected_error");
  return Response.json(known.toBody(), { status: known.status, headers: known.headers() });
}
