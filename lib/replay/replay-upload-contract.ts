import { z } from "zod";

/**
 * The browser-facing contract of this application's own replay routes,
 * shared by their Services and the browser transport. Browser-safe on
 * purpose: no `server-only`, no Node APIs.
 *
 * Telemetry is OTLP/JSON posted to `/api/epic/replay/telemetry`; the reports
 * and identity routes keep their own small envelopes. Every schema the
 * browser can reach is `.strict()`, so an ownership field (`subjectId`, a
 * project id...) can never ride along.
 */

export const REPLAY_UPLOAD_CONTRACT_VERSION = 1;

export const REPLAY_IDENTITY_MAX_BYTES = 1_024;
// Event bytes are capped by the policy's `maxBatchBytes` (1 MiB); a JSON string
// escapes quotes, and each record carries its attributes, so the request body
// may be a few times larger. Epic's own ceiling is 4 MiB.
export const REPLAY_TELEMETRY_MAX_BYTES = 3 * 1_024 * 1_024;
// Epic refuses more records than this in one request.
export const REPLAY_TELEMETRY_MAX_RECORDS = 5_000;
export const REPLAY_REPORT_MAX_BYTES = 65_536;

export const REPLAY_REPORT_TEXT_MAX = 5_000;

/** Codes Epic's publishing routes return. Exact case matters. */
export const REPLAY_PUBLISHING_ERROR_CODES = [
  "REPLAY_CREDENTIAL_INVALID",
  "capture_disabled",
  "reporting_disabled",
  "idempotency_conflict",
  "payload_too_large",
  "unsupported_media_type",
  "invalid_request",
  "invalid_evidence",
  "rate_limited",
  "unavailable",
] as const;
export type ReplayPublishingErrorCode = (typeof REPLAY_PUBLISHING_ERROR_CODES)[number];

/** Codes only this application's relay produces, in the same flat envelope. */
export const REPLAY_RELAY_ERROR_CODES = ["cross_origin", "identity_required", "not_configured"] as const;
export type ReplayRelayErrorCode = (typeof REPLAY_RELAY_ERROR_CODES)[number];

export type ReplayUploadErrorCode = ReplayPublishingErrorCode | ReplayRelayErrorCode;

export const REPLAY_UPLOAD_ERROR_CODES: readonly ReplayUploadErrorCode[] = [
  ...REPLAY_PUBLISHING_ERROR_CODES,
  ...REPLAY_RELAY_ERROR_CODES,
];

export const REPLAY_UPLOAD_ERROR_STATUS: Record<ReplayUploadErrorCode, number> = {
  REPLAY_CREDENTIAL_INVALID: 401,
  capture_disabled: 403,
  reporting_disabled: 403,
  idempotency_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_request: 422,
  invalid_evidence: 422,
  rate_limited: 429,
  unavailable: 503,
  cross_origin: 403,
  identity_required: 401,
  not_configured: 503,
};

// Fixed, sanitized text. Clients branch on `code`, never on this.
export const REPLAY_UPLOAD_ERROR_MESSAGES: Record<ReplayUploadErrorCode, string> = {
  REPLAY_CREDENTIAL_INVALID: "The publishing credential was rejected.",
  capture_disabled: "Replay capture is disabled.",
  reporting_disabled: "Problem reports are disabled.",
  idempotency_conflict: "The same key was used for different content.",
  payload_too_large: "The request is too large.",
  unsupported_media_type: "Send the request as application/json.",
  invalid_request: "The request is not valid.",
  invalid_evidence: "The session reference is not valid.",
  rate_limited: "Too many requests.",
  unavailable: "Replay is temporarily unavailable.",
  cross_origin: "Cross-origin requests are not accepted.",
  identity_required: "A signed-in or acknowledged visitor identity is required.",
  not_configured: "Replay is not configured on this server.",
};

export interface ReplayUploadErrorBody {
  contractVersion: 1;
  error: string;
  code: ReplayUploadErrorCode;
  retryAfterMs?: number;
}

export const replayUploadErrorBodySchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    error: z.string(),
    code: z.enum([...REPLAY_PUBLISHING_ERROR_CODES, ...REPLAY_RELAY_ERROR_CODES]),
    retryAfterMs: z.number().int().positive().optional(),
  })
  .strict();

/** Central publishing errors never carry relay-only codes. */
export const replayPublishingErrorBodySchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    error: z.string(),
    code: z.enum(REPLAY_PUBLISHING_ERROR_CODES),
    retryAfterMs: z.number().int().positive().optional(),
  })
  .strict();

const uuidSchema = z.string().uuid();
const epochMsSchema = z.number().int().nonnegative();

export const REPLAY_RELEASE_PATTERN = /^[A-Za-z0-9._+\-/]{1,128}$/;
export const releaseSchema = z.string().regex(REPLAY_RELEASE_PATTERN).nullable();

/** ClickStack's browser session id: 32 lowercase hex characters. */
export const REPLAY_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:\-]{1,128}$/;

export const replayIdentityRequestSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    purpose: z.enum(["capture", "report"]).optional(),
  })
  .strict();
export type ReplayIdentityRequest = z.infer<typeof replayIdentityRequestSchema>;

export const replayIdentityResponseSchema = z
  .object({ contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION) })
  .strict();

const reportTextSchema = z.string().max(REPLAY_REPORT_TEXT_MAX);

export const replayReportEvidenceSchema = z
  .object({
    sessionId: z.string().regex(REPLAY_SESSION_ID_PATTERN),
    startedAt: epochMsSchema,
    offsetMs: epochMsSchema,
    traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    behaviorId: z.string().regex(OPAQUE_ID_PATTERN).optional(),
    occurrenceId: z.string().regex(OPAQUE_ID_PATTERN).optional(),
  })
  .strict();
export type ReplayReportEvidence = z.infer<typeof replayReportEvidenceSchema>;

export const REPLAY_REPORT_ROUTE_MAX = 2_048;

/** What the browser sends; the relay adds the trusted `subjectId`. */
export const replayReportRequestSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    idempotencyKey: uuidSchema,
    reportedAt: epochMsSchema,
    route: z
      .string()
      .max(REPLAY_REPORT_ROUTE_MAX)
      .regex(/^\/(?!\/)[^?#\u0000-\u001f\u007f\s`<>[\]{}"\\^|]*$/, "Expected a pathname"),
    release: releaseSchema,
    evidence: replayReportEvidenceSchema.nullable(),
    description: reportTextSchema.transform((value) => value.trim()).pipe(z.string().min(1)),
    expected: reportTextSchema.transform((value) => value.trim()).optional(),
  })
  .strict();
export type ReplayReportRequest = z.input<typeof replayReportRequestSchema>;

export const REPLAY_REPORT_EVIDENCE_STATES = [
  "absent",
  "pending",
  "playable",
  "incomplete",
  "unsampled",
  "unavailable",
  "expired",
  "deleted",
] as const;

export const replayReportResponseSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    reportId: uuidSchema,
    receivedAt: epochMsSchema,
    replayed: z.boolean(),
    evidence: z.object({ state: z.enum(REPLAY_REPORT_EVIDENCE_STATES) }).strict(),
  })
  .strict();
export type ReplayReportResponse = z.infer<typeof replayReportResponseSchema>;

/**
 * Strips the query and fragment: only a pathname is ever reported. Characters
 * a browser would have percent-encoded are encoded here too, since Epic
 * refuses them raw (they would break out of the markdown it quotes routes in).
 */
export function toReplayPathname(input: string): string | null {
  const path = (input.split(/[?#]/, 1)[0] ?? "").replace(/[\s`<>[\]{}"\\^|]/g, (char) => encodeURIComponent(char));
  return /^\/(?!\/)[^\u0000-\u001f\u007f]*$/.test(path) ? path : null;
}
