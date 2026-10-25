import { describe, expect, it, vi } from "vitest";

import { disabledReplayConfig } from "../replay-config.contract";
import { evaluateCapturePermission } from "../replay-permission";
import { activeReplayPolicy, disabledReplayPolicy } from "./replay-policy.fixture";

const allowed = {
  policy: activeReplayPolicy(),
  consent: "granted" as const,
  pathname: "/",
  sampled: () => true,
};

describe("evaluateCapturePermission", () => {
  it("allows capture when every gate passes", () => {
    expect(evaluateCapturePermission(allowed)).toEqual({ allowed: true });
  });

  it.each([
    ["policy_disabled", { policy: disabledReplayPolicy() }],
    [
      "policy_expired",
      {
        policy: disabledReplayConfig({ reason: "expired", environment: "production", release: null, now: 0 }),
      },
    ],
    ["policy_disabled", { policy: activeReplayPolicy({ enabled: false }) }],
    ["policy_disabled", { policy: activeReplayPolicy({}, { environment: null }) }],
    ["consent_absent", { consent: "unknown" as const }],
    ["consent_withdrawn", { consent: "withdrawn" as const }],
    ["route_excluded", { pathname: "/excluded" }],
    ["not_sampled", { sampled: () => false }],
  ])("blocks with %s", (reason, override) => {
    expect(evaluateCapturePermission({ ...allowed, ...override })).toEqual({ allowed: false, reason });
  });

  it("treats an unanswered prompt as consent where it is not required, but never an opt-out", () => {
    const optional = activeReplayPolicy({ consentMode: "not_required" });

    expect(evaluateCapturePermission({ ...allowed, policy: optional, consent: "unknown" })).toEqual({ allowed: true });
    expect(evaluateCapturePermission({ ...allowed, policy: optional, consent: "withdrawn" })).toEqual({
      allowed: false,
      reason: "consent_withdrawn",
    });
    expect(evaluateCapturePermission({ ...allowed, consent: "unknown" })).toEqual({
      allowed: false,
      reason: "consent_absent",
    });
  });

  it("does not draw a sample before consent or on an excluded route", () => {
    const sampled = vi.fn(() => true);

    expect(evaluateCapturePermission({ ...allowed, consent: "unknown", sampled })).toEqual({
      allowed: false,
      reason: "consent_absent",
    });
    evaluateCapturePermission({ ...allowed, pathname: "/excluded", sampled });
    expect(sampled).not.toHaveBeenCalled();
  });
});
