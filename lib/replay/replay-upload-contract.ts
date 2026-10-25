import { z } from "zod";

import { replayRecordingLimitsSchema } from "./replay-config.contract";

/**
 * The browser-facing upload contract (version 1), shared by the same-origin
 * routes, their Services and the browser transport. Browser-safe on purpose:
 * no `server-only`, no Node APIs.
 *
 * Every schema the browser can reach is `.strict()`, so an ownership field
 * (`subjectId`, `projectId`, a Cloud UUID...) can never ride along.
 */

export const REPLAY_UPLOAD_CONTRACT_VERSION = 1;

// A test asserts this equals the installed `@rrweb/record` version.
export const REPLAY_RECORDER_VERSION = "2.2.0";

export const REPLAY_IDENTITY_MAX_BYTES = 1_024;
export const REPLAY_REGISTRATION_MAX_BYTES = 8_192;
export const REPLAY_CAPABILITY_MAX_BYTES = 1_024;
export const REPLAY_REPORT_MAX_BYTES = 65_536;

export const REPLAY_BATCH_MAX_EVENTS = 500;
export const REPLAY_BATCH_HARD_MAX_BYTES = 1_048_576;

// What the relay adds to a batch before it reaches Epic: `,"subjectId":"sub_…"`
// is about 64 bytes, so the browser packs against a bounded allowance.
export const REPLAY_SUBJECT_ENVELOPE_ALLOWANCE_BYTES = 128;

export const REPLAY_REPORT_TEXT_MAX = 5_000;

export const REPLAY_AVAILABILITIES = [
  "waiting_for_events",
  "events_received",
  "playable",
  "incomplete",
  "unavailable",
  "expired",
  "deleted",
] as const;
export type ReplayAvailability = (typeof REPLAY_AVAILABILITIES)[number];

/** Codes Epic's publishing routes return (EPI-210/211). Exact case matters. */
export const REPLAY_PUBLISHING_ERROR_CODES = [
  "REPLAY_CREDENTIAL_INVALID",
  "capability_expired",
  "invalid_capability",
  "subject_mismatch",
  "capture_disabled",
  "reporting_disabled",
  "recording_not_found",
  "idempotency_conflict",
  "recording_closed",
  "payload_too_large",
  "invalid_request",
  "invalid_evidence",
  "rate_limited",
  "unavailable",
] as const;
export type ReplayPublishingErrorCode = (typeof REPLAY_PUBLISHING_ERROR_CODES)[number];

/** Codes only this application's relay produces, in the same flat envelope. */
export const REPLAY_RELAY_ERROR_CODES = [
  "cross_origin",
  "unsupported_media_type",
  "identity_required",
  "not_configured",
] as const;
export type ReplayRelayErrorCode = (typeof REPLAY_RELAY_ERROR_CODES)[number];

export type ReplayUploadErrorCode = ReplayPublishingErrorCode | ReplayRelayErrorCode;

export const REPLAY_UPLOAD_ERROR_CODES: readonly ReplayUploadErrorCode[] = [
  ...REPLAY_PUBLISHING_ERROR_CODES,
  ...REPLAY_RELAY_ERROR_CODES,
];

export const REPLAY_UPLOAD_ERROR_STATUS: Record<ReplayUploadErrorCode, number> = {
  REPLAY_CREDENTIAL_INVALID: 401,
  capability_expired: 401,
  invalid_capability: 401,
  subject_mismatch: 403,
  capture_disabled: 403,
  reporting_disabled: 403,
  recording_not_found: 404,
  idempotency_conflict: 409,
  recording_closed: 409,
  payload_too_large: 413,
  invalid_request: 422,
  invalid_evidence: 422,
  rate_limited: 429,
  unavailable: 503,
  cross_origin: 403,
  unsupported_media_type: 415,
  identity_required: 401,
  not_configured: 503,
};

// Fixed, sanitized text. Clients branch on `code`, never on this.
export const REPLAY_UPLOAD_ERROR_MESSAGES: Record<ReplayUploadErrorCode, string> = {
  REPLAY_CREDENTIAL_INVALID: "The publishing credential was rejected.",
  capability_expired: "The upload capability expired.",
  invalid_capability: "The upload capability is not valid.",
  subject_mismatch: "The recording belongs to another identity.",
  capture_disabled: "Replay capture is disabled.",
  reporting_disabled: "Problem reports are disabled.",
  recording_not_found: "The recording was not found.",
  idempotency_conflict: "The same key was used for different content.",
  recording_closed: "The recording no longer accepts events; start a new recording.",
  payload_too_large: "The request is too large.",
  invalid_request: "The request is not valid.",
  invalid_evidence: "The recording reference is not valid.",
  rate_limited: "Too many requests.",
  unavailable: "Replay is temporarily unavailable.",
  cross_origin: "Cross-origin requests are not accepted.",
  unsupported_media_type: "Send the request as application/json.",
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

// Epic's bounds: a pathname with no query, fragment or leading `//`.
export const REPLAY_ROUTE_MAX = 512;
const routeSchema = z
  .string()
  .max(REPLAY_ROUTE_MAX)
  .regex(/^\/(?!\/)[^?#\u0000-\u001f\u007f\s`<>[\]{}"\\^|]*$/, "Expected a pathname");

export const REPLAY_RELEASE_PATTERN = /^[A-Za-z0-9._+\-/]{1,128}$/;
export const releaseSchema = z.string().regex(REPLAY_RELEASE_PATTERN).nullable();

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

export const replayRegistrationRequestSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    idempotencyKey: uuidSchema,
    startedAt: epochMsSchema,
    route: routeSchema,
    recorderVersion: z.literal(REPLAY_RECORDER_VERSION),
    configVersion: z.string().regex(/^[1-9][0-9]{0,15}$/),
    release: releaseSchema,
    viewport: z
      .object({
        width: z.number().int().min(1).max(16_384),
        height: z.number().int().min(1).max(16_384),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ReplayRegistrationRequest = z.infer<typeof replayRegistrationRequestSchema>;

export const replayCapabilityRequestSchema = z
  .object({ contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION) })
  .strict();

export const replayEventEnvelopeSchema = z
  .object({
    type: z.number().int().min(0).max(6),
    timestamp: epochMsSchema,
    data: z.record(z.string(), z.unknown()),
    delay: z.number().optional(),
  })
  .strict();
export type ReplayEventEnvelope = z.infer<typeof replayEventEnvelopeSchema>;

export const replayBatchRequestSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    recordingToken: z.string().min(1).max(512),
    batchId: uuidSchema,
    sequence: z.number().int().min(0).max(1_000_000),
    events: z.array(replayEventEnvelopeSchema).max(REPLAY_BATCH_MAX_EVENTS),
    final: z.boolean(),
  })
  .strict();
export type ReplayBatchRequest = z.infer<typeof replayBatchRequestSchema>;

export const replayAvailabilitySchema = z.enum(REPLAY_AVAILABILITIES);

/** A sealed capability: opaque to the application, which only stores and resends it. */
export const REPLAY_RECORDING_TOKEN_PATTERN = /^eprc_1\.[A-Za-z0-9_-]{40,480}$/;

/** Registration (201/200) and capability renewal (200) share this shape. */
export const replayRecordingResponseSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    recordingId: uuidSchema,
    recordingToken: z.string().regex(REPLAY_RECORDING_TOKEN_PATTERN),
    tokenExpiresAt: epochMsSchema,
    startedAt: epochMsSchema,
    availability: replayAvailabilitySchema,
    limits: replayRecordingLimitsSchema,
  })
  .strict();
export type ReplayRecordingResponse = z.infer<typeof replayRecordingResponseSchema>;

export const replayBatchResponseSchema = z
  .object({
    contractVersion: z.literal(REPLAY_UPLOAD_CONTRACT_VERSION),
    recordingId: uuidSchema,
    batchId: uuidSchema,
    sequence: z.number().int().nonnegative(),
    delivery: z.enum(["accepted", "finalized"]),
  })
  .strict();
export type ReplayBatchResponse = z.infer<typeof replayBatchResponseSchema>;

const reportTextSchema = z.string().max(REPLAY_REPORT_TEXT_MAX);

export const replayReportEvidenceSchema = z
  .object({
    recordingId: uuidSchema,
    startedAt: epochMsSchema,
    offsetMs: epochMsSchema,
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
