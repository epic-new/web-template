import {
  createReplayCaptureSession,
  type ReplayCaptureSessionOptions,
  type ReplayCaptureState,
} from "./replay-capture";
import { replayLifecycle } from "./replay-lifecycle";
import { createReplayDiagnostics } from "./replay-diagnostics";
import { createReplayMarkers, type ReplayEventResult } from "./replay-markers";
import {
  createReplayUploader,
  type ReplayRecordingReference,
  type ReplayUploaderOptions,
  type ReplayUploadReason,
  type ReplayUploadState,
} from "./replay-uploader";

/**
 * One capture session wired to one uploader: the real recorder, gates and
 * redaction feeding the verified-ownership transport. The root provider owns
 * the only instance in a tab.
 *
 * When the transport loses a recording (a batch that stayed unanswered after
 * its attempts, a closed recording, buffer overrun) the pipeline starts a fresh
 * boundary with a new registration and a new FullSnapshot, at most
 * `maxAttempts` times. The budget comes back only after a recording uploads
 * enough batches to prove it works, so a stream that fails right after its
 * first batch cannot loop through registrations forever.
 */

export interface ReplayPipelineState {
  capture: ReplayCaptureState;
  upload: ReplayUploadState;
  /** True once the restart budget is spent and the pipeline stays down. */
  restartsExhausted: boolean;
}

export interface ReplayRecordingPipelineOptions
  extends Omit<ReplayUploaderOptions, "getLimits" | "getConfigVersion" | "onRecordingLost">,
    Omit<ReplayCaptureSessionOptions, "sink" | "onNavigate"> {
  /** Defaults to the effective policy of `replayLifecycle`. */
  getPolicy?: NonNullable<ReplayCaptureSessionOptions["getPolicy"]>;
}

// A recording must upload this many batches before the budget refills.
const RECOVERY_BATCHES = 2;
// Failures that no fresh recording can fix; capture stops until policy changes.
const RESUMABLE_STOPS = new Set<ReplayUploadReason>(["capture_disabled", "REPLAY_CREDENTIAL_INVALID"]);

export function createReplayRecordingPipeline(options: ReplayRecordingPipelineOptions) {
  const { getPolicy = () => replayLifecycle.getSnapshot(), ...rest } = options;
  const subscribePolicy = rest.subscribePolicy ?? ((listener: () => void) => replayLifecycle.subscribe(listener));

  let restarts = 0;
  let restartsExhausted = false;
  let started = false;
  let stoppedAtConfig: string | null | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let state: ReplayPipelineState;
  const listeners = new Set<() => void>();
  const cleanups: (() => void)[] = [];

  const uploader = createReplayUploader({
    ...rest,
    getLimits: () => getPolicy().recording.limits,
    getConfigVersion: () => getPolicy().configVersion,
    onRecordingLost: onLost,
  });

  const markers = createReplayMarkers((tag, payload) => session.addCustomEvent(tag, payload));
  // Console and network context, each only while its own policy switch is on.
  const diagnostics = createReplayDiagnostics(
    (tag, payload) => session.addCustomEvent(tag, payload),
    () => {
      const policy = getPolicy();
      return policy.status === "active" ? policy.capture.diagnostics : { console: false, network: false };
    },
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
    restartTimer = setTimeout(() => recover(reason), 0);
  }

  function recover(reason: ReplayUploadReason) {
    if (!started) return;
    if (uploader.shouldRestart(reason) && restarts < getPolicy().recording.limits.maxAttempts) {
      restarts += 1;
      session.restartBoundary();
      return;
    }
    if (uploader.shouldRestart(reason)) restartsExhausted = true;
    // Nothing more can be uploaded for this boundary: stop recording it.
    if (RESUMABLE_STOPS.has(reason)) stoppedAtConfig = getPolicy().configVersion;
    session.dispose();
    refresh();
  }

  // Recovery earned: a recording that uploaded enough batches refills the budget.
  function creditHealthyUploads() {
    const { history } = uploader.getState();
    if (history.some((entry) => entry.acceptedBatches >= RECOVERY_BATCHES && entry.outcome !== "unavailable")) {
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
        // A recording whose capture stopped is finished: flush it and close it.
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
          session.start();
        }
      }));

      markers.start();
      diagnostics.start();
      const onPageHide = (event: PageTransitionEvent) => {
        if (!event.persisted) uploader.closeForUnload();
      };
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
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      session.dispose();
      uploader.clear();
      refresh();
    },

    /** Re-evaluates the gates now, e.g. after identity is acknowledged. */
    refresh(): void {
      session.refresh();
    },

    /** The reference a bug report may attach, or null. Never a bare local id. */
    getRecordingReference(): ReplayRecordingReference | null {
      return uploader.getReference();
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
