import { z } from "zod";

/**
 * The public replay configuration contract.
 *
 * Browser-safe on purpose: the Service builds this shape, the query module
 * parses it, and the lifecycle manager holds it. Every level is `.strict()`,
 * so a field that is not part of the contract can never ride along to the
 * browser.
 */

export const REPLAY_CONFIG_CONTRACT_VERSION = 1;

// Polling cadence, not an unconditional end-to-end disable guarantee.
export const MIN_REFRESH_INTERVAL_MS = 10_000;
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
export const MAX_REFRESH_INTERVAL_MS = 60_000;

export const MAX_POLICY_TTL_MS = 300_000;

// Initial upper limits from EPI-209.
export const REPLAY_RECORDING_LIMITS = {
  maxBatchBytes: 1_048_576,
  maxBatchEvents: 500,
  maxBufferBytes: 5_242_880,
  maxBufferAgeMs: 60_000,
  flushIntervalMs: 20_000,
  flushBytes: 65_536,
  maxAttempts: 3,
} as const;

export const replayEnvironmentSchema = z.enum([
  "production",
  "preview",
  "development",
  "test",
]);
export type ReplayEnvironment = z.infer<typeof replayEnvironmentSchema>;

export const replayDisabledReasonSchema = z.enum([
  "not_configured",
  "unauthorized",
  "upstream_unavailable",
  "invalid_policy",
  "expired",
  // Client-only: no policy has loaded yet.
  "unavailable",
]);
export type ReplayDisabledReason = z.infer<typeof replayDisabledReasonSchema>;

const timestampSchema = z.number().int().nonnegative();
const positiveIntSchema = z.number().int().positive();

export const replayRecordingLimitsSchema = z
  .object({
    maxBatchBytes: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.maxBatchBytes),
    maxBatchEvents: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.maxBatchEvents),
    maxBufferBytes: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.maxBufferBytes),
    maxBufferAgeMs: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.maxBufferAgeMs),
    flushIntervalMs: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.flushIntervalMs),
    flushBytes: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.flushBytes),
    maxAttempts: positiveIntSchema.max(REPLAY_RECORDING_LIMITS.maxAttempts),
  })
  .strict();

export const publicReplayConfigSchema = z
  .object({
    contractVersion: z.literal(REPLAY_CONFIG_CONTRACT_VERSION),
    status: z.enum(["active", "disabled"]),
    reason: replayDisabledReasonSchema.nullable(),
    configVersion: z
      .string()
      .refine((version) => version.trim() !== "", "Blank configuration version")
      .nullable(),
    // Null only in a disabled response whose environment could not be
    // resolved; central resources always carry one of the four values.
    environment: replayEnvironmentSchema.nullable(),
    release: z.string().nullable(),
    fetchedAt: timestampSchema,
    expiresAt: timestampSchema,
    refreshIntervalMs: positiveIntSchema,
    capture: z
      .object({
        enabled: z.boolean(),
        sessionSampleRate: z.number().min(0).max(1),
        routes: z
          .object({
            include: z.array(z.string()),
            exclude: z.array(z.string()),
          })
          .strict(),
        privacy: z
          .object({
            maskAllInputs: z.boolean(),
            maskTextSelector: z.string().nullable(),
            blockSelector: z.string().nullable(),
          })
          .strict(),
        diagnostics: z
          .object({
            console: z.boolean(),
            network: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    reporting: z.object({ enabled: z.boolean() }).strict(),
    recording: z
      .object({
        transport: z.literal("epic-http"),
        limits: replayRecordingLimitsSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const enabled = config.capture.enabled || config.reporting.enabled;
    if (enabled && config.configVersion === null) {
      ctx.addIssue({
        code: "custom",
        path: ["configVersion"],
        message: "Enabled capture or reporting requires a configuration version",
      });
    }
    if (config.status === "active" && (config.reason !== null || config.environment === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "An active policy has no reason and a resolved environment",
      });
    }
    if (config.status === "disabled" && (enabled || config.reason === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A disabled policy has a reason and nothing enabled",
      });
    }
  });

export type PublicReplayConfig = z.infer<typeof publicReplayConfigSchema>;

export function disabledReplayConfig({
  reason,
  environment,
  release,
  now,
}: {
  reason: ReplayDisabledReason;
  environment: ReplayEnvironment | null;
  release: string | null;
  now: number;
}): PublicReplayConfig {
  return {
    contractVersion: REPLAY_CONFIG_CONTRACT_VERSION,
    status: "disabled",
    reason,
    configVersion: null,
    environment,
    release,
    fetchedAt: now,
    expiresAt: now,
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    capture: {
      enabled: false,
      sessionSampleRate: 0,
      routes: { include: [], exclude: [] },
      privacy: {
        maskAllInputs: true,
        maskTextSelector: "[data-mask]",
        blockSelector: "[data-private]",
      },
      diagnostics: { console: false, network: false },
    },
    reporting: { enabled: false },
    recording: {
      transport: "epic-http",
      limits: { ...REPLAY_RECORDING_LIMITS },
    },
  };
}
