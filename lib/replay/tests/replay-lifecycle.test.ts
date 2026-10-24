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
    vi.restoreAllMocks();
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
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    replayLifecycle.apply(activeConfig());

    monotonic.mockReturnValue(1_000 + 300_000);

    expect(replayLifecycle.getSnapshot()).toMatchObject({
      status: "disabled",
      reason: "expired",
      capture: { enabled: false },
    });
  });

  it("never lets the wall clock extend the receipt-bound lifetime", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    replayLifecycle.apply(activeConfig(), { receivedAt: 1_000 });

    vi.setSystemTime(1_700_000_000_000);
    monotonic.mockReturnValue(1_000 + 300_000);

    expect(replayLifecycle.getSnapshot().reason).toBe("expired");
  });

  it("keeps the original receipt when the same policy is reapplied", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const policy = activeConfig();
    replayLifecycle.apply(policy, { receivedAt: 1_000 });

    monotonic.mockReturnValue(250_000);
    replayLifecycle.apply({ ...policy }, { receivedAt: 250_000 });
    monotonic.mockReturnValue(1_000 + 300_000);

    expect(replayLifecycle.getSnapshot().reason).toBe("expired");
  });

  it("notifies listeners when the expiry timer fires", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const listener = vi.fn();
    replayLifecycle.subscribe(listener);
    replayLifecycle.apply(activeConfig());

    vi.advanceTimersByTime(300_000);

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "disabled", reason: "expired" }),
    );
  });

  it("withholds a policy received before a gate until a fresh one arrives", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const policy = activeConfig();
    replayLifecycle.apply(policy, { receivedAt: 1_000 });

    monotonic.mockReturnValue(2_000);
    replayLifecycle.gate();
    expect(replayLifecycle.getSnapshot()).toMatchObject({
      status: "disabled",
      reason: "unavailable",
      capture: { enabled: false },
    });

    replayLifecycle.apply(policy, { receivedAt: 3_000 });
    expect(replayLifecycle.getSnapshot().status).toBe("disabled");

    const fresh = { ...policy, fetchedAt: policy.fetchedAt + 1 };
    replayLifecycle.apply(fresh, { receivedAt: 3_000 });
    expect(replayLifecycle.getSnapshot()).toEqual(fresh);
  });
});
