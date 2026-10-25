import type { eventWithTime } from "@rrweb/types";

import type { PublicReplayConfig } from "./replay-config.contract";
import {
  buildLogsRequest,
  encodeEvidence,
  encodeReplayEvent,
  utf8Length,
  type EvidenceInput,
  type ScopedLogRecord,
} from "./replay-otlp";
import { replaySessions, type ReplaySessionStore } from "./replay-session";
import {
  REPLAY_RELEASE_PATTERN,
  replayUploadErrorBodySchema,
  type ReplayUploadErrorCode,
} from "./replay-upload-contract";

/**
 * The browser transport for telemetry: it packages the redacted rrweb events
 * and the evidence log records as OTLP/JSON and posts them, one request in
 * flight at a time, to this application's own `/api/epic/replay/telemetry`
 * relay. See docs/replay-privacy.md.
 *
 * It plugs into `createReplayCaptureSession` as the sink the memory buffer
 * used to be. Every record belongs to a browser session (`rum.sessionId`);
 * a request carries one session's records, in order, and is frozen once
 * chosen: however often it is retried, its body never changes, so the relay
 * and ClickStack see the same records every time. Nothing it does can throw
 * into the page; every failure only changes its state.
 *
 * Time is monotonic on purpose. Buffer age, backoff and request deadlines
 * use `monotonicNow()`, so a wall-clock jump or a suspended tab cannot extend
 * how long private events are held. Event and wire timestamps stay the
 * original browser epoch milliseconds.
 */

type Limits = PublicReplayConfig["recording"]["limits"];

export interface ReplaySessionReference {
  sessionId: string;
  /** The session's start, in epoch milliseconds. */
  startedAt: number;
  boundary: number;
}

export type ReplayUploadStatus = "idle" | "uploading" | "pending" | "unavailable";

export type ReplayUploadReason =
  | ReplayUploadErrorCode
  | "offline"
  | "buffer_exceeded"
  | "attempts_exhausted"
  | "snapshot_too_large"
  | "session_rotated";

export interface ReplayUploadState {
  status: ReplayUploadStatus;
  reason: ReplayUploadReason | null;
  /** The session the latest records belong to. */
  current: ReplaySessionReference | null;
  acceptedBatches: number;
  bufferedEvents: number;
  bufferedBytes: number;
  /** An accepted batch is never evidence of playback. */
  evidence: "unverified";
}

export interface ReplayUploaderOptions {
  getLimits: () => Limits;
  /** The immutable build identity of this document, or null when unknown. */
  getDocumentRelease: () => string | null;
  sessions?: ReplaySessionStore;
  fetch?: typeof fetch;
  monotonicNow?: () => number;
  isOnline?: () => boolean;
  /** Spreads retries so clients that failed together do not return together. */
  random?: () => number;
  onRecordingLost?: (reason: ReplayUploadReason) => void;
  baseUrl?: string;
}

const BACKOFF_MS = [500, 1_000, 2_000];
const MAX_BACKOFF_JITTER = 0.5;
// A server-provided pause longer than this would outlive the buffer's retention anyway.
const MAX_RETRY_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const OFFLINE_POLL_MS = 500;
const STATE_THROTTLE_MS = 250;
const KEEPALIVE_MAX_BYTES = 64 * 1_024;
const MAX_QUEUED_EVIDENCE = 500;
const META = 4;
const FLUSH_WAIT_MS = 5_000;

interface QueuedRecord extends ScopedLogRecord {
  bytes: number;
  at: number;
  sessionId: string;
  replay: boolean;
}

interface FrozenBatch {
  sessionId: string;
  items: QueuedRecord[];
  body: string;
  keepalive: boolean;
}

type Failure =
  | { kind: "network" }
  | {
      kind: "error";
      status: number;
      code: ReplayUploadErrorCode;
      retryAfterMs?: number;
    };

type Result = { ok: true } | ({ ok: false } & Failure);

// A batch answered with one of these, or not answered at all, may or may not
// be stored. Retrying the identical batch is safe: playback drops duplicates.
const TRANSIENT_CODES = new Set<ReplayUploadErrorCode>(["unavailable", "rate_limited"]);
// Losses a fresh boundary can recover from; the rest stop capture until policy changes.
const RESTARTABLE_REASONS = new Set<ReplayUploadReason>(["buffer_exceeded", "attempts_exhausted", "session_rotated"]);

export function createReplayUploader(options: ReplayUploaderOptions) {
  const {
    getLimits,
    getDocumentRelease,
    onRecordingLost,
    sessions = replaySessions,
    baseUrl = "/api/epic/replay",
    fetch: fetchOption,
    monotonicNow = () => performance.now(),
    isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    random = Math.random,
  } = options;

  let queue: QueuedRecord[] = [];
  let queueBytes = 0;
  let frozen: FrozenBatch | null = null;
  // The recorder boundary in progress and the session its records belong to.
  let bound: { boundary: number; sessionId: string; startedAt: number; rotated: boolean } | null = null;
  // The newest session this transport carried a record for.
  let latest: ReplaySessionReference | null = null;
  let accepted = 0;
  let attempts = 0;
  let retryAt = 0;
  let flushRequested = false;
  let halted: ReplayUploadReason | null = null;
  let lostReason: ReplayUploadReason | null = null;
  let running = false;
  let inflight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = 0;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let removeOnline: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const idleWaiters = new Set<() => void>();

  let state: ReplayUploadState = {
    status: "idle",
    reason: null,
    current: null,
    acceptedBatches: 0,
    bufferedEvents: 0,
    bufferedBytes: 0,
    evidence: "unverified",
  };

  function fetchImpl(): typeof fetch {
    return fetchOption ?? globalThis.fetch.bind(globalThis);
  }

  // ---- state ---------------------------------------------------------------

  function held() {
    return {
      records: queue.length + (frozen?.items.length ?? 0),
      bytes: queueBytes + (frozen?.items.reduce((total, item) => total + item.bytes, 0) ?? 0),
    };
  }

  function compute(): ReplayUploadState {
    const totals = held();
    let status: ReplayUploadStatus = "idle";
    let reason: ReplayUploadReason | null = null;

    if (lostReason) {
      status = "unavailable";
      reason = lostReason;
    } else if (running) {
      status = "uploading";
    } else if (totals.records > 0) {
      status = "pending";
    }
    if (!reason && totals.records > 0 && !isOnline()) reason = "offline";

    return {
      status,
      reason,
      current: latest ? { ...latest } : null,
      acceptedBatches: accepted,
      bufferedEvents: totals.records,
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

  function settle() {
    if (running || queue.length > 0 || frozen) return;
    flushRequested = false;
    for (const resolve of [...idleWaiters]) resolve();
  }

  // ---- loss ----------------------------------------------------------------

  function discard() {
    queue = [];
    queueBytes = 0;
    frozen = null;
  }

  function notifyLost(reason: ReplayUploadReason) {
    try {
      onRecordingLost?.(reason);
    } catch {
      // The owner failing to react never reaches the page.
    }
  }

  function lose(reason: ReplayUploadReason) {
    discard();
    attempts = 0;
    retryAt = 0;
    lostReason = reason;
    // A loss no fresh boundary can fix keeps the transport quiet until the owner resumes it.
    if (!RESTARTABLE_REASONS.has(reason)) halted = reason;
    inflight?.abort();
    publish();
    notifyLost(reason);
    settle();
    schedule(0);
  }

  // ---- sink ----------------------------------------------------------------

  function normalize(event: eventWithTime): eventWithTime {
    if (event.type !== META) return event;
    const data = event.data as { href?: unknown };
    if (typeof data.href !== "string") return event;
    // A query or fragment can carry tokens; the recording keeps the path.
    const href = data.href.replace(/[?#].*$/, "");
    return href === data.href ? event : ({ ...event, data: { ...data, href } } as eventWithTime);
  }

  function enqueue(items: QueuedRecord[], limits: Limits): boolean {
    const bytes = items.reduce((total, item) => total + item.bytes, 0);
    if (held().bytes + bytes > limits.maxBufferBytes) return false;
    queue.push(...items);
    queueBytes += bytes;
    return true;
  }

  function push(event: eventWithTime, boundary: number) {
    try {
      if (disposed || halted) return;
      if (!bound || bound.boundary !== boundary) {
        if (bound && boundary < bound.boundary) return;
        const session = sessions.current();
        bound = { boundary, sessionId: session.id, startedAt: session.startedAt, rotated: false };
        lostReason = null;
        listenOnline();
      } else if (bound.rotated) {
        return;
      } else if (!sessions.isLive(bound.sessionId)) {
        // The session went idle or reached its maximum age: this boundary has no
        // Meta and FullSnapshot under the new id, so it cannot continue.
        bound.rotated = true;
        notifyLost("session_rotated");
        return;
      }
      const { sessionId, startedAt } = bound;

      const limits = getLimits();
      const encoded = encodeReplayEvent(normalize(event), {
        maxChunkBytes: limits.maxChunkBytes,
        reserve: (records) => sessions.reserve(sessionId, records),
      });
      if (!encoded) return;

      const at = monotonicNow();
      const items = encoded.records.map((entry, index) => ({
        ...entry,
        bytes: encoded.bytes[index]!,
        at,
        sessionId,
        replay: true,
      }));
      latest = { sessionId, startedAt, boundary };
      if (!enqueue(items, limits)) {
        lose("buffer_exceeded");
        return;
      }
      publish(false);
      wake(limits);
    } catch {
      // Capture must never break the page.
    }
  }

  /**
   * Queues a non-replay evidence record (behavior markers, browser errors).
   * The owner decides whether evidence is allowed; this only carries it.
   */
  function pushEvidence(input: EvidenceInput) {
    try {
      if (disposed || halted) return;
      if (queue.filter((item) => !item.replay).length >= MAX_QUEUED_EVIDENCE) return;
      const session = sessions.current();
      const entry = encodeEvidence(input);
      const limits = getLimits();
      lostReason = null;
      latest = { sessionId: session.id, startedAt: session.startedAt, boundary: bound?.boundary ?? 0 };
      const item = { ...entry, bytes: utf8Length(entry.record.body.stringValue), at: monotonicNow(), sessionId: session.id, replay: false };
      if (!enqueue([item], limits)) return;
      listenOnline();
      publish(false);
      wake(limits);
    } catch {
      // Evidence must never break the page.
    }
  }

  function wake(limits: Limits) {
    if (isFull(limits)) {
      schedule(0);
      return;
    }
    const oldest = oldestAt();
    schedule(oldest === null ? limits.flushIntervalMs : oldest + limits.flushIntervalMs - monotonicNow());
  }

  function isFull(limits: Limits): boolean {
    return queue.length >= limits.maxBatchEvents || queueBytes >= limits.maxBatchBytes || queueBytes >= limits.flushBytes;
  }

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    inflight?.abort();
    discard();
    bound = null;
    flushRequested = false;
    publish();
    settle();
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

  function oldestAt(): number | null {
    const times = [frozen?.items[0]?.at ?? null, queue[0]?.at ?? null].filter((time): time is number => time !== null);
    return times.length ? Math.min(...times) : null;
  }

  function retentionLeft(): number {
    const at = oldestAt();
    return at === null ? Infinity : at + getLimits().maxBufferAgeMs - monotonicNow();
  }

  function due(limits: Limits): boolean {
    if (frozen) return true;
    if (queue.length === 0) return false;
    if (flushRequested || isFull(limits)) return true;
    const oldest = oldestAt();
    return oldest !== null && monotonicNow() - oldest >= limits.flushIntervalMs;
  }

  async function tick() {
    if (running || disposed) return;
    try {
      if (held().records > 0 && retentionLeft() < 0) {
        lose("buffer_exceeded");
        return;
      }
      const limits = getLimits();
      if (!frozen && queue.length === 0) {
        settle();
        publish();
        return;
      }
      if (!due(limits)) {
        const oldest = oldestAt();
        const nextFlush = oldest === null ? Infinity : oldest + limits.flushIntervalMs - monotonicNow();
        schedule(Math.min(Math.max(nextFlush, 0), Math.max(retentionLeft(), 0)));
        publish();
        return;
      }
      if (!isOnline()) {
        publish();
        schedule(Math.min(OFFLINE_POLL_MS, Math.max(retentionLeft(), 0)));
        return;
      }
      const wait = retryAt - monotonicNow();
      if (wait > 0) {
        schedule(Math.min(wait, Math.max(retentionLeft(), 0)));
        return;
      }

      running = true;
      publish();
      try {
        await upload(limits);
      } finally {
        running = false;
      }
      publish();
      settle();
      schedule(0);
    } catch {
      running = false;
      lose("unavailable");
    }
  }

  // ---- requests ------------------------------------------------------------

  async function call(batch: FrozenBatch): Promise<Result> {
    const controller = new AbortController();
    inflight = controller;
    const timeout = setTimeout(() => controller.abort(), Math.max(Math.min(REQUEST_TIMEOUT_MS, retentionLeft()), 1));
    try {
      const response = await fetchImpl()(`${baseUrl}/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: batch.body,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        keepalive: batch.keepalive,
      });
      const json: unknown = await response.json().catch(() => undefined);
      if (response.ok) return { ok: true };
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

  // Counts an attempt against the current batch and schedules the retry.
  function retryLater(retryAfterMs?: number) {
    attempts += 1;
    if (attempts >= getLimits().maxAttempts) {
      lose("attempts_exhausted");
      return;
    }
    const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
    const pause = Math.max(backoff, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
    retryAt = monotonicNow() + pause * (1 + MAX_BACKOFF_JITTER * random());
  }

  function onFailure(failure: Failure) {
    if (failure.kind === "network" || TRANSIENT_CODES.has(failure.code)) {
      retryLater(failure.kind === "error" ? failure.retryAfterMs : undefined);
      return;
    }
    lose(failure.code);
  }

  function documentRelease(): string | null {
    const release = getDocumentRelease();
    return release && REPLAY_RELEASE_PATTERN.test(release) ? release : null;
  }

  function bodyOf(sessionId: string, items: QueuedRecord[]): string {
    return JSON.stringify(buildLogsRequest({ sessionId, release: documentRelease(), records: items }));
  }

  // Chooses the next batch once; from then on only that frozen batch is retried.
  // A batch is the queue's leading run of one session's records.
  function freeze(limits: Limits, keepaliveBudget?: number): boolean {
    const first = queue[0];
    if (!first) return false;

    const items: QueuedRecord[] = [];
    let bytes = 0;
    for (const item of queue) {
      if (item.sessionId !== first.sessionId) break;
      if (items.length >= limits.maxBatchEvents || bytes + item.bytes > limits.maxBatchBytes) break;
      items.push(item);
      bytes += item.bytes;
    }
    if (items.length === 0) {
      // Never truncated or split further than the policy's chunk size.
      lose("snapshot_too_large");
      return false;
    }

    let body = bodyOf(first.sessionId, items);
    if (keepaliveBudget !== undefined) {
      while (items.length > 1 && utf8Length(body) > keepaliveBudget) {
        items.pop();
        body = bodyOf(first.sessionId, items);
      }
      if (utf8Length(body) > keepaliveBudget) return false;
    }

    queue = queue.slice(items.length);
    queueBytes -= items.reduce((total, item) => total + item.bytes, 0);
    // A hidden tab may be frozen or closed before a plain request finishes.
    const keepalive = (flushRequested || keepaliveBudget !== undefined) && utf8Length(body) <= KEEPALIVE_MAX_BYTES;
    frozen = { sessionId: first.sessionId, items, body, keepalive };
    return true;
  }

  async function upload(limits: Limits) {
    if (!frozen && !freeze(limits)) return;
    const batch = frozen!;
    const result = await call(batch);
    if (frozen !== batch) return;

    if (result.ok) {
      accepted += 1;
      frozen = null;
      attempts = 0;
      retryAt = 0;
      return;
    }
    onFailure(result);
  }

  // ---- unload --------------------------------------------------------------

  /**
   * Best effort on `pagehide`: one keepalive request with what is queued,
   * sent only when the whole encoded body fits keepalive's budget and nothing
   * else is in flight. It never bypasses ordering or retention.
   */
  function closeForUnload() {
    try {
      if (disposed || halted || running || inflight || frozen || queue.length === 0) return;
      if (!freeze(getLimits(), KEEPALIVE_MAX_BYTES)) return;
      const batch = frozen!;
      void fetchImpl()(`${baseUrl}/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: batch.body,
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
      }).catch(() => undefined);
      frozen = null;
      sessions.flush();
      publish();
    } catch {
      // Best effort only.
    }
  }

  /** Sends what is queued now without waiting for the interval: the tab may be hiding. */
  function flushNow() {
    if (disposed || halted) return;
    sessions.flush();
    if (queue.length === 0 && !frozen) return;
    flushRequested = true;
    schedule(0);
  }

  /** Resolves once everything queued so far was sent or given up on, at most a few seconds. */
  function flush(): Promise<void> {
    if (disposed || halted || (queue.length === 0 && !frozen && !running)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(giveUp);
        idleWaiters.delete(done);
        resolve();
      };
      const giveUp = setTimeout(done, FLUSH_WAIT_MS);
      idleWaiters.add(done);
      flushNow();
    });
  }

  function dispose() {
    disposed = true;
    clear();
    clearTimeout(stateTimer);
    removeOnline?.();
    removeOnline = undefined;
    listeners.clear();
  }

  return {
    push,
    pushEvidence,
    clear,
    dispose,
    /** A recording whose capture stopped is finished: send what it still holds. */
    closeActive() {
      if (queue.length > 0 || frozen) {
        flushRequested = true;
        schedule(0);
      }
    },
    closeForUnload,
    flushNow,
    flush,
    /** Stops sending after a loss no fresh boundary can fix, until `resume()`. */
    halt(reason: ReplayUploadReason) {
      halted = reason;
      lostReason ??= reason;
      discard();
      publish();
    },
    resume() {
      halted = null;
      lostReason = null;
      attempts = 0;
      publish();
    },
    /** Failed recordings that should restart rather than stay down. */
    shouldRestart(reason: ReplayUploadReason): boolean {
      return RESTARTABLE_REASONS.has(reason);
    },
    /** The newest session this tab sent records for, or null. Never a bare local id. */
    getReference(): ReplaySessionReference | null {
      if (!latest || !sessions.isLive(latest.sessionId)) return null;
      return { ...latest };
    },
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
