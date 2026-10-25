import { userAgent, type NextRequest } from "next/server";

import { REPLAY_TELEMETRY_MAX_BYTES } from "@/lib/replay/replay-upload-contract";
import {
  assertSameOrigin,
  readJsonBody,
  replayErrorResponse,
  replayJson,
  resolveReplayActor,
} from "@/lib/replay/server/replay-request";
import { RelayReplayTelemetry } from "./behaviors/relay-replay-telemetry/relay-replay-telemetry.service";

/**
 * POST /api/epic/replay/telemetry - relays a browser's OTLP/JSON logs (rrweb
 * events and behavior evidence) to Epic's ingest. The browser never holds the
 * publishing credential and never says whose telemetry it is: the visitor
 * comes from the session or the signed visitor cookie.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJsonBody(request, REPLAY_TELEMETRY_MAX_BYTES);
    const actor = await resolveReplayActor(request, "capture");
    await RelayReplayTelemetry.execute({ actor, input, userAgent: userAgent(request) });
    return replayJson({ partialSuccess: {} });
  } catch (error) {
    return replayErrorResponse(error);
  }
}
