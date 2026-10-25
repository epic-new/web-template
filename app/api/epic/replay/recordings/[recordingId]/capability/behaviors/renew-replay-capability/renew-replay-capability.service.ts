import "server-only";

import { z } from "zod";

import {
  parseReplayRequest,
  replayCapabilityRequestSchema,
  ReplayUploadError,
  type ReplayRecordingCapability,
} from "@/lib/replay/replay-upload-contract";
import { requireReplayRelay, toReplayUploadError } from "@/lib/replay/server/replay-relay";
import type { ReplayActor } from "@/lib/replay/server/replay-subject";
import { RecordingsResource } from "@/shared/integrations/epic/resources/recordings.resource";
import { ReplayRecordingModel, type ReplayRecordingRecord } from "@/shared/models/replay-recording";
import { ReplayRecordingPolicy, type ReplaySubject } from "@/shared/policies/replay-recording.policy";

export interface RenewReplayCapabilityCommand {
  actor: ReplayActor | null;
  recordingId: string;
  input: unknown;
}

export type CapabilityResult = ReplayRecordingCapability;

const CAPABILITY_RATE = { limit: 30, windowMs: 60_000 };

/**
 * Renews the upload capability of the current subject's own recording. The
 * answer is the complete registration shape; its `nextSequence` is
 * diagnostic and never renumbers a pending batch. Local cached status is not
 * authoritative: central decides closed or uncertain.
 */
export class RenewReplayCapability {
  static async execute({ actor, recordingId, input }: RenewReplayCapabilityCommand): Promise<CapabilityResult> {
    parseReplayRequest(replayCapabilityRequestSchema, input);
    const { client, subject } = requireReplayRelay(actor);

    const record = z.uuid().safeParse(recordingId).success
      ? await ReplayRecordingModel.findByRecordingId(recordingId.toLowerCase())
      : null;
    RenewReplayCapability.authorize(subject, record);

    const rate = await ReplayRecordingModel.consumeRate(subject.subjectId, "capability", {
      ...CAPABILITY_RATE,
      now: Date.now(),
    });
    if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

    try {
      return await RecordingsResource.renewCapability(client, record.recordingId, { subjectId: subject.subjectId });
    } catch (error) {
      throw toReplayUploadError(error);
    }
  }

  // Unknown and foreign recordings answer identically.
  private static authorize(
    subject: ReplaySubject,
    record: ReplayRecordingRecord | null,
  ): asserts record is ReplayRecordingRecord & { recordingId: string } {
    if (!ReplayRecordingPolicy.canRelay(subject, record)) throw new ReplayUploadError("recording_not_found");
  }
}
