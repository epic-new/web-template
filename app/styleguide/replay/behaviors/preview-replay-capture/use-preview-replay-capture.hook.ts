"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createReplayMemoryBuffer, type ReplayBufferEntry } from "@/lib/replay/replay-buffer";
import {
  createReplayCaptureSession,
  type ReplayCaptureSession,
  type ReplayCaptureState,
} from "@/lib/replay/replay-capture";
import {
  disabledReplayConfig,
  REPLAY_RECORDING_LIMITS,
  type PublicReplayConfig,
} from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { replayDocumentOwners } from "@/lib/replay/replay-document-owner";
import { createReplayIdentity, subscribeReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { createReplaySampler } from "@/lib/replay/replay-sampling";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { evaluateCapturePermission } from "@/lib/replay/replay-permission";
import { syntheticReplayPolicy, type ReplayHarnessSource } from "./synthetic-policies";

/**
 * The privacy harness's capture session: real recorder, real gates and
 * sanitizers, writing into a local in-memory buffer that is displayed and
 * never uploaded. Module-level so it survives client navigation between the
 * harness and its excluded page; disposed, and its buffer cleared, a task
 * after the last harness page unmounts.
 */

let currentSource: ReplayHarnessSource = "application";
let synthetic: PublicReplayConfig | null = null;
const sourceListeners = new Set<() => void>();

function getPolicy(): PublicReplayConfig {
  if (currentSource === "application" || !synthetic) return replayLifecycle.getSnapshot();
  if (Date.now() >= synthetic.expiresAt) {
    return disabledReplayConfig({
      reason: "expired",
      environment: synthetic.environment,
      release: null,
      now: synthetic.expiresAt,
    });
  }
  return synthetic;
}

const buffer = createReplayMemoryBuffer(REPLAY_RECORDING_LIMITS);
const sampler = createReplaySampler({ storage: null });
let session: ReplayCaptureSession | null = null;
let mounted = 0;
let disposeTimer: ReturnType<typeof setTimeout> | undefined;
let releaseOwner: (() => void) | null = null;
let bootstrap: AbortController | null = null;
let identityReady = false;
const identityTransitions = new Set<number>();
let unsubscribeIdentity: (() => void) | null = null;

// This harness has no remote recording or subject: acknowledge only its
// explicitly synthetic, memory-only identity, never call the application relay.
const identity = createReplayIdentity({ fetch: async () => Response.json({ contractVersion: 1 }) });

function stopOwnedSession() {
  bootstrap?.abort();
  bootstrap = null;
  identityReady = false;
  session?.dispose();
  buffer.clear();
}

function acquireHarness() {
  if (!releaseOwner) {
    releaseOwner = replayDocumentOwners().acquire("harness", () => {
      releaseOwner = null;
      stopOwnedSession();
    });
  }
  getSession().start();
  const policy = getPolicy();
  const permitted = evaluateCapturePermission({ policy, consent: epicReplayConsent.getSnapshot(), pathname: window.location.pathname,
    sampled: () => sampler.decide({ configVersion: policy.configVersion, sessionSampleRate: policy.capture.sessionSampleRate }) }).allowed;
  if (bootstrap || identityTransitions.size > 0 || !permitted) return;
  const controller = new AbortController();
  bootstrap = controller;
  void identity.acknowledge({ signal: controller.signal }).then((accepted) => {
    if (controller.signal.aborted || bootstrap !== controller || !releaseOwner || mounted === 0) return;
    identityReady = accepted;
    getSession().refresh();
  });
}

function getSession(): ReplayCaptureSession {
  session ??= createReplayCaptureSession({
    sink: buffer,
    getPolicy,
    sampler,
    getCaptureAllowed: () => identityReady && identityTransitions.size === 0 && releaseOwner !== null && mounted > 0,
    subscribePolicy: (listener) => {
      const unsubscribe = replayLifecycle.subscribe(listener);
      sourceListeners.add(listener);
      return () => {
        unsubscribe();
        sourceListeners.delete(listener);
      };
    },
  });
  return session;
}

function setSource(next: ReplayHarnessSource) {
  currentSource = next;
  synthetic = next === "application" ? null : syntheticReplayPolicy(next);
  if (mounted > 0) acquireHarness();
  for (const listener of [...sourceListeners]) listener();
  for (const listener of [...sourceStoreListeners]) listener();
}

const sourceStoreListeners = new Set<() => void>();
function subscribeSource(listener: () => void) {
  sourceStoreListeners.add(listener);
  return () => {
    sourceStoreListeners.delete(listener);
  };
}

const blocked: ReplayCaptureState = { status: "blocked", reason: "policy_disabled", boundary: 0 };
const noEvents: readonly ReplayBufferEntry[] = [];

// Keeps the module-level session started while any harness component is mounted.
function useHarnessSession() {
  useEffect(() => {
    mounted++;
    clearTimeout(disposeTimer);
    acquireHarness();
    const consent = epicReplayConsent.subscribe(() => { if (releaseOwner) acquireHarness(); });
    if (!unsubscribeIdentity) unsubscribeIdentity = subscribeReplayIdentityBoundary((event) => {
      if (event.phase === "begin") identityTransitions.add(event.epoch);
      if (event.phase === "settled") identityTransitions.delete(event.epoch);
      if (event.phase !== "settled") {
        stopOwnedSession();
        identity.requireReset();
      }
      // External invalidation is broadcast after the remote auth operation settles.
      if (event.phase !== "begin" && mounted > 0 && releaseOwner && identityTransitions.size === 0) acquireHarness();
    });
    return () => {
      consent();
      mounted = Math.max(0, mounted - 1);
      if (mounted === 0) { stopOwnedSession(); unsubscribeIdentity?.(); unsubscribeIdentity = null; identityTransitions.clear(); }
      disposeTimer = setTimeout(() => {
        if (mounted > 0) return;
        releaseOwner?.();
        releaseOwner = null;
        session = null;
        buffer.clear();
      }, 0);
    };
  }, []);
}

/**
 * Capture state and the buffered events. Re-renders on every admitted event,
 * so only components inside `data-private` may use it: a recorded component
 * re-rendering per event would record its own re-render and never settle.
 */
export function usePreviewReplayCapture() {
  useHarnessSession();

  const state = useSyncExternalStore(
    (listener) => getSession().subscribe(listener),
    () => getSession().getState(),
    () => blocked,
  );
  const events = useSyncExternalStore(buffer.subscribe, buffer.events, () => noEvents);

  return {
    status: state.status,
    reason: state.reason,
    boundary: state.boundary,
    events,
    eventCount: events.length,
    bufferJson: JSON.stringify(events, null, 2),
  };
}

/** The harness's policy source. Re-renders only when the source changes. */
export function useReplayHarnessSource() {
  useHarnessSession();

  const source = useSyncExternalStore(subscribeSource, () => currentSource, () => "application" as const);
  return { source, setSource };
}

// Tests only.
export function resetPreviewReplayCapture() {
  clearTimeout(disposeTimer);
  stopOwnedSession();
  unsubscribeIdentity?.(); unsubscribeIdentity = null; identityTransitions.clear();
  releaseOwner?.();
  releaseOwner = null;
  session = null;
  mounted = 0;
  buffer.clear();
  currentSource = "application";
  synthetic = null;
}
