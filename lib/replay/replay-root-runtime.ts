import type { ReplayRecordingPipeline, ReplayRecordingPipelineOptions } from "./replay-recording-pipeline";
import type { PublicReplayConfig } from "./replay-config.contract";
import { epicReplayConsent, type ReplayConsentSource } from "./replay-consent";
import { replayLifecycle } from "./replay-lifecycle";
import { evaluateCapturePermission } from "./replay-permission";
import { replaySampler, type ReplaySampler } from "./replay-sampling";
import { beginReplayIdentityBoundary, createReplayIdentity, clearReplayIdentityReset, replayIdentityResetPending } from "./replay-identity";
import { replayDocumentOwners, type createReplayDocumentOwners } from "./replay-document-owner";
import { acquireReplayOwnership, replayIntentLockName, replayRecordingLockName, type ReplayOwnershipLease, type ReplayLockManager } from "./replay-ownership";
import { createReplayHandoff, type ReplayHandoff, type PreparedReplayHandoff, type ReplayHandoffContext, type ReplayReloadNavigation } from "./replay-handoff";
import { createReplayRecoveryBudget, publicDocumentRelease, replayContextFingerprint, replayLifecycleOptions, type ReplayLifecycleOptions } from "./replay-runtime-policy";
import type { ReplayRecordingReference } from "./replay-uploader";
import type { ReplayFetch } from "./replay-upload-contract";
import type { ReplayUploadCheckpoint } from "./replay-upload-checkpoint";
import type { ReplayEvidenceReference } from "./replay-evidence";
import { parseReplayMarker, sanitizeMarkerRoute, type ReplayMarkerSummary, type ReplayTrackResult } from "./replay-marker.contract";
import { attachReplayBrowserMarkers } from "./replay-browser-markers";
import { normalizeReplayPath } from "./replay-routes";

const EMPTY_MARKERS: readonly ReplayMarkerSummary[] = Object.freeze([]);

export interface EpicReplaySnapshot {
  readonly status: "disabled" | "waiting" | "capturing" | "unavailable";
  readonly reason: string | null;
  readonly reference: ReplayRecordingReference | null;
  readonly snapshotReceived: boolean;
  readonly continuity: "fresh" | "resuming" | "resumed" | "new_recording" | "handoff";
  readonly evidence: "unverified";
}
export const UNAVAILABLE_REPLAY_SNAPSHOT: EpicReplaySnapshot = Object.freeze({
  status: "disabled", reason: "provider_unavailable", reference: null,
  snapshotReceived: false, continuity: "fresh", evidence: "unverified",
});

export interface ReplayRootOptions {
  documentRelease: string | null;
  lifecycle?: Partial<ReplayLifecycleOptions>;
  getPolicy?: () => PublicReplayConfig;
  subscribePolicy?: (listener: () => void) => () => void;
  consent?: ReplayConsentSource;
  sampler?: ReplaySampler;
  getPathname?: () => string;
  fetch?: ReplayFetch;
  now?: () => number;
  monotonicNow?: () => number;
  loadPipeline?: () => Promise<{ createReplayRecordingPipeline: (options: ReplayRecordingPipelineOptions) => ReplayRecordingPipeline }>;
  pipelineOptions?: Pick<ReplayRecordingPipelineOptions, "record" | "isOnline" | "getViewport">;
  handoff?: ReplayHandoff;
  navigation?: ReplayReloadNavigation;
  locks?: ReplayLockManager | null;
  owners?: ReturnType<typeof createReplayDocumentOwners>;
}

/** Lightweight coordinator. The recorder/pipeline chunk is imported only after permission + identity + DOM readiness. */
export function createReplayRootRuntime({
  documentRelease: suppliedRelease, lifecycle: suppliedLifecycle,
  getPolicy = () => replayLifecycle.getSnapshot(),
  subscribePolicy = (listener) => replayLifecycle.subscribe(listener),
  consent = epicReplayConsent, sampler = replaySampler,
  getPathname = () => window.location.pathname,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  now = Date.now, monotonicNow = () => performance.now(),
  loadPipeline = () => import("./replay-recording-pipeline"), pipelineOptions,
  handoff: suppliedHandoff, navigation, locks, owners = replayDocumentOwners(),
}: ReplayRootOptions) {
  const release = publicDocumentRelease(suppliedRelease);
  const lifecycle = replayLifecycleOptions(suppliedLifecycle);
  const handoff = suppliedHandoff ?? createReplayHandoff({ windowMs: lifecycle.handoffWindowMs, now, monotonicNow });
  const identity = createReplayIdentity({ fetch: fetchImpl, now, maxAttempts: () => getPolicy().recording.limits.maxAttempts });
  const budget = createReplayRecoveryBudget();
  let candidate = handoff.peek(navigation);
  // Import restrictive debt even when a later proof check rejects continuation.
  // Metadata can withhold recovery, never grant ownership or replenish attempts.
  if (candidate) budget.debt = candidate.prepared.context.recoveryDebt;
  let prepared: PreparedReplayHandoff | null = null;
  let prepareKey: string | null = null;
  let preparation = 0;
  let pipeline: ReplayRecordingPipeline | null = null;
  let unsubscribePipeline: (() => void) | undefined;
  let attached = 0;
  let requested = true;
  let suspended = false;
  let leaving = false;
  let exhausted = false;
  let deliberatelyDisabled = false;
  let idle = false;
  let identityKey: string | null | undefined;
  let previousIdentity: string | null | undefined;
  let identityReady = false;
  let revalidatingIdentity = false;
  let pausedIdentity: { checkpoint: ReplayUploadCheckpoint; policy: PublicReplayConfig; deadline: number; monotonicDeadline: number } | null = null;
  let resumeCandidate: typeof candidate = null;
  let generation = 0;
  let pending: AbortController | null = null;
  let startup = false;
  let resuming = false;
  let fingerprint = "";
  let durationDeadline = Infinity;
  let inactivityDeadline = Infinity;
  let lastBoundary = 0;
  let releaseOwner: (() => void) | null = null;
  let continuity: EpicReplaySnapshot["continuity"] = candidate ? "resuming" : "fresh";
  let state: EpicReplaySnapshot = { ...UNAVAILABLE_REPLAY_SNAPSHOT, reason: "identity_pending", status: "waiting" };
  const listeners = new Set<() => void>();
  const diagnosticListeners = new Set<() => void>();
  let diagnostics: { pipeline: ReturnType<ReplayRecordingPipeline["getState"]> | null; eligibleHandoff: boolean; recoveryDebt: number; markers: readonly ReplayMarkerSummary[] } = { pipeline: null, eligibleHandoff: false, recoveryDebt: 0, markers: EMPTY_MARKERS };
  const issuedEvidence = new WeakMap<ReplayEvidenceReference, number>();
  let reportContext = "";
  const reported = new Set<string>();
  let screenTimer: ReturnType<typeof setTimeout> | undefined;
  let lastScreen = "";
  let emittingMarker = false;
  const leases = new Map<string, ReplayOwnershipLease>();
  const cleanups: (() => void)[] = [];
  if (replayIdentityResetPending()) identity.requireReset();

  const hasLocks = () => {
    try { return locks !== undefined ? locks !== null : typeof navigator !== "undefined" && !!navigator.locks; }
    catch { return false; }
  };
  function publish(next: Partial<EpicReplaySnapshot> = {}) {
    const merged = { ...state, ...next };
    if (JSON.stringify(merged) === JSON.stringify(state)) return;
    state = Object.freeze(merged);
    for (const listener of [...listeners]) listener();
  }
  function permission() {
    return evaluateCapturePermission({ policy: getPolicy(), consent: consent.getSnapshot(), pathname: getPathname(),
      sampled: () => sampler.decide({ configVersion: getPolicy().configVersion, sessionSampleRate: getPolicy().capture.sessionSampleRate }) });
  }
  function allowed() {
    return attached > 0 && requested && !suspended && !exhausted && !idle && identityKey !== undefined && !!releaseOwner && permission().allowed;
  }
  function invalidateHandoff() {
    preparation++;
    prepared = null;
    prepareKey = null;
    handoff.invalidate();
  }
  function diagnosticsChanged() {
    const next = { pipeline: pipeline?.getState() ?? null, eligibleHandoff: !!prepared, recoveryDebt: budget.debt, markers: pipeline?.getMarkerSummaries() ?? EMPTY_MARKERS };
    if (next.pipeline === diagnostics.pipeline && next.eligibleHandoff === diagnostics.eligibleHandoff && next.recoveryDebt === diagnostics.recoveryDebt && next.markers === diagnostics.markers) return;
    diagnostics = next;
    for (const listener of [...diagnosticListeners]) listener();
  }
  function cancel(stop = true) {
    generation++;
    clearTimeout(screenTimer); screenTimer = undefined;
    pending?.abort(); pending = null;
    startup = false;
    resuming = false;
    identityReady = false;
    if (stop) {
      pausedIdentity = null;
      resumeCandidate = null;
      pipeline?.stop();
    }
  }
  function handoffContext(): ReplayHandoffContext | null {
    const time = monotonicNow();
    if (!release || durationDeadline <= time || inactivityDeadline <= time) return null;
    return { documentRelease: release, fingerprint: replayContextFingerprint(getPolicy(), lifecycle),
      remainingDurationMs: Math.floor(Math.min(lifecycle.maxDurationMs, durationDeadline - time)),
      remainingInactivityMs: Math.floor(Math.min(lifecycle.inactivityMs, inactivityDeadline - time)), recoveryDebt: budget.debt };
  }
  function update() {
    if (!pipeline) return;
    if (leaving || suspended || idle || !requested || revalidatingIdentity || pausedIdentity) { diagnosticsChanged(); return; }
    const current = pipeline.getState();
    const progress = pipeline.getProgress();
    if (current.capture.boundary !== lastBoundary) {
      if (lastBoundary > 0) {
        if (!resuming) {
          durationDeadline = monotonicNow() + lifecycle.maxDurationMs;
          continuity = "new_recording";
          resumeCandidate = null;
        }
      }
      lastBoundary = current.capture.boundary;
    }
    if ((current.upload.status === "unavailable" && !pipeline.isRecovering() && !resuming) || pipeline.hasCaptureFailure()) exhausted = true;
    if (resumeCandidate && handoff.remainingWindowMs(resumeCandidate) <= 0) {
      resumeCandidate = null; cancel(); invalidateHandoff(); continuity = "new_recording";
      if (!budget.take(getPolicy().recording.limits.maxAttempts)) exhausted = true;
      publish({ status: exhausted ? "unavailable" : "waiting", reason: "handoff_expired", reference: null, snapshotReceived: false, continuity });
      queueMicrotask(reconcile);
      return;
    }
    if (progress.continuity === "handoff" || (progress.continuity === "resumed" && current.upload.current?.boundary === current.capture.boundary)) {
      continuity = progress.continuity;
      if (continuity === "resumed") resumeCandidate = null;
    }
    publish({ status: exhausted ? "unavailable" : pipeline.isRecovering() ? "waiting" : current.capture.status === "capturing" ? "capturing" : "waiting",
      // Dropping unsent data on detach/revocation clears the transport's active
      // state; it must not erase the terminal outcome of the exhausted owner.
      reason: pipeline.hasCaptureFailure() ? "recorder_unavailable" : exhausted ? current.upload.reason ?? state.reason : current.capture.reason,
      reference: current.upload.current, snapshotReceived: progress.snapshotReceived, continuity });
    diagnosticsChanged();
    scheduleScreen();
    const checkpoint = pipeline.getCheckpoint();
    const context = handoffContext();
    const lease = checkpoint && leases.get(replayRecordingLockName(checkpoint.recordingId));
    if (!checkpoint || !context || !lease?.isHeld() || !allowed() || !identityReady) {
      if (prepareKey) invalidateHandoff();
      return;
    }
    const key = JSON.stringify([checkpoint, context.fingerprint, context.recoveryDebt]);
    if (key === prepareKey && prepared && now() < prepared.armedUntil - 5_000) return;
    if (key === prepareKey && !prepared) return;
    prepareKey = key;
    const attempt = ++preparation;
    void handoff.prepare(checkpoint, context).then((value) => {
      if (attempt !== preparation) return;
      prepared = value;
      if (!value) prepareKey = null;
      diagnosticsChanged();
    });
  }
  function markerAllowed() {
    return !leaving && allowed() && identityReady && !!pipeline;
  }
  function track(input: unknown): ReplayTrackResult {
    try {
      if (!markerAllowed()) return { status: "dropped", reason: "capture_not_permitted" };
      if (emittingMarker) return { status: "dropped", reason: "rate_limited" };
      emittingMarker = true;
      try { return pipeline!.track(input); }
      finally { emittingMarker = false; }
    } catch { return { status: "dropped", reason: "recorder_unavailable" }; }
  }
  function getEvidenceReference(): ReplayEvidenceReference | null {
    try {
      if (!markerAllowed()) return null;
      const evidence = pipeline!.getEvidenceReference();
      if (evidence) issuedEvidence.set(evidence, generation);
      return evidence;
    } catch { return null; }
  }
  function trackAcknowledgedReport(acknowledgment: unknown, frozenEvidence: ReplayEvidenceReference): ReplayTrackResult {
    try {
      if (!markerAllowed()) return { status: "dropped", reason: "capture_not_permitted" };
      if (!acknowledgment || typeof acknowledgment !== "object") return { status: "dropped", reason: "invalid_payload" };
      const ack = acknowledgment as { durable?: unknown; reportId?: unknown; behaviorId?: unknown; occurrenceId?: unknown };
      if (ack.durable !== true) return { status: "dropped", reason: "invalid_payload" };
      const parsed = parseReplayMarker({ tag: "epic.bug.reported", payload: { version: 1,
        reportId: ack.reportId, ...(ack.behaviorId === undefined ? {} : { behaviorId: ack.behaviorId }),
        ...(ack.occurrenceId === undefined ? {} : { occurrenceId: ack.occurrenceId }) } });
      if (!parsed.success || parsed.marker.tag !== "epic.bug.reported") return { status: "dropped", reason: "invalid_payload" };
      const current = getEvidenceReference();
      if (!current || issuedEvidence.get(frozenEvidence) !== generation ||
          current.recordingId !== frozenEvidence.recordingId || current.startedAt !== frozenEvidence.startedAt ||
          current.boundary !== frozenEvidence.boundary || current.release !== frozenEvidence.release || current.configVersion !== frozenEvidence.configVersion) return { status: "dropped", reason: "stale_reference" };
      const key = `${current.recordingId}:${current.boundary}`;
      if (reportContext !== key) { reported.clear(); reportContext = key; }
      if (reported.has(parsed.marker.payload.reportId)) return { status: "dropped", reason: "duplicate" };
      if (reported.size >= 128 || emittingMarker) return { status: "dropped", reason: "rate_limited" };
      emittingMarker = true;
      try {
        const result = pipeline!.track(parsed.marker, { acknowledgedReport: true });
        if (result.status === "emitted") reported.add(parsed.marker.payload.reportId);
        return result;
      } finally { emittingMarker = false; }
    } catch { return { status: "dropped", reason: "invalid_payload" }; }
  }
  function scheduleScreen() {
    if (screenTimer !== undefined || !markerAllowed()) return;
    const run = generation;
    screenTimer = setTimeout(() => {
      screenTimer = undefined;
      try {
        if (run !== generation || !markerAllowed()) return;
        const context = pipeline!.getEvidenceReference();
        if (!context) return;
        const path = normalizeReplayPath(getPathname());
        const key = `${context.recordingId}:${context.boundary}:${path}`;
        if (key === lastScreen) return;
        lastScreen = key;
        track({ tag: "epic.screen.viewed", payload: { version: 1, route: sanitizeMarkerRoute(path) } });
      } catch { /* Navigation never depends on telemetry. */ }
    }, 0);
  }
  async function own(name: string, signal: AbortSignal, timeoutMs = 1_000) {
    if (leases.get(name)?.isHeld()) return true;
    if (!hasLocks()) return true; // A fresh UUID remains document-owned; resume never uses this fallback.
    // Acquisition cancellation must not release a held lock before upload abort has settled.
    const lease = await acquireReplayOwnership(name, { locks, timeoutMs });
    if (!lease) return false;
    if (signal.aborted || !allowed()) { lease.release(); return false; }
    leases.set(name, lease);
    return true;
  }
  async function ready(signal: AbortSignal): Promise<boolean> {
    if (typeof document === "undefined" || signal.aborted) return false;
    if (document.readyState !== "loading") return true;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean) => {
        clearTimeout(timer); document.removeEventListener("DOMContentLoaded", onReady); signal.removeEventListener("abort", aborted); resolve(value);
      };
      const onReady = () => { timer = setTimeout(() => finish(!signal.aborted && document.readyState !== "loading"), 0); };
      const aborted = () => finish(false);
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
  async function begin() {
    if (startup || !allowed()) return;
    startup = true;
    const controller = new AbortController(); pending = controller;
    const run = ++generation;
    const valid = () => run === generation && !controller.signal.aborted && allowed();
    const offeredCandidate = candidate;
    const deadline = offeredCandidate ? now() + handoff.remainingWindowMs(offeredCandidate) : pausedIdentity?.deadline ?? Infinity;
    publish({ status: "waiting", reason: "identity_pending" });
    try {
      if (!await identity.acknowledge({ signal: controller.signal, deadline }) || !valid()) {
        if (valid() && offeredCandidate && handoff.remainingWindowMs(offeredCandidate) <= 0) {
          candidate = null; handoff.clear(); continuity = "new_recording";
          if (budget.take(getPolicy().recording.limits.maxAttempts)) {
            startup = false; queueMicrotask(reconcile); return;
          }
        }
        if (valid()) {
          candidate = null; cancel(); invalidateHandoff(); exhausted = true;
          publish({ status: "unavailable", reason: "identity_unavailable", reference: null, snapshotReceived: false });
        }
        return;
      }
      identityReady = true;
      clearReplayIdentityReset();
      publish({ reason: "document_loading" });
      if (!await ready(controller.signal) || !valid()) return;
      const loaded = await loadPipeline();
      if (!valid()) return;
      if (offeredCandidate && handoff.remainingWindowMs(offeredCandidate) <= 0) {
        candidate = null; handoff.clear(); continuity = "new_recording";
        if (!budget.take(getPolicy().recording.limits.maxAttempts)) {
          exhausted = true; publish({ status: "unavailable", reason: "attempts_exhausted", continuity }); return;
        }
      }
      fingerprint = replayContextFingerprint(getPolicy(), lifecycle);
      if (!pipeline) {
        pipeline = loaded.createReplayRecordingPipeline({ ...pipelineOptions, fetch: fetchImpl, getPolicy, subscribePolicy, consent, sampler, getPathname,
          getDocumentRelease: () => release, wallNow: now, monotonicNow, recoveryBudget: budget, managePageHide: false,
          getCaptureAllowed: () => allowed() && identityReady && monotonicNow() < durationDeadline && monotonicNow() < inactivityDeadline &&
            (!resumeCandidate || handoff.remainingWindowMs(resumeCandidate) > 0),
          beforeRegistration: (intent, signal) => own(replayIntentLockName(intent.idempotencyKey), signal),
          acquireOwnership: (intent, id, signal) => own(replayRecordingLockName(id), signal).then((held) => {
            if (held) { const key = replayIntentLockName(intent.idempotencyKey); leases.get(key)?.release(); leases.delete(key); }
            return held;
          }),
          onRecordingEnded: (intent, id) => {
            for (const key of [replayIntentLockName(intent.idempotencyKey), ...(id ? [replayRecordingLockName(id)] : [])]) {
              leases.get(key)?.release(); leases.delete(key);
            }
          },
        });
        unsubscribePipeline = pipeline.subscribe(update);
      }
      if (pausedIdentity) {
        const retained = pausedIdentity;
        const lease = leases.get(replayRecordingLockName(retained.checkpoint.recordingId));
        const eligible = now() < retained.deadline && monotonicNow() < retained.monotonicDeadline && monotonicNow() < durationDeadline && monotonicNow() < inactivityDeadline &&
          replayContextFingerprint(retained.policy, lifecycle) === fingerprint && (!hasLocks() || lease?.isHeld());
        pausedIdentity = null;
        if (eligible) {
          resuming = true;
          continuity = "resuming";
          const resumed = await pipeline.resumeFromCheckpoint(retained.checkpoint, { signal: controller.signal, deadline: retained.deadline, revalidate: true });
          if (run === generation) resuming = false;
          if (resumed && valid()) { update(); return; }
        }
        if (!valid()) return;
        pipeline.stop(); exhausted = false; continuity = "new_recording";
        if (!budget.take(getPolicy().recording.limits.maxAttempts)) {
          exhausted = true; publish({ status: "unavailable", reason: "attempts_exhausted", reference: null, continuity }); return;
        }
      }
      durationDeadline = monotonicNow() + lifecycle.maxDurationMs;
      inactivityDeadline = monotonicNow() + lifecycle.inactivityMs;
      if (candidate) {
        const offered = candidate; candidate = null;
        const context = handoffContext();
        const key = replayRecordingLockName(offered.prepared.upload.recordingId);
        const remaining = handoff.remainingWindowMs(offered);
        const lease = context && remaining > 0 && hasLocks() ? await acquireReplayOwnership(key, { locks, timeoutMs: Math.max(1, Math.min(1_000, remaining)) }) : null;
        let adopted = false;
        if (!valid()) { lease?.release(); return; }
        const consumed = lease && context ? await handoff.consume(offered, context, lease, controller.signal) : null;
        if (consumed && valid()) {
          leases.set(key, lease!);
          adopted = true;
          budget.debt = Math.max(budget.debt, consumed.remaining.recoveryDebt);
          durationDeadline = monotonicNow() + consumed.remaining.remainingDurationMs;
          inactivityDeadline = monotonicNow() + consumed.remaining.remainingInactivityMs;
          resuming = true;
          resumeCandidate = offered;
          const resumed = await pipeline.resumeFromCheckpoint(offered.prepared.upload, { signal: controller.signal, deadline: now() + handoff.remainingWindowMs(offered) });
          if (run === generation) resuming = false;
          if (resumed && valid()) { update(); return; }
        }
        // An abort can settle the public resume result before fetch itself settles.
        // The transport's onRecordingEnded owns adopted leases until all work ends.
        if (!adopted || !pipeline.hasPendingWork()) { lease?.release(); leases.delete(key); }
        handoff.clear();
        if (!valid()) return;
        pipeline.stop(); exhausted = false;
        resumeCandidate = null;
        continuity = "new_recording";
        if (!budget.take(getPolicy().recording.limits.maxAttempts)) { exhausted = true; publish({ status: "unavailable", reason: "attempts_exhausted", continuity }); return; }
      }
      if (!valid()) return;
      durationDeadline = monotonicNow() + lifecycle.maxDurationMs;
      inactivityDeadline = monotonicNow() + lifecycle.inactivityMs;
      pipeline.start({ explicit: false });
      update();
    } catch {
      if (valid()) {
        candidate = null; cancel(); invalidateHandoff(); exhausted = true;
        publish({ status: "unavailable", reason: "runtime_unavailable", reference: null, snapshotReceived: false });
      }
    } finally {
      if (run === generation) { startup = false; pending = null; }
    }
  }
  function reconcile() {
    if (!attached || suspended) return;
    const policy = getPolicy();
    if (policy.status === "active" && !policy.capture.enabled) deliberatelyDisabled = true;
    else if (deliberatelyDisabled && policy.status === "active" && policy.capture.enabled) {
      deliberatelyDisabled = false;
      cancel(); invalidateHandoff(); fingerprint = "";
      exhausted = false;
      budget.reset();
    }
    if (!releaseOwner && owners.getOwner() === null) {
      // acquire emits synchronously; defer its observer to prevent recursive acquisition.
      releaseOwner = owners.acquire("root", () => { releaseOwner = null; cancel(); invalidateHandoff(); publish({ status: "disabled", reason: "harness_owner", reference: null }); });
    }
    const gate = permission();
    if (pausedIdentity) {
      const retainedGate = evaluateCapturePermission({ policy: pausedIdentity.policy, consent: consent.getSnapshot(), pathname: getPathname(), sampled: () => true });
      const policyPending = policy.status === "disabled" && policy.reason === "unavailable";
      if (!requested || !releaseOwner || !retainedGate.allowed || now() >= pausedIdentity.deadline || monotonicNow() >= pausedIdentity.monotonicDeadline ||
          monotonicNow() >= durationDeadline || monotonicNow() >= inactivityDeadline ||
          (!policyPending && (!gate.allowed || replayContextFingerprint(policy, lifecycle) !== replayContextFingerprint(pausedIdentity.policy, lifecycle)))) {
        cancel(); invalidateHandoff(); continuity = "new_recording";
      } else if (revalidatingIdentity || policyPending) {
        publish({ status: "waiting", reason: revalidatingIdentity ? "identity_pending" : "policy_pending", reference: null, snapshotReceived: false });
        return;
      }
    }
    if (!allowed()) {
      if (pipeline?.getState().capture.status === "capturing" || startup) cancel();
      if (consent.getSnapshot() === "withdrawn") { candidate = null; invalidateHandoff(); }
      if (!exhausted) publish({ status: gate.allowed ? "waiting" : "disabled", reason: !requested ? "stopped" : idle ? "inactive" : !releaseOwner ? "harness_owner" : identityKey === undefined ? "identity_pending" : gate.allowed ? "waiting" : gate.reason, reference: null, snapshotReceived: false });
      return;
    }
    const next = replayContextFingerprint(getPolicy(), lifecycle);
    if (fingerprint && next !== fingerprint) { cancel(); invalidateHandoff(); fingerprint = next; }
    if (pipeline?.getState().capture.status === "capturing" || pipeline?.isRecovering()) return;
    void begin();
  }
  function onPageHide(event: PageTransitionEvent) {
    if (suspended || leaving) return;
    const eligible = allowed() && identityReady && !event.persisted;
    leaving = true;
    const current = pipeline;
    const checkpoint = current?.quiesceForHandoff();
    const context = handoffContext();
    const lease = checkpoint && leases.get(replayRecordingLockName(checkpoint.recordingId));
    const offered = eligible && checkpoint && context && lease && prepared && handoff.offer(prepared, checkpoint, context, lease, { persisted: event.persisted });
    suspended = true;
    generation++; pending?.abort(); pending = null; startup = false; identityReady = false;
    if (offered) { current!.commitHandoff(); continuity = "handoff"; publish({ status: "waiting", reason: "unresumed_open", reference: null, continuity, snapshotReceived: false }); }
    else { invalidateHandoff(); current?.flushOnPageHide(); publish({ status: "waiting", reason: "unload_incomplete", reference: null }); }
    leaving = false;
  }
  function onActivity(event?: Event) {
    if (event && "isTrusted" in event && !event.isTrusted) return;
    inactivityDeadline = monotonicNow() + lifecycle.inactivityMs;
    if (idle) { idle = false; reconcile(); }
  }
  function onTick() {
    if (candidate && handoff.remainingWindowMs(candidate) <= 0) { candidate = null; handoff.clear(); continuity = "new_recording"; }
    if (suspended || !attached) return;
    if (!revalidatingIdentity && !pausedIdentity && pipeline && (pipeline.getState().capture.status === "capturing" || pipeline.getRecordingReference() !== null)) {
      if (monotonicNow() >= inactivityDeadline) { idle = true; pipeline.stopCapture(); if (permission().allowed) pipeline.flushOnPageHide(); cancel(); invalidateHandoff(); publish({ status: "waiting", reason: "inactive", reference: null }); }
      else if (monotonicNow() >= durationDeadline) { invalidateHandoff(); durationDeadline = monotonicNow() + lifecycle.maxDurationMs; pipeline.rotate(); update(); }
      else update();
    }
    reconcile();
  }
  function install() {
    cleanups.push(subscribePolicy(reconcile), consent.subscribe(reconcile), owners.subscribe(() => queueMicrotask(reconcile)));
    cleanups.push(attachReplayBrowserMarkers(track));
    const navigated = () => { reconcile(); scheduleScreen(); };
    for (const method of ["pushState", "replaceState"] as const) {
      const original = window.history[method];
      const patched = function(this: History, ...args: Parameters<History["pushState"]>) { const result = original.apply(this, args); navigated(); return result; };
      window.history[method] = patched;
      cleanups.push(() => { if (window.history[method] === patched) window.history[method] = original; });
    }
    const show = (event: PageTransitionEvent) => { if (event.persisted || suspended) { suspended = false; candidate = null; handoff.clear(); cancel(); continuity = "new_recording"; replayLifecycle.gate(); reconcile(); } };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", show);
    window.addEventListener("popstate", navigated);
    // The redirecting GET can be entered without a React auth mutation.
    const signoutNavigation = (url: string | undefined) => {
      if (!url) return;
      try {
        const destination = new URL(url, window.location.href);
        if (destination.origin === window.location.origin && destination.pathname === "/auth/signout") {
          beginReplayIdentityBoundary();
          identityKey = undefined; candidate = null; cancel(); invalidateHandoff();
        }
      } catch { /* An invalid destination grants no new replay permission. */ }
    };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") as HTMLAnchorElement | null : null;
      if (anchor && (!anchor.target || anchor.target === "_self")) signoutNavigation(anchor.href);
    };
    const navigationTarget = (window as Window & { navigation?: EventTarget }).navigation;
    const navigate = (event: Event) => signoutNavigation((event as Event & { destination?: { url?: string } }).destination?.url);
    document.addEventListener("click", click, true);
    navigationTarget?.addEventListener("navigate", navigate);
    for (const name of ["pointerdown", "keydown", "scroll"] as const) window.addEventListener(name, onActivity, { passive: true });
    const tick = setInterval(onTick, 1_000);
    cleanups.push(() => {
      clearInterval(tick); window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", show); window.removeEventListener("popstate", navigated);
      document.removeEventListener("click", click, true); navigationTarget?.removeEventListener("navigate", navigate);
      for (const name of ["pointerdown", "keydown", "scroll"] as const) window.removeEventListener(name, onActivity);
    });
  }
  function beginIdentityRevalidation() {
    if (revalidatingIdentity) return;
    revalidatingIdentity = true;
    identityKey = undefined;
    cancel(false);
    const checkpoint = pipeline?.quiesceForHandoff();
    const lease = checkpoint && leases.get(replayRecordingLockName(checkpoint.recordingId));
    if (checkpoint && permission().allowed && (!hasLocks() || lease?.isHeld())) {
      pausedIdentity = { checkpoint, policy: structuredClone(getPolicy()), deadline: now() + 12_000, monotonicDeadline: monotonicNow() + 12_000 };
    } else if (pipeline) {
      pipeline.stop(); invalidateHandoff(); continuity = "new_recording";
    }
    if (!exhausted) publish({ status: "waiting", reason: "identity_pending", reference: null, snapshotReceived: false });
  }
  return {
    track,
    getEvidenceReference,
    trackAcknowledgedReport,
    attach() { attached++; if (attached === 1) install(); reconcile(); return () => { attached = Math.max(0, attached - 1); if (!attached) { cancel(); if (!(suspended && continuity === "handoff")) invalidateHandoff(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); releaseOwner?.(); releaseOwner = null; } }; },
    setIdentity(key: string | null | undefined) {
      if (key === undefined) { beginIdentityRevalidation(); return; }
      if (identityKey === key) return;
      const changed = previousIdentity !== undefined && previousIdentity !== key;
      if (changed) { identity.requireReset(); candidate = null; cancel(); invalidateHandoff(); continuity = "new_recording"; }
      previousIdentity = key;
      identityKey = key;
      if (!revalidatingIdentity) cancel();
      revalidatingIdentity = false;
      reconcile();
    },
    beginIdentityRevalidation,
    failIdentityRevalidation() { revalidatingIdentity = false; identityKey = undefined; candidate = null; cancel(); invalidateHandoff(); exhausted = true; publish({ status: "unavailable", reason: "identity_unavailable", reference: null, snapshotReceived: false }); },
    beginIdentityChange() { revalidatingIdentity = false; identity.requireReset(); identityKey = undefined; candidate = null; cancel(); invalidateHandoff(); if (!exhausted) publish({ status: "waiting", reason: "identity_pending", reference: null, snapshotReceived: false }); },
    start() { requested = true; idle = false; reconcile(); },
    stop() { requested = false; candidate = null; cancel(); invalidateHandoff(); publish({ status: "disabled", reason: "stopped", reference: null, snapshotReceived: false }); },
    restart() { cancel(); invalidateHandoff(); exhausted = false; budget.reset(); requested = true; idle = false; reconcile(); },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getDiagnostics: () => diagnostics,
    subscribeDiagnostics(listener: () => void) { diagnosticListeners.add(listener); return () => { diagnosticListeners.delete(listener); }; },
    activity: () => onActivity(),
    dispose() { attached = 0; cancel(); if (!(suspended && continuity === "handoff")) invalidateHandoff(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); unsubscribePipeline?.(); pipeline?.dispose(); releaseOwner?.(); releaseOwner = null; listeners.clear(); diagnosticListeners.clear(); },
  };
}

export type ReplayRootRuntime = ReturnType<typeof createReplayRootRuntime>;
