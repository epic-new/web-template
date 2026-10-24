import {
  disabledReplayConfig,
  MAX_POLICY_TTL_MS,
  publicReplayConfigSchema,
  type PublicReplayConfig,
} from "@/lib/replay/replay-config.contract";

/**
 * Synthetic replay policies for the development privacy harness. They live in
 * the harness's own policy source and are never applied to `replayLifecycle`,
 * so no other page can see them and the policy refresh cannot replace them.
 */

export type ReplayHarnessSource = "application" | "synthetic-sampled" | "synthetic-unsampled";

export const REPLAY_HARNESS_EXCLUDED_PATH = "/styleguide/replay/excluded";

export function syntheticReplayPolicy(source: Exclude<ReplayHarnessSource, "application">): PublicReplayConfig {
  const now = Date.now();
  const base = disabledReplayConfig({ reason: "unavailable", environment: "development", release: null, now });
  return publicReplayConfigSchema.parse({
    ...base,
    status: "active",
    reason: null,
    configVersion: source,
    expiresAt: now + MAX_POLICY_TTL_MS,
    capture: {
      ...base.capture,
      enabled: true,
      sessionSampleRate: source === "synthetic-sampled" ? 1 : 0,
      routes: { include: [], exclude: [REPLAY_HARNESS_EXCLUDED_PATH] },
    },
  });
}
