"use client";

import { createContext, useContext } from "react";

import type { ReplayCaptureState } from "./replay-capture";
import type { ReplayEventResult } from "./replay-markers";
import type { ReplayRecordingReference, ReplayUploadState } from "./replay-uploader";

/**
 * What the application can know about replay. `recording` means a recorder is
 * running; it never means a recording is playable - `evidence` is always
 * `"unverified"` here, because only Epic can verify playback.
 */
export type EpicReplayStatus =
  /** Capture is off: not configured, not enabled, or the provider is absent. */
  | "disabled"
  /** Enabled, but a gate (consent, route, sampling, identity) has not passed. */
  | "waiting"
  | "recording"
  | "unavailable";

export interface EpicReplay {
  status: EpicReplayStatus;
  reason: string | null;
  capture: ReplayCaptureState | null;
  upload: ReplayUploadState | null;
  evidence: "unverified";
  reporting: { enabled: boolean };
  /**
   * The recording a bug report may attach, or null. Only a recording this tab
   * registered successfully is ever returned.
   */
  getRecordingReference(): ReplayRecordingReference | null;
  /** Records an application event; harmless when nothing is recording. */
  event(name: string, payload?: unknown): ReplayEventResult;
}

const DISABLED: EpicReplay = {
  status: "disabled",
  reason: null,
  capture: null,
  upload: null,
  evidence: "unverified",
  reporting: { enabled: false },
  getRecordingReference: () => null,
  event: () => ({ recorded: false, reason: "not_recording" }),
};

export const EpicReplayContext = createContext<EpicReplay>(DISABLED);

/** Harmless outside the provider: everything reports disabled and no-ops. */
export function useEpicReplay(): EpicReplay {
  return useContext(EpicReplayContext);
}
