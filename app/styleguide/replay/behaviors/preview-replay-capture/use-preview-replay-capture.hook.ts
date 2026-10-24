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
let session: ReplayCaptureSession | null = null;
let mounted = 0;
let disposeTimer: ReturnType<typeof setTimeout> | undefined;

function getSession(): ReplayCaptureSession {
  session ??= createReplayCaptureSession({
    sink: buffer,
    getPolicy,
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
    getSession().start();
    return () => {
      mounted--;
      disposeTimer = setTimeout(() => {
        if (mounted > 0) return;
        session?.dispose();
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
  session?.dispose();
  session = null;
  mounted = 0;
  buffer.clear();
  currentSource = "application";
  synthetic = null;
}
