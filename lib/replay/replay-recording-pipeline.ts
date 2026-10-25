import type { record as rrwebRecord } from "@rrweb/record";

import {
  createReplayCaptureSession,
  type ReplayCaptureSessionOptions,
  type ReplayCaptureState,
} from "./replay-capture";
import type { PublicReplayConfig } from "./replay-config.contract";
import type { ReplayConsentSource } from "./replay-consent";
import { replayLifecycle } from "./replay-lifecycle";
import type { ReplaySampler } from "./replay-sampling";
import { createReplayRecoveryBudget, type ReplayRecoveryBudget } from "./replay-runtime-policy";
import type { ReplayUploadCheckpoint } from "./replay-upload-checkpoint";
import {
  createReplayUploader,
  type ReplayRecordingReference,
  type ReplayUploaderOptions,
  type ReplayUploadState,
} from "./replay-uploader";

/**
 * One capture session wired to one upload transport. When a recording is
 * lost in a way that permits a fresh one (delivery uncertain, out of order,
 * buffer exceeded, ...), the capture session restarts its boundary - a new
 * registration with fresh Meta and FullSnapshot - at most `maxAttempts`
 * times per pipeline; beyond that it stays unavailable.
 *
 * WEB-4's root provider mounts one per tab; this module starts nothing on
 * import.
 */

export interface ReplayPipelineState {
  capture: ReplayCaptureState;
  upload: ReplayUploadState;
}

export interface ReplayRecordingPipelineOptions
  extends Omit<ReplayUploaderOptions, "getLimits" | "getConfigVersion" | "onRecordingLost"> {
  getPolicy?: () => PublicReplayConfig;
  subscribePolicy?: (listener: () => void) => () => void;
  consent?: ReplayConsentSource;
  sampler?: ReplaySampler;
  record?: typeof rrwebRecord;
  getPathname?: () => string;
  getCaptureAllowed?: () => boolean;
  recoveryBudget?: ReplayRecoveryBudget;
  managePageHide?: boolean;
}

export function createReplayRecordingPipeline({
  getPolicy = () => replayLifecycle.getSnapshot(),
  subscribePolicy,
  consent,
  sampler,
  record,
  getPathname,
  getCaptureAllowed,
  recoveryBudget = createReplayRecoveryBudget(),
  managePageHide = true,
  ...uploaderOptions
}: ReplayRecordingPipelineOptions = {}) {
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let pagehideAttached = false;
  let started = false;
  let captureFailureHandled = false;

  const uploader = createReplayUploader({
    ...uploaderOptions,
    getRoute: uploaderOptions.getRoute ?? getPathname,
    getLimits: () => getPolicy().recording.limits,
    getConfigVersion: () => getPolicy().configVersion,
    onRecordingLost: () => {
      if (!recoveryBudget.take(getPolicy().recording.limits.maxAttempts)) {
        uploader.halt();
        return;
      }
      // Out of the recorder's emit and the transport's own call stack.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        session.restartBoundary();
        restartTimer = undefined;
        changed();
      }, 0);
    },
  });

  const captureOptions: ReplayCaptureSessionOptions = { sink: uploader, getPolicy };
  if (subscribePolicy) captureOptions.subscribePolicy = subscribePolicy;
  if (consent) captureOptions.consent = consent;
  if (sampler) captureOptions.sampler = sampler;
  if (record) captureOptions.record = record;
  if (getPathname) captureOptions.getPathname = getPathname;
  if (getCaptureAllowed) captureOptions.getCaptureAllowed = getCaptureAllowed;
  const session = createReplayCaptureSession(captureOptions);

  let state: ReplayPipelineState = { capture: session.getState(), upload: uploader.getState() };
  const listeners = new Set<() => void>();
  function changed() {
    const next = { capture: session.getState(), upload: uploader.getState() };
    if (next.capture === state.capture && next.upload === state.upload) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }
  session.subscribe(() => {
    if (session.hasFailed() && !captureFailureHandled) {
      captureFailureHandled = true;
      started = false;
      uploader.clear();
      session.dispose();
      if (pagehideAttached && typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      pagehideAttached = false;
    }
    changed();
  });
  uploader.subscribe(() => {
    const progress = uploader.getProgress();
    const reference = uploader.getRecordingReference();
    if (reference) recoveryBudget.acknowledged(reference.recordingId, progress.acceptedBatches, progress.postOpeningBatches, uploaderOptions.monotonicNow?.() ?? performance.now());
    if (uploader.getState().status === "unavailable" && restartTimer === undefined) {
      started = false;
      // The upload outcome/history remains visible; stopping rrweb must not
      // turn a terminal rejection into an apparently idle transport.
      session.dispose("transport_unavailable");
      if (pagehideAttached && typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      pagehideAttached = false;
    }
    changed();
  });

  const onPageHide = () => uploader.flushOnPageHide();

  return {
    start({ explicit = true }: { explicit?: boolean } = {}): void {
      if (started) return;
      started = true;
      captureFailureHandled = false;
      if (explicit) recoveryBudget.reset();
      uploader.resume();
      session.refresh();
      session.start();
      if (managePageHide && started && !pagehideAttached && typeof window !== "undefined") {
        window.addEventListener("pagehide", onPageHide);
        pagehideAttached = true;
      }
      changed();
    },

    rotate(): void { session.restartBoundary(); },

    refresh(): void { session.refresh(); },

    /** Detach capture before checking the frontier; do not clear retained data. */
    stopCapture(): void {
      started = false;
      clearTimeout(restartTimer);
      restartTimer = undefined;
      session.dispose();
      if (pagehideAttached) window.removeEventListener("pagehide", onPageHide);
      pagehideAttached = false;
    },

    getCheckpoint() { return uploader.getCheckpoint(); },
    getProgress() { return uploader.getProgress(); },
    isRecovering() { return restartTimer !== undefined; },
    hasPendingWork() { return uploader.hasPendingWork(); },
    hasCaptureFailure() { return session.hasFailed(); },
    quiesceForHandoff() {
      this.stopCapture();
      return uploader.quiesceForHandoff();
    },
    commitHandoff(): void { uploader.commitHandoff(); changed(); },
    flushOnPageHide(): void { uploader.flushOnPageHide(); },
    async resumeFromCheckpoint(checkpoint: ReplayUploadCheckpoint, options: { signal?: AbortSignal; deadline?: number; revalidate?: boolean } = {}): Promise<boolean> {
      const restored = await uploader.resumeFromCheckpoint(checkpoint, session.getState().boundary + 1, options);
      if (!restored || options.signal?.aborted || getCaptureAllowed?.() === false) {
        session.retireUnstartedBoundary();
        return false;
      }
      started = true;
      session.start();
      changed();
      return true;
    },

    /** Stops capture and drops queued local data; history and the restart budget stay. */
    stop(): void {
      started = false;
      clearTimeout(restartTimer);
      restartTimer = undefined;
      session.dispose();
      uploader.clear();
      if (pagehideAttached) window.removeEventListener("pagehide", onPageHide);
      pagehideAttached = false;
      changed();
    },

    dispose(): void {
      this.stop();
      uploader.dispose();
      changed();
    },

    getState(): ReplayPipelineState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Only a reference from a successful registration in this tab, or null. */
    getRecordingReference(): ReplayRecordingReference | null {
      return uploader.getRecordingReference();
    },
  };
}

export type ReplayRecordingPipeline = ReturnType<typeof createReplayRecordingPipeline>;
