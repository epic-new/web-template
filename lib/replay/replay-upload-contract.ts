import { z } from "zod";

import { REPLAY_RECORDING_LIMITS, replayRecordingLimitsSchema } from "./replay-config.contract";

/**
 * The browser-facing replay upload contract (EPI-210 v1): what the browser may
 * send to `/api/epic/replay/recordings/*`, what it gets back, and the flat
 * error envelope every publishing hop answers with.
 *
 * Browser-safe on purpose; the routes, Services and the upload transport all
 * parse with these schemas. Every request object is `.strict()`, so a browser
 * can never add ownership or scope fields (`subjectId`, `projectId`,
 * `environment`, `captureContext`, a Cloud UUID, ...): they are rejected, not
 * ignored.
 */

export const REPLAY_UPLOAD_CONTRACT_VERSION = 1;

/** The pinned `@rrweb/record` version this template records with. */
export const REPLAY_RECORDER_VERSION = "2.2.0";

export const REPLAY_REGISTRATION_MAX_BYTES = 8_192;
export const REPLAY_CAPABILITY_MAX_BYTES = 1_024;

/**
 * `maxBatchBytes` bounds the complete UTF-8 JSON request at every hop. The
 * application server adds `"subjectId":"sub_<43 chars>"` (64 bytes with its
 * comma) before relaying, so the browser packs each batch to leave this
 * conservative allowance free. The central wire limit is never raised.
 */
export const REPLAY_SUBJECT_ALLOWANCE_BYTES = 128;

/** Packing assumes a capability of the maximum length, so renewal never overflows. */
export const REPLAY_TOKEN_MAX_LENGTH = 256;

export const MAX_VIEWPORT_DIMENSION = 16_384;
export const MAX_REPLAY_ROUTE_LENGTH = 512;
export const MAX_REPLAY_RELEASE_LENGTH = 128;
export const MAX_REPLAY_SEQUENCE = 1_000_000;

const uuidSchema = z.uuid();
const timestampSchema = z.number().int().nonnegative();
const contractVersionSchema = z.literal(REPLAY_UPLOAD_CONTRACT_VERSION);

export const replayViewportSchema = z
  .object({
    width: z.number().int().min(1).max(MAX_VIEWPORT_DIMENSION),
    height: z.number().int().min(1).max(MAX_VIEWPORT_DIMENSION),
  })
  .strict();
export type ReplayViewport = z.infer<typeof replayViewportSchema>;

const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() !== "", "Blank value");

export const replayRegistrationRequestSchema = z
  .object({
    contractVersion: contractVersionSchema,
    idempotencyKey: uuidSchema,
    startedAt: timestampSchema,
    route: z.string().max(MAX_REPLAY_ROUTE_LENGTH),
    recorderVersion: z.literal(REPLAY_RECORDER_VERSION),
    configVersion: z.string().regex(/^[1-9][0-9]*$/),
    // The document/build-bound release, frozen by the page; null when unknown.
    release: nonBlank(MAX_REPLAY_RELEASE_LENGTH).regex(/^[A-Za-z0-9._+\-/]+$/).nullable(),
    viewport: replayViewportSchema.nullable(),
  })
  .strict();
export type ReplayRegistrationRequest = z.infer<typeof replayRegistrationRequestSchema>;

/** Host identity must be acknowledged before registration can have central side effects. */
export const replayIdentityRequestSchema = z.object({ contractVersion: contractVersionSchema }).strict();
export const replayIdentityResponseSchema = z.object({ contractVersion: contractVersionSchema }).strict();

export const replayCapabilityRequestSchema = z
  .object({ contractVersion: contractVersionSchema })
  .strict();
export type ReplayCapabilityRequest = z.infer<typeof replayCapabilityRequestSchema>;

/** An rrweb `eventWithTime` envelope; `data` is the recorder's own payload. */
export const rrwebEventSchema = z
  .object({
    type: z.number().int().min(0).max(6),
    timestamp: timestampSchema,
    data: z.record(z.string(), z.unknown()),
    delay: z.number().optional(),
  })
  .strict();
export type ReplayWireEvent = z.infer<typeof rrwebEventSchema>;

export const replayBatchRequestSchema = z
  .object({
    contractVersion: contractVersionSchema,
    recordingToken: z.string().min(1).max(REPLAY_TOKEN_MAX_LENGTH),
    batchId: uuidSchema,
    sequence: z.number().int().min(0).max(MAX_REPLAY_SEQUENCE),
    events: z.array(rrwebEventSchema).max(REPLAY_RECORDING_LIMITS.maxBatchEvents),
    final: z.boolean(),
  })
  .strict();
export type ReplayBatchRequest = z.infer<typeof replayBatchRequestSchema>;

export const replayAvailabilitySchema = z.enum([
  "waiting_for_events",
  "events_received",
  "playable",
  "incomplete",
  "unavailable",
  "expired",
  "deleted",
]);
export type ReplayAvailability = z.infer<typeof replayAvailabilitySchema>;

/**
 * Registration (201 new, 200 idempotent retry) and capability renewal (200)
 * answer exactly this shape. Renewal never changes `recordingId` or
 * `startedAt`, and its `nextSequence` is diagnostic only.
 */
export const replayRecordingCapabilitySchema = z
  .object({
    contractVersion: contractVersionSchema,
    recordingId: uuidSchema,
    recordingToken: z.string().min(1).max(REPLAY_TOKEN_MAX_LENGTH),
    tokenExpiresAt: timestampSchema,
    startedAt: timestampSchema,
    availability: replayAvailabilitySchema,
    nextSequence: z.number().int().nonnegative(),
    limits: replayRecordingLimitsSchema,
  })
  .strict();
export type ReplayRecordingCapability = z.infer<typeof replayRecordingCapabilitySchema>;

/**
 * `finalized` is only an empty (metadata-only) finalization: it claims no
 * provider write, event receipt or playback.
 */
export const replayBatchAcknowledgmentSchema = z
  .object({
    contractVersion: contractVersionSchema,
    recordingId: uuidSchema,
    batchId: uuidSchema,
    sequence: z.number().int().nonnegative(),
    delivery: z.enum(["accepted", "finalized"]),
    availability: replayAvailabilitySchema,
    nextSequence: z.number().int().positive(),
  })
  .strict()
  .refine((ack) => ack.nextSequence === ack.sequence + 1, "nextSequence must be sequence + 1");
export type ReplayBatchAcknowledgment = z.infer<typeof replayBatchAcknowledgmentSchema>;

/**
 * The central EPI-210 publishing error codes. The uppercase publishing
 * credential code is intentional; every other code is lowercase.
 */
export const REPLAY_PUBLISHING_ERROR_STATUS = {
  REPLAY_CREDENTIAL_INVALID: 401,
  capability_expired: 401,
  invalid_capability: 401,
  subject_mismatch: 403,
  capture_disabled: 403,
  reporting_disabled: 403,
  recording_not_found: 404,
  idempotency_conflict: 409,
  out_of_order: 409,
  upload_in_progress: 409,
  recording_closed: 409,
  delivery_uncertain: 409,
  payload_too_large: 413,
  invalid_request: 422,
  invalid_evidence: 422,
  rate_limited: 429,
  unavailable: 503,
} as const;
export type ReplayPublishingErrorCode = keyof typeof REPLAY_PUBLISHING_ERROR_STATUS;

/**
 * Relay-only host-policy and configuration codes, answered by this
 * application's routes before anything reaches Epic. A local request-shape
 * rejection (unknown or ownership fields, malformed JSON) is `invalid_request`
 * at 400; the central schema/bounds rejection stays 422.
 */
export const REPLAY_RELAY_ERROR_STATUS = {
  cross_origin: 403,
  unsupported_media_type: 415,
  identity_required: 401,
  not_configured: 503,
} as const;
export type ReplayRelayErrorCode = keyof typeof REPLAY_RELAY_ERROR_STATUS;

export type ReplayUploadErrorCode = ReplayPublishingErrorCode | ReplayRelayErrorCode;

export const REPLAY_PUBLISHING_ERROR_CODES = Object.keys(
  REPLAY_PUBLISHING_ERROR_STATUS,
) as ReplayPublishingErrorCode[];
export const REPLAY_UPLOAD_ERROR_CODES = [
  ...REPLAY_PUBLISHING_ERROR_CODES,
  ...(Object.keys(REPLAY_RELAY_ERROR_STATUS) as ReplayRelayErrorCode[]),
] as ReplayUploadErrorCode[];

const REPLAY_UPLOAD_ERROR_STATUS: Record<ReplayUploadErrorCode, number> = {
  ...REPLAY_PUBLISHING_ERROR_STATUS,
  ...REPLAY_RELAY_ERROR_STATUS,
};

/** The statuses a code may be answered with; only invalid_request has two. */
export function replayErrorStatuses(code: ReplayUploadErrorCode): readonly number[] {
  return code === "invalid_request" ? [400, 422] : [REPLAY_UPLOAD_ERROR_STATUS[code]];
}

const ERROR_MESSAGES: Record<ReplayUploadErrorCode, string> = {
  REPLAY_CREDENTIAL_INVALID: "The publishing credential was rejected",
  capability_expired: "The upload capability expired",
  invalid_capability: "The upload capability is not valid",
  subject_mismatch: "The recording belongs to another subject",
  capture_disabled: "Capture is disabled",
  reporting_disabled: "Reporting is disabled",
  recording_not_found: "Recording not found",
  idempotency_conflict: "The idempotency key was used with different content",
  out_of_order: "The batch is out of order",
  upload_in_progress: "An upload for this recording is in progress",
  recording_closed: "The recording is closed",
  delivery_uncertain: "Delivery of this batch is uncertain",
  payload_too_large: "The request is too large",
  invalid_request: "The request is not valid",
  invalid_evidence: "The evidence is not valid",
  rate_limited: "Too many requests",
  unavailable: "Replay ingestion is unavailable",
  cross_origin: "Cross-origin writes are not allowed",
  unsupported_media_type: "Requests must be application/json",
  identity_required: "A signed-in user is required",
  not_configured: "Replay upload is not configured",
};

/** Codes whose typed fields are required by the v1 table. */
const REQUIRES_EXPECTED_SEQUENCE = new Set<ReplayUploadErrorCode>(["out_of_order"]);
const REQUIRES_RETRY_AFTER = new Set<ReplayUploadErrorCode>(["upload_in_progress", "rate_limited"]);
const ALLOWS_RETRY_AFTER = new Set<ReplayUploadErrorCode>([
  "upload_in_progress",
  "rate_limited",
  "unavailable",
]);

/**
 * The flat v1 error envelope. Clients branch on `code` and the typed fields,
 * never on `error` text.
 */
export const replayUploadErrorBodySchema = z
  .object({
    contractVersion: contractVersionSchema,
    error: z.string().min(1).max(256),
    code: z.enum(REPLAY_UPLOAD_ERROR_CODES as [ReplayUploadErrorCode, ...ReplayUploadErrorCode[]]),
    expectedSequence: z.number().int().nonnegative().optional(),
    retryAfterMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (REQUIRES_EXPECTED_SEQUENCE.has(body.code) !== (body.expectedSequence !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["expectedSequence"], message: "expectedSequence mismatch" });
    }
    if (REQUIRES_RETRY_AFTER.has(body.code) && body.retryAfterMs === undefined) {
      ctx.addIssue({ code: "custom", path: ["retryAfterMs"], message: "retryAfterMs required" });
    }
    if (!ALLOWS_RETRY_AFTER.has(body.code) && body.retryAfterMs !== undefined) {
      ctx.addIssue({ code: "custom", path: ["retryAfterMs"], message: "retryAfterMs not allowed" });
    }
  });
export type ReplayUploadErrorBody = z.infer<typeof replayUploadErrorBodySchema>;

/** A parsed error answer: valid only when the status matches the code. */
export function parseReplayUploadError(status: number, payload: unknown): ReplayUploadErrorBody | null {
  const parsed = replayUploadErrorBodySchema.safeParse(payload);
  if (!parsed.success) return null;
  return replayErrorStatuses(parsed.data.code).includes(status) ? parsed.data : null;
}

/** `Retry-After` is whole seconds: ceil(ms / 1000). */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** A known, browser-safe upload failure. Carries no upstream detail. */
export class ReplayUploadError extends Error {
  readonly status: number;
  readonly expectedSequence?: number;
  readonly retryAfterMs?: number;

  constructor(
    public readonly code: ReplayUploadErrorCode,
    {
      status,
      expectedSequence,
      retryAfterMs,
    }: { status?: number; expectedSequence?: number; retryAfterMs?: number } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ReplayUploadError";
    this.status =
      status !== undefined && replayErrorStatuses(code).includes(status)
        ? status
        : REPLAY_UPLOAD_ERROR_STATUS[code];
    if (expectedSequence !== undefined) this.expectedSequence = expectedSequence;
    if (retryAfterMs !== undefined) this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
  }

  /** A local request-shape rejection (unknown or forged fields, bad JSON). */
  static malformed(): ReplayUploadError {
    return new ReplayUploadError("invalid_request", { status: 400 });
  }

  toBody(): ReplayUploadErrorBody {
    return {
      contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
      error: ERROR_MESSAGES[this.code],
      code: this.code,
      ...(this.expectedSequence === undefined ? {} : { expectedSequence: this.expectedSequence }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }

  /** `Cache-Control: no-store`, plus `Retry-After` in seconds when delayed. */
  headers(): Record<string, string> {
    return this.retryAfterMs === undefined
      ? { "Cache-Control": "no-store" }
      : { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds(this.retryAfterMs)) };
  }
}

/**
 * Parses a browser body, separating a request-shape violation (unknown or
 * forged fields: 400) from a value/bounds violation (422), both
 * `invalid_request`.
 */
export function parseReplayRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const shape =
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    parsed.error.issues.some((issue) => issue.code === "unrecognized_keys");
  throw shape ? ReplayUploadError.malformed() : new ReplayUploadError("invalid_request");
}

/**
 * The safe pathname a registration may carry: an absolute path only, with
 * query and fragment (where credentials live) removed. Null for anything
 * else, including a full or protocol-relative URL.
 */
export function safeReplayPathname(route: string): string | null {
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\")) return null;
  const path = (route.split(/[?#]/, 1)[0] ?? "/").replace(/\/{2,}/g, "/");
  return path.length <= MAX_REPLAY_ROUTE_LENGTH && !/[\s\x00-\x1f\x7f]/.test(path) ? path : null;
}
