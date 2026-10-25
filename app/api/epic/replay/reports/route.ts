import type { NextRequest } from "next/server";

import { REPLAY_REPORT_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  readJsonBody,
  replayErrorResponse,
  replayJson,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { SubmitReplayReport } from "./behaviors/submit-replay-report/submit-replay-report.service";

/**
 * POST /api/epic/replay/reports - relays a bug report to Epic. It does not
 * depend on capture: a report with no recording is valid, and anonymous
 * reporting is its own host switch.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_REPORT_MAX_BYTES);
    const actor = await resolveReplayActor(request, "report");
    const { created, report } = await SubmitReplayReport.execute({ actor, input });
    return replayJson(report, created ? 201 : 200);
  } catch (error) {
    return replayErrorResponse(error);
  }
}
