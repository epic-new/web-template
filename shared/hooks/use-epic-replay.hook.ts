"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { EpicReplaySnapshot, ReplayRootRuntime } from "@/lib/replay/replay-root-runtime";
import type { ReplayTrackResult } from "@/lib/replay/replay-marker.contract";
import type { ReplayEvidenceReference } from "@/lib/replay/replay-evidence";

/** Type-only runtime dependency keeps rrweb and even the manager out of the SSR path. */
export const EMPTY_EPIC_REPLAY: EpicReplaySnapshot = Object.freeze({
  status: "disabled", reason: "provider_unavailable", reference: null,
  snapshotReceived: false, continuity: "fresh", evidence: "unverified",
});
export const EpicReplayContext = createContext<ReplayRootRuntime | null>(null);
const emptySubscribe = () => () => {};
const getEmpty = () => EMPTY_EPIC_REPLAY;
const getEmptyDiagnostics = () => null;
const noop = () => {};
const unavailable = (): ReplayTrackResult => ({ status: "dropped", reason: "provider_unavailable" });
const emptyTrack: (input: unknown) => ReplayTrackResult = unavailable;
const emptyReport: (ack: unknown, frozen: ReplayEvidenceReference) => ReplayTrackResult = unavailable;
const EMPTY_CONTROLS = Object.freeze({
  start: noop, stop: noop, restart: noop,
  track: emptyTrack,
  getEvidenceReference: (): ReplayEvidenceReference | null => null,
  trackAcknowledgedReport: emptyReport,
});

/** Internal adapter for the development harness; ordinary consumers use useEpicReplay. */
export function useEpicReplayRuntime(): ReplayRootRuntime | null {
  return useContext(EpicReplayContext);
}

export function useEpicReplay() {
  const runtime = useEpicReplayRuntime();
  const snapshot = useSyncExternalStore(runtime?.subscribe ?? emptySubscribe, runtime?.getSnapshot ?? getEmpty, getEmpty);
  const controls = useMemo(() => runtime ? {
    start: () => { try { runtime.start(); } catch { /* Replay is optional. */ } },
    stop: () => { try { runtime.stop(); } catch { /* Replay is optional. */ } },
    restart: () => { try { runtime.restart(); } catch { /* Replay is optional. */ } },
    track: (input: unknown): ReplayTrackResult => {
      try { return runtime.track(input); } catch { return { status: "dropped", reason: "recorder_unavailable" }; }
    },
    getEvidenceReference: (): ReplayEvidenceReference | null => {
      try { return runtime.getEvidenceReference(); } catch { return null; }
    },
    trackAcknowledgedReport: (ack: unknown, frozen: ReplayEvidenceReference): ReplayTrackResult => {
      try { return runtime.trackAcknowledgedReport(ack, frozen); } catch { return { status: "dropped", reason: "recorder_unavailable" }; }
    },
  } : EMPTY_CONTROLS, [runtime]);
  return useMemo(() => ({ ...snapshot, ...controls }), [snapshot, controls]);
}

/** Opt-in private diagnostics: never feed this volatile snapshot to normal app consumers. */
export function useEpicReplayDiagnostics() {
  const runtime = useEpicReplayRuntime();
  return useSyncExternalStore(runtime?.subscribeDiagnostics ?? emptySubscribe,
    runtime?.getDiagnostics ?? getEmptyDiagnostics, getEmptyDiagnostics);
}

