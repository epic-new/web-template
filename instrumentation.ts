/**
 * Server tracing for Epic: registers OpenTelemetry only when
 * `EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN` are set, on the Node runtime.
 * Unconfigured, nothing is registered. See docs/replay-adoption.md.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Loaded here, not at the top: the edge runtime also loads this file and cannot load the exporter.
  const { registerReplayTracing } = await import("@/lib/replay/server/tracing");
  registerReplayTracing();
}
