import "server-only";

import { ReplayUploadError } from "@/lib/replay/replay-upload-contract";
import { EpicClient, EpicIntegrationError } from "@/shared/integrations/epic/epic";
import type { ReplaySubject } from "@/shared/policies/replay-recording.policy";
import { deriveReplaySubject, type ReplayActor } from "./replay-subject";

/**
 * What every replay publishing Service needs before it may relay: a resolved
 * actor, the publishing credential and the stable identity secret. Without
 * the credential or secret there is no write isolation to assume, so the
 * answer is `not_configured` and nothing else is attempted.
 */

const MIN_IDENTITY_SECRET_LENGTH = 32;

export function requireReplayRelay(
  actor: ReplayActor | null,
  env: Partial<Record<string, string | undefined>> = process.env,
): { client: EpicClient; subject: ReplaySubject } {
  if (!actor) throw new ReplayUploadError("identity_required");
  const client = EpicClient.fromEnv(env);
  const secret = env.BETTER_AUTH_SECRET;
  if (!client || !secret || secret.length < MIN_IDENTITY_SECRET_LENGTH) {
    throw new ReplayUploadError("not_configured");
  }
  return { client, subject: deriveReplaySubject(actor, secret) };
}

/**
 * Central outcomes keep their exact status, code and typed fields. A rejected
 * credential without the v1 envelope is still the publishing credential
 * failing, never local `not_configured`; transport failures are `unavailable`.
 */
export function toReplayUploadError(error: unknown): ReplayUploadError {
  if (error instanceof ReplayUploadError) return error;
  if (error instanceof EpicIntegrationError) {
    if (error.rejection) {
      const { code, status, expectedSequence, retryAfterMs } = error.rejection;
      return new ReplayUploadError(code, { status, expectedSequence, retryAfterMs });
    }
    if (error.code === "unauthorized") return new ReplayUploadError("REPLAY_CREDENTIAL_INVALID");
  }
  return new ReplayUploadError("unavailable");
}
