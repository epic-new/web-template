import type { eventWithTime } from "@rrweb/types";

import type { PublicReplayConfig } from "./replay-config.contract";
import type { ReplayEventSink } from "./replay-buffer";
import type { ReplayRecordingContext } from "./replay-evidence";
import { jsonByteLength } from "./replay-redaction";
import { replayUploadCheckpointSchema, type ReplayUploadCheckpoint } from "./replay-upload-checkpoint";
import {
  MAX_REPLAY_RELEASE_LENGTH,
  parseReplayUploadError,
  REPLAY_RECORDER_VERSION,
  REPLAY_SUBJECT_ALLOWANCE_BYTES,
  REPLAY_TOKEN_MAX_LENGTH,
  REPLAY_UPLOAD_CONTRACT_VERSION,
  replayBatchAcknowledgmentSchema,
  replayIdentityResponseSchema,
  replayRecordingCapabilitySchema,
  safeReplayPathname,
  type ReplayAvailability,
  type ReplayFetch,
  type ReplayBatchAcknowledgment,
  type ReplayBatchRequest,
  type ReplayRegistrationRequest,
  type ReplayUploadErrorCode,
  type ReplayViewport,
} from "./replay-upload-contract";

export type { ReplayUploadCheckpoint } from "./replay-upload-checkpoint";

/**
 * The browser upload transport for Epic Replay (see docs/replay-privacy.md).
 *
 * A `ReplayEventSink`: the capture session pushes sanitized events per
 * boundary, and each boundary becomes one recording. The transport registers
 * first (no event leaves before a successful registration), then uploads
 * ordered, frozen batches one request at a time through this application's
 * same-origin relay. Every retry resends the identical frozen body; nothing
 * is renumbered, skipped or truncated. Local memory is bounded by bytes and
 * by age, measured on a monotonic clock that wall-clock jumps cannot extend.
 *
 * Its state is honest: a registration or an accepted batch is never evidence
 * of playback (`evidence` is always "unverified"). It never throws into the
 * recorder, rendering, navigation or forms; failures only change state.
 */

type Limits = PublicReplayConfig["recording"]["limits"];

export type ReplayUploadStatus = "idle" | "recorder_started" | "registered" | "uploading" | "pending" | "unavailable";
export type ReplayUploadReason =
  | null
  | ReplayUploadErrorCode
  | "offline"
  | "buffer_exceeded"
  | "attempts_exhausted"
  | "snapshot_too_large";

/** Frozen once a registration succeeds; never replaced or moved. */
export interface ReplayRecordingReference {
  readonly recordingId: string;
  readonly startedAt: number;
  readonly boundary: number;
}

export interface ReplayRecordingHistoryEntry {
  readonly reference: ReplayRecordingReference;
  readonly outcome: "open" | "incomplete" | "closed" | "unavailable";
  readonly reason: ReplayUploadReason;
  readonly acceptedBatches: number;
  readonly availability: ReplayAvailability | null;
}

export interface ReplayUploadState {
  readonly status: ReplayUploadStatus;
  readonly reason: ReplayUploadReason;
  readonly current: ReplayRecordingReference | null;
  readonly history: readonly ReplayRecordingHistoryEntry[];
  readonly bufferedEvents: number;
  readonly bufferedBytes: number;
  readonly evidence: "unverified";
}

/** Private runtime diagnostics; not an event-by-event public React context. */
export interface ReplayUploadProgress {
  readonly snapshotReceived: boolean;
  readonly acceptedBatches: number;
  readonly postOpeningBatches: number;
  readonly continuity: "fresh" | "resuming" | "resumed" | "handoff";
}

export type ReplayErrorAction = "stop" | "renew" | "restart" | "retry" | "quarantine";

/** The normative EPI-210 v1 client action for every code. */
export const REPLAY_ERROR_ACTIONS: Record<ReplayUploadErrorCode, ReplayErrorAction> = {
  // A server credential failure: never "repaired" by capability renewal.
  REPLAY_CREDENTIAL_INVALID: "stop",
  capability_expired: "renew",
  invalid_capability: "restart",
  subject_mismatch: "restart",
  capture_disabled: "stop",
  reporting_disabled: "stop",
  recording_not_found: "restart",
  idempotency_conflict: "stop",
  out_of_order: "restart",
  upload_in_progress: "retry",
  recording_closed: "restart",
  delivery_uncertain: "quarantine",
  payload_too_large: "stop",
  invalid_request: "stop",
  invalid_evidence: "stop",
  rate_limited: "retry",
  unavailable: "retry",
  cross_origin: "stop",
  unsupported_media_type: "stop",
  identity_required: "stop",
  not_configured: "stop",
};

export const REPLAY_RETRY_BACKOFF_MS = [500, 1_000, 2_000] as const;
const KEEPALIVE_MAX_BYTES = 64 * 1024;
const HISTORY_LIMIT = 10;
const TICK_MS = 1_000;
export const REPLAY_UPLOAD_REQUEST_TIMEOUT_MS = 12_000;
const MAX_CLOSING_RECORDINGS = 1;

export interface ReplayUploaderOptions {
  getLimits: () => Limits;
  getConfigVersion: () => string | null;
  /** The document/build-bound release, never the latest policy's; null when unknown. */
  getDocumentRelease?: () => string | null;
  fetch?: ReplayFetch;
  monotonicNow?: () => number;
  wallNow?: () => number;
  isOnline?: () => boolean;
  getViewport?: () => ReplayViewport | null;
  getRoute?: () => string;
  randomUUID?: () => string;
  /** A recording ended in a way that permits a fresh one (new boundary). */
  onRecordingLost?: (reason: ReplayUploadReason) => void;
  /** Cooperative intent ownership, before this recording's first central write. */
  beforeRegistration?: (registration: ReplayRegistrationRequest, signal: AbortSignal) => Promise<boolean>;
  /** Hold recording ownership before any events may leave this producer. */
  acquireOwnership?: (registration: ReplayRegistrationRequest, recordingId: string, signal: AbortSignal) => Promise<boolean>;
  /** Called only after the retired recording's asynchronous work has settled. */
  onRecordingEnded?: (registration: ReplayRegistrationRequest, recordingId: string | null) => void;
  baseUrl?: string;
}

interface Queued {
  event: eventWithTime;
  bytes: number;
  mono: number;
  wall: number;
}

interface FrozenBatch {
  body: ReplayBatchRequest;
  eventBytes: number;
  oldest: { mono: number; wall: number };
  renewed: boolean;
  attempts: number;
}

interface Recording {
  boundary: number;
  phase: "registering" | "open" | "ended";
  registration: ReplayRegistrationRequest;
  registrationAttempts: number;
  identityAttempts: number;
  identityReady: boolean;
  renewAttempts: number;
  renewing: boolean;
  reference: ReplayRecordingReference | null;
  token: string | null;
  limits: Limits;
  nextSequence: number;
  queue: Queued[];
  queueBytes: number;
  inflight: FrozenBatch | null;
  busy: boolean;
  abortController: AbortController | null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  lastFlushAt: number;
  finalRequested: boolean;
  acceptedBatches: number;
  availability: ReplayAvailability | null;
  outcome: ReplayRecordingHistoryEntry["outcome"];
  reason: ReplayUploadReason;
  offline: boolean;
  lastAcknowledgment: ReplayBatchAcknowledgment | null;
  snapshotReceived: boolean;
  opening: "meta" | "snapshot" | "received" | "invalid";
  postOpeningBatches: number;
  resumeCheckpoint: ReplayUploadCheckpoint | null;
  resumeDeadline: number | null;
  continuation: "fresh" | "resuming" | "resumed";
  pendingOperations: number;
  intentOwned: boolean;
  ownershipReleased: boolean;
  ownedRecordingId: string | null;
}

type Outcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "error"; code: ReplayUploadErrorCode; retryAfterMs?: number }
  | { kind: "transient"; retryAfterMs?: number }
  | { kind: "invalid" };

function defaultViewport(): ReplayViewport | null {
  if (typeof window === "undefined") return null;
  const clamp = (value: number) => Math.min(Math.max(Math.round(value), 1), 16_384);
  const width = window.innerWidth;
  const height = window.innerHeight;
  return width > 0 && height > 0 ? { width: clamp(width), height: clamp(height) } : null;
}

function documentRelease(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_REPLAY_RELEASE_LENGTH && /^[A-Za-z0-9._+\-/]+$/.test(trimmed) ? trimmed : null;
}

export function createReplayUploader({
  getLimits,
  getConfigVersion,
  getDocumentRelease = () => null,
  fetch: fetchImpl = ((input, init) => fetch(input, init)) as typeof fetch,
  monotonicNow = () => performance.now(),
  wallNow = () => Date.now(),
  isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false,
  getViewport = defaultViewport,
  getRoute = () => (typeof window === "undefined" ? "/" : window.location.pathname),
  randomUUID = () => crypto.randomUUID(),
  onRecordingLost = () => {},
  beforeRegistration,
  acquireOwnership,
  onRecordingEnded = () => {},
  baseUrl = "/api/epic/replay",
}: ReplayUploaderOptions) {
  let current: Recording | null = null;
  // Older recordings still sending their final batch.
  let closing: Recording[] = [];
  let terminal: { status: ReplayUploadStatus; reason: ReplayUploadReason } = { status: "idle", reason: null };
  let history: readonly ReplayRecordingHistoryEntry[] = [];
  let historyRecordings: Recording[] = [];
  // The newest boundary ever started: older or finished boundaries never restart.
  let lastBoundary = 0;
  let generation = 0;
  let halted = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let requestOwner: Recording | null = null;
  let pendingContinuations = 0;
  let handoffQuiesced = false;
  let handedOff = false;
  const listeners = new Set<() => void>();
  let state: ReplayUploadState = buildState();

  // ---- state -------------------------------------------------------------

  function liveRecordings(): Recording[] {
    return [current, ...closing].filter((rec): rec is Recording => rec !== null && rec.phase !== "ended");
  }

  function pendingBytes(rec: Recording): number {
    return rec.queueBytes + (rec.inflight?.eventBytes ?? 0);
  }

  function buildState(): ReplayUploadState {
    const rec = current;
    let status = terminal.status;
    let reason = terminal.reason;
    if (rec && rec.phase !== "ended") {
      reason = rec.offline ? "offline" : null;
      if (rec.phase === "registering") status = "recorder_started";
      else if (rec.offline) status = "pending";
      else if (rec.busy || rec.inflight) status = "uploading";
      else status = rec.acceptedBatches > 0 ? "pending" : "registered";
    } else if (rec) {
      status = "unavailable";
      reason = rec.reason;
    }
    const live = rec && rec.phase !== "ended" ? rec : null;
    const pending = liveRecordings();
    return {
      status,
      reason,
      current: live?.reference ?? null,
      history,
      bufferedEvents: pending.reduce((count, item) => count + item.queue.length + (item.inflight?.body.events.length ?? 0), 0),
      bufferedBytes: pending.reduce((bytes, item) => bytes + pendingBytes(item), 0),
      evidence: "unverified",
    };
  }

  function recordHistory(rec: Recording) {
    if (!rec.reference) return;
    if (!historyRecordings.includes(rec)) {
      // Same-document revalidation replaces the local producer, not the durable
      // recording. Keep one row with its cumulative receipts; saved references
      // remain immutable values held by their original consumers.
      const id = rec.reference.recordingId;
      historyRecordings = [rec, ...historyRecordings.filter((entry) => entry.reference?.recordingId !== id)].slice(0, HISTORY_LIMIT);
    }
    history = historyRecordings.map(
      (entry): ReplayRecordingHistoryEntry => ({
        reference: entry.reference!,
        outcome: entry.outcome,
        reason: entry.reason,
        acceptedBatches: entry.acceptedBatches,
        availability: entry.availability,
      }),
    );
  }

  function notify() {
    state = buildState();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A subscriber's failure is not the transport's.
      }
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  function ensureTicker() {
    if (ticker !== undefined || handoffQuiesced) return;
    ticker = setInterval(() => safely(tick), TICK_MS);
  }

  function stopTickerIfIdle() {
    const live = [current, ...closing].some((rec) => rec && rec.phase !== "ended");
    if (!live && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function tick() {
    if (handoffQuiesced) return;
    for (const rec of [current, ...closing]) {
      if (!rec || rec.phase === "ended") continue;
      if (!checkRetention(rec)) continue;
      pump(rec);
    }
    notify();
  }

  function safely(run: () => void) {
    try {
      run();
    } catch {
      // Every internal failure becomes state, never an exception for callers.
      if (current && current.phase !== "ended") end(current, "unavailable", "unavailable", false);
      else terminal = { status: "unavailable", reason: "unavailable" };
      notify();
    }
  }

  function startRecording(boundary: number, first: { timestamp: number }): Recording {
    const configVersion = getConfigVersion();
    const limits = getLimits();
    const viewport = getViewport();
    const rec: Recording = {
      boundary,
      phase: "registering",
      registration: {
        contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
        idempotencyKey: randomUUID(),
        startedAt: first.timestamp,
        route: safeReplayPathname(getRoute()) ?? "/",
        recorderVersion: REPLAY_RECORDER_VERSION,
        configVersion: configVersion ?? "",
        release: documentRelease(getDocumentRelease()),
        viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
      },
      registrationAttempts: 0,
      identityAttempts: 0,
      identityReady: false,
      renewAttempts: 0,
      renewing: false,
      reference: null,
      token: null,
      limits: { ...limits },
      nextSequence: 0,
      queue: [],
      queueBytes: 0,
      inflight: null,
      busy: false,
      abortController: null,
      retryTimer: undefined,
      lastFlushAt: monotonicNow(),
      finalRequested: false,
      acceptedBatches: 0,
      availability: null,
      outcome: "open",
      reason: null,
      offline: false,
      lastAcknowledgment: null,
      snapshotReceived: false,
      opening: "meta",
      postOpeningBatches: 0,
      resumeCheckpoint: null,
      resumeDeadline: null,
      continuation: "fresh",
      pendingOperations: 0,
      intentOwned: false,
      ownershipReleased: false,
      ownedRecordingId: null,
    };
    Object.freeze(rec.registration);
    if (!configVersion || !configVersion.trim()) end(rec, "not_configured", "unavailable", false);
    return rec;
  }

  function releaseOwnership(rec: Recording) {
    if (rec.phase !== "ended" || rec.pendingOperations > 0 || rec.busy || rec.ownershipReleased) return;
    rec.ownershipReleased = true;
    try { onRecordingEnded(rec.registration, rec.reference?.recordingId ?? rec.ownedRecordingId); } catch { /* Host isolation. */ }
  }

  function runOperation(rec: Recording, operation: () => Promise<void>) {
    pendingContinuations++;
    rec.pendingOperations++;
    void operation().catch(() => {
      end(rec, "unavailable", "incomplete", false);
    }).finally(() => {
      pendingContinuations--;
      rec.pendingOperations--;
      releaseOwnership(rec);
      // Ownership acquisition and receipt application are part of the same
      // serialized operation as the request. Only now may any recording pump.
      safely(() => {
        if (pendingContinuations === 0) {
          for (const pending of [...closing, current]) {
            if (pending && pending.phase !== "ended" && checkRetention(pending)) pump(pending);
          }
        }
      });
      notify();
    });
  }

  /** Ends a recording: discards its local events and timers; history keeps its reference. */
  function end(
    rec: Recording,
    reason: ReplayUploadReason,
    outcome: ReplayRecordingHistoryEntry["outcome"],
    lost: boolean,
  ) {
    if (rec.phase === "ended") return;
    rec.phase = "ended";
    rec.reason = reason;
    rec.outcome = rec.reference ? outcome : "unavailable";
    rec.queue = [];
    rec.queueBytes = 0;
    rec.inflight = null;
    rec.token = null;
    rec.abortController?.abort();
    clearTimeout(rec.retryTimer);
    rec.retryTimer = undefined;
    recordHistory(rec);
    if (rec === current) terminal = { status: "unavailable", reason };
    closing = closing.filter((other) => other !== rec);
    stopTickerIfIdle();
    releaseOwnership(rec);
    if (lost && rec === current && !halted) {
      try {
        onRecordingLost(reason);
      } catch {
        // The pipeline's own failure stays out of the transport.
      }
    }
  }

  function retireCurrent() {
    const old = current;
    current = null;
    if (!old || old.phase === "ended") return;
    // The previous boundary is finished: flush what remains and finalize.
    old.finalRequested = true;
    closing.push(old);
    while (closing.length > MAX_CLOSING_RECORDINGS) end(closing[0]!, "unavailable", "incomplete", false);
    pump(old);
  }

  // ---- bounds ------------------------------------------------------------

  /** Bytes of a batch body without events, for the current token, plus the subject allowance. */
  function envelopeBytes(rec: Recording) {
    const skeleton = {
      contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
      recordingToken: "x".repeat(REPLAY_TOKEN_MAX_LENGTH),
      batchId: "00000000-0000-4000-8000-000000000000",
      sequence: Math.max(rec.nextSequence, 1_000_000_000),
      events: [],
      final: false,
    };
    return jsonByteLength(skeleton) + REPLAY_SUBJECT_ALLOWANCE_BYTES;
  }

  function fitsAlone(rec: Recording, bytes: number) {
    return envelopeBytes(rec) + bytes <= rec.limits.maxBatchBytes;
  }

  /** The first batch of every producer, including a successor, opens atomically. */
  function checkOpeningPair(rec: Recording): boolean {
    if (rec.snapshotReceived || rec.inflight || rec.queue.length < 2) return true;
    const [meta, snapshot] = rec.queue;
    if (meta!.event.type !== 4 || snapshot!.event.type !== 2) {
      end(rec, "invalid_request", "unavailable", false);
      return false;
    }
    if (rec.limits.maxBatchEvents < 2 ||
      envelopeBytes(rec) + meta!.bytes + 1 + snapshot!.bytes > rec.limits.maxBatchBytes) {
      end(rec, "snapshot_too_large", "unavailable", false);
      return false;
    }
    return true;
  }

  function elapsed(since: { mono: number; wall: number }) {
    // Uncertain elapsed time counts against retention: a suspension or a
    // forward wall-clock jump discards, a backward jump never extends.
    return Math.max(monotonicNow() - since.mono, wallNow() - since.wall, 0);
  }

  /** False when the recording just ended for exceeding its retention. */
  function checkRetention(rec: Recording): boolean {
    const oldest = rec.inflight?.oldest ?? rec.queue[0];
    if (oldest && elapsed(oldest) >= rec.limits.maxBufferAgeMs) {
      end(rec, "buffer_exceeded", "incomplete", true);
      return false;
    }
    // A boundary rollover may leave one older finalization in flight, but
    // that must not double the pipeline's private-data budget.
    const budget = Math.min(...liveRecordings().map((item) => item.limits.maxBufferBytes));
    for (const old of [...closing]) {
      if (liveRecordings().reduce((bytes, item) => bytes + pendingBytes(item), 0) <= budget) break;
      end(old, "buffer_exceeded", "incomplete", false);
    }
    if (rec.phase === "ended") return false;
    if (pendingBytes(rec) > budget) {
      end(rec, "buffer_exceeded", "incomplete", true);
      return false;
    }
    return true;
  }

  // ---- transport ---------------------------------------------------------

  async function send(rec: Recording, path: string, body: unknown, keepalive = false): Promise<Outcome | null> {
    const startedIn = generation;
    const controller = new AbortController();
    rec.abortController = controller;
    requestOwner = rec;
    rec.busy = true;
    const oldest = rec.inflight?.oldest ?? rec.queue[0];
    const remaining = oldest ? Math.max(0, rec.limits.maxBufferAgeMs - elapsed(oldest)) : REPLAY_UPLOAD_REQUEST_TIMEOUT_MS;
    const resumeRemaining = rec.resumeDeadline === null ? Infinity : Math.max(0, rec.resumeDeadline - wallNow());
    const deadline = setTimeout(() => controller.abort(), Math.min(REPLAY_UPLOAD_REQUEST_TIMEOUT_MS, remaining, resumeRemaining));
    notify();
    let outcome: Outcome;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(keepalive ? { keepalive: true } : {}),
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (response.ok) {
        outcome = { kind: "ok", payload };
      } else {
        const parsed = parseReplayUploadError(response.status, payload);
        if (parsed) outcome = { kind: "error", code: parsed.code, retryAfterMs: parsed.retryAfterMs };
        else outcome = response.status >= 500 ? { kind: "transient" } : { kind: "invalid" };
      }
    } catch {
      outcome = { kind: "transient" };
    } finally {
      clearTimeout(deadline);
      rec.abortController = null;
      if (requestOwner === rec) requestOwner = null;
      rec.busy = false;
      if (liveRecordings().length > 0 && !handoffQuiesced) {
        clearTimeout(wakeTimer);
        // Let the request's own continuation apply its receipt before waking
        // another recording; otherwise the just-accepted batch can be resent.
        wakeTimer = setTimeout(() => {
          wakeTimer = undefined;
          safely(() => {
            for (const pending of [...closing, current]) {
              if (pending && pending.phase !== "ended" && checkRetention(pending)) pump(pending);
            }
            notify();
          });
        }, 0);
      }
    }
    // A clear() or end() while in flight: the answer has nowhere to go.
    if (startedIn !== generation || rec.phase === "ended") return null;
    return outcome;
  }

  /** Waits before the next attempt; false when attempts are exhausted. */
  function scheduleRetry(rec: Recording, attempts: number, retryAfterMs?: number): boolean {
    if (attempts >= rec.limits.maxAttempts) {
      end(rec, "attempts_exhausted", "incomplete", false);
      return false;
    }
    const step = Math.min(Math.max(attempts - 1, 0), REPLAY_RETRY_BACKOFF_MS.length - 1);
    const backoff = REPLAY_RETRY_BACKOFF_MS[step]!;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    clearTimeout(rec.retryTimer);
    rec.retryTimer = setTimeout(() => {
      rec.retryTimer = undefined;
      safely(() => {
        if (checkRetention(rec)) pump(rec);
        notify();
      });
    }, delay);
    return true;
  }

  /** Applies the v1 action table to a failed request. */
  function fail(rec: Recording, outcome: Exclude<Outcome, { kind: "ok" }>, attempts: number): "retry" | "renew" | "ended" {
    if (outcome.kind === "invalid") {
      end(rec, "unavailable", "unavailable", false);
      return "ended";
    }
    if (outcome.kind === "transient" || REPLAY_ERROR_ACTIONS[outcome.code] === "retry") {
      return scheduleRetry(rec, attempts, outcome.retryAfterMs) ? "retry" : "ended";
    }
    const action = REPLAY_ERROR_ACTIONS[outcome.code];
    if (action === "renew") return "renew";
    if (action === "quarantine") end(rec, outcome.code, "incomplete", true);
    else if (action === "restart") end(rec, outcome.code, "incomplete", true);
    else end(rec, outcome.code, rec.reference ? "incomplete" : "unavailable", false);
    return "ended";
  }

  // Offline attempts are not spent: the request is simply not made.
  function offline(rec: Recording): boolean {
    rec.offline = !isOnline();
    return rec.offline;
  }

  function pump(rec: Recording) {
    if (handoffQuiesced || pendingContinuations > 0 || rec.phase === "ended" || rec.busy || requestOwner !== null || rec.retryTimer !== undefined) return;
    if (offline(rec)) {
      ensureTicker();
      return;
    }
    if (rec.phase === "registering") {
      if (rec.identityReady) runOperation(rec, () => register(rec));
      else runOperation(rec, () => establishIdentity(rec));
      return;
    }
    if (rec.renewing) {
      runOperation(rec, () => renew(rec));
      return;
    }
    if (rec.inflight) {
      runOperation(rec, () => upload(rec));
      return;
    }
    const due =
      rec.finalRequested ||
      rec.queue.length >= rec.limits.maxBatchEvents ||
      envelopeBytes(rec) + rec.queueBytes + rec.queue.length >= rec.limits.maxBatchBytes ||
      (rec.queue.length > 0 && monotonicNow() - rec.lastFlushAt >= rec.limits.flushIntervalMs);
    if (!due) return;
    if (rec.queue.length === 0 && !rec.finalRequested) return;
    const batch = freeze(rec);
    if (!batch) return;
    rec.inflight = batch;
    runOperation(rec, () => upload(rec));
  }

  /** Freezes the next batch: id, sequence, events and final never change after this. */
  function freeze(rec: Recording): FrozenBatch | null {
    if (!checkOpeningPair(rec) || (!rec.snapshotReceived && rec.queue.length < 2)) return null;
    const budget = rec.limits.maxBatchBytes - envelopeBytes(rec);
    const taken: Queued[] = [];
    let bytes = 0;
    for (const item of rec.queue) {
      if (taken.length >= rec.limits.maxBatchEvents) break;
      const next = bytes + item.bytes + (taken.length > 0 ? 1 : 0);
      if (next > budget) break;
      taken.push(item);
      bytes = next;
    }
    rec.queue = rec.queue.slice(taken.length);
    rec.queueBytes -= taken.reduce((sum, item) => sum + item.bytes, 0);
    rec.lastFlushAt = monotonicNow();
    const oldest = taken[0] ?? { mono: monotonicNow(), wall: wallNow() };
    const body: ReplayBatchRequest = Object.freeze({
      contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
      recordingToken: rec.token!,
      batchId: randomUUID(),
      sequence: rec.nextSequence,
      events: Object.freeze(taken.map((item) => item.event)) as ReplayBatchRequest["events"],
      final: rec.finalRequested && rec.queue.length === 0,
    });
    return {
      body,
      eventBytes: taken.reduce((sum, item) => sum + item.bytes, 0),
      oldest: { mono: oldest.mono, wall: oldest.wall },
      renewed: false,
      attempts: 0,
    };
  }

  async function establishIdentity(rec: Recording) {
    rec.identityAttempts++;
    const outcome = await send(rec, "/identity", { contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION });
    if (!outcome) return;
    if (outcome.kind !== "ok") {
      if (rec.resumeCheckpoint) {
        end(rec, outcome.kind === "error" ? outcome.code : "unavailable", "incomplete", false);
        notify();
        return;
      }
      if (offline(rec) && outcome.kind === "transient") rec.identityAttempts--;
      if (fail(rec, outcome, rec.identityAttempts) === "renew") end(rec, "identity_required", "unavailable", false);
      notify();
      return;
    }
    if (!replayIdentityResponseSchema.safeParse(outcome.payload).success) {
      end(rec, "unavailable", "unavailable", false);
      notify();
      return;
    }
    rec.identityReady = true;
    if (checkRetention(rec)) pump(rec);
    notify();
  }

  async function own(rec: Recording, acquire: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    const controller = new AbortController();
    rec.abortController = controller;
    rec.busy = true;
    requestOwner = rec;
    const duration = Math.min(REPLAY_UPLOAD_REQUEST_TIMEOUT_MS,
      rec.resumeDeadline === null ? Infinity : Math.max(0, rec.resumeDeadline - wallNow()));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (duration <= 0) return false;
      const cancelled = new Promise<boolean>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(false), { once: true });
        deadline = setTimeout(() => controller.abort(), duration);
      });
      const allowed = await Promise.race([acquire(controller.signal), cancelled]);
      return allowed && !controller.signal.aborted && rec.phase !== "ended";
    } catch {
      return false;
    } finally {
      clearTimeout(deadline);
      rec.abortController = null;
      rec.busy = false;
      if (requestOwner === rec) requestOwner = null;
    }
  }

  async function register(rec: Recording) {
    if (!rec.intentOwned && beforeRegistration) {
      if (!await own(rec, (signal) => beforeRegistration(rec.registration, signal))) {
        end(rec, "unavailable", "unavailable", false);
        return;
      }
      rec.intentOwned = true;
    }
    if (!liveRecordings().includes(rec)) return;
    rec.registrationAttempts++;
    const outcome = await send(rec, "/recordings", rec.registration);
    if (!outcome) return;
    if (outcome.kind !== "ok") {
      // A consumed handoff is one attempt. Lost/uncertain registration is
      // not retried into an apparently proven continuation.
      if (rec.resumeCheckpoint) {
        end(rec, outcome.kind === "error" ? outcome.code : "unavailable", "incomplete", false);
        notify();
        return;
      }
      if (offline(rec) && outcome.kind === "transient") rec.registrationAttempts--;
      if (fail(rec, outcome, rec.registrationAttempts) === "renew") end(rec, "unavailable", "unavailable", false);
      notify();
      return;
    }
    const parsed = replayRecordingCapabilitySchema.safeParse(outcome.payload);
    if (!parsed.success || parsed.data.startedAt !== rec.registration.startedAt) {
      end(rec, "unavailable", "unavailable", false);
      notify();
      return;
    }
    const capability = parsed.data;
    // This new boundary has not uploaded anything before receiving its first
    // registration acknowledgment. A nonzero sequence belongs to a producer
    // whose history this instance cannot prove; never splice our snapshot in.
    const checkpoint = rec.resumeCheckpoint;
    if (checkpoint ? (
      capability.recordingId !== checkpoint.recordingId ||
      capability.startedAt !== checkpoint.startedAt ||
      capability.nextSequence !== checkpoint.nextSequence ||
      Object.entries(checkpoint.limits).some(([key, value]) => capability.limits[key as keyof Limits] !== value) ||
      ["incomplete", "unavailable", "expired", "deleted"].includes(capability.availability)
    ) : capability.nextSequence !== 0) {
      end(rec, "out_of_order", "incomplete", !checkpoint);
      notify();
      return;
    }
    // An acquisition may finish immediately before cancellation, before the
    // public reference is bound. Cleanup must still know which lease to release.
    rec.ownedRecordingId = capability.recordingId;
    if (acquireOwnership && !await own(rec, (signal) => acquireOwnership(rec.registration, capability.recordingId, signal))) {
      end(rec, "unavailable", "unavailable", false);
      notify();
      return;
    }
    if (rec.phase === "ended") return;
    rec.reference = Object.freeze({
      recordingId: capability.recordingId,
      startedAt: capability.startedAt,
      boundary: rec.boundary,
    });
    rec.token = capability.recordingToken;
    rec.limits = { ...capability.limits };
    rec.nextSequence = capability.nextSequence;
    rec.availability = capability.availability;
    rec.phase = "open";
    rec.resumeDeadline = null;
    rec.lastFlushAt = monotonicNow();
    recordHistory(rec);
    // An event too large for the recording's own limits is never truncated.
    if (rec.queue.some((item) => !fitsAlone(rec, item.bytes))) {
      end(rec, "snapshot_too_large", "unavailable", false);
    } else if (checkOpeningPair(rec) && checkRetention(rec)) {
      ensureTicker();
      pump(rec);
    }
    notify();
  }

  async function renew(rec: Recording) {
    rec.renewAttempts++;
    const outcome = await send(rec, `/recordings/${encodeURIComponent(rec.reference!.recordingId)}/capability`, {
      contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
    });
    if (!outcome) return;
    if (outcome.kind !== "ok") {
      if (offline(rec) && outcome.kind === "transient") rec.renewAttempts--;
      // An expired capability on renewal is not renewed again.
      if (fail(rec, outcome, rec.renewAttempts) === "renew") end(rec, "capability_expired", "incomplete", false);
      notify();
      return;
    }
    const parsed = replayRecordingCapabilitySchema.safeParse(outcome.payload);
    if (
      !parsed.success ||
      parsed.data.recordingId !== rec.reference!.recordingId ||
      parsed.data.startedAt !== rec.reference!.startedAt
    ) {
      end(rec, "unavailable", "incomplete", false);
      notify();
      return;
    }
    // Only the capability changes: renewal's nextSequence is diagnostic and
    // never renumbers the pending batch.
    rec.token = parsed.data.recordingToken;
    rec.availability = parsed.data.availability;
    rec.renewing = false;
    rec.renewAttempts = 0;
    if (rec.inflight) {
      rec.inflight = { ...rec.inflight, body: Object.freeze({ ...rec.inflight.body, recordingToken: rec.token }) };
    }
    pump(rec);
    notify();
  }

  async function upload(rec: Recording, keepalive = false) {
    const batch = rec.inflight!;
    batch.attempts++;
    const outcome = await send(
      rec,
      `/recordings/${encodeURIComponent(rec.reference!.recordingId)}/batches`,
      batch.body,
      keepalive,
    );
    if (!outcome) return;
    if (outcome.kind !== "ok") {
      if (offline(rec) && outcome.kind === "transient") batch.attempts--;
      const next = fail(rec, outcome, batch.attempts);
      if (next === "renew") {
        if (batch.renewed) {
          end(rec, "capability_expired", "incomplete", false);
        } else {
          batch.renewed = true;
          rec.renewing = true;
          pump(rec);
        }
      }
      notify();
      return;
    }
    const parsed = replayBatchAcknowledgmentSchema.safeParse(outcome.payload);
    if (
      !parsed.success ||
      parsed.data.recordingId !== rec.reference!.recordingId ||
      parsed.data.batchId !== batch.body.batchId ||
      parsed.data.sequence !== batch.body.sequence ||
      (parsed.data.delivery === "finalized") !== (batch.body.events.length === 0 && batch.body.final)
    ) {
      end(rec, "unavailable", "incomplete", false);
      notify();
      return;
    }
    rec.inflight = null;
    rec.nextSequence = parsed.data.nextSequence;
    rec.availability = parsed.data.availability;
    if (parsed.data.delivery === "accepted") {
      rec.acceptedBatches++;
      if (!batch.body.final) rec.lastAcknowledgment = Object.freeze({ ...parsed.data });
      const hadSnapshot = rec.snapshotReceived;
      for (const event of batch.body.events) {
        if (rec.opening === "meta") rec.opening = event.type === 4 ? "snapshot" : "invalid";
        else if (rec.opening === "snapshot") rec.opening = event.type === 2 ? "received" : "invalid";
      }
      rec.snapshotReceived = rec.opening === "received";
      if (hadSnapshot && batch.body.events.length > 0) rec.postOpeningBatches++;
      if (rec.continuation === "resuming" && rec.snapshotReceived) rec.continuation = "resumed";
    }
    if (batch.body.final) {
      rec.outcome = "closed";
      rec.phase = "ended";
      rec.token = null;
      rec.reason = null;
      recordHistory(rec);
      closing = closing.filter((other) => other !== rec);
      if (rec === current) {
        current = null;
        terminal = { status: "idle", reason: null };
      }
      stopTickerIfIdle();
      releaseOwnership(rec);
    } else {
      recordHistory(rec);
      pump(rec);
    }
    notify();
  }

  // ---- sink --------------------------------------------------------------

  function push(event: eventWithTime, boundary: number) {
    if (halted || handoffQuiesced) return;
    if (boundary < lastBoundary || (boundary === lastBoundary && current?.boundary !== boundary)) return;
    if (boundary > lastBoundary) {
      retireCurrent();
      lastBoundary = boundary;
      current = startRecording(boundary, event);
      terminal = { status: "idle", reason: null };
    }
    const rec = current!;
    if (rec.resumeCheckpoint && rec.phase === "registering") return;
    if (rec.phase === "ended") {
      notify();
      return;
    }
    // Own the serialized event so a producer cannot change a pending batch
    // after its identity and byte budget have been frozen.
    const serialized = JSON.stringify(event);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (!fitsAlone(rec, bytes)) {
      end(rec, "snapshot_too_large", "unavailable", false);
      notify();
      return;
    }
    rec.queue.push({ event: JSON.parse(serialized) as eventWithTime, bytes, mono: monotonicNow(), wall: wallNow() });
    rec.queueBytes += bytes;
    ensureTicker();
    if (checkOpeningPair(rec) && checkRetention(rec)) pump(rec);
    notify();
  }

  function dropAll() {
    generation++;
    for (const rec of [current, ...closing]) {
      if (!rec || rec.phase === "ended") continue;
      // Withdrawal drops local data only; nothing already uploaded is deleted.
      end(rec, null, "incomplete", false);
    }
    current = null;
    closing = [];
    terminal = { status: "idle", reason: null };
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
    handoffQuiesced = false;
    handedOff = false;
  }

  function checkpoint(): ReplayUploadCheckpoint | null {
    const rec = current;
    if (
      !rec || rec.phase !== "open" || !rec.reference || !rec.snapshotReceived || !rec.lastAcknowledgment ||
      rec.finalRequested || rec.queue.length !== 0 || rec.queueBytes !== 0 || rec.inflight ||
      requestOwner || rec.busy || rec.renewing || rec.retryTimer !== undefined ||
      pendingContinuations !== 0 || closing.length !== 0 || rec.offline || !isOnline() ||
      wakeTimer !== undefined || rec.lastAcknowledgment.nextSequence !== rec.nextSequence
    ) return null;
    return replayUploadCheckpointSchema.parse({
      registration: rec.registration,
      recordingId: rec.reference.recordingId,
      startedAt: rec.reference.startedAt,
      nextSequence: rec.nextSequence,
      limits: { ...rec.limits },
      lastAcknowledgment: rec.lastAcknowledgment,
      acceptedBatches: rec.acceptedBatches,
      snapshotReceived: true,
    });
  }

  function safeCheckpoint(): ReplayUploadCheckpoint | null {
    try { return checkpoint(); } catch { return null; }
  }

  const uploader = {
    push(event: eventWithTime, boundary: number): void {
      safely(() => push(event, boundary));
    },

    /** Consent withdrawal: drops queued capture data and timers, keeps history. */
    clear(): void {
      safely(() => {
        dropAll();
        notify();
      });
    },

    /** A pure metadata view; an ACK cursor never substitutes for local receipt evidence. */
    getCheckpoint(): ReplayUploadCheckpoint | null {
      return safeCheckpoint();
    },

    /** Caller must detach capture first. Does not drop queued events or send final. */
    quiesceForHandoff(): ReplayUploadCheckpoint | null {
      handoffQuiesced = true;
      if (ticker !== undefined) clearInterval(ticker);
      ticker = undefined;
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
      const result = safeCheckpoint();
      if (!result) {
        handoffQuiesced = false;
        if (liveRecordings().length > 0) ensureTicker();
      }
      return result;
    },

    /** Metadata was persisted under ownership. Retire locally without closing centrally. */
    commitHandoff(): boolean {
      if (!handoffQuiesced || !safeCheckpoint() || !current) return false;
      const rec = current;
      generation++;
      halted = true;
      handedOff = true;
      rec.phase = "ended";
      rec.token = null;
      // The server may stay open forever if nobody resumes. This is not a close ACK.
      rec.outcome = "open";
      recordHistory(rec);
      current = null;
      terminal = { status: "idle", reason: null };
      releaseOwnership(rec);
      notify();
      return true;
    },

    /** A consumed handoff or this producer's quiesced frontier, under continued ownership. */
    async resumeFromCheckpoint(
      input: ReplayUploadCheckpoint,
      boundary = 1,
      options: { signal?: AbortSignal; deadline?: number; revalidate?: boolean } = {},
    ): Promise<boolean> {
      const parsed = replayUploadCheckpointSchema.safeParse(input);
      if (!parsed.success || options.signal?.aborted || requestOwner || pendingContinuations > 0 ||
        boundary <= lastBoundary || (options.deadline !== undefined && options.deadline <= wallNow())) return false;
      const saved = parsed.data;
      if (saved.registration.configVersion !== getConfigVersion() || saved.registration.release !== documentRelease(getDocumentRelease())) return false;
      const predecessor = options.revalidate ? current : null;
      if (options.revalidate) {
        const ownedFrontier = handoffQuiesced ? safeCheckpoint() : null;
        if (!predecessor || !ownedFrontier || JSON.stringify(ownedFrontier) !== JSON.stringify(saved)) return false;
      } else if (liveRecordings().length > 0) return false;
      const rec = startRecording(boundary, { timestamp: saved.startedAt });
      if (rec.phase === "ended") return false;
      if (predecessor) {
        // No events, requests, timers or receipt continuations remain. Transfer
        // the lease to the successor without invoking the release callback.
        predecessor.phase = "ended";
        predecessor.token = null;
        predecessor.ownershipReleased = true;
        rec.intentOwned = predecessor.intentOwned;
      }
      halted = false;
      handoffQuiesced = false;
      handedOff = false;
      rec.registration = Object.freeze(saved.registration);
      rec.resumeCheckpoint = saved;
      // The caller already holds this recording's lease during resume identity
      // bootstrap. Abort before registration still owes that lease a release.
      rec.ownedRecordingId = saved.recordingId;
      rec.resumeDeadline = options.deadline ?? wallNow() + REPLAY_UPLOAD_REQUEST_TIMEOUT_MS;
      rec.continuation = "resuming";
      rec.nextSequence = saved.nextSequence;
      rec.acceptedBatches = saved.acceptedBatches;
      rec.lastAcknowledgment = Object.freeze(saved.lastAcknowledgment);
      current = rec;
      lastBoundary = boundary;
      terminal = { status: "idle", reason: null };
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = () => {
          if (done || rec.phase === "registering") return;
          done = true;
          listeners.delete(finish);
          options.signal?.removeEventListener("abort", abort);
          clearTimeout(deadline);
          resolve(rec.phase === "open");
        };
        const abort = () => {
          end(rec, "unavailable", "incomplete", false);
          notify();
        };
        listeners.add(finish);
        options.signal?.addEventListener("abort", abort, { once: true });
        const deadline = setTimeout(abort, Math.max(0, rec.resumeDeadline! - wallNow()));
        pump(rec);
        notify();
      });
    },

    getProgress(): ReplayUploadProgress {
      return {
        snapshotReceived: current?.snapshotReceived ?? false,
        acceptedBatches: current?.acceptedBatches ?? 0,
        postOpeningBatches: current?.postOpeningBatches ?? 0,
        continuity: handedOff ? "handoff" : current?.continuation ?? "fresh",
      };
    },

    /** Stop first; a rejected/aborted promise is not proof its request has settled. */
    hasPendingWork(): boolean {
      return pendingContinuations > 0 || requestOwner !== null || closing.length > 0 ||
        liveRecordings().some((rec) => rec.busy || rec.inflight !== null || rec.queue.length > 0 || rec.retryTimer !== undefined);
    },

    /**
     * Best effort on pagehide: one final keepalive request, only when its
     * entire encoded body is <= 64 KiB and nothing else is in flight. Never
     * bypasses one-in-flight or retention bounds, and promises nothing.
     */
    flushOnPageHide(): void {
      safely(() => {
        // Failed checkpoint persistence falls back to the existing final path.
        handoffQuiesced = false;
        const rec = current;
        if (!rec || rec.phase !== "open" || rec.busy || requestOwner !== null || rec.inflight || rec.retryTimer !== undefined || rec.offline || pendingContinuations > 0) return;
        if (!checkRetention(rec)) return;
        rec.finalRequested = true;
        const batch = freeze(rec);
        if (!batch) {
          notify();
          return;
        }
        if (rec.queue.length > 0 || jsonByteLength(batch.body) > KEEPALIVE_MAX_BYTES) {
          // Too large for keepalive: put the events back unchanged.
          rec.queue = [
            ...batch.body.events.map((event) => ({ event, bytes: jsonByteLength(event), mono: batch.oldest.mono, wall: batch.oldest.wall })),
            ...rec.queue,
          ];
          rec.queueBytes += batch.eventBytes;
          rec.finalRequested = false;
          return;
        }
        rec.inflight = batch;
        runOperation(rec, () => upload(rec, true));
        notify();
      });
    },

    /** Stops for good (e.g. the restart budget is spent); state stays as it is. */
    halt(): void {
      halted = true;
    },

    /** Only an explicit pipeline restart releases its exhausted recovery budget. */
    resume(): void {
      halted = false;
      handoffQuiesced = false;
    },

    dispose(): void {
      safely(() => {
        dropAll();
        halted = true;
        notify();
      });
    },

    /** Only ever a reference returned by a successful registration in this tab. */
    getRecordingReference(): ReplayRecordingReference | null {
      return state.current;
    },

    /** Independent of a clean upload frontier; safe even while a batch is pending. */
    getRecordingContext(): ReplayRecordingContext | null {
      if (halted || handoffQuiesced || !current?.reference || current.phase === "ended") return null;
      return Object.freeze({ ...current.reference, release: current.registration.release,
        configVersion: current.registration.configVersion });
    },

    /** Optional markers must never end a recording merely by exceeding its wire budget. */
    preflightMarker(event: eventWithTime, boundary: number): "recording_unavailable" | "marker_too_large" | "invalid_payload" | null {
      if (halted || handoffQuiesced || !current?.reference || current.phase === "ended" || current.boundary !== boundary) return "recording_unavailable";
      if (!Number.isSafeInteger(event.timestamp) || event.timestamp < current.reference.startedAt) return "invalid_payload";
      try {
        return fitsAlone(current, jsonByteLength(event)) ? null : "marker_too_large";
      } catch { return "marker_too_large"; }
    },

    /** Stable between changes, so it can back `useSyncExternalStore`. */
    getState(): ReplayUploadState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies ReplayEventSink & Record<string, unknown>;

  return uploader;
}

export type ReplayUploader = ReturnType<typeof createReplayUploader>;
