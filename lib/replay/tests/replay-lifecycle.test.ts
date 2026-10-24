import { afterEach, describe, expect, it, vi } from "vitest";

import { disabledReplayConfig, type PublicReplayConfig } from "../replay-config.contract";
import { replayLifecycle } from "../replay-lifecycle";

function activeConfig(overrides: Partial<PublicReplayConfig> = {}): PublicReplayConfig {
  const now = Date.now();
  return {
    ...disabledReplayConfig({ reason: "unavailable", environment: "production", release: null, now }),
    status: "active",
    reason: null,
    configVersion: "prod-v3",
    expiresAt: now + 300_000,
    capture: {
      ...disabledReplayConfig({ reason: "unavailable", environment: "production", release: null, now }).capture,
      enabled: true,
      sessionSampleRate: 1,
    },
    reporting: { enabled: true },
    ...overrides,
  };
}

describe("replayLifecycle", () => {
  afterEach(() => {
    replayLifecycle.reset();
    vi.useRealTimers();
  });

  it("starts disabled as unavailable", () => {
    expect(replayLifecycle.getSnapshot()).toMatchObject({
      status: "disabled",
      reason: "unavailable",
    });
  });

  it("notifies once per meaningful change", () => {
    const listener = vi.fn();
    replayLifecycle.subscribe(listener);
    const activeV3 = activeConfig();
    const disabledV4 = activeConfig({
      configVersion: "prod-v4",
      capture: { ...activeV3.capture, enabled: false },
    });

    replayLifecycle.apply(activeV3);
    replayLifecycle.apply({ ...activeV3 });
    replayLifecycle.apply(disabledV4);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0].capture.enabled).toBe(false);
    expect(replayLifecycle.getSnapshot()).toEqual(disabledV4);
  });

  it("disables an expired policy on read, even without a timer firing", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
    replayLifecycle.apply(activeConfig());

    vi.setSystemTime(1_800_000_300_001);

    expect(replayLifecycle.getSnapshot()).toMatchObject({
      status: "disabled",
      reason: "expired",
      capture: { enabled: false },
    });
  });
});
