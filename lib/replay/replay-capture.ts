import { record as rrwebRecord } from "@rrweb/record";
import { EventType, type eventWithTime } from "@rrweb/types";

import type { PublicReplayConfig } from "./replay-config.contract";
import { epicReplayConsent, type ReplayConsentSource } from "./replay-consent";
import { replayLifecycle } from "./replay-lifecycle";
import type { ReplayEventSink } from "./replay-buffer";
import { createReplayEventSanitizer } from "./replay-event-sanitizer";
import { evaluateCapturePermission, type ReplayBlockReason } from "./replay-permission";
import { buildReplayRecordOptions } from "./replay-record-options";
import { jsonByteLength } from "./replay-redaction";
import { normalizeReplayPath } from "./replay-routes";
import { replaySampler, type ReplaySampler } from "./replay-sampling";
import { parseReplayMarker, type ReplayMarker, type ReplayTrackResult, type ReplayTrackDropReason } from "./replay-marker.contract";

/**
 * The privacy-enforcing wrapper around `@rrweb/record`. See
 * docs/replay-privacy.md.
 *
 * Every event is re-checked against the effective policy (whose expiry
 * `replayLifecycle.getSnapshot()` evaluates at read time), consent and the
 * current pathname before it is sanitized and handed to the sink. Stops are
 * synchronous: on consent withdrawal, on a policy change, and on every URL
 * change. Next's App Router calls `history.pushState` in an insertion effect,
 * inside the same commit that swaps the DOM, so the recorder is stopped
 * before its MutationObserver can deliver a single mutation of an excluded
 * page — and anything that still arrives is dropped at admission.
 *
 * A withdrawal clears the sink inside `withdraw()` whichever gate is reported
 * as the reason: an expired or disabled policy that already blocks capture
 * does not keep earlier events retained.
 *
 * Starts after a URL change are deferred by one task, so the FullSnapshot of
 * a new boundary is taken of the committed page rather than a DOM React is
 * still replacing. Every start is a new boundary that begins with Meta and
 * FullSnapshot; incremental events never cross boundaries.
 *
 * One session per tab. The root provider (WEB-4) owns that instance; this
 * module starts nothing on import.
 */

type RecordFn = typeof rrwebRecord;

export interface ReplayCaptureState {
  status: "capturing" | "blocked";
  reason: ReplayBlockReason | "transport_unavailable" | "identity_pending" | "document_loading" | "opening_snapshot" | null;
  boundary: number;
}

export interface ReplayCaptureSessionOptions {
  sink: ReplayEventSink;
  getPolicy?: () => PublicReplayConfig;
  subscribePolicy?: (listener: () => void) => () => void;
  consent?: ReplayConsentSource;
  sampler?: ReplaySampler;
  record?: RecordFn;
  getPathname?: () => string;
  /** Root-owned identity/producer gate, checked again for every event. */
  getCaptureAllowed?: () => boolean;
  preflightMarker?: (event: eventWithTime, boundary: number) => ReplayTrackDropReason | null;
  onMarker?: (marker: ReplayMarker, timestamp: number, boundary: number) => void;
}

export function createReplayCaptureSession({
  sink,
  getPolicy = () => replayLifecycle.getSnapshot(),
  subscribePolicy = (listener) => replayLifecycle.subscribe(listener),
  consent = epicReplayConsent,
  sampler = replaySampler,
  record = rrwebRecord,
  getPathname = () => window.location.pathname,
  getCaptureAllowed = () => true,
  preflightMarker = () => "recording_unavailable",
  onMarker,
}: ReplayCaptureSessionOptions) {
  let state: ReplayCaptureState = { status: "blocked", reason: "policy_disabled", boundary: 0 };
  let active: {
    boundary: number;
    privacy: string;
    stop?: () => void;
    openingMeta?: eventWithTime;
    openingTimer?: ReturnType<typeof setTimeout>;
    opened: boolean;
    admittingOpening: boolean;
  } | null = null;
  // A recorder that threw stays off until the policy changes.
  let failed = false;
  let started = false;
  let pendingStart: ReturnType<typeof setTimeout> | undefined;
  let removeReadyListeners: (() => void) | undefined;
  let startGeneration = 0;
  let markerEmission: { marker: ReplayMarker; result: ReplayTrackResult } | null = null;
  const cleanups: (() => void)[] = [];
  const listeners = new Set<() => void>();

  function setState(next: ReplayCaptureState) {
    if (next.status === state.status && next.reason === state.reason && next.boundary === state.boundary) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function permission(pathname: string) {
    const policy = getPolicy();
    return {
      policy,
      result: evaluateCapturePermission({
        policy,
        consent: consent.getSnapshot(),
        pathname: normalizeReplayPath(pathname),
        sampled: () =>
          sampler.decide({
            configVersion: policy.configVersion,
            sessionSampleRate: policy.capture.sessionSampleRate,
          }),
      }),
    };
  }

  function captureAllowed(): boolean {
    try {
      return getCaptureAllowed();
    } catch {
      return false;
    }
  }

  function cancelPendingStart() {
    startGeneration++;
    clearTimeout(pendingStart);
    pendingStart = undefined;
    removeReadyListeners?.();
    removeReadyListeners = undefined;
  }

  function deferStart() {
    if (pendingStart !== undefined) return;
    const generation = startGeneration;
    pendingStart = setTimeout(() => {
      pendingStart = undefined;
      if (generation === startGeneration) evaluate();
    }, 0);
  }

  function documentReady(): boolean {
    if (removeReadyListeners) return false;
    if (document.readyState !== "loading") return true;
    const generation = startGeneration;
    const onReady = () => {
      if (generation !== startGeneration || document.readyState === "loading") return;
      removeReadyListeners?.();
      removeReadyListeners = undefined;
      // Do not install rrweb from within the lifecycle event it also observes.
      // Re-evaluate all gates in a later task, after this document has committed.
      deferStart();
    };
    document.addEventListener("DOMContentLoaded", onReady);
    document.addEventListener("readystatechange", onReady);
    window.addEventListener("load", onReady);
    removeReadyListeners = () => {
      document.removeEventListener("DOMContentLoaded", onReady);
      document.removeEventListener("readystatechange", onReady);
      window.removeEventListener("load", onReady);
    };
    // Publish only after cleanup is installed: a synchronous subscriber can
    // dispose/withdraw while receiving this state and must remove this wait.
    setState({ status: "blocked", reason: "document_loading", boundary: state.boundary });
    onReady();
    return false;
  }

  function stopRecorder() {
    const current = active;
    active = null;
    clearTimeout(current?.openingTimer);
    if (current) current.openingMeta = undefined;
    try {
      current?.stop?.();
    } catch {
      // A recorder that fails to stop is already detached from this session.
    }
  }

  function block(reason: NonNullable<ReplayCaptureState["reason"]>) {
    stopRecorder();
    setState({ status: "blocked", reason, boundary: state.boundary });
  }

  function fail() {
    failed = true;
    block("policy_disabled");
  }

  function startRecorder(policy: PublicReplayConfig) {
    const boundary = state.boundary + 1;
    const session: NonNullable<typeof active> = {
      boundary, privacy: JSON.stringify(policy.capture.privacy), opened: false, admittingOpening: false,
    };
    // Node context (for value-only mutations) never crosses a boundary.
    const sanitizer = createReplayEventSanitizer();
    active = session;
    setState({ status: "blocked", reason: "opening_snapshot", boundary });
    if (!started || active !== session) return;
    if (!captureAllowed()) {
      block("identity_pending");
      return;
    }
    const openingMono = performance.now();
    const openingWall = Date.now();
    const openingAge = policy.recording.limits.maxBufferAgeMs;
    session.openingTimer = setTimeout(() => {
      if (active === session && !session.opened) fail();
    }, openingAge);

    const emit = (event: eventWithTime) => {
      if (active !== session || session.admittingOpening) return;
      const { result } = permission(getPathname());
      if (!result.allowed) {
        block(result.reason);
        return;
      }
      if (!captureAllowed()) {
        block("identity_pending");
        return;
      }
      try {
        const custom = event.type === EventType.Custom ? event.data : null;
        const reserved = custom && typeof custom.tag === "string" && custom.tag.startsWith("epic.");
        // Reserved markers enter only through this owner's wrapper, never an SDK bypass.
        if (reserved && (!markerEmission || custom.tag !== markerEmission.marker.tag || custom.payload !== markerEmission.marker.payload)) return;
        const sanitized = sanitizer.sanitize(event);
        if (!sanitized) return;
        // Generic toJSON hooks must not manufacture a reserved marker after
        // the raw-event ownership check above.
        if (sanitized.type === EventType.Custom && sanitized.data.tag.startsWith("epic.") && !reserved) return;
        if (!session.opened) {
          if (Math.max(performance.now() - openingMono, Date.now() - openingWall, 0) >= openingAge ||
              !Number.isSafeInteger(event.timestamp) || event.timestamp < 0 ||
              jsonByteLength(sanitized) > Math.min(policy.recording.limits.maxBufferBytes, policy.recording.limits.maxBatchBytes)) {
            fail();
            return;
          }
          if (!session.openingMeta) {
            if (event.type !== EventType.Meta || typeof (event.data as { href?: unknown }).href !== "string") {
              fail();
              return;
            }
            session.openingMeta = sanitized;
            return;
          }
          const node = (event.data as { node?: unknown }).node;
          const root = node as { type?: unknown; id?: unknown; childNodes?: unknown } | undefined;
          if (event.type !== EventType.FullSnapshot || !node || typeof node !== "object" || Array.isArray(node) ||
              root?.type !== 0 || typeof root.id !== "number" || !Number.isSafeInteger(root.id) || root.id < 1 || !Array.isArray(root.childNodes) ||
              event.timestamp < session.openingMeta.timestamp ||
              jsonByteLength(session.openingMeta) + jsonByteLength(sanitized) + 3 > policy.recording.limits.maxBufferBytes) {
            fail();
            return;
          }
          const meta = session.openingMeta;
          session.openingMeta = undefined;
          clearTimeout(session.openingTimer);
          session.openingTimer = undefined;
          session.admittingOpening = true;
          // Neither event reaches the sink until the complete pair is known.
          // The original Meta timestamp is retained for the uploader's start.
          sink.push(meta, boundary);
          if (active !== session) return;
          if (!captureAllowed()) {
            block("identity_pending");
            return;
          }
          sink.push(sanitized, boundary);
          session.admittingOpening = false;
          if (active === session) {
            session.opened = true;
            setState({ status: "capturing", reason: null, boundary });
          }
          return;
        }
        if (reserved && markerEmission) {
          const reason = preflightMarker(sanitized, boundary);
          if (reason) { markerEmission.result = { status: "dropped", reason }; return; }
        }
        sink.push(sanitized, boundary);
        if (reserved && markerEmission && active === session && captureAllowed()) {
          markerEmission.result = { status: "emitted" };
          // A diagnostics subscriber must never break the recorder or its receipt.
          try { onMarker?.(markerEmission.marker, sanitized.timestamp, boundary); } catch { /* Optional diagnostics. */ }
        }
      } catch {
        fail();
      }
    };

    try {
      // Only reached after document readiness. A loading rrweb 2.2.0 instance
      // can emit DOMContentLoaded/Load before its opening Meta/FullSnapshot.
      const stop = record({ emit, ...buildReplayRecordOptions(policy.capture.privacy) });
      if (active === session) session.stop = stop;
      else stop?.();
      if (active === session && !stop) fail();
    } catch {
      if (active === session) fail();
    }
  }

  /**
   * Re-evaluates permission. `allowStart: false` only ever stops; `"defer"`
   * stops now and starts, if still allowed, one task later.
   */
  function evaluate(pathname = getPathname(), allowStart: boolean | "defer" = true) {
    if (!started) return;
    const { policy, result } = permission(pathname);
    if (!result.allowed) {
      cancelPendingStart();
      block(result.reason);
      return;
    }
    if (!captureAllowed()) {
      cancelPendingStart();
      block("identity_pending");
      return;
    }
    if (active && active.privacy !== JSON.stringify(policy.capture.privacy)) stopRecorder();
    if (active) return;
    if (failed || !allowStart) return;
    if (allowStart === "defer") {
      deferStart();
      return;
    }
    if (pendingStart !== undefined || !documentReady()) return;
    startRecorder(policy);
  }

  function onUrlChange() {
    // A recording never spans a URL change into an excluded route, and a new
    // boundary is only taken once the new page has committed.
    const { result } = permission(getPathname());
    if (!result.allowed) {
      evaluate();
      return;
    }
    if (!active) evaluate(getPathname(), "defer");
  }

  // Stops collection and clears every retained local event, independently of
  // which gate evaluate() then reports.
  function withdraw() {
    cancelPendingStart();
    stopRecorder();
    sink.clear();
  }

  function patchHistory(method: "pushState" | "replaceState") {
    const original = window.history[method];
    const patched = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      onUrlChange();
      return result;
    };
    window.history[method] = patched;
    cleanups.push(() => {
      if (window.history[method] === patched) window.history[method] = original;
    });
  }

  function markerBlockReason(): ReplayTrackDropReason | null {
    try {
      if (!started || !captureAllowed() || !permission(getPathname()).result.allowed) return "capture_not_permitted";
      return active?.opened && state.status === "capturing" ? null : "recording_unavailable";
    } catch { return "capture_not_permitted"; }
  }

  return {
    markerBlockReason,
    /** Synchronous rrweb emission, with no deferred payload or fabricated timestamp. */
    track(input: unknown): ReplayTrackResult {
      try {
        const blocked = markerBlockReason();
        if (blocked) return { status: "dropped", reason: blocked };
        if (markerEmission) return { status: "dropped", reason: "rate_limited" };
        const parsed = parseReplayMarker(input);
        if (!parsed.success) return { status: "dropped", reason: "invalid_payload" };
        // Conservative timestamp width for wire capacity before invoking rrweb.
        const reason = preflightMarker({ type: EventType.Custom, timestamp: Number.MAX_SAFE_INTEGER, data: parsed.marker } as eventWithTime, state.boundary);
        if (reason) return { status: "dropped", reason };
        if (typeof record.addCustomEvent !== "function") return { status: "dropped", reason: "recorder_unavailable" };
        const receipt = { marker: parsed.marker, result: { status: "dropped", reason: "recorder_unavailable" } as ReplayTrackResult };
        markerEmission = receipt;
        try { record.addCustomEvent(parsed.marker.tag, parsed.marker.payload); }
        finally { markerEmission = null; }
        return receipt.result;
      } catch { markerEmission = null; return { status: "dropped", reason: "recorder_unavailable" }; }
    },

    start(): void {
      if (started || typeof window === "undefined") return;
      started = true;

      cleanups.push(
        subscribePolicy(() => {
          failed = false;
          evaluate();
        }),
      );
      cleanups.push(
        consent.subscribe(() => {
          if (consent.getSnapshot() === "withdrawn") withdraw();
          evaluate();
        }),
      );

      window.addEventListener("popstate", onUrlChange);
      cleanups.push(() => window.removeEventListener("popstate", onUrlChange));
      patchHistory("pushState");
      patchHistory("replaceState");

      // The Navigation API reports a destination before the URL changes;
      // it is only ever used to stop early, never to start.
      const navigation = (window as Window & { navigation?: EventTarget }).navigation;
      if (navigation) {
        const onNavigate = (event: Event) => {
          const url = (event as Event & { destination?: { url?: string } }).destination?.url;
          if (!url) return;
          try {
            const destination = new URL(url, window.location.href);
            if (destination.origin === window.location.origin) evaluate(destination.pathname, false);
          } catch {
            // Unparseable destination: the URL change itself re-evaluates.
          }
        };
        navigation.addEventListener("navigate", onNavigate);
        cleanups.push(() => navigation.removeEventListener("navigate", onNavigate));
      }

      evaluate();
    },

    /**
     * Ends the current boundary and, if capture is still permitted, starts a
     * new one at once with fresh Meta and FullSnapshot events. The upload
     * pipeline calls it when a recording was lost (e.g. delivery uncertain).
     */
    restartBoundary(): void {
      if (!started) return;
      cancelPendingStart();
      stopRecorder();
      evaluate();
    },

    /** Re-evaluates now, e.g. after the policy source was swapped. */
    refresh(): void {
      failed = false;
      evaluate();
    },

    /** A resume registration reserved this boundary without initializing rrweb. */
    retireUnstartedBoundary(): void {
      if (started || active) return;
      setState({ ...state, boundary: state.boundary + 1 });
    },

    dispose(reason?: "transport_unavailable"): void {
      if (!started) return;
      started = false;
      cancelPendingStart();
      stopRecorder();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      setState({ status: "blocked", reason: reason ?? state.reason ?? "policy_disabled", boundary: state.boundary });
    },

    getState(): ReplayCaptureState {
      return state;
    },
    hasFailed(): boolean { return failed; },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ReplayCaptureSession = ReturnType<typeof createReplayCaptureSession>;
