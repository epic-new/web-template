import type { Context } from "@opentelemetry/api";
import {
  AlwaysOffSampler,
  ParentBasedSampler,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPHttpJsonTraceExporter, registerOTel, type Configuration } from "@vercel/otel";

import { isAllowedEpicUrl, resolveOtlpEndpoint } from "./otlp-endpoint";

/**
 * Server-side OpenTelemetry for the application, exported to Epic's OTLP
 * ingest as http/json under the publishing credential. Off unless
 * `EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN` are set: with either missing
 * nothing is registered and the app behaves as before.
 *
 * Next.js continues a W3C `traceparent` on its own, so the browser's header
 * (see `replay-tracing.ts`) makes a page's request and its server spans one
 * trace. What leaves a span is a closed list: the route pattern, the method,
 * the status code and Next's own `next.*` vocabulary. Query strings, bodies,
 * cookies, headers, fetch URLs and exception messages never leave.
 *
 * The relay routes under `/api/epic/replay/` are not traced at all, so the
 * telemetry path never produces telemetry about itself.
 *
 * Pure of `server-only` on purpose: `instrumentation.ts` loads this file.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const REPLAY_RELAY_PATH_PREFIX = "/api/epic/replay/";

/** The only span attributes that leave, by exact name; `next.*` is allowed by prefix. */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "http.method",
  "http.request.method",
  "http.status_code",
  "http.response.status_code",
  "http.route",
]);
const ALLOWED_PREFIXES = ["next."] as const;
// Duplicates the span name, which can still be a concrete path before Next renames it.
const DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set(["next.span_name"]);

function isAllowed(name: string): boolean {
  if (DROPPED_ATTRIBUTES.has(name)) return false;
  return ALLOWED_ATTRIBUTES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Whether a span belongs to a relay request, judged from what it starts with. */
export function isRelaySpan(name: string, attributes: Record<string, unknown> | undefined): boolean {
  const candidates = [name, attributes?.["http.target"], attributes?.["http.url"], attributes?.["url.path"], attributes?.["next.route"]];
  return candidates.some((value) => typeof value === "string" && value.includes(REPLAY_RELAY_PATH_PREFIX));
}

/**
 * Drops a relay span at the source. Under `ParentBasedSampler` a span whose
 * parent was not sampled is not sampled either, so the whole subtree of a
 * relay request is never created.
 */
class RelayFilterSampler implements Sampler {
  shouldSample(
    _context: Context,
    _traceId: string,
    spanName: string,
    _spanKind: unknown,
    attributes?: Record<string, unknown>,
  ): SamplingResult {
    return {
      decision: isRelaySpan(spanName, attributes) ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
    };
  }

  toString(): string {
    return "RelayFilterSampler";
  }
}

/**
 * Every request is recorded except the relay's, and a request whose caller said
 * its trace is not sampled stays unsampled.
 */
export function traceSampler(): Sampler {
  const filter = new RelayFilterSampler();
  return new ParentBasedSampler({
    root: filter,
    remoteParentSampled: filter,
    localParentSampled: filter,
    remoteParentNotSampled: new AlwaysOffSampler(),
  });
}

/**
 * Removes everything not on the list from a span as it ends, in place, ahead
 * of the exporter (the batching processor after it keeps the same span).
 */
export class ScrubbingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    try {
      const attributes = span.attributes as Record<string, unknown>;

      // Next's outer request span keeps the bare method as its name and reports 200
      // for a request its route answered otherwise; its status is not a fact.
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(span.name)) {
        delete attributes["http.status_code"];
        delete attributes["http.response.status_code"];
      }
      const http = Number(attributes["http.status_code"] ?? attributes["http.response.status_code"]);
      if (Number.isFinite(http) && http >= 400) (span.status as { code: number }).code = 2;

      for (const key of Object.keys(attributes)) {
        if (!isAllowed(key)) delete attributes[key];
      }

      (span.events as unknown[]).length = 0;
      (span.links as unknown[]).length = 0;
      const status = span.status as { message?: string };
      if (status.message !== undefined) delete status.message;

      // A fetch span is named after its URL; anything that looks like one becomes its span type.
      if (span.name.includes("://")) {
        (span as { name: string }).name = String(attributes["next.span_type"] ?? "span");
      }
    } catch {
      // A span that could not be scrubbed is emptied rather than exported as it was.
      try {
        const attributes = span.attributes as Record<string, unknown>;
        for (const key of Object.keys(attributes)) delete attributes[key];
      } catch {
        // Nothing left to try.
      }
    }
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/**
 * The `registerOTel` configuration, or `undefined` when tracing is not
 * configured: both `EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN` must be set and
 * the OTLP address valid.
 */
export function tracingConfig(env: Env = process.env, serviceName = env.OTEL_SERVICE_NAME || "web"): Configuration | undefined {
  const apiUrl = env.EPIC_API_URL;
  const token = env.EPIC_PUBLISHING_TOKEN;
  if (!apiUrl || !token || env.OTEL_SDK_DISABLED === "true") return undefined;

  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return undefined;
  }
  if (!isAllowedEpicUrl(api, env)) return undefined;
  const endpoint = resolveOtlpEndpoint(env, api);
  if (!endpoint) return undefined;

  return {
    serviceName,
    traceSampler: traceSampler(),
    // No `fetch` instrumentation: it names spans after the URL and would propagate context to third parties.
    instrumentations: [],
    // The scrubber first, so the exporter only ever sees the scrubbed span.
    spanProcessors: [new ScrubbingSpanProcessor(), "auto"],
    traceExporter: new OTLPHttpJsonTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(env.EPIC_VERCEL_PROTECTION_BYPASS?.trim() && new URL(endpoint).origin === api.origin
          ? { "x-vercel-protection-bypass": env.EPIC_VERCEL_PROTECTION_BYPASS.trim() }
          : {}),
      },
    }),
  };
}

/** Registers tracing when configured; returns whether it did. */
export function registerReplayTracing(env: Env = process.env): boolean {
  const config = tracingConfig(env);
  if (!config) return false;
  // A fetch span's name is the URL, and a name cannot be scrubbed once it exists.
  process.env.NEXT_OTEL_FETCH_DISABLED = "1";
  registerOTel(config);
  return true;
}
