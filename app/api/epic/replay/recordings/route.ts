import { userAgent, type NextRequest } from "next/server";

import { REPLAY_REGISTRATION_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  readJsonBody,
  replayErrorResponse,
  replayJson,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { RegisterReplayRecording } from "./behaviors/register-replay-recording/register-replay-recording.service";

/**
 * POST /api/epic/replay/recordings - registers a recording with Epic for the
 * current trusted subject and returns Epic's recording id and a narrow upload
 * capability. Ownership never comes from the body.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_REGISTRATION_MAX_BYTES);
    const actor = await resolveReplayActor(request, "capture");
    const { created, registration } = await RegisterReplayRecording.execute({
      actor,
      input,
      userAgent: userAgent(request),
    });
    return replayJson(registration, created ? 201 : 200);
  } catch (error) {
    return replayErrorResponse(error);
  }
}
