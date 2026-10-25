import {
  isReplayDiagnosticUrlAllowed,
  redactSecrets,
  sanitizeNetworkDiagnostic,
  sanitizeReplayPayload,
  sanitizeReplayText,
} from "./replay-redaction";
import { TRACE_ID_PATTERN, traceIdOf, type ReplayTracing } from "./replay-tracing";

/**
 * Optional console and network context, recorded as rrweb custom events
 * (`epic.console`, `epic.network`) on the same timeline as the session — the
 * shapes the Builder's diagnostics panels read. Each stream is installed only
 * while its own policy switch is on, and events only land while the capture
 * session is recording, so consent, route and expiry gates apply as they do to
 * the recording itself.
 *
 * Nothing private leaves: console text goes through the payload redaction and
 * is bounded; a request records only method, path (no query, no fragment, the
 * origin only when it is another site), status, duration and the trace id of
 * the request (never any other header) — never bodies — and Epic's own `/api/epic/replay/*` traffic is never recorded.
 *
 * The page's own calls behave exactly as before: every wrapper calls the
 * original with the same arguments and returns its result, and recording
 * failures are swallowed.
 */

export interface ReplayDiagnosticsSettings {
  console: boolean;
  network: boolean;
}

type AddCustomEvent = (tag: string, payload: unknown) => boolean;

export const CONSOLE_TAG = "epic.console";
/** Which streams are on, so a reader can tell "off" from "nothing happened". */
export const DIAGNOSTICS_TAG = "epic.diagnostics";
export const NETWORK_TAG = "epic.network";

/** Per stream: at most this many events in a window, and this many in a page's life. */
export const REPLAY_DIAGNOSTIC_LIMITS = {
  burst: 20,
  windowMs: 10_000,
  perPage: 300,
  maxMessageLength: 500,
} as const;

const CONSOLE_LEVELS = ["warn", "error"] as const;

/** The framework's own traffic (dev overlay, HMR, assets) says nothing about the app. */
const FRAMEWORK_PATHS = ["/__nextjs", "/_next/"] as const;

export function createReplayDiagnostics(
  add: AddCustomEvent,
  getSettings: () => ReplayDiagnosticsSettings,
  now: () => number = () => Date.now(),
  // Checked before a payload is built, so a page that is not being recorded pays nothing per call.
  isRecording: () => boolean = () => true,
  // Where a request's trace id comes from; the header it carries is the fallback.
  tracing?: Pick<ReplayTracing, "getLastTraceId" | "issuedCount" | "traceIdOfXhr">,
) {
  let started = false;
  let emitting = false;
  // Wrappers check these, so one left in another library's chain after we
  // restore (we never undo a later patch) goes inert instead of recording.
  const active = { console: false, network: false };
  let uninstallConsole: (() => void) | null = null;
  let uninstallNetwork: (() => void) | null = null;
  const budgets = { console: budget(), network: budget() };

  function budget() {
    return { total: 0, windowStart: 0, inWindow: 0 };
  }

  function hasBudget(stream: keyof typeof budgets): boolean {
    const b = budgets[stream];
    const at = now();
    if (at - b.windowStart >= REPLAY_DIAGNOSTIC_LIMITS.windowMs || at < b.windowStart) {
      b.windowStart = at;
      b.inWindow = 0;
    }
    return b.total < REPLAY_DIAGNOSTIC_LIMITS.perPage && b.inWindow < REPLAY_DIAGNOSTIC_LIMITS.burst;
  }

  /**
   * Records one diagnostic, building its payload only when the stream may
   * still record, and spending budget only on what actually landed (nothing
   * lands before consent). Never produces another diagnostic, never throws.
   */
  function emit(stream: keyof typeof budgets, tag: string, payload: () => unknown) {
    if (emitting || !active[stream] || !isRecording() || !hasBudget(stream)) return;
    emitting = true;
    try {
      if (add(tag, payload())) {
        budgets[stream].total += 1;
        budgets[stream].inWindow += 1;
      }
    } catch {
      // Diagnostics are best effort.
    } finally {
      emitting = false;
    }
  }

  /** Puts `original` back only while ours is still the installed function. */
  function restoreIfOurs<T>(read: () => T, ours: T, write: (value: T) => void, original: T) {
    if (read() === ours) write(original);
  }

  function installConsole(): () => void {
    const restores: (() => void)[] = [];
    for (const level of CONSOLE_LEVELS) {
      const original = console[level];
      const wrapper = function (this: unknown, ...args: unknown[]) {
        // `emit` builds the message inside its own try, so nothing here can throw before the page's call.
        emit("console", CONSOLE_TAG, () => ({ level, message: consoleMessage(args) }));
        return original.apply(this, args);
      };
      console[level] = wrapper;
      restores.push(() => restoreIfOurs(() => console[level], wrapper, (value) => (console[level] = value), original));
    }
    return () => {
      for (const restore of restores) restore();
    };
  }

  function installNetwork(): () => void {
    const restores: (() => void)[] = [];

    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch;
      const wrapper = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const startedAt = performance.now();
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")) || "GET";
        const url = input instanceof Request ? input.url : String(input);
        const issuedBefore = tracing?.issuedCount() ?? 0;
        const pending = originalFetch.call(this, input, init);
        // The call above runs synchronously through any tracing wrapper, which is
        // how a header added by one installed around this one is still seen.
        const traceId =
          tracing && tracing.issuedCount() > issuedBefore ? tracing.getLastTraceId() : requestTraceId(input, init);
        // Re-thrown on failure, so a fetch the page leaves unhandled still reaches `unhandledrejection`.
        return pending.then(
          (response) => {
            recordRequest(method, url, response.status, performance.now() - startedAt, traceId);
            return response;
          },
          (error: unknown) => {
            recordRequest(method, url, 0, performance.now() - startedAt, traceId);
            throw error;
          },
        );
      } as typeof window.fetch;
      window.fetch = wrapper;
      restores.push(() => restoreIfOurs(() => window.fetch, wrapper, (value) => (window.fetch = value), originalFetch));
    }

    if (typeof XMLHttpRequest !== "undefined") {
      const proto = XMLHttpRequest.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      const open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        const result = (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
        meta.set(this, { method, url: String(url) });
        return result;
      } as typeof proto.open;
      const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const request = meta.get(this);
        if (request) {
          const startedAt = performance.now();
          this.addEventListener(
            "loadend",
            () =>
              recordRequest(
                request.method,
                request.url,
                this.status,
                performance.now() - startedAt,
                tracing?.traceIdOfXhr(this) ?? null,
              ),
            { once: true },
          );
        }
        return originalSend.call(this, body);
      };
      proto.open = open;
      proto.send = send;
      restores.push(() => {
        restoreIfOurs(() => proto.open, open, (value) => (proto.open = value), originalOpen);
        restoreIfOurs(() => proto.send, send, (value) => (proto.send = value), originalSend);
      });
    }

    return () => {
      for (const restore of restores.reverse()) restore();
    };
  }

  function requestTraceId(input: RequestInfo | URL, init?: RequestInit): string | null {
    try {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      return traceIdOf(headers.get("traceparent"));
    } catch {
      return null;
    }
  }

  function recordRequest(method: string, url: string, status: number, durationMs: number, traceId: string | null) {
    try {
      const raw = diagnosticPath(url);
      if (!raw || !isReplayDiagnosticUrlAllowed(raw)) return;
      if (FRAMEWORK_PATHS.some((prefix) => raw.startsWith(prefix))) return;
      const path = redactPath(raw);
      emit("network", NETWORK_TAG, () =>
        sanitizeNetworkDiagnostic({
          method,
          url: path,
          status,
          durationMs,
          ...(traceId && TRACE_ID_PATTERN.test(traceId) ? { traceId } : {}),
        }),
      );
    } catch {
      // A URL the page could fetch but we cannot parse is simply not recorded.
    }
  }

  function sync() {
    if (!started) return;
    const settings = getSettings();
    active.console = settings.console;
    active.network = settings.network;
    if (settings.console && !uninstallConsole) uninstallConsole = installConsole();
    if (!settings.console && uninstallConsole) {
      uninstallConsole();
      uninstallConsole = null;
    }
    if (settings.network && !uninstallNetwork) uninstallNetwork = installNetwork();
    if (!settings.network && uninstallNetwork) {
      uninstallNetwork();
      uninstallNetwork = null;
    }
  }

  let announced: string | null = null;

  return {
    /**
     * Records which streams are on into the recording, once per boundary and
     * again whenever that changes. Outside the budgets: it is the context
     * every other diagnostic is read against.
     */
    announce(boundary: number): void {
      if (!started) return;
      const settings = { console: active.console, network: active.network };
      const key = `${boundary}:${settings.console}:${settings.network}`;
      if (key === announced) return;
      try {
        if (add(DIAGNOSTICS_TAG, settings)) announced = key;
      } catch {
        // Best effort, like every diagnostic.
      }
    },
    /** Installs what the current policy allows. Idempotent. */
    start(): void {
      if (started || typeof window === "undefined") return;
      started = true;
      sync();
    },
    /** Re-reads the policy: installs a stream switched on, removes one switched off. */
    sync,
    /** Removes every wrapper still installed, restoring the page's own console and network functions. */
    stop(): void {
      if (!started) return;
      started = false;
      active.console = false;
      active.network = false;
      uninstallConsole?.();
      uninstallNetwork?.();
      uninstallConsole = null;
      uninstallNetwork = null;
    },
  };
}

export type ReplayDiagnostics = ReturnType<typeof createReplayDiagnostics>;

/** Each argument and the joined text are cut before any pattern runs over them. */
const ARGUMENT_CHARS = 2_000;
const JOINED_CHARS = 4_000;

/** The bounded, redacted text of a console call's arguments. Never throws. */
export function consoleMessage(args: unknown[]): string {
  const text = args
    .map((arg) => {
      try {
        if (typeof arg === "string") return arg.slice(0, ARGUMENT_CHARS);
        if (arg instanceof Error) return `${arg.name}: ${String(arg.message)}`.slice(0, ARGUMENT_CHARS);
        // Objects go through the payload redaction first, so `{ password: … }` loses its value by key.
        return (JSON.stringify(sanitizeReplayPayload(arg)) ?? "").slice(0, ARGUMENT_CHARS);
      } catch {
        return "[unserializable]";
      }
    })
    .join(" ")
    .slice(0, JOINED_CHARS);
  return sanitizeReplayText(redactSecrets(text), REPLAY_DIAGNOSTIC_LIMITS.maxMessageLength);
}

const ID_SEGMENT = /^(?:\d{4,}|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{24,})$/i;

/**
 * A path with the segments that tend to be secrets or identifiers (long ids,
 * hex, UUIDs, tokens, addresses, `;matrix` params) replaced by `:id`, so
 * `/invite/<token>` records as `/invite/:id`.
 */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const bare = segment.split(";")[0] ?? "";
      let decoded = bare;
      try {
        decoded = decodeURIComponent(bare);
      } catch {
        // Keep the raw segment.
      }
      if (decoded.includes("@") || ID_SEGMENT.test(decoded)) return ":id";
      return bare;
    })
    .join("/");
}

/**
 * The part of a request URL worth recording: the path for this site, origin +
 * path for another, never the query or fragment (where tokens live).
 */
export function diagnosticPath(url: string): string | null {
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://replay.invalid/";
    const parsed = new URL(url, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const sameSite = typeof window !== "undefined" && parsed.origin === window.location.origin;
    return sameSite ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}
