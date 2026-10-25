/**
 * Where Epic's OTLP ingest lives, for the relay and for server tracing.
 * Pure on purpose (no `server-only`): `instrumentation.ts` imports it too.
 */

type Env = Partial<Record<string, string | undefined>>;

/** HTTPS, or plain HTTP to localhost outside production. */
export function isAllowedEpicUrl(url: URL, env: Env): boolean {
  const isLocalHttp = url.protocol === "http:" && url.hostname === "localhost" && env.NODE_ENV !== "production";
  return url.protocol === "https:" || isLocalHttp;
}

/**
 * `EPIC_OTLP_ENDPOINT` when set, else `${EPIC_API_URL}/api/observability`.
 * A set but invalid value leaves telemetry unconfigured (null) rather than
 * silently falling back, so the credential never goes to an address nobody
 * chose.
 */
export function resolveOtlpEndpoint(env: Env, apiUrl: URL): string | null {
  const configured = env.EPIC_OTLP_ENDPOINT?.trim();
  if (!configured) return `${apiUrl.origin}/api/observability`;
  try {
    const url = new URL(configured);
    if (!isAllowedEpicUrl(url, env) || url.search || url.hash || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}
