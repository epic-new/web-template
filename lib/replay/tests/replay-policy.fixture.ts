import {
  disabledReplayConfig,
  MAX_POLICY_TTL_MS,
  type PublicReplayConfig,
} from "../replay-config.contract";

/** A synthetic, contract-valid active policy for replay privacy tests. */
export function activeReplayPolicy(
  capture: Partial<PublicReplayConfig["capture"]> = {},
  overrides: Partial<PublicReplayConfig> = {},
): PublicReplayConfig {
  const now = Date.now();
  const base = disabledReplayConfig({ reason: "unavailable", environment: "development", release: null, now });
  return {
    ...base,
    status: "active",
    reason: null,
    configVersion: "1",
    expiresAt: now + MAX_POLICY_TTL_MS,
    capture: {
      ...base.capture,
      enabled: true,
      sessionSampleRate: 1,
      routes: { include: [], exclude: ["/excluded"] },
      ...capture,
    },
    ...overrides,
  };
}

export function disabledReplayPolicy(reason: PublicReplayConfig["reason"] & string = "not_configured") {
  return disabledReplayConfig({ reason, environment: "development", release: null, now: Date.now() });
}
