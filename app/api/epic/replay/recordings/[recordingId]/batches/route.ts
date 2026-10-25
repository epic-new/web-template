import type { NextRequest } from "next/server";

import { REPLAY_RECORDING_LIMITS } from "@/lib/replay/replay-config.contract";
import {
  assertSameOrigin,
  NO_STORE,
  readJsonBody,
  replayErrorResponse,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { UploadReplayBatch } from "./behaviors/upload-replay-batch/upload-replay-batch.service";

/**
 * POST /api/epic/replay/recordings/[recordingId]/batches
 *
 * Relays one frozen batch. The complete UTF-8 JSON request is bounded by
 * `maxBatchBytes` as streamed (whatever Content-Length says); the Service
 * re-checks the augmented central body against the same limit.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ recordingId: string }> }) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_RECORDING_LIMITS.maxBatchBytes);
    const { actor } = await resolveReplayActor(request);
    const { recordingId } = await params;
    const ack = await UploadReplayBatch.execute({ actor, recordingId, input });
    return Response.json(ack, { status: 200, headers: NO_STORE });
  } catch (error) {
    return replayErrorResponse(error, "replay-batch");
  }
}
