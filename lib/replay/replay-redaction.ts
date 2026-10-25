/**
 * Capture-time redaction for everything that is not the DOM itself: URLs,
 * metadata, custom-event payloads, errors and diagnostics. Runs in the
 * browser before an event enters a buffer, so nothing here may throw.
 * See docs/replay-privacy.md.
 */

export const REDACTED = "[redacted]";
const REDACTED_ENCODED = encodeURIComponent(REDACTED);
const TRUNCATED_SUFFIX = "…[truncated]";

export const REPLAY_PAYLOAD_LIMITS = {
  maxStringLength: 1_024,
  maxDepth: 6,
  maxArrayItems: 50,
  maxObjectKeys: 50,
  maxPayloadBytes: 16_384,
} as const;

/**
 * Query parameters whose value never leaves the browser. A superset of the
 * preview bridge's list: `_proxy_token` is the Epic preview gate's bearer
 * token, which stays in the address when the gate does not swap it for a
 * cookie. The rest cover OAuth callbacks and signed URLs.
 */
const CREDENTIAL_PARAMS = new Set([
  "_proxy_token",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "code",
  "state",
  "auth",
  "authorization",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "signature",
  "sig",
  "x-amz-signature",
  "password",
  "session",
  "jwt",
]);

export function isCredentialParam(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_PARAMS.has(lower) || /token|secret|password/.test(lower);
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

// Redacts credential values in `a=1&b=2`, leaving every other pair as it was.
function sanitizePairs(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals === -1) return pair;
      return isCredentialParam(decodeName(pair.slice(0, equals)))
        ? `${pair.slice(0, equals)}=${REDACTED_ENCODED}`
        : pair;
    })
    .join("&");
}

/**
 * The URL with credential-bearing query (and `=`-carrying fragment) values
 * redacted and any `user:pass@` removed. Keeps the input's form — absolute,
 * protocol-relative or relative — and every other character as it was.
 */
export function sanitizeUrl(input: string): string {
  if (typeof input !== "string" || input === "") return input;
  try {
    let rest = input;
    let hash = "";
    const hashAt = rest.indexOf("#");
    if (hashAt !== -1) {
      hash = rest.slice(hashAt + 1);
      rest = rest.slice(0, hashAt);
    }
    let query: string | null = null;
    const queryAt = rest.indexOf("?");
    if (queryAt !== -1) {
      query = rest.slice(queryAt + 1);
      rest = rest.slice(0, queryAt);
    }
    // Userinfo in `scheme://user:pass@host` or `//user@host`.
    rest = rest.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/@]*@/i, "$1");

    let out = rest;
    if (query !== null) out += `?${sanitizePairs(query)}`;
    if (hashAt !== -1) out += `#${hash.includes("=") ? sanitizePairs(hash) : hash}`;
    return out;
  } catch {
    return REDACTED;
  }
}

// URLs embedded in free text: absolute, protocol-relative, or a path with a query.
// Parentheses end a URL so a CSS `url(...)` keeps its closing paren.
const URL_IN_TEXT = /(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>`()]+|\/[^\s"'<>`?()]*\?[^\s"'<>`()]+/gi;

export function sanitizeReplayText(text: string, maxLength: number = REPLAY_PAYLOAD_LIMITS.maxStringLength): string {
  const sanitized = text.replace(URL_IN_TEXT, (url) => sanitizeUrl(url));
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) + TRUNCATED_SUFFIX : sanitized;
}

const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]*)\1/gi;
// A `name=value` pair after `?`, `&`, `#` or `;` anywhere in the text, so a
// credential survives neither a relative CSS URL nor a CSS escape.
const PAIR_IN_TEXT = /([?&#;])([^=&#?;\s"'()<>`\\]+)=([^&#;\s"'()<>`\\]*)/g;

/**
 * CSS text (stylesheet rules, `style` values, `_cssText`) with credential
 * values removed from every `url(...)`, `@import` and query-like pair. The
 * rule structure is kept, so replay still renders.
 */
export function sanitizeCssText(css: string): string {
  return sanitizeReplayText(
    css
      .replace(CSS_URL, (_, quote: string, url: string) => `url(${quote}${sanitizeUrl(url.trim())}${quote})`)
      .replace(CSS_IMPORT, (_, quote: string, url: string) => `@import ${quote}${sanitizeUrl(url)}${quote}`),
    Number.POSITIVE_INFINITY,
  ).replace(PAIR_IN_TEXT, (pair, lead: string, name: string) =>
    isCredentialParam(decodeName(name)) ? `${lead}${name}=${REDACTED_ENCODED}` : pair,
  );
}

const encoder = new TextEncoder();

/** The UTF-8 size of a value's JSON, which is what a byte limit bounds. */
export function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

const SENSITIVE_KEY =
  /password|passwd|secret|token|authorization|cookie|session|api[-_]?key|credential|signature/i;

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeReplayText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined; // functions, symbols, undefined
  if (seen.has(value)) return "[circular]";
  if (depth >= REPLAY_PAYLOAD_LIMITS.maxDepth) return "[truncated]";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return sanitizeReplayError(value);

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, REPLAY_PAYLOAD_LIMITS.maxArrayItems)
        .map((item) => sanitizeValue(item, depth + 1, seen) ?? null);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, REPLAY_PAYLOAD_LIMITS.maxObjectKeys)) {
      const safeKey = key.length > 128 ? key.slice(0, 128) : key;
      if (SENSITIVE_KEY.test(key)) {
        out[safeKey] = REDACTED;
        continue;
      }
      const item = sanitizeValue((value as Record<string, unknown>)[key], depth + 1, seen);
      if (item !== undefined) out[safeKey] = item;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * A JSON-safe, bounded, redacted copy of an arbitrary payload. Too large after
 * bounding, it becomes `{ truncated: true }` rather than a partial object.
 */
export function sanitizeReplayPayload(value: unknown): unknown {
  try {
    const sanitized = sanitizeValue(value, 0, new WeakSet()) ?? null;
    return jsonByteLength(sanitized) > REPLAY_PAYLOAD_LIMITS.maxPayloadBytes ? { truncated: true } : sanitized;
  } catch {
    return { truncated: true };
  }
}

// Each part is bounded so a long run of word characters cannot backtrack for long.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.[A-Za-z]{2,24}/g;
// Also a JWT cut short by a length bound, which would otherwise keep its header and payload.
const JWT = /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PROVIDER_KEY = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g;
const KEY_VALUE = /\b(password|passwd|secret|token|api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)[^"'\s,;}&]{1,256}/gi;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

/**
 * What an app tends to log by accident: addresses, JWTs, auth headers,
 * provider keys, `password=…`-style pairs and long hex secrets. Replaced
 * before the text reaches the recording; callers bound the input first.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(JWT, "[redacted-token]")
    .replace(BEARER, "$1 [redacted]")
    .replace(PROVIDER_KEY, "[redacted-key]")
    .replace(KEY_VALUE, "$1$2[redacted]")
    .replace(EMAIL, "[redacted-email]")
    .replace(LONG_HEX, "[redacted-hex]");
}

export function sanitizeReplayError(error: unknown): { name: string; message: string; stack: string | null } {
  try {
    if (error instanceof Error) {
      return {
        name: sanitizeReplayText(error.name || "Error", 128),
        message: sanitizeReplayText(redactSecrets(String(error.message).slice(0, 4_096))),
        stack: typeof error.stack === "string" ? sanitizeReplayText(redactSecrets(error.stack.slice(0, 8_192)), 4_096) : null,
      };
    }
    return { name: "Error", message: sanitizeReplayText(redactSecrets(String(error).slice(0, 4_096))), stack: null };
  } catch {
    return { name: "Error", message: REDACTED, stack: null };
  }
}

/** Configuration, ingestion and report endpoints are never diagnosed. */
export const REPLAY_DIAGNOSTIC_DENYLIST = ["/api/epic/replay/"] as const;

export function isReplayDiagnosticUrlAllowed(url: string): boolean {
  try {
    const { pathname } = new URL(url, "http://replay.invalid");
    const path = pathname.endsWith("/") ? pathname : `${pathname}/`;
    return !REPLAY_DIAGNOSTIC_DENYLIST.some((prefix) => path.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * A network diagnostic reduced to what may be recorded. The output type has
 * no headers or bodies, so they cannot be included by default.
 */
export function sanitizeNetworkDiagnostic(entry: {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}): { method: string; url: string; status: number; durationMs: number } | null {
  if (!isReplayDiagnosticUrlAllowed(entry.url)) return null;
  return {
    method: String(entry.method).toUpperCase().slice(0, 16),
    url: sanitizeReplayText(entry.url, 2_048),
    status: Number.isFinite(entry.status) ? Math.trunc(entry.status) : 0,
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
  };
}
