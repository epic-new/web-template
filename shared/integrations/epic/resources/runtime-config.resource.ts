import "server-only";

import { z } from "zod";

import { EpicIntegrationError, type EpicClient } from "../epic";
import type { RuntimeConfigResource as RuntimeConfigResourceRecord } from "../resources";

const RUNTIME_CONFIG_PATH = "/api/replay/v1/runtime-config";

const intSchema = z.number().int();
const positiveIntSchema = intSchema.positive();

/**
 * Strict EPI-209 version 1 schema: unknown fields, malformed scope and any
 * credential-bearing additions are rejected at every level.
 */
const runtimeConfigResourceSchema = z
  .object({
    contractVersion: z.literal(1),
    projectId: z.string(),
    applicationId: z.string(),
    environment: z.enum(["production", "preview", "development", "test"]),
    configVersion: z.string().nullable(),
    issuedAt: intSchema,
    expiresAt: intSchema,
    refreshIntervalMs: intSchema,
    capture: z
      .object({
        enabled: z.boolean(),
        sessionSampleRate: z.number(),
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
          .object({ console: z.boolean(), network: z.boolean() })
          .strict(),
      })
      .strict(),
    reporting: z.object({ enabled: z.boolean() }).strict(),
    recording: z
      .object({
        transport: z.literal("epic-http"),
        limits: z
          .object({
            maxBatchBytes: positiveIntSchema,
            maxBatchEvents: positiveIntSchema,
            maxBufferBytes: positiveIntSchema,
            maxBufferAgeMs: positiveIntSchema,
            flushIntervalMs: positiveIntSchema,
            flushBytes: positiveIntSchema,
            maxAttempts: positiveIntSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<RuntimeConfigResourceRecord>;

export const RuntimeConfigResource = {
  /**
   * Reads the policy the publishing credential is bound to. No scope selector
   * is ever sent: the central credential picks project, application and
   * environment, and the caller validates the returned binding.
   */
  async fetch(
    client: EpicClient,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<RuntimeConfigResourceRecord> {
    const payload = await client.request(RUNTIME_CONFIG_PATH, { signal });
    const parsed = runtimeConfigResourceSchema.safeParse(payload);
    if (!parsed.success) throw new EpicIntegrationError("invalid_response");
    return parsed.data;
  },
};
