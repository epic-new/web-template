import "server-only";

import { randomUUID } from "node:crypto";

import {
  replayRegistrationRequestSchema,
  type ReplayRecordingResponse,
} from "@/lib/replay/replay-upload-contract";
import { canonicalReplayHash } from "@/lib/replay/server/canonical-hash";
import { deriveReplayCaptureContext, type UserAgentInfo } from "@/lib/replay/server/capture-context";
import { relayFailure } from "@/lib/replay/server/relay-failure";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { deriveReplaySubject, type ReplayActor } from "@/lib/replay/server/replay-subject";
import { EpicClient } from "@/shared/integrations/epic/epic";
import {
  RecordingsResource,
  type RegistrationPayload,
} from "@/shared/integrations/epic/resources/recordings.resource";
import { ReplayRecordingModel, type ReplayRecordingRecord } from "@/shared/models/replay-recording";

const REGISTER_RATE = { limit: 10, windowMs: 60_000 };

export interface RegisterReplayRecordingCommand {
  actor: ReplayActor | null;
  input: unknown;
  userAgent: UserAgentInfo;
}

export interface RegistrationResult {
  /** True for a new recording (201), false for an idempotent retry (200). */
  created: boolean;
  registration: ReplayRecordingResponse;
}

/**
 * Registers a recording with Epic for the current trusted subject. The browser
 * supplies only its frozen intent; the subject, coarse device context and
 * credential are the server's. The exact central payload is persisted before
 * it is sent, so a lost response is retried byte-for-byte rather than
 * re-derived from a different User-Agent, release or deployment.
 */
export class RegisterReplayRecording {
  static async execute(command: RegisterReplayRecordingCommand): Promise<RegistrationResult> {
    try {
      const input = replayRegistrationRequestSchema.parse(command.input);
      if (!command.actor) throw new ReplayUploadError("identity_required");

      const client = EpicClient.fromEnv();
      const secret = process.env.BETTER_AUTH_SECRET;
      if (!client || !secret) throw new ReplayUploadError("not_configured");

      const subjectId = deriveReplaySubject(command.actor, secret);
      const rate = await ReplayRecordingModel.consumeRate(subjectId, "register", {
        ...REGISTER_RATE,
        now: Date.now(),
      });
      if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

      const hash = canonicalReplayHash({ subjectId, ...input });
      const existing = await ReplayRecordingModel.findByIdempotencyKey(subjectId, input.idempotencyKey);
      const record =
        existing ??
        (await RegisterReplayRecording.insert(subjectId, hash, input, command.userAgent));
      if (record.registrationHash !== hash) throw new ReplayUploadError("idempotency_conflict");

      const payload = record.registrationPayload as unknown as RegistrationPayload;
      const { created, recording } = await RecordingsResource.register(client, payload);

      const bound = await ReplayRecordingModel.bindRecordingId(record.id, recording.recordingId);
      if (!bound) throw new ReplayUploadError("unavailable");
      await ReplayRecordingModel.transitionStatus(recording.recordingId, ["registering"], "open");

      return { created, registration: recording };
    } catch (error) {
      throw relayFailure(error);
    }
  }

  // A raced insert resolves to the stored winner, whose payload is the one sent.
  private static async insert(
    subjectId: string,
    hash: string,
    input: ReturnType<typeof replayRegistrationRequestSchema.parse>,
    userAgent: UserAgentInfo,
  ): Promise<ReplayRecordingRecord> {
    const payload: RegistrationPayload = {
      contractVersion: 1,
      idempotencyKey: input.idempotencyKey,
      subjectId,
      startedAt: input.startedAt,
      route: input.route,
      release: input.release,
      recorderVersion: input.recorderVersion,
      configVersion: input.configVersion,
      captureContext: deriveReplayCaptureContext(userAgent, input.viewport),
    };
    const { record } = await ReplayRecordingModel.insertRegistering({
      id: randomUUID(),
      subjectId,
      idempotencyKey: input.idempotencyKey,
      registrationHash: hash,
      registrationPayload: payload as unknown as Record<string, unknown>,
    });
    return record;
  }
}
