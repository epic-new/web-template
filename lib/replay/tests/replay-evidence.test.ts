import { describe, expect, it } from "vitest";
import { freezeReplayEvidence } from "../replay-evidence";

describe("frozen recording moments", () => {
  it("freezes the original millisecond context without copying credentials", () => {
    const context = { recordingId: "synthetic", startedAt: 1_800_000_000_000, boundary: 1,
      release: "build-A", configVersion: "1", recordingToken: "not-public" };
    const reference = freezeReplayEvidence(context, context.startedAt + 5_100)!;
    context.release = "build-B";
    expect(reference).toEqual({ recordingId: "synthetic", startedAt: 1_800_000_000_000,
      boundary: 1, release: "build-A", configVersion: "1", capturedAt: 1_800_000_005_100, offsetMs: 5_100 });
    expect(Object.isFrozen(reference)).toBe(true);
  });
  it("withholds missing or invalid clock context rather than rebasing it", () => {
    const context = { recordingId: "synthetic", startedAt: 100, boundary: 1, release: null, configVersion: "1" };
    for (const time of [99, NaN, Infinity, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(freezeReplayEvidence(context, time)).toBeNull();
    }
    expect(freezeReplayEvidence(null, 100)).toBeNull();
  });
});
