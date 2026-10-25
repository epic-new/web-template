import type { NextRequest } from "next/server";

import { parseReplayRequest, replayIdentityRequestSchema, ReplayUploadError } from "@/lib/replay/replay-upload-contract";
import { assertSameOrigin, NO_STORE, readJsonBody, replayErrorResponse, resolveReplayActor } from "@/lib/replay/server/replay-request";
import { clearReplayVisitorCookie } from "@/lib/replay/server/replay-visitor-cookie";

export const dynamic = "force-dynamic";

/** Establishes only the host identity; no recording or central request is created. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    parseReplayRequest(replayIdentityRequestSchema, await readJsonBody(request, 1_024));
    const { actor, setCookie } = await resolveReplayActor(request, { mint: true });
    if (!actor) throw new ReplayUploadError("identity_required");
    const response = Response.json({ contractVersion: 1 }, { headers: NO_STORE });
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  } catch (error) {
    return replayErrorResponse(error, "replay-identity");
  }
}

/** The provider uses this acknowledged reset before a new anonymous account boundary. */
export async function DELETE(request: NextRequest) {
  try {
    assertSameOrigin(request);
    parseReplayRequest(replayIdentityRequestSchema, await readJsonBody(request, 1_024));
    return Response.json({ contractVersion: 1 }, {
      headers: {
        ...NO_STORE,
        "Set-Cookie": clearReplayVisitorCookie((process.env.NEXT_PUBLIC_BASE_URL ?? "").startsWith("https://")),
      },
    });
  } catch (error) {
    return replayErrorResponse(error, "replay-identity-reset");
  }
}
