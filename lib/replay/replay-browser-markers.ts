import {
  REPLAY_ERROR_CLASSES,
  type ReplayErrorClass,
  type ReplayMarker,
  type ReplayRejectionKind,
  type ReplayTrackResult,
} from "./replay-marker.contract";
import { isReplayDiagnosticUrlAllowed } from "./replay-redaction";

const DEDUPLICATION_WINDOW_MS = 1_000;
const MAX_SEEN_IDENTITIES = 64;

/** Only inspect classification, never message, stack, arbitrary serialization or a custom name getter. */
function classify(reason: unknown): { errorClass: ReplayErrorClass; reasonKind: ReplayRejectionKind } {
  try {
    const isError = reason instanceof Error || (typeof DOMException !== "undefined" && reason instanceof DOMException);
    if (!isError) return { errorClass: "Error", reasonKind: reason !== null && (typeof reason === "object" || typeof reason === "function") ? "object" : "primitive" };
    let cursor: object | null = reason;
    for (let depth = 0; cursor && depth < 8; depth++, cursor = Object.getPrototypeOf(cursor)) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "name");
      if (!descriptor) continue;
      return {
        errorClass: "value" in descriptor && REPLAY_ERROR_CLASSES.includes(descriptor.value as ReplayErrorClass) ? descriptor.value as ReplayErrorClass : "Error",
        reasonKind: "error",
      };
    }
    return { errorClass: "Error", reasonKind: "error" };
  } catch { return { errorClass: "Error", reasonKind: "unknown" }; }
}

/** Root-owned, browser-only observers. Permission and rate decisions remain in track. */
export function attachReplayBrowserMarkers(track: (input: unknown) => ReplayTrackResult): () => void {
  if (typeof window === "undefined") return () => {};
  let disposed = false;
  let emitting = false;
  let seen = new WeakMap<object, { at: number; tag: ReplayMarker["tag"] }>();
  let seenCount = 0;

  function duplicate(value: unknown, tag: ReplayMarker["tag"]): boolean {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
    const identity = value as object;
    const time = Date.now();
    const previous = seen.get(identity);
    if (previous?.tag === tag && time >= previous.at && time - previous.at < DEDUPLICATION_WINDOW_MS) return true;
    if (++seenCount > MAX_SEEN_IDENTITIES) { seen = new WeakMap(); seenCount = 1; }
    seen.set(identity, { at: time, tag });
    return false;
  }
  function emit(event: Event, marker: ReplayMarker, reason: unknown): void {
    if (disposed || emitting || duplicate(event, marker.tag) || duplicate(reason, marker.tag)) return;
    emitting = true;
    try { track(marker); } catch { /* Optional telemetry cannot become another uncaught error. */ }
    finally { emitting = false; }
  }
  const error = (event: Event) => {
    if (disposed || emitting) return;
    try {
      // Resource failures are plain Events; do not inspect their DOM targets.
      // Property presence also supports environments without ErrorEvent's constructor.
      if (!("error" in event) || !("message" in event)) return;
      const value = event as ErrorEvent;
      if (typeof value.filename === "string" && value.filename && !isReplayDiagnosticUrlAllowed(value.filename)) return;
      const reason = value.error;
      emit(event, { tag: "epic.browser.error", payload: { version: 1, errorClass: classify(reason).errorClass, source: "uncaught_error" } }, reason);
    } catch { /* Browser getters and exotic error values are not trusted. */ }
  };
  const rejection = (event: Event) => {
    if (disposed || emitting) return;
    try {
      if (!("reason" in event)) return;
      const reason = (event as PromiseRejectionEvent).reason;
      const classification = classify(reason);
      emit(event, { tag: "epic.browser.unhandled_rejection", payload: { version: 1, ...classification } }, reason);
    } catch { /* Never inspect or stringify an unavailable rejection value. */ }
  };
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
    seen = new WeakMap();
  };
}
