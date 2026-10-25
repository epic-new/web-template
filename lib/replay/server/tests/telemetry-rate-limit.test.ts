import { describe, expect, it } from "vitest";

import {
  allowTelemetryBatch,
  TELEMETRY_BATCHES_PER_VISITOR_PER_MINUTE,
} from "../telemetry-rate-limit";

describe("allowTelemetryBatch", () => {
  it("stops one visitor past the per-minute budget and lets another through", () => {
    const now = 1_000_000;
    for (let i = 0; i < TELEMETRY_BATCHES_PER_VISITOR_PER_MINUTE; i += 1) {
      expect(allowTelemetryBatch("visitor-a", now)).toBe(true);
    }
    expect(allowTelemetryBatch("visitor-a", now)).toBe(false);
    expect(allowTelemetryBatch("visitor-b", now)).toBe(true);
    expect(allowTelemetryBatch("visitor-a", now + 60_000)).toBe(true);
  });
});
