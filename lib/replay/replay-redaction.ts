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
// Match the authority without rescanning a possible scheme at every letter.
// For relative paths only the final segment needs query redaction; excluding
// slashes from that prefix also keeps long non-URL paths linear to scan.
const URL_IN_TEXT = /\/\/[^\s"'<>`()]+|\/[^\s"'<>`?()/]*\?[^\s"'<>`()]+/gi;

export function sanitizeReplayText(text: string, maxLength: number = REPLAY_PAYLOAD_LIMITS.maxStringLength): string {
  const sanitized = text.replace(URL_IN_TEXT, (url) => sanitizeUrl(url));
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) + TRUNCATED_SUFFIX : sanitized;
}

const CSS_URL = /url\(\s*(?:(['"])([^'")]*)\1|([^'")\s]+))\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]*)\1/gi;
const CSS_IDENTIFIER = /(?:[a-z\d_-]|\\(?:[\da-f]{1,6}[ \t\r\n\f]?|[\s\S]))+/gi;
const CSS_ESCAPE = /\\([\da-f]{1,6})[ \t\r\n\f]?|\\([\s\S])/gi;

/** Raw CSSOM arguments precede browser escape normalization in rrweb. */
function redactEscapedCssResources(css: string): string {
  if (!css.includes("\\")) return css;
  const parts: string[] = [];
  let copied = 0;
  // Match identifiers without a required suffix: a long plain text node is
  // scanned once, rather than retrying a failing `url(` match at each letter.
  const identifiers = new RegExp(CSS_IDENTIFIER.source, "iy");
  let cursor = 0;
  while (cursor < css.length) {
    // An apparent function inside a selector/content string is text. Import
    // strings are handled explicitly below, before this outer scanner sees them.
    if (css[cursor] === '"' || css[cursor] === "'") {
      const quote = css[cursor++];
      while (cursor < css.length) {
        if (css[cursor] === "\\") { cursor += 2; continue; }
        if (css[cursor++] === quote) break;
      }
      continue;
    }
    if (css.startsWith("/*", cursor)) {
      const close = css.indexOf("*/", cursor + 2);
      cursor = close === -1 ? css.length : close + 2;
      continue;
    }
    identifiers.lastIndex = cursor;
    const token = identifiers.exec(css);
    if (!token) { cursor++; continue; }
    const name = token[0].replace(CSS_ESCAPE, (_, hex: string | undefined, escaped: string | undefined) =>
      hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : escaped ?? "").toLowerCase();
    const bodyAt = identifiers.lastIndex;
    let end = bodyAt;
    let replacement: string | null = null;
    if (name === "url" && css[bodyAt] === "(") {
      let quote: string | null = null;
      for (end = bodyAt + 1; end < css.length; end++) {
        const char = css[end];
        if (char === "\\") { end++; continue; }
        if (quote) { if (char === quote) quote = null; }
        else if (char === "'" || char === '"') quote = char;
        else if (char === ")") { end++; break; }
      }
      end = Math.min(end, css.length);
      if (css.slice(token.index, end).includes("\\")) replacement = `url("${REDACTED}")`;
    } else if (name === "import" && css[token.index - 1] === "@") {
      while (/\s/.test(css[end] ?? "") && end < css.length) end++;
      const quote = css[end];
      if (quote === "'" || quote === '"') {
        for (end++; end < css.length; end++) {
          if (css[end] === "\\") { end++; continue; }
          if (css[end] === quote) { end++; break; }
        }
        end = Math.min(end, css.length);
        if (css.slice(token.index, end).includes("\\")) replacement = `import ${quote}${REDACTED}${quote}`;
      }
    }
    if (replacement !== null) {
      parts.push(css.slice(copied, token.index), replacement);
      copied = end;
    }
    cursor = Math.max(end, bodyAt);
  }
  return copied === 0 ? css : parts.join("") + css.slice(copied);
}
// A `name=value` pair after `?`, `&`, `#` or `;` anywhere in the text, so a
// credential does not survive an ordinary relative CSS URL.
const PAIR_IN_TEXT = /([?&#;])([^=&#?;\s"'()<>`\\]+)=([^&#;\s"'()<>`\\]*)/g;

/**
 * CSS text (stylesheet rules, `style` values, `_cssText`) with credential
 * values removed from every `url(...)`, `@import` and query-like pair. The
 * rule structure is kept, so replay still renders.
 */
export function sanitizeCssText(css: string): string {
  return sanitizeReplayText(
    redactEscapedCssResources(css)
      .replace(CSS_URL, (_, quote: string | undefined, quoted: string | undefined, unquoted: string | undefined) =>
        `url(${quote ?? ""}${sanitizeUrl((quoted ?? unquoted ?? "").trim())}${quote ?? ""})`)
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

export function sanitizeReplayError(error: unknown): { name: string; message: string; stack: string | null } {
  try {
    if (error instanceof Error) {
      return {
        name: sanitizeReplayText(error.name || "Error", 128),
        message: sanitizeReplayText(String(error.message)),
        stack: typeof error.stack === "string" ? sanitizeReplayText(error.stack, 4_096) : null,
      };
    }
    return { name: "Error", message: sanitizeReplayText(String(error)), stack: null };
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
