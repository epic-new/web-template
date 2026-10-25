import { userAgent, type NextRequest } from "next/server";

import { REPLAY_REGISTRATION_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  NO_STORE,
  readJsonBody,
  replayErrorResponse,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { RegisterReplayRecording } from "./behaviors/register-replay-recording/register-replay-recording.service";

/**
 * POST /api/epic/replay/recordings
 *
 * Registers a recording before any event leaves the browser. Same-origin
 * JSON only, streamed bytes bounded; the actor comes from this application's
 * session or, when the host allows anonymous capture, its protected visitor
 * cookie (minted here and only here). 201 new, 200 idempotent retry.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_REGISTRATION_MAX_BYTES);
    const { actor, setCookie } = await resolveReplayActor(request, { mint: true });
    const result = await RegisterReplayRecording.execute({ actor, input, userAgent: userAgent(request) });

    const response = Response.json(result.recording, { status: result.created ? 201 : 200, headers: NO_STORE });
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  } catch (error) {
    return replayErrorResponse(error, "replay-register");
  }
}
