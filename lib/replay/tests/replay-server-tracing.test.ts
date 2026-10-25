import { context, ROOT_CONTEXT, trace, TraceFlags, type Attributes } from "@opentelemetry/api";
import { SamplingDecision, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { resolveOtlpEndpoint } from "../server/otlp-endpoint";
import { isRelaySpan, ScrubbingSpanProcessor, tracingConfig, traceSampler } from "../server/tracing";

const configured = {
  EPIC_API_URL: "https://epic.test",
  EPIC_PUBLISHING_TOKEN: "test-publishing-token",
};

describe("server tracing configuration", () => {
  it("registers nothing unless the API and the credential are both set", () => {
    expect(tracingConfig({})).toBeUndefined();
    expect(tracingConfig({ EPIC_API_URL: configured.EPIC_API_URL })).toBeUndefined();
    expect(tracingConfig({ EPIC_PUBLISHING_TOKEN: configured.EPIC_PUBLISHING_TOKEN })).toBeUndefined();
    expect(tracingConfig({ ...configured, EPIC_API_URL: "http://epic.example" })).toBeUndefined();
    expect(tracingConfig({ ...configured, OTEL_SDK_DISABLED: "true" })).toBeUndefined();
  });

  it("exports OTLP http/json to the derived or configured address", () => {
    expect(tracingConfig(configured, "my-app")).toMatchObject({ serviceName: "my-app" });
    expect(resolveOtlpEndpoint(configured, new URL(configured.EPIC_API_URL))).toBe("https://epic.test/api/observability");
    expect(
      resolveOtlpEndpoint({ ...configured, EPIC_OTLP_ENDPOINT: "https://otlp.epic.test/ingest/" }, new URL(configured.EPIC_API_URL)),
    ).toBe("https://otlp.epic.test/ingest");
    expect(
      resolveOtlpEndpoint({ ...configured, EPIC_OTLP_ENDPOINT: "http://otlp.epic.test" }, new URL(configured.EPIC_API_URL)),
    ).toBeNull();
    expect(tracingConfig({ ...configured, EPIC_OTLP_ENDPOINT: "not a url" })).toBeUndefined();
  });
});

describe("server tracing sampler", () => {
  const sampler = traceSampler();
  const decide = (name: string, attributes: Attributes = {}, parent = ROOT_CONTEXT) =>
    sampler.shouldSample(parent, "a".repeat(32), name, 1, attributes, []).decision;

  it("records ordinary requests and never the relay routes", () => {
    expect(decide("GET", { "http.target": "/issues/12" })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide("GET", { "http.target": "/api/epic/replay/telemetry" })).toBe(SamplingDecision.NOT_RECORD);
    expect(decide("POST", { "http.target": "/api/epic/replay/reports?x=1" })).toBe(SamplingDecision.NOT_RECORD);
    expect(decide("executing api route (app) /api/epic/replay/config")).toBe(SamplingDecision.NOT_RECORD);
    expect(isRelaySpan("GET /api/epic/replay/identity", undefined)).toBe(true);
    expect(isRelaySpan("GET /api/orders", { "http.target": "/api/orders" })).toBe(false);
  });

  it("respects a caller that said its trace is not sampled", () => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: TraceFlags.NONE,
      isRemote: true,
    });
    expect(decide("GET", { "http.target": "/issues" }, parent)).toBe(SamplingDecision.NOT_RECORD);

    const sampled = trace.setSpanContext(context.active(), {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    expect(decide("GET", { "http.target": "/issues" }, sampled)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});

describe("ScrubbingSpanProcessor", () => {
  it("keeps the closed allowlist and drops everything else", () => {
    const span = {
      name: "GET /issues/[id]",
      attributes: {
        "http.method": "GET",
        "http.route": "/issues/[id]",
        "http.status_code": 404,
        "http.target": "/issues/12?token=secret",
        "http.url": "https://app.test/issues/12?token=secret",
        "http.user_agent": "Mozilla",
        "http.request.header.cookie": "session=secret",
        "next.route": "/issues/[id]",
        "next.span_name": "GET /issues/12",
        "db.statement": "select 1",
      },
      events: [{ name: "exception", attributes: { "exception.message": "secret" } }],
      links: [{ context: {} }],
      status: { code: 0, message: "secret" },
    } as unknown as ReadableSpan;

    new ScrubbingSpanProcessor().onEnd(span);

    expect(span.attributes).toEqual({
      "http.method": "GET",
      "http.route": "/issues/[id]",
      "http.status_code": 404,
      "next.route": "/issues/[id]",
    });
    expect(span.events).toHaveLength(0);
    expect(span.links).toHaveLength(0);
    expect(span.status).toEqual({ code: 2 });
  });

  it("renames a span named after a URL and distrusts the outer request span's status", () => {
    const fetchSpan = {
      name: "fetch GET https://third-party.example/x?token=secret",
      attributes: { "next.span_type": "AppRender.fetch" },
      events: [],
      links: [],
      status: { code: 0 },
    } as unknown as ReadableSpan;
    const outer = {
      name: "GET",
      attributes: { "http.method": "GET", "http.status_code": 200 },
      events: [],
      links: [],
      status: { code: 0 },
    } as unknown as ReadableSpan;

    const processor = new ScrubbingSpanProcessor();
    processor.onEnd(fetchSpan);
    processor.onEnd(outer);

    expect(fetchSpan.name).toBe("AppRender.fetch");
    expect(outer.attributes).toEqual({ "http.method": "GET" });
  });
});
