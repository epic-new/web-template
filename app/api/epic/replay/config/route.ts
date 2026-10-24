import { disabledReplayConfig } from "@/lib/replay/replay-config.contract";
import { ReadReplayConfig } from "./behaviors/read-replay-config/read-replay-config.service";

/**
 * GET /api/epic/replay/config
 *
 * The public, allowlisted replay policy for this deployment. No session is
 * required: signed-out pages are subject to the policy too. The handler takes
 * no `request`, so query, body, headers and cookies can never reach scope.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    return Response.json(await ReadReplayConfig.execute(), {
      status: 200,
      headers: NO_STORE,
    });
  } catch {
    console.warn("[replay-config]", "upstream_unavailable");
    return Response.json(
      disabledReplayConfig({
        reason: "upstream_unavailable",
        environment: null,
        release: null,
        now: Date.now(),
      }),
      { status: 200, headers: NO_STORE },
    );
  }
}
