import type { NextRequest } from "next/server";

import { REPLAY_CAPABILITY_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  NO_STORE,
  readJsonBody,
  replayErrorResponse,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { RenewReplayCapability } from "./behaviors/renew-replay-capability/renew-replay-capability.service";

/**
 * POST /api/epic/replay/recordings/[recordingId]/capability
 *
 * Renews the upload capability of the current subject's own recording.
 * Never mints a visitor cookie.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ recordingId: string }> }) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_CAPABILITY_MAX_BYTES);
    const { actor } = await resolveReplayActor(request);
    const { recordingId } = await params;
    const capability = await RenewReplayCapability.execute({ actor, recordingId, input });
    return Response.json(capability, { status: 200, headers: NO_STORE });
  } catch (error) {
    return replayErrorResponse(error, "replay-capability");
  }
}
