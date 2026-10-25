import "server-only";

/**
 * Fixed one-minute windows in this process only. They stop a looping tab or a
 * scripted visitor before the relay spends an Epic request on it; Epic keeps
 * its own daily budgets per application and project.
 */
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

/** A tab flushes every twenty seconds, or on hide: 60 a minute is generous. */
export const TELEMETRY_BATCHES_PER_VISITOR_PER_MINUTE = 60;
/** Every visitor together, per instance. */
export const TELEMETRY_BATCHES_PER_INSTANCE_PER_MINUTE = 3_000;

const windows = new Map<string, { startedAt: number; count: number }>();

function allow(key: string, max: number, now: number): boolean {
  const window = windows.get(key);
  if (!window || now - window.startedAt >= WINDOW_MS) {
    windows.delete(key);
    windows.set(key, { startedAt: now, count: 1 });
    while (windows.size > MAX_KEYS) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
    return true;
  }
  window.count += 1;
  return window.count <= max;
}

/** Whether this visitor may relay one more batch now. */
export function allowTelemetryBatch(visitorKey: string, now = Date.now()): boolean {
  return (
    allow("instance", TELEMETRY_BATCHES_PER_INSTANCE_PER_MINUTE, now) &&
    allow(`visitor:${visitorKey}`, TELEMETRY_BATCHES_PER_VISITOR_PER_MINUTE, now)
  );
}

export function clearTelemetryRateLimits(): void {
  windows.clear();
}
