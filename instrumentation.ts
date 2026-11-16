import { registerEpicTracing } from "@epicnew/analytics/otel";

const bypass = process.env.EPIC_VERCEL_PROTECTION_BYPASS;

/** Server traces to Epic, when this deployment is registered with it. */
export function register(): Promise<void> {
  return registerEpicTracing({ headers: bypass ? { "x-vercel-protection-bypass": bypass } : undefined });
}
