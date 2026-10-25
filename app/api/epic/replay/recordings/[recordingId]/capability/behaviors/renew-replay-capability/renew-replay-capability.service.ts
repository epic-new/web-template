import "server-only";

import {
  replayCapabilityRequestSchema,
  type ReplayRecordingResponse,
} from "@/lib/replay/replay-upload-contract";
import { relayFailure } from "@/lib/replay/server/relay-failure";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { deriveReplaySubject, type ReplayActor } from "@/lib/replay/server/replay-subject";
import { EpicClient } from "@/shared/integrations/epic/epic";
import { RecordingsResource } from "@/shared/integrations/epic/resources/recordings.resource";
import { ReplayRecordingModel } from "@/shared/models/replay-recording";
import { ReplayRecordingPolicy } from "@/shared/policies/replay-recording.policy";

const CAPABILITY_RATE = { limit: 30, windowMs: 60_000 };

export interface RenewReplayCapabilityCommand {
  actor: ReplayActor | null;
  recordingId: string;
  input: unknown;
}

/**
 * Re-establishes the upload capability of a recording this server registered
 * for the current subject. Returns Epic's complete registration shape; the
 * cursor in it is diagnostic and never renumbers a pending batch. Central
 * closed, uncertain and credential outcomes pass through unchanged.
 */
export class RenewReplayCapability {
  static async execute(command: RenewReplayCapabilityCommand): Promise<ReplayRecordingResponse> {
    try {
      replayCapabilityRequestSchema.parse(command.input);
      if (!command.actor) throw new ReplayUploadError("identity_required");

      const client = EpicClient.fromEnv();
      const secret = process.env.BETTER_AUTH_SECRET;
      if (!client || !secret) throw new ReplayUploadError("not_configured");

      const subjectId = deriveReplaySubject(command.actor, secret);
      const record = await ReplayRecordingModel.findByRecordingId(command.recordingId);
      this.authorize({ subjectId }, record);

      const rate = await ReplayRecordingModel.consumeRate(subjectId, "capability", {
        ...CAPABILITY_RATE,
        now: Date.now(),
      });
      if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

      return await RecordingsResource.renewCapability(client, command.recordingId, { subjectId });
    } catch (error) {
      throw relayFailure(error);
    }
  }

  // Unknown and foreign recordings answer identically.
  private static authorize(
    actor: { subjectId: string },
    record: Awaited<ReturnType<typeof ReplayRecordingModel.findByRecordingId>>,
  ): void {
    if (!ReplayRecordingPolicy.canRelay(actor, record)) {
      throw new ReplayUploadError("recording_not_found");
    }
  }
}
