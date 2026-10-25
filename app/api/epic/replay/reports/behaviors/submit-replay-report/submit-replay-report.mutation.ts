import {
  REPLAY_UPLOAD_CONTRACT_VERSION,
  replayIdentityResponseSchema,
  replayReportResponseSchema,
  replayUploadErrorBodySchema,
  type ReplayReportRequest,
  type ReplayReportResponse,
  type ReplayUploadErrorCode,
} from "@/lib/replay/replay-upload-contract";

const BASE_URL = "/api/epic/replay";

/** A failed submission, by the relay's stable code; the text is never parsed. */
export class ReplayReportError extends Error {
  constructor(
    readonly code: ReplayUploadErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "ReplayReportError";
  }
}

async function post<T>(
  path: string,
  body: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ReplayReportError("unavailable");
  }

  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ReplayReportError("unavailable");
    return parsed.data;
  }
  const error = replayUploadErrorBodySchema.safeParse(json);
  throw error.success
    ? new ReplayReportError(error.data.code, error.data.retryAfterMs)
    : new ReplayReportError("unavailable");
}

/**
 * Sends one frozen report: the identity handshake for reporting, then the
 * report itself. The same request, key included, may be sent again after any
 * failure; Epic's idempotency decides whether it already exists.
 */
export async function submitReplayReport(request: ReplayReportRequest): Promise<ReplayReportResponse> {
  await post(
    "/identity",
    { contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION, purpose: "report" },
    replayIdentityResponseSchema,
  );
  return post("/reports", request, replayReportResponseSchema);
}
