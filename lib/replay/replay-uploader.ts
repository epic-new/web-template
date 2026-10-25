import type { eventWithTime } from "@rrweb/types";
import type { z } from "zod";

import type { PublicReplayConfig } from "./replay-config.contract";
import { jsonByteLength } from "./replay-redaction";
import {
  REPLAY_RECORDER_VERSION,
  REPLAY_RELEASE_PATTERN,
  REPLAY_SUBJECT_ENVELOPE_ALLOWANCE_BYTES,
  REPLAY_UPLOAD_CONTRACT_VERSION,
  replayBatchResponseSchema,
  replayIdentityResponseSchema,
  replayRecordingResponseSchema,
  replayRegistrationRequestSchema,
  replayUploadErrorBodySchema,
  toReplayPathname,
  type ReplayAvailability,
  type ReplayRegistrationRequest,
  type ReplayUploadErrorCode,
} from "./replay-upload-contract";

/**
 * The browser transport for a recording: it registers first, then uploads the
 * redacted events as ordered batches through this application's own routes,
 * one request in flight at a time. See docs/replay-privacy.md.
 *
 * It plugs into `createReplayCaptureSession` as the sink the memory buffer
 * used to be. Every boundary the session starts becomes one recording:
 * registered with the first event's timestamp as its immutable `startedAt`,
 * then drained in frozen batches whose id, sequence and events never change
 * once chosen, however often they are retried. Nothing it does can throw
 * into the page; every failure only changes its state.
 *
 * Time is monotonic on purpose. Buffer age, backoff and request deadlines
 * use `monotonicNow()`, so a wall-clock jump or a suspended tab cannot extend
 * how long private events are held. Event and wire timestamps stay the
 * original browser epoch milliseconds.
 */

type Limits = PublicReplayConfig["recording"]["limits"];

export interface ReplayRecordingReference {
  recordingId: string;
  startedAt: number;
  boundary: number;
}

export type ReplayHistoryOutcome = "open" | "incomplete" | "closed" | "unavailable";

export interface ReplayHistoryEntry {
  reference: ReplayRecordingReference;
  outcome: ReplayHistoryOutcome;
  acceptedBatches: number;
  availability: ReplayAvailability | null;
}

export type ReplayUploadStatus =
  | "idle"
  | "recorder_started"
  | "registered"
  | "uploading"
  | "pending"
  | "unavailable";

export type ReplayUploadReason =
  | ReplayUploadErrorCode
  | "offline"
  | "buffer_exceeded"
  | "attempts_exhausted"
  | "snapshot_too_large";

export interface ReplayUploadState {
  status: ReplayUploadStatus;
  reason: ReplayUploadReason | null;
  /** Set only from a successful registration; frozen. */
  current: ReplayRecordingReference | null;
  /** The most recent recordings, newest last. */
  history: readonly ReplayHistoryEntry[];
  bufferedEvents: number;
  bufferedBytes: number;
  /** A registration or accepted batch is never evidence of playback. */
  evidence: "unverified";
}

export interface ReplayUploaderOptions {
  getLimits: () => Limits;
  getConfigVersion: () => string | null;
  /** The immutable build identity of this document, or null when unknown. */
  getDocumentRelease: () => string | null;
  fetch?: typeof fetch;
  monotonicNow?: () => number;
  isOnline?: () => boolean;
  getViewport?: () => { width: number; height: number } | null;
  getPathname?: () => string;
  randomUUID?: () => string;
  onRecordingLost?: (reason: ReplayUploadReason) => void;
  baseUrl?: string;
}

const BACKOFF_MS = [500, 1_000, 2_000];
const REQUEST_TIMEOUT_MS = 12_000;
const OFFLINE_POLL_MS = 500;
const STATE_THROTTLE_MS = 250;
const HISTORY_SIZE = 10;
const KEEPALIVE_MAX_BYTES = 64 * 1_024;
const MAX_CLOSING_SEGMENTS = 2;
const META = 4;
const FULL_SNAPSHOT = 2;

interface QueuedEvent {
  event: eventWithTime;
  bytes: number;
  at: number;
}

interface FrozenBatch {
  batchId: string;
  sequence: number;
  events: eventWithTime[];
  bytes: number;
  final: boolean;
  oldestAt: number | null;
}

interface Segment {
  boundary: number;
  startedAt: number;
  firstEvent: eventWithTime;
  registration: ReplayRegistrationRequest | null;
  phase: "pending" | "registered" | "dead";
  recording: { id: string; token: string } | null;
  queue: QueuedEvent[];
  queueBytes: number;
  frozen: FrozenBatch | null;
  /** The next sequence to freeze. */
  sequence: number;
  accepted: number;
  closing: boolean;
  attempts: number;
  retryAt: number;
  renewed: boolean;
  lastFlushAt: number | null;
  /** Set when the tab hides: send what is queued now, without closing. */
  flushRequested: boolean;
  entry: ReplayHistoryEntry | null;
  lostReason: ReplayUploadReason | null;
}

type Failure =
  | { kind: "network" }
  | {
      kind: "error";
      status: number;
      code: ReplayUploadErrorCode;
      retryAfterMs?: number;
    };

type Result<T> = { ok: true; status: number; body: T } | ({ ok: false } & Failure);

// Losses after which a fresh recording is the right recovery.
const OLD_RECORDING_CODES = new Set<ReplayUploadErrorCode>([
  "invalid_capability",
  "subject_mismatch",
  "recording_not_found",
  "recording_closed",
]);
const INCOMPLETE_CODES = new Set<ReplayUploadErrorCode>(["recording_closed"]);
// A batch answered with one of these, or not answered at all, may or may not
// be stored. Retrying the identical batch is safe: playback drops duplicates.
const TRANSIENT_CODES = new Set<ReplayUploadErrorCode>(["unavailable", "rate_limited"]);

export function createReplayUploader(options: ReplayUploaderOptions) {
  const {
    getLimits,
    getConfigVersion,
    getDocumentRelease,
    onRecordingLost,
    baseUrl = "/api/epic/replay",
    fetch: fetchOption,
    monotonicNow = () => performance.now(),
    isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    getViewport = defaultViewport,
    getPathname = () => window.location.pathname,
    randomUUID = () => crypto.randomUUID(),
  } = options;

  let segments: Segment[] = [];
  const history: ReplayHistoryEntry[] = [];
  let identityAcked = false;
  let running: Segment | null = null;
  let inflight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = 0;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let removeOnline: (() => void) | undefined;
  const listeners = new Set<() => void>();

  let state: ReplayUploadState = {
    status: "idle",
    reason: null,
    current: null,
    history: [],
    bufferedEvents: 0,
    bufferedBytes: 0,
    evidence: "unverified",
  };

  function fetchImpl(): typeof fetch {
    return fetchOption ?? globalThis.fetch.bind(globalThis);
  }

  // ---- state ---------------------------------------------------------------

  const active = () => segments[segments.length - 1];

  function held(segment: Segment) {
    return {
      events: segment.queue.length + (segment.frozen?.events.length ?? 0),
      bytes: segment.queueBytes + (segment.frozen?.bytes ?? 0),
    };
  }

  function totalHeld() {
    return segments.reduce(
      (total, segment) => {
        const { events, bytes } = held(segment);
        return { events: total.events + events, bytes: total.bytes + bytes };
      },
      { events: 0, bytes: 0 },
    );
  }

  function compute(): ReplayUploadState {
    const current = active();
    const totals = totalHeld();
    const offline = !isOnline();
    let status: ReplayUploadStatus = "idle";
    let reason: ReplayUploadReason | null = null;

    if (current) {
      if (current.lostReason) {
        status = "unavailable";
        reason = current.lostReason;
      } else if (current.phase === "pending") {
        status = "recorder_started";
      } else if (running === current) {
        status = "uploading";
      } else {
        status = current.accepted > 0 ? "pending" : "registered";
      }
      if (!reason && offline && totals.events > 0) reason = "offline";
    }

    return {
      status,
      reason,
      current:
        current && current.phase !== "dead" && current.entry ? { ...current.entry.reference } : null,
      history: history.slice(-HISTORY_SIZE).map((entry) => ({ ...entry, reference: { ...entry.reference } })),
      bufferedEvents: totals.events,
      bufferedBytes: totals.bytes,
      evidence: "unverified",
    };
  }

  function sameState(a: ReplayUploadState, b: ReplayUploadState) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function emit(next: ReplayUploadState) {
    if (sameState(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  // Structural changes are published now; buffer counters only every
  // STATE_THROTTLE_MS, so a stream of events does not re-render subscribers.
  function publish(immediate = true) {
    if (immediate) {
      clearTimeout(stateTimer);
      stateTimer = undefined;
      emit(compute());
      return;
    }
    if (stateTimer !== undefined) return;
    stateTimer = setTimeout(() => {
      stateTimer = undefined;
      emit(compute());
    }, STATE_THROTTLE_MS);
  }

  // ---- segments ------------------------------------------------------------

  function recordHistory(segment: Segment, id: string) {
    const entry: ReplayHistoryEntry = {
      reference: { recordingId: id, startedAt: segment.startedAt, boundary: segment.boundary },
      outcome: "open",
      acceptedBatches: 0,
      availability: "waiting_for_events",
    };
    segment.entry = entry;
    history.push(entry);
    if (history.length > HISTORY_SIZE * 2) history.splice(0, history.length - HISTORY_SIZE);
  }

  // A function, so a check after an await is not narrowed away by the compiler.
  function isDead(segment: Segment): boolean {
    return segment.phase === "dead";
  }

  function discard(segment: Segment) {
    segment.queue = [];
    segment.queueBytes = 0;
    segment.frozen = null;
  }

  function lose(segment: Segment, reason: ReplayUploadReason, outcome: ReplayHistoryOutcome = "unavailable") {
    if (isDead(segment)) return;
    const wasActive = segment === active();
    segment.phase = "dead";
    segment.lostReason = reason;
    discard(segment);
    if (segment.entry) segment.entry.outcome = outcome;
    if (running === segment) inflight?.abort();
    publish();
    if (wasActive) notifyLost(reason);
    schedule(0);
  }

  function notifyLost(reason: ReplayUploadReason) {
    try {
      onRecordingLost?.(reason);
    } catch {
      // The owner failing to react never reaches the page.
    }
  }

  function finish(segment: Segment) {
    segment.phase = "dead";
    discard(segment);
    if (segment.entry) segment.entry.outcome = "closed";
  }

  function prune() {
    const last = active();
    segments = segments.filter((segment) => segment === last || (segment.phase !== "dead" && !isIdleClosed(segment)));
    const closing = segments.filter((segment) => segment !== last);
    for (const extra of closing.slice(0, Math.max(closing.length - MAX_CLOSING_SEGMENTS, 0))) {
      discard(extra);
      extra.phase = "dead";
      if (extra.entry) extra.entry.outcome = "incomplete";
    }
    segments = segments.filter((segment) => segment === last || segment.phase !== "dead");
  }

  // A closing recording that never uploaded anything has nothing to finish.
  function isIdleClosed(segment: Segment) {
    return segment.closing && segment.accepted === 0 && segment.sequence === 0 && !segment.frozen && segment.queue.length === 0 && segment.recording !== null;
  }

  function beginClosing(segment: Segment) {
    if (segment.phase !== "dead") segment.closing = true;
  }

  // ---- sink ----------------------------------------------------------------

  function normalize(event: eventWithTime): eventWithTime {
    if (event.type !== META) return event;
    const data = event.data as { href?: unknown };
    if (typeof data.href !== "string") return event;
    // Epic rejects a Meta href with a query or fragment.
    const href = data.href.replace(/[?#].*$/, "");
    return href === data.href ? event : ({ ...event, data: { ...data, href } } as eventWithTime);
  }

  function push(event: eventWithTime, boundary: number) {
    try {
      if (disposed) return;
      let segment = active();
      if (!segment || segment.boundary !== boundary) {
        if (segment && boundary < segment.boundary) return;
        if (segment) beginClosing(segment);
        segment = {
          boundary,
          startedAt: event.timestamp,
          firstEvent: event,
          registration: null,
          phase: "pending",
          recording: null,
          queue: [],
          queueBytes: 0,
          frozen: null,
          sequence: 0,
          accepted: 0,
          closing: false,
          attempts: 0,
          retryAt: 0,
          renewed: false,
          lastFlushAt: null,
          flushRequested: false,
          entry: null,
          lostReason: null,
        };
        segments.push(segment);
        prune();
        listenOnline();
      }
      if (isDead(segment)) return;

      const normalized = normalize(event);
      const bytes = jsonByteLength(normalized) + 1;
      const limits = getLimits();
      if (totalHeld().bytes + bytes > limits.maxBufferBytes) {
        lose(segment, "buffer_exceeded");
        return;
      }
      segment.queue.push({ event: normalized, bytes, at: monotonicNow() });
      segment.queueBytes += bytes;
      publish(false);
      wake(segment, limits);
    } catch {
      // Capture must never break the page.
    }
  }

  function wake(segment: Segment, limits: Limits) {
    const full = isFull(segment, limits);
    if (full || segment.phase === "pending" || segment.lastFlushAt === null) {
      schedule(0);
      return;
    }
    schedule(segment.lastFlushAt + limits.flushIntervalMs - monotonicNow());
  }

  function isFull(segment: Segment, limits: Limits): boolean {
    return (
      segment.queue.length >= limits.maxBatchEvents ||
      segment.queueBytes >= limits.maxBatchBytes ||
      segment.queueBytes >= limits.flushBytes
    );
  }

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    inflight?.abort();
    for (const segment of segments) {
      discard(segment);
      if (segment.phase !== "dead" && segment.entry && segment.entry.outcome === "open") {
        segment.entry.outcome = "incomplete";
      }
      segment.phase = "dead";
    }
    segments = [];
    publish();
  }

  // ---- scheduling ----------------------------------------------------------

  // Keeps the earliest pending wake-up, so a stream of events cannot keep
  // pushing the next flush back.
  function schedule(delay: number) {
    if (disposed) return;
    const at = monotonicNow() + Math.max(delay, 0);
    if (timer !== undefined && timerAt <= at) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, Math.max(delay, 0));
  }

  function listenOnline() {
    if (removeOnline || typeof window === "undefined") return;
    const onOnline = () => schedule(0);
    const onOffline = () => publish();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    removeOnline = () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }

  function oldestAt(segment: Segment): number | null {
    const times = [segment.frozen?.oldestAt ?? null, segment.queue[0]?.at ?? null].filter(
      (time): time is number => time !== null,
    );
    return times.length ? Math.min(...times) : null;
  }

  function retentionLeft(segment: Segment): number {
    const at = oldestAt(segment);
    return at === null ? Infinity : at + getLimits().maxBufferAgeMs - monotonicNow();
  }

  function enforceRetention() {
    for (const segment of [...segments]) {
      if (segment.phase !== "dead" && retentionLeft(segment) < 0) lose(segment, "buffer_exceeded");
    }
  }

  function due(segment: Segment, limits: Limits): boolean {
    if (segment.phase === "pending" || segment.frozen) return true;
    if (segment.queue.length > 0) {
      // Sequence 0 opens with Meta and FullSnapshot together.
      if (segment.sequence === 0 && segment.queue.length < 2) return false;
      if (segment.closing || segment.flushRequested || segment.lastFlushAt === null) return true;
      if (isFull(segment, limits)) return true;
      return monotonicNow() - segment.lastFlushAt >= limits.flushIntervalMs;
    }
    return segment.closing && segment.accepted > 0;
  }

  async function tick() {
    if (running || disposed) return;
    try {
      enforceRetention();
      prune();
      const limits = getLimits();
      const ready = segments.find((segment) => segment.phase !== "dead" && due(segment, limits));
      if (!ready) {
        const waiting = segments.find((segment) => segment.phase !== "dead" && segment.queue.length > 0);
        if (waiting) {
          // Without a first flush it is waiting for sequence 0's second event,
          // which wakes it; only retention can fire before that.
          const nextFlush =
            waiting.lastFlushAt === null
              ? Infinity
              : waiting.lastFlushAt + limits.flushIntervalMs - monotonicNow();
          schedule(Math.min(Math.max(nextFlush, 0), Math.max(retentionLeft(waiting), 0)));
        }
        publish();
        return;
      }

      if (!isOnline()) {
        publish();
        schedule(Math.min(OFFLINE_POLL_MS, Math.max(retentionLeft(ready), 0)));
        return;
      }
      const wait = ready.retryAt - monotonicNow();
      if (wait > 0) {
        schedule(Math.min(wait, Math.max(retentionLeft(ready), 0)));
        return;
      }

      running = ready;
      publish();
      try {
        await step(ready, limits);
      } finally {
        running = null;
      }
      publish();
      schedule(0);
    } catch {
      running = null;
      const current = active();
      if (current) lose(current, "unavailable");
    }
  }

  // ---- requests ------------------------------------------------------------

  async function call<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    segment: Segment | null,
    { keepalive = false }: { keepalive?: boolean } = {},
  ): Promise<Result<T>> {
    const controller = new AbortController();
    inflight = controller;
    const budget = segment ? retentionLeft(segment) : Infinity;
    const timeout = setTimeout(() => controller.abort(), Math.max(Math.min(REQUEST_TIMEOUT_MS, budget), 1));
    try {
      const response = await fetchImpl()(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        keepalive,
      });
      const json: unknown = await response.json().catch(() => undefined);
      if (response.ok) {
        const parsed = schema.safeParse(json);
        return parsed.success ? { ok: true, status: response.status, body: parsed.data } : { ok: false, kind: "network" };
      }
      const error = replayUploadErrorBodySchema.safeParse(json);
      if (!error.success) return { ok: false, kind: "network" };
      return {
        ok: false,
        kind: "error",
        status: response.status,
        code: error.data.code,
        retryAfterMs: error.data.retryAfterMs,
      };
    } catch {
      return { ok: false, kind: "network" };
    } finally {
      clearTimeout(timeout);
      if (inflight === controller) inflight = null;
    }
  }

  // Counts an attempt against the current operation and schedules the retry.
  function retryLater(segment: Segment, retryAfterMs?: number) {
    segment.attempts += 1;
    if (segment.attempts >= getLimits().maxAttempts) {
      lose(segment, "attempts_exhausted");
      return;
    }
    const backoff = BACKOFF_MS[Math.min(segment.attempts - 1, BACKOFF_MS.length - 1)]!;
    segment.retryAt = monotonicNow() + Math.max(backoff, retryAfterMs ?? 0);
  }

  // The exact action for each failure (EPI-210 normative error table).
  function onFailure(segment: Segment, failure: Failure) {
    if (isDead(segment)) return;
    if (failure.kind === "network" || TRANSIENT_CODES.has(failure.code)) {
      retryLater(segment, failure.kind === "error" ? failure.retryAfterMs : undefined);
      return;
    }
    const code = failure.code;
    lose(segment, code, INCOMPLETE_CODES.has(code) ? "incomplete" : "unavailable");
  }

  async function step(segment: Segment, limits: Limits) {
    if (segment.phase === "pending") return register(segment);
    return upload(segment, limits);
  }

  async function register(segment: Segment) {
    if (!identityAcked) {
      const identity = await call(
        "/identity",
        { contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION, purpose: "capture" },
        replayIdentityResponseSchema,
        segment,
      );
      if (isDead(segment)) return;
      if (!identity.ok) return onFailure(segment, identity);
      identityAcked = true;
    }

    if (!segment.registration) {
      const parsed = replayRegistrationRequestSchema.safeParse({
        contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
        idempotencyKey: randomUUID(),
        startedAt: segment.startedAt,
        route: registrationRoute(segment),
        recorderVersion: REPLAY_RECORDER_VERSION,
        configVersion: getConfigVersion() ?? "",
        release: documentRelease(),
        viewport: getViewport(),
      });
      if (!parsed.success) return lose(segment, "invalid_request");
      segment.registration = parsed.data;
    }

    const result = await call("/recordings", segment.registration, replayRecordingResponseSchema, segment);
    if (isDead(segment)) return;
    if (!result.ok) return onFailure(segment, result);

    const { recordingId, recordingToken, startedAt } = result.body;
    // Another producer's recording is not ours to extend.
    if (startedAt !== segment.startedAt) return lose(segment, "recording_closed", "incomplete");
    segment.recording = { id: recordingId, token: recordingToken };
    segment.phase = "registered";
    segment.attempts = 0;
    recordHistory(segment, recordingId);
    segment.entry!.availability = result.body.availability;
  }

  function documentRelease(): string | null {
    const release = getDocumentRelease();
    return release && REPLAY_RELEASE_PATTERN.test(release) ? release : null;
  }

  function registrationRoute(segment: Segment): string {
    const data = segment.firstEvent.data as { href?: unknown };
    try {
      if (segment.firstEvent.type === META && typeof data.href === "string") {
        return toReplayPathname(new URL(data.href).pathname) ?? "/";
      }
    } catch {
      // Fall through to the current location.
    }
    return toReplayPathname(getPathname()) ?? "/";
  }

  function envelopeBytes(segment: Segment, sequence: number): number {
    return (
      jsonByteLength({
        contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
        recordingToken: segment.recording?.token ?? "",
        batchId: "00000000-0000-0000-0000-000000000000",
        sequence: Math.max(sequence, 1_000_000),
        events: [],
        final: false,
      }) + REPLAY_SUBJECT_ENVELOPE_ALLOWANCE_BYTES
    );
  }

  // Chooses the next batch once; from then on only that frozen batch is retried.
  function freeze(segment: Segment, limits: Limits): "frozen" | "wait" | "lost" {
    if (segment.queue.length === 0) {
      if (!(segment.closing && segment.accepted > 0)) return "wait";
      segment.frozen = {
        batchId: randomUUID(),
        sequence: segment.sequence,
        events: [],
        bytes: 0,
        final: true,
        oldestAt: null,
      };
      return "frozen";
    }

    const first = segment.sequence === 0;
    // Epic wants sequence 0 to open with Meta then FullSnapshot together.
    if (first) {
      const [meta, snapshot] = segment.queue;
      if (!snapshot) return "wait";
      if (meta!.event.type !== META || snapshot.event.type !== FULL_SNAPSHOT) {
        lose(segment, "invalid_request");
        return "lost";
      }
    }

    const budget = limits.maxBatchBytes - envelopeBytes(segment, segment.sequence);
    const taken: QueuedEvent[] = [];
    let bytes = 0;
    for (const entry of segment.queue) {
      if (taken.length >= limits.maxBatchEvents || bytes + entry.bytes > budget) break;
      taken.push(entry);
      bytes += entry.bytes;
    }
    if (taken.length === 0 || (first && taken.length < 2)) {
      // Never truncated, split or skipped.
      lose(segment, "snapshot_too_large");
      return "lost";
    }

    segment.queue = segment.queue.slice(taken.length);
    segment.queueBytes -= bytes;
    segment.frozen = {
      batchId: randomUUID(),
      sequence: segment.sequence,
      events: taken.map((entry) => entry.event),
      bytes,
      final: segment.closing && segment.queue.length === 0,
      oldestAt: taken[0]!.at,
    };
    return "frozen";
  }

  async function upload(segment: Segment, limits: Limits) {
    if (!segment.recording) return lose(segment, "unavailable");
    if (!segment.frozen) {
      const outcome = freeze(segment, limits);
      if (outcome !== "frozen") return;
    }
    const batch = segment.frozen!;
    const recording = segment.recording;
    const base = `/recordings/${encodeURIComponent(recording.id)}`;

    const payload = {
      contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
      recordingToken: recording.token,
      batchId: batch.batchId,
      sequence: batch.sequence,
      events: batch.events,
      final: batch.final,
    };
    // A hidden tab may be frozen or closed before a plain request finishes.
    const keepalive = segment.flushRequested && jsonByteLength(payload) <= KEEPALIVE_MAX_BYTES;
    const result = await call(`${base}/batches`, payload, replayBatchResponseSchema, segment, { keepalive });
    if (isDead(segment)) return;

    if (result.ok) {
      const ack = result.body;
      if (ack.batchId !== batch.batchId || ack.sequence !== batch.sequence) {
        return lose(segment, "recording_closed", "incomplete");
      }
      segment.sequence = batch.sequence + 1;
      segment.accepted += 1;
      segment.frozen = null;
      segment.attempts = 0;
      segment.renewed = false;
      segment.flushRequested = false;
      segment.lastFlushAt = monotonicNow();
      if (segment.entry) {
        segment.entry.acceptedBatches = segment.accepted;
        segment.entry.availability = "events_received";
      }
      if (batch.final) finish(segment);
      return;
    }

    if (result.kind === "error" && result.code === "capability_expired") {
      // One renewal, then the identical batch again with only the token changed.
      if (segment.renewed) return lose(segment, "invalid_capability");
      const renewal = await call(
        `${base}/capability`,
        { contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION },
        replayRecordingResponseSchema,
        segment,
      );
      if (isDead(segment)) return;
      if (!renewal.ok) return onFailure(segment, renewal);
      segment.recording = { id: recording.id, token: renewal.body.recordingToken };
      segment.renewed = true;
      return;
    }

    onFailure(segment, result);
  }

  // ---- unload --------------------------------------------------------------

  /**
   * Best effort on `pagehide`: one keepalive request that closes the active
   * recording, sent only when the whole encoded body fits keepalive's budget
   * and nothing else is in flight. It never bypasses ordering or retention.
   */
  function closeForUnload() {
    try {
      const segment = active();
      if (!segment || disposed || running || inflight) return;
      if (segment.phase !== "registered" || !segment.recording || segment.frozen) return;
      const limits = getLimits();
      if (freeze(Object.assign(segment, { closing: true }), limits) !== "frozen") return;
      const batch = segment.frozen!;
      const body = JSON.stringify({
        contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
        recordingToken: segment.recording.token,
        batchId: batch.batchId,
        sequence: batch.sequence,
        events: batch.events,
        final: true,
      });
      if (new TextEncoder().encode(body).length > KEEPALIVE_MAX_BYTES) return;
      void fetchImpl()(`${baseUrl}/recordings/${encodeURIComponent(segment.recording.id)}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
      }).catch(() => undefined);
      finish(segment);
      publish();
    } catch {
      // Best effort only.
    }
  }

  /** Sends what is queued now without closing: the tab may come back. */
  function flushNow() {
    const segment = active();
    if (!segment || disposed || segment.phase === "dead") return;
    if (segment.queue.length === 0 && !segment.frozen) return;
    segment.flushRequested = true;
    schedule(0);
  }

  function dispose() {
    disposed = true;
    clear();
    clearTimeout(stateTimer);
    removeOnline?.();
    removeOnline = undefined;
    listeners.clear();
  }

  // The live recording, else the latest one this tab registered: a recording
  // that was quarantined or closed is still the evidence of what happened.
  function getReference(): ReplayRecordingReference | null {
    if (state.current) return state.current;
    const latest = history[history.length - 1];
    return latest ? { ...latest.reference } : null;
  }

  return {
    push,
    clear,
    dispose,
    /** Closes the active recording: its remaining events, then a final batch. */
    closeActive() {
      const segment = active();
      if (!segment) return;
      beginClosing(segment);
      schedule(0);
    },
    closeForUnload,
    flushNow,
    /** Failed recordings that should restart rather than stay down. */
    shouldRestart(reason: ReplayUploadReason): boolean {
      return reason === "buffer_exceeded" || reason === "attempts_exhausted" || OLD_RECORDING_CODES.has(reason as ReplayUploadErrorCode);
    },
    getReference,
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ReplayUploader = ReturnType<typeof createReplayUploader>;

function defaultViewport(): { width: number; height: number } | null {
  if (typeof window === "undefined") return null;
  const clamp = (value: number) => Math.min(Math.max(Math.round(value), 1), 16_384);
  const { innerWidth, innerHeight } = window;
  return innerWidth > 0 && innerHeight > 0 ? { width: clamp(innerWidth), height: clamp(innerHeight) } : null;
}
