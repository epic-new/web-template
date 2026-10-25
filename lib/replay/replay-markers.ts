import { EVIDENCE_EVENTS, type EvidenceInput } from "./replay-otlp";
import { normalizeReplayPath } from "./replay-routes";
import { sanitizeReplayError } from "./replay-redaction";

/**
 * Behavior, navigation and browser-error markers, recorded as rrweb custom
 * events so they sit on the same millisecond timeline as everything else.
 * They carry no free text from the application: a behavior event holds only
 * short identifiers, an error holds the sanitized name, message and stack.
 *
 * Behavior events and browser errors are also handed to `emitEvidence` as
 * plain log records, whether or not the replay is being recorded: the
 * replay timeline reads the rrweb markers, the evidence stays queryable for
 * sessions the sampler left unrecorded.
 */

export const REPLAY_EVENT_NAMES = [
  "epic.screen.viewed",
  "epic.behavior.started",
  "epic.behavior.succeeded",
  "epic.behavior.failed",
  "epic.bug.reported",
] as const;
export type ReplayEventName = (typeof REPLAY_EVENT_NAMES)[number];

export interface ReplayEventPayload {
  behaviorId?: string;
  occurrenceId?: string;
  reportId?: string;
}

export type ReplayEventResult =
  | { recorded: true }
  | { recorded: false; reason: "unsupported_event" | "not_recording" };

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PAYLOAD_KEYS = ["behaviorId", "occurrenceId", "reportId"] as const;

const NAVIGATE_TAG = "epic.navigate";
const ERROR_TAG = "epic.error";
const MAX_ERROR_MARKERS = 50;

export function isReplayEventName(name: unknown): name is ReplayEventName {
  return typeof name === "string" && (REPLAY_EVENT_NAMES as readonly string[]).includes(name);
}

/** Keeps only the three identifier fields, and only well-formed values. */
export function sanitizeReplayEventPayload(payload: unknown): ReplayEventPayload {
  const result: ReplayEventPayload = {};
  if (!payload || typeof payload !== "object") return result;
  for (const key of PAYLOAD_KEYS) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && ID_PATTERN.test(value)) result[key] = value;
  }
  return result;
}

type AddCustomEvent = (tag: string, payload: unknown) => boolean;
type EmitEvidence = (input: EvidenceInput) => void;

const BEHAVIOR_EVIDENCE: Partial<Record<ReplayEventName, EvidenceInput["event"]>> = {
  "epic.behavior.started": EVIDENCE_EVENTS.behaviorStarted,
  "epic.behavior.succeeded": EVIDENCE_EVENTS.behaviorSucceeded,
  "epic.behavior.failed": EVIDENCE_EVENTS.behaviorFailed,
};

/**
 * Navigation and error markers for the one provider. `start()` is idempotent
 * and `stop()` removes every listener, so remounts never duplicate a marker.
 */
export function createReplayMarkers(
  add: AddCustomEvent,
  emitEvidence?: EmitEvidence,
  getRoute: () => string = () => normalizeReplayPath(window.location.pathname),
  now: () => number = () => Date.now(),
) {
  let started = false;
  let emitting = false;
  let errors = 0;
  let lastBehavior: { behaviorId?: string; occurrenceId?: string } | null = null;
  const cleanups: (() => void)[] = [];

  // A failure while adding a marker must not produce a marker of its own.
  function guarded(tag: string, payload: unknown) {
    if (emitting) return;
    emitting = true;
    try {
      add(tag, payload);
    } catch {
      // Marker failures stay silent.
    } finally {
      emitting = false;
    }
  }

  function reportError(kind: "error" | "unhandledrejection", error: unknown) {
    if (emitting || errors >= MAX_ERROR_MARKERS) return;
    errors += 1;
    const { name, message, stack } = sanitizeReplayError(error);
    guarded(ERROR_TAG, { kind, name, message, stack });
    evidence({ event: EVIDENCE_EVENTS.browserError, body: `${name}: ${message}` });
  }

  // Evidence never throws into the page and never depends on the replay recording.
  function evidence(input: Omit<EvidenceInput, "at" | "route">) {
    if (!emitEvidence) return;
    try {
      emitEvidence({ ...input, at: now(), route: getRoute().slice(0, 512) });
    } catch {
      // Evidence is best effort.
    }
  }

  return {
    start() {
      if (started || typeof window === "undefined") return;
      started = true;
      errors = 0;

      const onError = (event: ErrorEvent) => reportError("error", event.error ?? event.message);
      const onRejection = (event: PromiseRejectionEvent) => reportError("unhandledrejection", event.reason);
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      cleanups.push(
        () => window.removeEventListener("error", onError),
        () => window.removeEventListener("unhandledrejection", onRejection),
      );
    },

    stop() {
      started = false;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },

    navigate(pathname: string) {
      guarded(NAVIGATE_TAG, { path: normalizeReplayPath(pathname).slice(0, 512) });
    },

    /** The identifiers of the latest behavior marker, for a report to cite. */
    getLastBehavior(): { behaviorId?: string; occurrenceId?: string } | null {
      return lastBehavior ? { ...lastBehavior } : null;
    },

    event(name: unknown, payload?: unknown): ReplayEventResult {
      if (!isReplayEventName(name)) return { recorded: false, reason: "unsupported_event" };
      const clean = sanitizeReplayEventPayload(payload);
      const behavior = BEHAVIOR_EVIDENCE[name];
      if (behavior) {
        lastBehavior = { behaviorId: clean.behaviorId, occurrenceId: clean.occurrenceId };
        evidence({
          event: behavior,
          body: `${behavior}${clean.behaviorId ? ` ${clean.behaviorId}` : ""}`,
          behaviorName: clean.behaviorId,
          occurrence: clean.occurrenceId,
        });
      }
      try {
        const recorded = add(name, clean);
        return recorded ? { recorded: true } : { recorded: false, reason: "not_recording" };
      } catch {
        return { recorded: false, reason: "not_recording" };
      }
    },
  };
}

export type ReplayMarkers = ReturnType<typeof createReplayMarkers>;
