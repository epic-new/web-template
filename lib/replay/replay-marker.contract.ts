import { jsonByteLength } from "./replay-redaction";

/** Agreed producer v1 contract. Builder reader and deployed acceptance remain separate. */
export const REPLAY_MARKER_VERSION = 1 as const;
export const REPLAY_MARKER_MAX_BYTES = 2_048;
export const REPLAY_MARKER_MAX_ID_LENGTH = 128;
export const REPLAY_MARKER_REDACTED_ROUTE = "/[redacted]";

export const REPLAY_ERROR_CLASSES = [
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "DOMException",
] as const;
export type ReplayErrorClass = typeof REPLAY_ERROR_CLASSES[number];
export type ReplayRejectionKind = "error" | "primitive" | "object" | "unknown";
type Context = { version: 1; behaviorId?: string; occurrenceId?: string };

/** Mirrors rrweb Custom.data; the envelope owns the event timestamp. */
export type ReplayMarker =
  | { tag: "epic.screen.viewed"; payload: { version: 1; route: string; screenId?: string } }
  | { tag: "epic.behavior.started" | "epic.behavior.succeeded"; payload: Context }
  | { tag: "epic.behavior.failed"; payload: Context & { code?: string } }
  | { tag: "epic.bug.reported"; payload: Context & { reportId: string } }
  | { tag: "epic.browser.error"; payload: { version: 1; errorClass: ReplayErrorClass; source: "uncaught_error" } }
  | { tag: "epic.browser.unhandled_rejection"; payload: { version: 1; errorClass: ReplayErrorClass; reasonKind: ReplayRejectionKind } };

export type ReplayMarkerParseResult = { success: true; marker: ReplayMarker } | { success: false };
export type ReplayTrackDropReason =
  | "provider_unavailable" | "capture_not_permitted" | "recording_unavailable"
  | "invalid_payload" | "rate_limited" | "stale_reference" | "recorder_unavailable"
  | "marker_too_large" | "duplicate";
/** Emitted means local recorder admission, never delivery, retention or playback. */
export type ReplayTrackResult = { status: "emitted" } | { status: "dropped"; reason: ReplayTrackDropReason };

export type ReplayMarkerSummary = ReplayMarker & {
  timestamp: number;
  recordingId: string;
  startedAt: number;
  offsetMs: number;
  boundary: number;
  release: string | null;
  configVersion: string;
};

const STATIC_ROUTES = new Set([
  "/", "/auth/signin", "/auth/signup", "/auth/signout", "/admin", "/admin/users", "/admin/database",
  "/styleguide", "/styleguide/replay", "/styleguide/replay/upload", "/styleguide/replay/upload/second", "/styleguide/replay/excluded",
]);
const STYLEGUIDE_COMPONENTS = new Set([
  "accordion", "alert", "alert-dialog", "aspect-ratio", "avatar", "badge", "breadcrumb", "button", "button-group", "calendar",
  "card", "carousel", "chart", "checkbox", "collapsible", "combobox", "command", "context-menu", "dialog", "direction", "drawer",
  "dropdown-menu", "empty", "field", "hover-card", "input", "input-group", "input-otp", "item", "kbd", "label", "menubar",
  "native-select", "navigation-menu", "pagination", "popover", "progress", "radio-group", "resizable", "scroll-area", "select",
  "separator", "sheet", "sidebar", "skeleton", "slider", "sonner", "spinner", "switch", "table", "tabs", "textarea", "toggle",
  "toggle-group", "tooltip",
]);

/** An explicit screen map, independent of capture eligibility; extend for new application routes. */
export function sanitizeMarkerRoute(pathname: string): string {
  if (typeof pathname !== "string" || pathname.length > 4_096) return REPLAY_MARKER_REDACTED_ROUTE;
  let path = pathname.split(/[?#]/, 1)[0];
  if (!path.startsWith("/") || path.startsWith("//")) return REPLAY_MARKER_REDACTED_ROUTE;
  try { path = decodeURI(path); } catch { return REPLAY_MARKER_REDACTED_ROUTE; }
  path = path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  if (path.length > 512) return REPLAY_MARKER_REDACTED_ROUTE;
  if (STATIC_ROUTES.has(path) || path === REPLAY_MARKER_REDACTED_ROUTE) return path;
  if (/^\/admin\/database\/[^/]+$/.test(path)) return "/admin/database/:tableName";
  const component = path.match(/^\/styleguide\/components\/([^/]+)$/)?.[1];
  if (component && STYLEGUIDE_COMPONENTS.has(component)) return path;
  return REPLAY_MARKER_REDACTED_ROUTE;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Accessors are never invoked. A proxy trap can still throw, contained by the parser. */
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error("Marker accessor");
  return descriptor.value;
}
const STATIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= REPLAY_MARKER_MAX_ID_LENGTH && STATIC_ID.test(value);
}
function optionalId(payload: Record<string, unknown>, name: string): string | undefined {
  const value = own(payload, name);
  if (value === undefined) return undefined;
  if (!identifier(value) || (name === "occurrenceId" && !UUID.test(value))) throw new Error("Invalid marker ID");
  return value;
}
function context(payload: Record<string, unknown>): Context {
  const behaviorId = optionalId(payload, "behaviorId");
  const occurrenceId = optionalId(payload, "occurrenceId");
  return { version: 1, ...(behaviorId === undefined ? {} : { behaviorId }), ...(occurrenceId === undefined ? {} : { occurrenceId }) };
}

/** Projects fields before serialization; arbitrary extras, cycles and Error objects never enter the marker. */
export function parseReplayMarker(input: unknown): ReplayMarkerParseResult {
  try {
    if (!object(input)) return { success: false };
    const tag = own(input, "tag");
    const payload = own(input, "payload");
    if (!object(payload) || own(payload, "version") !== 1) return { success: false };
    let marker: ReplayMarker;
    switch (tag) {
      case "epic.screen.viewed": {
        const route = own(payload, "route");
        if (typeof route !== "string" || !route) return { success: false };
        const screenId = optionalId(payload, "screenId");
        marker = { tag, payload: { version: 1, route: sanitizeMarkerRoute(route), ...(screenId === undefined ? {} : { screenId }) } };
        break;
      }
      case "epic.behavior.started":
      case "epic.behavior.succeeded":
        marker = { tag, payload: context(payload) };
        break;
      case "epic.behavior.failed": {
        const code = optionalId(payload, "code");
        marker = { tag, payload: { ...context(payload), ...(code === undefined ? {} : { code }) } };
        break;
      }
      case "epic.bug.reported": {
        // Local acknowledgment-adapter identifier only; this does not define EPI-211's response or prove durable success.
        const reportId = own(payload, "reportId");
        if (!identifier(reportId)) return { success: false };
        marker = { tag, payload: { ...context(payload), reportId } };
        break;
      }
      case "epic.browser.error": {
        const errorClass = own(payload, "errorClass");
        if (!REPLAY_ERROR_CLASSES.includes(errorClass as ReplayErrorClass) || own(payload, "source") !== "uncaught_error") return { success: false };
        marker = { tag, payload: { version: 1, errorClass: errorClass as ReplayErrorClass, source: "uncaught_error" } };
        break;
      }
      case "epic.browser.unhandled_rejection": {
        const errorClass = own(payload, "errorClass");
        const reasonKind = own(payload, "reasonKind");
        if (!REPLAY_ERROR_CLASSES.includes(errorClass as ReplayErrorClass) || !["error", "primitive", "object", "unknown"].includes(reasonKind as string)) return { success: false };
        marker = { tag, payload: { version: 1, errorClass: errorClass as ReplayErrorClass, reasonKind: reasonKind as ReplayRejectionKind } };
        break;
      }
      default: return { success: false };
    }
    if (jsonByteLength(marker) > REPLAY_MARKER_MAX_BYTES) return { success: false };
    return { success: true, marker };
  } catch { return { success: false }; }
}
