import "server-only";

import { z } from "zod";

import { EpicIntegrationError, type EpicClient } from "../epic";
import type { RuntimeConfigResource as RuntimeConfigResourceRecord } from "../resources";

const RUNTIME_CONFIG_PATH = "/api/replay/v1/runtime-config";

const intSchema = z.number().int();
const positiveIntSchema = intSchema.positive();

/**
 * Strict version 2 schema: unknown fields, malformed scope and any
 * credential-bearing additions are rejected at every level.
 */
const runtimeConfigResourceSchema = z
  .object({
    contractVersion: z.literal(2),
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
        // Policies saved before consent mode existed asked for consent.
        consentMode: z.enum(["required", "not_required"]).default("required"),
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
    retention: z.object({ days: positiveIntSchema }).strict(),
    recording: z
      .object({
        transport: z.literal("otlp-relay"),
        limits: z
          .object({
            maxBatchBytes: positiveIntSchema,
            maxBatchEvents: positiveIntSchema,
            maxBufferBytes: positiveIntSchema,
            maxBufferAgeMs: positiveIntSchema,
            flushIntervalMs: positiveIntSchema,
            flushBytes: positiveIntSchema,
            maxAttempts: positiveIntSchema,
            maxChunkBytes: positiveIntSchema,
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
