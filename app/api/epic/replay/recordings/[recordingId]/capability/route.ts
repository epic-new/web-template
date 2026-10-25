import type { NextRequest } from "next/server";

import { REPLAY_CAPABILITY_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  readJsonBody,
  replayErrorResponse,
  replayJson,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { RenewReplayCapability } from "./behaviors/renew-replay-capability/renew-replay-capability.service";

/**
 * POST /api/epic/replay/recordings/[recordingId]/capability - renews the
 * upload capability of a recording this server registered. Never mints an
 * identity cookie.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_CAPABILITY_MAX_BYTES);
    const actor = await resolveReplayActor(request, "capture");
    const { recordingId } = await params;
    return replayJson(await RenewReplayCapability.execute({ actor, recordingId, input }));
  } catch (error) {
    return replayErrorResponse(error);
  }
}
