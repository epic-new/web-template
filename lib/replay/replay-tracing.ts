import { REPLAY_DIAGNOSTIC_DENYLIST } from "./replay-redaction";

/**
 * W3C trace context for this application's own requests: a `traceparent`
 * header on same-origin `fetch` and XHR calls, so a server span and a session
 * can be matched by trace id. Nothing about the request is recorded here; the
 * only state is the latest trace id, which a bug report may cite.
 *
 * Cross-origin requests never get the header (it would hand a third party a
 * correlation id and trigger a CORS preflight), and neither do the replay
 * relay routes, which are not traced at all. A request that already carries a
 * `traceparent` keeps it and its trace id is adopted.
 */

const TRACEPARENT = "traceparent";
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

function randomHex(bytes: number): string {
  for (;;) {
    const value = Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    // An all-zero id is invalid in W3C trace context.
    if (/[1-9a-f]/.test(value)) return value;
  }
}

export function newTraceparent(): { header: string; traceId: string } {
  const traceId = randomHex(16);
  return { header: `00-${traceId}-${randomHex(8)}-01`, traceId };
}

export function traceIdOf(header: string | null | undefined): string | null {
  return TRACEPARENT_PATTERN.exec(header ?? "")?.[1] ?? null;
}

function isTraceable(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin !== window.location.origin) return false;
    const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    return !REPLAY_DIAGNOSTIC_DENYLIST.some((prefix) => path.startsWith(prefix));
  } catch {
    return false;
  }
}

export interface ReplayTracingOptions {
  /** Checked per request, so withdrawing consent stops the headers at once. */
  isEnabled: () => boolean;
}

export function createReplayTracing({ isEnabled }: ReplayTracingOptions) {
  let started = false;
  let lastTraceId: string | null = null;
  // Counts headers issued, so a wrapper installed around ours can tell
  // whether the call it just made went through us.
  let issued = 0;
  const restores: (() => void)[] = [];
  const xhrMeta = new WeakMap<XMLHttpRequest, { url: string; traceId: string | null }>();

  function restoreIfOurs<T>(read: () => T, ours: T, write: (value: T) => void, original: T) {
    if (read() === ours) write(original);
  }

  function adopt(traceId: string) {
    lastTraceId = traceId;
    issued += 1;
  }

  function installFetch() {
    if (typeof window.fetch !== "function") return;
    const originalFetch = window.fetch;
    const wrapper = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      let next = init;
      try {
        const url = input instanceof Request ? input.url : String(input);
        if (isEnabled() && isTraceable(url)) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const existing = traceIdOf(headers.get(TRACEPARENT));
          if (existing) {
            adopt(existing);
          } else {
            const { header, traceId } = newTraceparent();
            headers.set(TRACEPARENT, header);
            next = { ...init, headers };
            adopt(traceId);
          }
        }
      } catch {
        next = init;
      }
      return originalFetch.call(this, input, next);
    } as typeof window.fetch;
    window.fetch = wrapper;
    restores.push(() => restoreIfOurs(() => window.fetch, wrapper, (value) => (window.fetch = value), originalFetch));
  }

  function installXhr() {
    if (typeof XMLHttpRequest === "undefined") return;
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;
    const meta = xhrMeta;

    const open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      meta.set(this, { url: String(url), traceId: null });
      return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    const setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      if (name.toLowerCase() === TRACEPARENT) {
        const request = meta.get(this);
        const traceId = traceIdOf(value);
        if (request && traceId) request.traceId = traceId;
      }
      return originalSetHeader.call(this, name, value);
    };
    const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const request = meta.get(this);
        if (request && isEnabled() && isTraceable(request.url)) {
          if (request.traceId) {
            adopt(request.traceId);
          } else {
            const { header, traceId } = newTraceparent();
            originalSetHeader.call(this, TRACEPARENT, header);
            request.traceId = traceId;
            adopt(traceId);
          }
        }
      } catch {
        // A header failure never reaches the page's request.
      }
      return originalSend.call(this, body);
    };
    proto.open = open;
    proto.setRequestHeader = setRequestHeader;
    proto.send = send;
    restores.push(() => {
      restoreIfOurs(() => proto.open, open, (value) => (proto.open = value), originalOpen);
      restoreIfOurs(() => proto.setRequestHeader, setRequestHeader, (value) => (proto.setRequestHeader = value), originalSetHeader);
      restoreIfOurs(() => proto.send, send, (value) => (proto.send = value), originalSend);
    });
  }

  return {
    start(): void {
      if (started || typeof window === "undefined") return;
      started = true;
      installFetch();
      installXhr();
    },

    stop(): void {
      if (!started) return;
      started = false;
      for (const restore of restores.splice(0).reverse()) restore();
      lastTraceId = null;
    },

    /** The trace id of the most recent traced request, or null. */
    getLastTraceId(): string | null {
      return lastTraceId;
    },

    /** The trace id this XHR was sent with, once `send` has run. */
    traceIdOfXhr(xhr: XMLHttpRequest): string | null {
      return xhrMeta.get(xhr)?.traceId ?? null;
    },

    /** Headers issued so far; a wrapper compares before and after a call. */
    issuedCount(): number {
      return issued;
    },
  };
}

export type ReplayTracing = ReturnType<typeof createReplayTracing>;
