/**
 * Server traces to Epic, when `EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN` are
 * set. Only the exporter lives here: what a span may keep is decided by Epic
 * when it receives it, so this file never needs to learn a new rule.
 */
export async function register(): Promise<void> {
  const apiUrl = process.env.EPIC_API_URL;
  const token = process.env.EPIC_PUBLISHING_TOKEN;
  if (process.env.NEXT_RUNTIME !== "nodejs" || !apiUrl || !token || process.env.OTEL_SDK_DISABLED === "true") return;

  // Loaded here, not at the top: the edge runtime also loads this file and cannot load the exporter.
  const { OTLPHttpJsonTraceExporter, registerOTel } = await import("@vercel/otel");
  // A fetch span is named after the URL it calls and would carry trace context to third parties.
  process.env.NEXT_OTEL_FETCH_DISABLED = "1";
  const bypass = process.env.EPIC_VERCEL_PROTECTION_BYPASS;
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME || "web",
    instrumentations: [],
    traceExporter: new OTLPHttpJsonTraceExporter({
      url: new URL("/api/observability/v1/traces", apiUrl).toString(),
      headers: { authorization: `Bearer ${token}`, ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) },
    }),
  });
}
