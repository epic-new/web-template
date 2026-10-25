import "server-only";

import {
  disabledReplayConfig,
  MAX_POLICY_TTL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  publicReplayConfigSchema,
  replayRecordingLimitsSchema,
  type PublicReplayConfig,
  type ReplayDisabledReason,
  replayEnvironmentSchema,
  type ReplayEnvironment,
} from "@/lib/replay/replay-config.contract";
import { EpicClient, EpicIntegrationError } from "@/shared/integrations/epic/epic";
import type { RuntimeConfigResource as RuntimeConfigResourceRecord } from "@/shared/integrations/epic/resources";
import { RuntimeConfigResource } from "@/shared/integrations/epic/resources/runtime-config.resource";

type Env = Partial<Record<string, string | undefined>>;

const ERROR_REASONS: Record<EpicIntegrationError["code"], ReplayDisabledReason> = {
  unauthorized: "unauthorized",
  unavailable: "upstream_unavailable",
  invalid_response: "invalid_policy",
};

const VERCEL_ENVIRONMENTS = new Set<ReplayEnvironment>([
  "production",
  "preview",
  "development",
]);

/**
 * Resolves this deployment's replay policy. Takes no command on purpose: scope
 * comes only from the server's own configuration and credential, so nothing a
 * browser sends can reach it.
 */
export class ReadReplayConfig {
  static async execute(): Promise<PublicReplayConfig> {
    const env = process.env;
    const environment = ReadReplayConfig.resolveEnvironment(env);
    const release = env.EPIC_RELEASE || env.VERCEL_GIT_COMMIT_SHA || null;

    const disabled = (reason: ReplayDisabledReason) => {
      console.warn("[replay-config]", reason);
      return disabledReplayConfig({ reason, environment, release, now: Date.now() });
    };

    // An explicitly invalid environment never falls back to a default.
    if (environment === null) return disabled("invalid_policy");

    const client = EpicClient.fromEnv(env);
    if (!client) return disabled("not_configured");

    let resource: RuntimeConfigResourceRecord;
    try {
      resource = await RuntimeConfigResource.fetch(client);
    } catch (error) {
      return disabled(
        error instanceof EpicIntegrationError
          ? ERROR_REASONS[error.code]
          : "upstream_unavailable",
      );
    }

    const now = Date.now();
    const enabled = resource.capture.enabled || resource.reporting.enabled;
    if (
      (resource.configVersion !== null && resource.configVersion.trim() === "") ||
      (resource.configVersion === null && enabled) ||
      resource.projectId !== client.projectId ||
      resource.environment !== environment ||
      resource.applicationId.trim() === "" ||
      !replayRecordingLimitsSchema.safeParse(resource.recording.limits).success ||
      resource.capture.sessionSampleRate < 0 ||
      resource.capture.sessionSampleRate > 1
    ) {
      return disabled("invalid_policy");
    }

    const expiresAt = Math.min(
      resource.expiresAt,
      resource.issuedAt + MAX_POLICY_TTL_MS,
      now + MAX_POLICY_TTL_MS,
    );
    if (expiresAt <= now) return disabled("expired");

    const result = publicReplayConfigSchema.safeParse(
      ReadReplayConfig.toPublicConfig(resource, { release, now, expiresAt }),
    );
    if (!result.success) return disabled("invalid_policy");
    return result.data;
  }

  // Returns null when EPIC_ENVIRONMENT is present but not a valid environment.
  private static resolveEnvironment(env: Env): ReplayEnvironment | null {
    if (env.EPIC_ENVIRONMENT !== undefined) {
      const explicit = replayEnvironmentSchema.safeParse(env.EPIC_ENVIRONMENT);
      return explicit.success ? explicit.data : null;
    }
    const vercel = env.VERCEL_ENV as ReplayEnvironment | undefined;
    if (vercel && VERCEL_ENVIRONMENTS.has(vercel)) return vercel;
    if (env.NODE_ENV === "test") return "test";
    if (env.NODE_ENV === "production") return "production";
    return "development";
  }

  private static toPublicConfig(
    resource: RuntimeConfigResourceRecord,
    { release, now, expiresAt }: { release: string | null; now: number; expiresAt: number },
  ): PublicReplayConfig {
    const { capture, reporting, recording } = resource;
    return {
      contractVersion: 1,
      status: "active",
      reason: null,
      configVersion: resource.configVersion,
      environment: resource.environment,
      release,
      fetchedAt: now,
      expiresAt,
      refreshIntervalMs: Math.min(
        Math.max(resource.refreshIntervalMs, MIN_REFRESH_INTERVAL_MS),
        MAX_REFRESH_INTERVAL_MS,
      ),
      capture: {
        enabled: capture.enabled,
        sessionSampleRate: capture.sessionSampleRate,
        routes: {
          include: [...capture.routes.include],
          exclude: [...capture.routes.exclude],
        },
        privacy: {
          maskAllInputs: capture.privacy.maskAllInputs,
          maskTextSelector: capture.privacy.maskTextSelector,
          blockSelector: capture.privacy.blockSelector,
        },
        diagnostics: {
          console: capture.diagnostics.console,
          network: capture.diagnostics.network,
        },
      },
      reporting: { enabled: reporting.enabled },
      recording: {
        transport: recording.transport,
        limits: {
          maxBatchBytes: recording.limits.maxBatchBytes,
          maxBatchEvents: recording.limits.maxBatchEvents,
          maxBufferBytes: recording.limits.maxBufferBytes,
          maxBufferAgeMs: recording.limits.maxBufferAgeMs,
          flushIntervalMs: recording.limits.flushIntervalMs,
          flushBytes: recording.limits.flushBytes,
          maxAttempts: recording.limits.maxAttempts,
        },
      },
    };
  }
}
