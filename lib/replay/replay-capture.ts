import type { record as rrwebRecord } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";

import type { PublicReplayConfig } from "./replay-config.contract";
import { epicReplayConsent, type ReplayConsentSource } from "./replay-consent";
import { replayLifecycle } from "./replay-lifecycle";
import type { ReplayEventSink } from "./replay-buffer";
import { createReplayEventSanitizer } from "./replay-event-sanitizer";
import { evaluateCapturePermission, type ReplayBlockReason } from "./replay-permission";
import { buildReplayRecordOptions } from "./replay-record-options";
import { normalizeReplayPath } from "./replay-routes";
import { replaySampler, type ReplaySampler } from "./replay-sampling";

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
  reason: ReplayBlockReason | null;
  boundary: number;
}

export interface ReplayCaptureSessionOptions {
  sink: ReplayEventSink;
  getPolicy?: () => PublicReplayConfig;
  subscribePolicy?: (listener: () => void) => () => void;
  consent?: ReplayConsentSource;
  sampler?: ReplaySampler;
  /** A recorder to use as is (tests); otherwise `@rrweb/record` is loaded on the first start. */
  record?: RecordFn;
  getPathname?: () => string;
  /** Called after a URL change into a page that may be recorded. */
  onNavigate?: (pathname: string) => void;
}

export function createReplayCaptureSession({
  sink,
  getPolicy = () => replayLifecycle.getSnapshot(),
  subscribePolicy = (listener) => replayLifecycle.subscribe(listener),
  consent = epicReplayConsent,
  sampler = replaySampler,
  record: providedRecord,
  getPathname = () => window.location.pathname,
  onNavigate,
}: ReplayCaptureSessionOptions) {
  let state: ReplayCaptureState = { status: "blocked", reason: "policy_disabled", boundary: 0 };
  let active: { boundary: number; privacy: string; stop?: () => void } | null = null;
  // A recorder that threw stays off until the policy changes.
  let failed = false;
  let started = false;
  let pendingStart: ReturnType<typeof setTimeout> | undefined;
  // The recorder is fetched only when a session may actually start, so a page
  // whose policy, consent or route never allows capture never downloads it.
  let record: RecordFn | undefined = providedRecord;
  let loading: Promise<void> | null = null;
  const cleanups: (() => void)[] = [];
  const listeners = new Set<() => void>();

  function setState(next: ReplayCaptureState) {
    if (next.status === state.status && next.reason === state.reason && next.boundary === state.boundary) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  // Every recorded event is admitted through here, so an unchanged answer is
  // reused: the policy object changes whenever the policy or its expiry does.
  let allowedMemo: { policy: PublicReplayConfig; consent: string; pathname: string } | null = null;

  function permission(pathname: string) {
    const policy = getPolicy();
    const consentState = consent.getSnapshot();
    if (
      allowedMemo &&
      allowedMemo.policy === policy &&
      allowedMemo.consent === consentState &&
      allowedMemo.pathname === pathname
    ) {
      return { policy, result: { allowed: true } as const };
    }
    const evaluated = {
      policy,
      result: evaluateCapturePermission({
        policy,
        consent: consentState,
        pathname: normalizeReplayPath(pathname),
        sampled: () =>
          sampler.decide({
            configVersion: policy.configVersion,
            sessionSampleRate: policy.capture.sessionSampleRate,
          }),
      }),
    };
    allowedMemo = evaluated.result.allowed ? { policy, consent: consentState, pathname } : null;
    return evaluated;
  }

  function stopRecorder() {
    const current = active;
    active = null;
    try {
      current?.stop?.();
    } catch {
      // A recorder that fails to stop is already detached from this session.
    }
  }

  function block(reason: ReplayBlockReason) {
    stopRecorder();
    setState({ status: "blocked", reason, boundary: state.boundary });
  }

  function fail() {
    failed = true;
    block("policy_disabled");
  }

  function loadRecorder() {
    loading ??= import("@rrweb/record").then(
      (module) => {
        record = module.record;
        // Permission is decided again: consent, route or policy may have changed meanwhile.
        evaluate();
      },
      () => {
        loading = null;
        fail();
      },
    );
  }

  function startRecorder(policy: PublicReplayConfig, record: RecordFn) {
    const boundary = state.boundary + 1;
    const session = { boundary, privacy: JSON.stringify(policy.capture.privacy) } as NonNullable<typeof active>;
    // Node context (for value-only mutations) never crosses a boundary.
    const sanitizer = createReplayEventSanitizer();
    active = session;
    setState({ status: "capturing", reason: null, boundary });

    const emit = (event: eventWithTime) => {
      if (active !== session) return;
      const { result } = permission(getPathname());
      if (!result.allowed) {
        block(result.reason);
        return;
      }
      try {
        sink.push(sanitizer.sanitize(event), boundary);
      } catch {
        fail();
      }
    };

    try {
      // rrweb emits Meta and FullSnapshot synchronously, inside this call.
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
      clearTimeout(pendingStart);
      pendingStart = undefined;
      block(result.reason);
      return;
    }
    if (active && active.privacy !== JSON.stringify(policy.capture.privacy)) stopRecorder();
    if (active) return;
    if (failed || !allowStart) return;
    if (!record) {
      loadRecorder();
      return;
    }
    if (allowStart === "defer") {
      clearTimeout(pendingStart);
      pendingStart = setTimeout(() => {
        pendingStart = undefined;
        evaluate();
      }, 0);
      return;
    }
    startRecorder(policy, record);
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
    else {
      try {
        onNavigate?.(normalizeReplayPath(getPathname()));
      } catch {
        // A marker failure never reaches the page.
      }
    }
  }

  // Stops collection and clears every retained local event, independently of
  // which gate evaluate() then reports.
  function withdraw() {
    clearTimeout(pendingStart);
    pendingStart = undefined;
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

  return {
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
     * new one with a fresh Meta and FullSnapshot. Used when the transport
     * lost the recording and its history cannot be continued.
     */
    restartBoundary(): void {
      if (!started) return;
      clearTimeout(pendingStart);
      pendingStart = undefined;
      stopRecorder();
      failed = false;
      evaluate();
    },

    /**
     * Adds a custom event to the current recording. Returns false, and does
     * nothing, when no recording is running. The event passes the same gates
     * and sanitizer as everything else.
     */
    addCustomEvent(tag: string, payload: unknown): boolean {
      if (!active || typeof record?.addCustomEvent !== "function") return false;
      try {
        record.addCustomEvent(tag, payload);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Whether evidence that does not depend on the replay (behavior markers,
     * browser errors) may be sent right now: every gate except sampling, so a
     * session left unrecorded by the sampler still reports what happened.
     */
    allowsEvidence(): boolean {
      if (!started) return false;
      try {
        return evaluateCapturePermission({
          policy: getPolicy(),
          consent: consent.getSnapshot(),
          pathname: normalizeReplayPath(getPathname()),
          sampled: () => true,
        }).allowed;
      } catch {
        return false;
      }
    },

    /** Re-evaluates now, e.g. after the policy source was swapped. */
    refresh(): void {
      failed = false;
      evaluate();
    },

    dispose(): void {
      if (!started) return;
      started = false;
      clearTimeout(pendingStart);
      pendingStart = undefined;
      stopRecorder();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      setState({ status: "blocked", reason: state.reason ?? "policy_disabled", boundary: state.boundary });
    },

    getState(): ReplayCaptureState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ReplayCaptureSession = ReturnType<typeof createReplayCaptureSession>;
