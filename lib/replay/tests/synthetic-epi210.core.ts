import { z } from "zod";
import { REPLAY_RECORDING_LIMITS } from "../replay-config.contract";
import {
  parseReplayRequest,
  REPLAY_PUBLISHING_ERROR_STATUS,
  replayBatchRequestSchema,
  replayCapabilityRequestSchema,
  replayIdentityRequestSchema,
  replayRegistrationRequestSchema,
  type ReplayAvailability,
  type ReplayBatchAcknowledgment,
  type ReplayPublishingErrorCode,
  type ReplayRecordingCapability,
  type ReplayUploadErrorBody,
  ReplayUploadError,
} from "../replay-upload-contract";

/**
 * SYNTHETIC EPI-210 FIXTURE - not Epic, not rrweb.
 *
 * A deterministic stand-in for the agreed central v1 publishing contract,
 * shared by the integration, Service, Route and transport tests and by the
 * development harness. It keeps a frozen registration hash per application-
 * wide idempotency key, a distinct hidden "Cloud" UUID that is never
 * returned, ordered receipts keyed by batch id, capability expiry,
 * uncertainty, delays, offline, 503 and metadata-only finalization. Passing
 * against it proves local conformance only: it is never production or
 * provider evidence of receipt, readiness or playback.
 */

export type SyntheticFixtureMode =
  | "accept"
  | "delay_registration"
  | "offline"
  | "fail_503"
  | "delivery_uncertain_next"
  | "expire_capability"
  | "tiny_batch";

export const SYNTHETIC_TINY_BATCH_BYTES = 2_048;
export const SYNTHETIC_REGISTRATION_DELAY_MS = 2_000;
export const SYNTHETIC_CAPABILITY_TTL_MS = 15 * 60_000;
export const SYNTHETIC_BROWSER_SUBJECT = "sub_synthetic-browser-subject";

export interface SyntheticAnswer {
  status: number;
  body: unknown;
}

interface Receipt {
  hash: string;
  ack: ReplayBatchAcknowledgment | null; // null: delivery uncertain
}

interface SyntheticRecording {
  recordingId: string;
  cloudId: string;
  subjectId: string;
  hash: string;
  startedAt: number;
  status: "open" | "closed" | "quarantined";
  availability: ReplayAvailability;
  nextSequence: number;
  limits: ReplayRecordingCapability["limits"];
  receipts: Map<string, Receipt>;
  expiredOnce: boolean;
}

export interface SyntheticLogEntry {
  id: number;
  path: string;
  status: number | "network_error";
  code: string | null;
  recordingId: string | null;
  batchId: string | null;
  sequence: number | null;
  eventCount: number | null;
  firstEventTypes: number[] | null;
  final: boolean | null;
  bodyKeys: string[];
}

function error(code: ReplayPublishingErrorCode, extra: Partial<ReplayUploadErrorBody> = {}): SyntheticAnswer {
  const body = new ReplayUploadError(code, extra).toBody();
  return { status: REPLAY_PUBLISHING_ERROR_STATUS[code], body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const encoder = new TextEncoder();
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

// The central endpoint does not accept the browser-only viewport field.
const centralRegistrationSchema = replayRegistrationRequestSchema.omit({ viewport: true }).extend({
  subjectId: z.string().min(1).max(200).regex(/^[\x21-\x3f\x41-\x7e]+$/),
  captureContext: z.object({
    browser: z.object({
      name: z.enum(["Chrome", "Edge", "Firefox", "Safari", "Opera", "Other", "Unknown"]),
      majorVersion: z.string().regex(/^[0-9]{1,4}$/).nullable(),
    }).strict(),
    os: z.object({
      name: z.enum(["Windows", "macOS", "iOS", "Android", "Linux", "Other", "Unknown"]),
      majorVersion: z.string().regex(/^[0-9]{1,4}$/).nullable(),
    }).strict(),
    deviceClass: z.enum(["desktop", "tablet", "mobile", "unknown"]),
    viewport: z.object({
      width: z.number().int().min(1).max(16_384),
      height: z.number().int().min(1).max(16_384),
    }).strict().nullable(),
  }).strict(),
}).strict();

export function createSyntheticEpi210({
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
}: { now?: () => number; randomUUID?: () => string } = {}) {
  let mode: SyntheticFixtureMode = "accept";
  let captureDisabled = false;
  const byKey = new Map<string, SyntheticRecording>();
  const byId = new Map<string, SyntheticRecording>();
  const tokens = new Map<string, { recordingId: string; subjectId: string; expiresAt: number }>();
  let tokenCounter = 0;
  /** Provider (Cloud) append calls: empty finalization never makes one. */
  const providerAppends: { recordingId: string; batchId: string; sequence: number }[] = [];
  /** Forced answers for the next central batch calls, consumed in order. */
  const scripted: SyntheticAnswer[] = [];

  function issueToken(recording: SyntheticRecording) {
    const token = `cap_${++tokenCounter}_${recording.recordingId.slice(0, 8)}`;
    const expiresAt = now() + SYNTHETIC_CAPABILITY_TTL_MS;
    tokens.set(token, { recordingId: recording.recordingId, subjectId: recording.subjectId, expiresAt });
    return { recordingToken: token, tokenExpiresAt: expiresAt };
  }

  function capability(recording: SyntheticRecording): ReplayRecordingCapability {
    return {
      contractVersion: 1,
      recordingId: recording.recordingId,
      ...issueToken(recording),
      startedAt: recording.startedAt,
      availability: recording.availability,
      nextSequence: recording.nextSequence,
      limits: { ...recording.limits },
    };
  }

  /** Central registration: the payload already carries the trusted subject. */
  function register(payload: unknown): SyntheticAnswer {
    const parsed = centralRegistrationSchema.safeParse(payload);
    if (!parsed.success) {
      return error("invalid_request");
    }
    payload = parsed.data;
    const registration = parsed.data;
    if (captureDisabled) return error("capture_disabled");
    // Central hashes the complete frozen central payload.
    const hash = JSON.stringify(payload);
    const existing = byKey.get(registration.idempotencyKey);
    if (existing) {
      if (existing.hash !== hash) return error("idempotency_conflict");
      if (existing.status !== "open") return error("recording_closed");
      return { status: 200, body: capability(existing) };
    }
    const recording: SyntheticRecording = {
      recordingId: randomUUID(),
      cloudId: randomUUID(),
      subjectId: registration.subjectId,
      hash,
      startedAt: registration.startedAt,
      status: "open",
      availability: "waiting_for_events",
      nextSequence: 0,
      limits: {
        ...REPLAY_RECORDING_LIMITS,
        ...(mode === "tiny_batch" ? { maxBatchBytes: SYNTHETIC_TINY_BATCH_BYTES } : {}),
      },
      receipts: new Map(),
      expiredOnce: false,
    };
    byKey.set(registration.idempotencyKey, recording);
    byId.set(recording.recordingId, recording);
    return { status: 201, body: capability(recording) };
  }

  function renew(recordingId: string, payload: unknown): SyntheticAnswer {
    if (!isRecord(payload) || payload.contractVersion !== 1 || typeof payload.subjectId !== "string") {
      return error("invalid_request");
    }
    const recording = byId.get(recordingId);
    if (!recording || recording.subjectId !== payload.subjectId) return error("recording_not_found");
    if (recording.status === "quarantined") return error("delivery_uncertain");
    if (recording.status === "closed") return error("recording_closed");
    return { status: 200, body: capability(recording) };
  }

  function batch(recordingId: string, payload: unknown): SyntheticAnswer {
    if (!isRecord(payload) || typeof payload.subjectId !== "string" || typeof payload.recordingToken !== "string" || typeof payload.batchId !== "string" || typeof payload.sequence !== "number" || !Array.isArray(payload.events) || typeof payload.final !== "boolean") {
      return error("invalid_request");
    }
    const recording = byId.get(recordingId);
    if (!recording) return error("recording_not_found");
    const token = tokens.get(payload.recordingToken);
    if (!token || token.recordingId !== recordingId) return error("invalid_capability");
    if (token.expiresAt <= now()) return error("capability_expired");
    if (token.subjectId !== payload.subjectId) return error("subject_mismatch");

    // Receipts are checked first: an exact retry recovers its original answer
    // even after the recording closed.
    const hash = JSON.stringify([payload.sequence, payload.events, payload.final]);
    const receipt = recording.receipts.get(payload.batchId);
    if (receipt) {
      if (receipt.hash !== hash) return error("idempotency_conflict");
      return receipt.ack ? { status: 200, body: receipt.ack } : error("delivery_uncertain");
    }
    if (recording.status === "quarantined") return error("delivery_uncertain");
    if (recording.status === "closed") return error("recording_closed");
    if (payload.sequence !== recording.nextSequence) {
      return error("out_of_order", { expectedSequence: recording.nextSequence });
    }
    if (payload.events.length > recording.limits.maxBatchEvents || byteLength(payload) > recording.limits.maxBatchBytes) {
      return error("payload_too_large");
    }
    if (payload.events.length === 0 && !payload.final) return error("invalid_request");

    const forced = scripted.shift();
    if (forced) return forced;
    if (mode === "fail_503") return error("unavailable");

    if (payload.events.length === 0) {
      // Metadata-only finalization: zero provider appends, availability unchanged.
      const ack = acknowledge(recording, payload.batchId, payload.sequence, "finalized");
      recording.receipts.set(payload.batchId, { hash, ack });
      recording.status = "closed";
      return { status: 200, body: ack };
    }
    if (captureDisabled) return error("capture_disabled");
    if (mode === "delivery_uncertain_next") {
      mode = "accept";
      recording.receipts.set(payload.batchId, { hash, ack: null });
      recording.status = "quarantined";
      return error("delivery_uncertain");
    }

    providerAppends.push({ recordingId, batchId: payload.batchId, sequence: payload.sequence });
    recording.availability = "events_received";
    const ack = acknowledge(recording, payload.batchId, payload.sequence, "accepted");
    recording.receipts.set(payload.batchId, { hash, ack });
    if (payload.final) recording.status = "closed";
    if (mode === "expire_capability" && !recording.expiredOnce) {
      recording.expiredOnce = true;
      token.expiresAt = now();
    }
    return { status: 200, body: ack };
  }

  function acknowledge(
    recording: SyntheticRecording,
    batchId: string,
    sequence: number,
    delivery: "accepted" | "finalized",
  ): ReplayBatchAcknowledgment {
    recording.nextSequence = sequence + 1;
    return {
      contractVersion: 1,
      recordingId: recording.recordingId,
      batchId,
      sequence,
      delivery,
      availability: recording.availability,
      nextSequence: recording.nextSequence,
    };
  }

  /**
   * Central routing for `/api/replay/v1/*`. Returns null for any other path.
   */
  function central(path: string, payload: unknown): SyntheticAnswer | null {
    if (path === "/api/replay/v1/recordings") return register(payload);
    const match = /^\/api\/replay\/v1\/recordings\/([^/]+)\/(capability|batches)$/.exec(path);
    if (!match) return null;
    const recordingId = decodeURIComponent(match[1]!);
    return match[2] === "capability" ? renew(recordingId, payload) : batch(recordingId, payload);
  }

  return {
    central,
    setMode(next: SyntheticFixtureMode) {
      mode = next;
    },
    getMode: () => mode,
    setCaptureDisabled(disabled: boolean) {
      captureDisabled = disabled;
    },
    /** Answers the next central batch calls (after receipt/order checks) with these. */
    scriptBatchAnswers(...answers: SyntheticAnswer[]) {
      scripted.push(...answers);
    },
    /** Expires every capability issued so far. */
    expireCapabilities() {
      for (const token of tokens.values()) token.expiresAt = now();
    },
    providerAppends,
    recordings: () =>
      [...byId.values()].map((recording) => {
        const copy: Partial<SyntheticRecording> = { ...recording };
        delete copy.receipts;
        return copy as Omit<SyntheticRecording, "receipts">;
      }),
  };
}

export type SyntheticEpi210 = ReturnType<typeof createSyntheticEpi210>;

const json = (answer: SyntheticAnswer) =>
  new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * A `fetch` that plays Epic central for server tests: only requests to
 * `apiUrl` with one of `tokens` as the bearer reach the fixture; anything
 * else is 401 REPLAY_CREDENTIAL_INVALID or 404. Every call is recorded.
 */
export function createSyntheticCentralFetch(
  fixture: SyntheticEpi210,
  { apiUrl, tokens }: { apiUrl: string; tokens: string[] },
) {
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url: url.toString(), headers, body });
    if (url.origin !== new URL(apiUrl).origin) return new Response(null, { status: 404 });
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
    if (!bearer || !tokens.includes(bearer)) return json(error("REPLAY_CREDENTIAL_INVALID"));
    const answer = fixture.central(url.pathname, body);
    return answer ? json(answer) : new Response(null, { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

/**
 * A `fetch` that plays this application's relay plus Epic central for the
 * browser transport: it strictly parses each browser body like the real
 * routes (forged fields are 400), adds a fixed synthetic subject and answers
 * from the fixture. Its log never holds event content.
 */
export function createSyntheticBrowserFetch(
  fixture: SyntheticEpi210,
  {
    baseUrl = "/api/epic/replay",
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: { baseUrl?: string; sleep?: (ms: number) => Promise<void> } = {},
) {
  const log: SyntheticLogEntry[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let counter = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  async function answer(path: string, body: unknown): Promise<SyntheticAnswer> {
    try {
      if (path === "/identity") {
        parseReplayRequest(replayIdentityRequestSchema, body);
        return { status: 200, body: { contractVersion: 1 } };
      }
      if (path === "/recordings") {
        const registration = parseReplayRequest(replayRegistrationRequestSchema, body);
        const { viewport, ...centralRegistration } = registration;
        if (fixture.getMode() === "delay_registration") await sleep(SYNTHETIC_REGISTRATION_DELAY_MS);
        return fixture.central("/api/replay/v1/recordings", {
          ...centralRegistration,
          subjectId: SYNTHETIC_BROWSER_SUBJECT,
          captureContext: {
            browser: { name: "Unknown", majorVersion: null },
            os: { name: "Unknown", majorVersion: null },
            deviceClass: "unknown",
            viewport,
          },
        })!;
      }
      const match = /^\/recordings\/([^/]+)\/(capability|batches)$/.exec(path);
      if (!match) return { status: 404, body: null };
      const centralPath = `/api/replay/v1/recordings/${match[1]}/${match[2]}`;
      if (match[2] === "capability") {
        parseReplayRequest(replayCapabilityRequestSchema, body);
        return fixture.central(centralPath, { contractVersion: 1, subjectId: SYNTHETIC_BROWSER_SUBJECT })!;
      }
      if (isRecord(body) && Array.isArray(body.events) && body.events.length > REPLAY_RECORDING_LIMITS.maxBatchEvents) {
        return error("payload_too_large");
      }
      const batch = parseReplayRequest(replayBatchRequestSchema, body);
      return fixture.central(centralPath, { ...batch, subjectId: SYNTHETIC_BROWSER_SUBJECT })!;
    } catch (thrown) {
      if (thrown instanceof ReplayUploadError) return { status: thrown.status, body: thrown.toBody() };
      throw thrown;
    }
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = raw.startsWith(baseUrl) ? raw.slice(baseUrl.length) : raw;
    let body: unknown = null;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    const entry: SyntheticLogEntry = {
      id: ++counter,
      path,
      status: "network_error",
      code: null,
      recordingId: /^\/recordings\/([^/]+)/.exec(path)?.[1] ?? null,
      batchId: isRecord(body) && typeof body.batchId === "string" ? body.batchId : null,
      sequence: isRecord(body) && typeof body.sequence === "number" ? body.sequence : null,
      eventCount: isRecord(body) && Array.isArray(body.events) ? body.events.length : null,
      firstEventTypes:
        isRecord(body) && Array.isArray(body.events)
          ? body.events.slice(0, 2).map((event) => (isRecord(event) && typeof event.type === "number" ? event.type : -1))
          : null,
      final: isRecord(body) && typeof body.final === "boolean" ? body.final : null,
      bodyKeys: isRecord(body) ? Object.keys(body).sort() : [],
    };
    log.push(entry);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    notify();
    try {
      if (fixture.getMode() === "offline") throw new TypeError("Failed to fetch");
      // An asynchronous hop, so a caller's concurrency is observable.
      await Promise.resolve();
      const result = await answer(path, body);
      entry.status = result.status;
      entry.code = isRecord(result.body) && typeof result.body.code === "string" ? result.body.code : null;
      if (!entry.recordingId && isRecord(result.body) && typeof result.body.recordingId === "string") {
        entry.recordingId = result.body.recordingId;
      }
      return json(result);
    } finally {
      inFlight--;
      notify();
    }
  };

  return {
    fetch: fetchImpl as typeof fetch,
    log,
    maxInFlight: () => maxInFlight,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
