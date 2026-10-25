import type { NextRequest } from "next/server";

import { replaySecret } from "@/lib/replay/server/replay-subject";
import { REPLAY_IDENTITY_MAX_BYTES, REPLAY_UPLOAD_CONTRACT_VERSION } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  readJsonBody,
  replayErrorResponse,
  replayJson,
  resolveReplayUser,
  resolveReplayVisitor,
} from "@/lib/replay/server/replay-request";
import {
  mintReplayVisitorId,
  replayVisitorClearCookie,
  replayVisitorSetCookie,
} from "@/lib/replay/server/replay-visitor-cookie";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { AcknowledgeReplayIdentity } from "./behaviors/acknowledge-replay-identity/acknowledge-replay-identity.service";

/**
 * POST /api/epic/replay/identity - acknowledges the identity a recording or
 * anonymous report will be attributed to, minting the protected visitor
 * cookie when the host allows anonymous replay. DELETE clears that cookie at
 * an account change. Neither calls Epic.
 */
export const dynamic = "force-dynamic";

const ACK = { contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION };

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_IDENTITY_MAX_BYTES);
    const { mintVisitor } = await AcknowledgeReplayIdentity.execute({
      user: await resolveReplayUser(),
      visitorId: resolveReplayVisitor(request),
      clientAddress: clientAddress(request),
      input,
    });

    const secret = replaySecret()!;
    return replayJson(
      ACK,
      200,
      mintVisitor ? { "Set-Cookie": replayVisitorSetCookie(mintReplayVisitorId(), secret) } : {},
    );
  } catch (error) {
    return replayErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_IDENTITY_MAX_BYTES);
    if (JSON.stringify(input) !== JSON.stringify(ACK)) {
      throw new ReplayUploadError("invalid_request", { status: 400 });
    }
    return replayJson(ACK, 200, { "Set-Cookie": replayVisitorClearCookie() });
  } catch (error) {
    return replayErrorResponse(error);
  }
}

/**
 * The address the platform saw, not one the client wrote: the platform's own
 * header first, then the hop the nearest proxy appended (the rightmost
 * `x-forwarded-for` entry) — the first entry is whatever the client sent.
 */
function clientAddress(request: NextRequest): string | null {
  const platform = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-real-ip");
  if (platform) return platform.split(",")[0]!.trim();
  const hops = request.headers.get("x-forwarded-for")?.split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops?.at(-1) ?? null;
}
