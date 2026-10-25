import {
  createReplayCaptureSession,
  type ReplayCaptureSessionOptions,
  type ReplayCaptureState,
} from "./replay-capture";
import { replayLifecycle } from "./replay-lifecycle";
import { createReplayDiagnostics } from "./replay-diagnostics";
import { createReplayMarkers, type ReplayEventResult } from "./replay-markers";
import { createReplayTracing } from "./replay-tracing";
import {
  createReplayUploader,
  type ReplaySessionReference,
  type ReplayUploaderOptions,
  type ReplayUploadReason,
  type ReplayUploadState,
} from "./replay-uploader";

/**
 * One capture session wired to one uploader: the real recorder, gates and
 * redaction feeding the OTLP transport. The root provider owns the only
 * instance in a tab.
 *
 * Behavior markers and browser errors also leave as plain evidence records
 * whenever every gate except sampling passes, so a session the sampler left
 * unrecorded still says what happened in it.
 *
 * When the transport loses what it holds (a batch that stayed unanswered after
 * its attempts, a buffer overrun) the pipeline starts a fresh boundary with a
 * new FullSnapshot, at most `maxAttempts` times. The budget comes back only
 * after a boundary uploads enough batches to prove it works, so a stream that
 * fails right after its first batch cannot loop forever. A session that went
 * idle or reached its maximum age restarts the boundary without spending it.
 */

export interface ReplaySessionEvidence extends Pick<ReplaySessionReference, "sessionId" | "startedAt"> {
  traceId?: string;
  behaviorId?: string;
  occurrenceId?: string;
}

export interface ReplayPipelineState {
  capture: ReplayCaptureState;
  upload: ReplayUploadState;
  /** True once the restart budget is spent and the pipeline stays down. */
  restartsExhausted: boolean;
}

export interface ReplayRecordingPipelineOptions
  extends Omit<ReplayUploaderOptions, "getLimits" | "onRecordingLost">,
    Omit<ReplayCaptureSessionOptions, "sink" | "onNavigate"> {
  /** Defaults to the effective policy of `replayLifecycle`. */
  getPolicy?: NonNullable<ReplayCaptureSessionOptions["getPolicy"]>;
}

// A boundary must upload this many batches before the budget refills.
const RECOVERY_BATCHES = 2;
// Failures that no fresh recording can fix; capture stops until policy changes.
// After an outage every client fails its attempts together; a fresh recording
// that registered at once would bring them all back at the same moment.
const RESTART_DELAY_MS = { min: 2_000, spread: 8_000 } as const;
const RESUMABLE_STOPS = new Set<ReplayUploadReason>(["capture_disabled", "REPLAY_CREDENTIAL_INVALID"]);

export function createReplayRecordingPipeline(options: ReplayRecordingPipelineOptions) {
  const { getPolicy = () => replayLifecycle.getSnapshot(), ...rest } = options;
  const subscribePolicy = rest.subscribePolicy ?? ((listener: () => void) => replayLifecycle.subscribe(listener));

  const random = rest.random ?? Math.random;
  let restarts = 0;
  let restartsExhausted = false;
  let started = false;
  let stoppedAtConfig: string | null | undefined;
  // Batches accepted before the current boundary started, so credit counts only its own.
  let acceptedBaseline = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let state: ReplayPipelineState;
  const listeners = new Set<() => void>();
  const cleanups: (() => void)[] = [];

  const uploader = createReplayUploader({
    ...rest,
    getLimits: () => getPolicy().recording.limits,
    onRecordingLost: onLost,
  });

  // Headers only while every gate but sampling passes; the latest trace id is what a report cites.
  const tracing = createReplayTracing({ isEnabled: () => session.allowsEvidence() });
  const markers = createReplayMarkers(
    (tag, payload) => session.addCustomEvent(tag, payload),
    (input) => {
      if (session.allowsEvidence()) uploader.pushEvidence(input);
    },
  );
  // Console and network context, each only while its own policy switch is on.
  const diagnostics = createReplayDiagnostics(
    (tag, payload) => session.addCustomEvent(tag, payload),
    () => {
      const policy = getPolicy();
      return policy.status === "active" ? policy.capture.diagnostics : { console: false, network: false };
    },
    undefined,
    () => session.getState().status === "capturing",
    tracing,
  );
  const session = createReplayCaptureSession({
    ...rest,
    sink: uploader,
    getPolicy,
    subscribePolicy,
    onNavigate: (pathname) => markers.navigate(pathname),
  });

  state = snapshot();

  function snapshot(): ReplayPipelineState {
    return { capture: session.getState(), upload: uploader.getState(), restartsExhausted };
  }

  function refresh() {
    const next = snapshot();
    if (
      next.capture === state.capture &&
      next.upload === state.upload &&
      next.restartsExhausted === state.restartsExhausted
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function onLost(reason: ReplayUploadReason) {
    // Never re-enter the sink from inside the transport's own call stack.
    clearTimeout(restartTimer);
    const delay =
      reason === "attempts_exhausted" ? RESTART_DELAY_MS.min + random() * RESTART_DELAY_MS.spread : 0;
    restartTimer = setTimeout(() => recover(reason), delay);
  }

  function recover(reason: ReplayUploadReason) {
    if (!started) return;
    // A rotated session is not a failure: its next boundary opens a new one.
    if (reason === "session_rotated") {
      session.restartBoundary();
      return;
    }
    if (uploader.shouldRestart(reason) && restarts < getPolicy().recording.limits.maxAttempts) {
      restarts += 1;
      acceptedBaseline = uploader.getState().acceptedBatches;
      session.restartBoundary();
      return;
    }
    if (uploader.shouldRestart(reason)) restartsExhausted = true;
    // Nothing more can be uploaded for this boundary: stop recording it.
    if (RESUMABLE_STOPS.has(reason)) stoppedAtConfig = getPolicy().configVersion;
    uploader.halt(reason);
    session.dispose();
    refresh();
  }

  // Recovery earned: a boundary that uploaded enough batches refills the budget.
  function creditHealthyUploads() {
    const { acceptedBatches, status } = uploader.getState();
    if (acceptedBatches - acceptedBaseline >= RECOVERY_BATCHES && status !== "unavailable") {
      restarts = 0;
      restartsExhausted = false;
    }
  }

  return {
    start(): void {
      if (started || typeof window === "undefined") return;
      started = true;

      cleanups.push(uploader.subscribe(() => {
        creditHealthyUploads();
        refresh();
      }));
      cleanups.push(session.subscribe(() => {
        const capture = session.getState();
        // A boundary whose capture stopped is finished: send what it still holds.
        if (capture.status === "blocked") uploader.closeActive();
        // The state turns "capturing" just before rrweb starts, inside the same call.
        else queueMicrotask(() => diagnostics.announce(capture.boundary));
        refresh();
      }));
      // A stop that policy can lift resumes only on a different config version.
      cleanups.push(subscribePolicy(() => {
        diagnostics.sync();
        const capture = session.getState();
        if (capture.status === "capturing") diagnostics.announce(capture.boundary);
        if (stoppedAtConfig !== undefined && getPolicy().configVersion !== stoppedAtConfig) {
          stoppedAtConfig = undefined;
          uploader.resume();
          session.start();
        }
      }));

      markers.start();
      tracing.start();
      diagnostics.start();
      // Whether the page is leaving for good or only frozen, what is queued goes now.
      const onPageHide = () => uploader.closeForUnload();
      window.addEventListener("pagehide", onPageHide);
      cleanups.push(() => window.removeEventListener("pagehide", onPageHide));
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") uploader.flushNow();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

      session.start();
      refresh();
    },

    dispose(): void {
      if (!started) return;
      started = false;
      clearTimeout(restartTimer);
      markers.stop();
      diagnostics.stop();
      tracing.stop();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      session.dispose();
      uploader.clear();
      refresh();
    },

    /** Re-evaluates the gates now, e.g. after identity is acknowledged. */
    refresh(): void {
      session.refresh();
    },

    /**
     * The session reference a bug report may attach, or null: the live
     * session this tab sent records for, with the latest trace id and behavior
     * marker. Null whenever capture is not allowed right now.
     */
    getSessionReference(): ReplaySessionEvidence | null {
      if (!session.allowsEvidence()) return null;
      const reference = uploader.getReference();
      if (!reference) return null;
      const behavior = markers.getLastBehavior();
      const traceId = tracing.getLastTraceId();
      return {
        sessionId: reference.sessionId,
        startedAt: reference.startedAt,
        ...(traceId ? { traceId } : {}),
        ...(behavior?.behaviorId ? { behaviorId: behavior.behaviorId } : {}),
        ...(behavior?.occurrenceId ? { occurrenceId: behavior.occurrenceId } : {}),
      };
    },

    /** Sends everything queued so a report reaches Epic after its session; a few seconds at most. */
    flush(): Promise<void> {
      return uploader.flush();
    },

    /** Records an application event; harmless when nothing is recording. */
    event(name: string, payload?: unknown): ReplayEventResult {
      return markers.event(name, payload);
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

export type ReplayRecordingPipeline = ReturnType<typeof createReplayRecordingPipeline>;
