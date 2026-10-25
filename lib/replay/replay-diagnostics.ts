import { isReplayDiagnosticUrlAllowed, redactSecrets, sanitizeNetworkDiagnostic, sanitizeReplayText } from "./replay-redaction";

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
 * origin only when it is another site), status and duration — never headers or
 * bodies — and Epic's own `/api/epic/replay/*` traffic is never recorded.
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
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export function createReplayDiagnostics(
  add: AddCustomEvent,
  getSettings: () => ReplayDiagnosticsSettings,
  now: () => number = () => Date.now(),
) {
  let started = false;
  let emitting = false;
  let uninstallConsole: (() => void) | null = null;
  let uninstallNetwork: (() => void) | null = null;
  const budgets = { console: budget(), network: budget() };

  function budget() {
    return { total: 0, windowStart: 0, inWindow: 0 };
  }

  function allowed(stream: keyof typeof budgets): boolean {
    const b = budgets[stream];
    const at = now();
    if (at - b.windowStart >= REPLAY_DIAGNOSTIC_LIMITS.windowMs) {
      b.windowStart = at;
      b.inWindow = 0;
    }
    if (b.total >= REPLAY_DIAGNOSTIC_LIMITS.perPage || b.inWindow >= REPLAY_DIAGNOSTIC_LIMITS.burst) return false;
    b.total += 1;
    b.inWindow += 1;
    return true;
  }

  // Recording a diagnostic must never produce another one (or throw into the page).
  function emit(stream: keyof typeof budgets, tag: string, payload: unknown) {
    if (emitting || !allowed(stream)) return;
    emitting = true;
    try {
      add(tag, payload);
    } catch {
      // Diagnostics are best effort.
    } finally {
      emitting = false;
    }
  }

  function installConsole(): () => void {
    const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>();
    for (const level of CONSOLE_LEVELS) {
      const original = console[level];
      originals.set(level, original);
      const wrapper = function (this: unknown, ...args: unknown[]) {
        if (!emitting) emit("console", CONSOLE_TAG, { level, message: consoleMessage(args) });
        return original.apply(this, args);
      };
      console[level] = wrapper;
    }
    return () => {
      for (const [level, original] of originals) console[level] = original;
    };
  }

  function installNetwork(): () => void {
    const restores: (() => void)[] = [];

    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch;
      window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const startedAt = performance.now();
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")) || "GET";
        const url = input instanceof Request ? input.url : String(input);
        const result = originalFetch.call(this, input, init);
        result.then(
          (response) => recordRequest(method, url, response.status, performance.now() - startedAt),
          () => recordRequest(method, url, 0, performance.now() - startedAt),
        );
        return result;
      } as typeof window.fetch;
      restores.push(() => {
        window.fetch = originalFetch;
      });
    }

    if (typeof XMLHttpRequest !== "undefined") {
      const proto = XMLHttpRequest.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        meta.set(this, { method, url: String(url) });
        return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
      } as typeof proto.open;
      proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const request = meta.get(this);
        if (request) {
          const startedAt = performance.now();
          this.addEventListener(
            "loadend",
            () => recordRequest(request.method, request.url, this.status, performance.now() - startedAt),
            { once: true },
          );
        }
        return originalSend.call(this, body);
      };
      restores.push(() => {
        proto.open = originalOpen;
        proto.send = originalSend;
      });
    }

    return () => {
      for (const restore of restores.reverse()) restore();
    };
  }

  function recordRequest(method: string, url: string, status: number, durationMs: number) {
    try {
      const path = diagnosticPath(url);
      if (!path || !isReplayDiagnosticUrlAllowed(path)) return;
      if (FRAMEWORK_PATHS.some((prefix) => path.startsWith(prefix))) return;
      const entry = sanitizeNetworkDiagnostic({ method, url: path, status, durationMs });
      if (entry) emit("network", NETWORK_TAG, entry);
    } catch {
      // A URL the page could fetch but we cannot parse is simply not recorded.
    }
  }

  function sync() {
    if (!started) return;
    const settings = getSettings();
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

  return {
    /** Installs what the current policy allows. Idempotent. */
    start(): void {
      if (started || typeof window === "undefined") return;
      started = true;
      sync();
    },
    /** Re-reads the policy: installs a stream switched on, removes one switched off. */
    sync,
    /** Removes every wrapper, restoring the page's own console and network functions. */
    stop(): void {
      if (!started) return;
      started = false;
      uninstallConsole?.();
      uninstallNetwork?.();
      uninstallConsole = null;
      uninstallNetwork = null;
    },
  };
}

export type ReplayDiagnostics = ReturnType<typeof createReplayDiagnostics>;

/** The bounded, redacted text of a console call's arguments. */
export function consoleMessage(args: unknown[]): string {
  const text = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  return sanitizeReplayText(redactSecrets(text), REPLAY_DIAGNOSTIC_LIMITS.maxMessageLength);
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
