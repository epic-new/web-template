import type { NextRequest } from "next/server";

import { REPLAY_BATCH_HARD_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  readJsonBody,
  replayErrorResponse,
  replayJson,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { UploadReplayBatch } from "./behaviors/upload-replay-batch/upload-replay-batch.service";

/**
 * POST /api/epic/replay/recordings/[recordingId]/batches - relays one ordered
 * batch of redacted rrweb events. The whole streamed request is bounded by
 * Epic's batch limit; the Service checks the augmented request against it
 * again before sending.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_BATCH_HARD_MAX_BYTES);
    const actor = await resolveReplayActor(request, "capture");
    const { recordingId } = await params;
    return replayJson(await UploadReplayBatch.execute({ actor, recordingId, input }));
  } catch (error) {
    return replayErrorResponse(error);
  }
}
