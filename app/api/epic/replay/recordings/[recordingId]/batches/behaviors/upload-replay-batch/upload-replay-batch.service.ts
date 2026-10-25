import "server-only";

import { z } from "zod";

import { REPLAY_RECORDING_LIMITS } from "@/lib/replay/replay-config.contract";
import { jsonByteLength } from "@/lib/replay/replay-redaction";
import {
  parseReplayRequest,
  replayBatchRequestSchema,
  ReplayUploadError,
  type ReplayBatchAcknowledgment,
} from "@/lib/replay/replay-upload-contract";
import { requireReplayRelay, toReplayUploadError } from "@/lib/replay/server/replay-relay";
import type { ReplayActor } from "@/lib/replay/server/replay-subject";
import type { RecordingBatchPayload } from "@/shared/integrations/epic/resources";
import { RecordingsResource } from "@/shared/integrations/epic/resources/recordings.resource";
import { ReplayRecordingModel, type ReplayRecordingRecord } from "@/shared/models/replay-recording";
import { ReplayRecordingPolicy, type ReplaySubject } from "@/shared/policies/replay-recording.policy";

export interface UploadReplayBatchCommand {
  actor: ReplayActor | null;
  recordingId: string;
  input: unknown;
}

export type BatchResult = ReplayBatchAcknowledgment;

const BATCH_RATE = { limit: 120, windowMs: 60_000 };

/**
 * Relays one frozen batch of the current subject's own recording to Epic,
 * adding only the trusted subject. Events are never persisted or logged.
 *
 * Central is the receipt authority: it decides new append, duplicate,
 * closed or uncertain, so a locally closed or quarantined row never blocks
 * the exact retry that recovers an accepted or finalized acknowledgment.
 * The local status is only a cache of what central answered.
 */
export class UploadReplayBatch {
  static async execute({ actor, recordingId, input }: UploadReplayBatchCommand): Promise<BatchResult> {
    if (
      input &&
      typeof input === "object" &&
      Array.isArray((input as { events?: unknown }).events) &&
      (input as { events: unknown[] }).events.length > REPLAY_RECORDING_LIMITS.maxBatchEvents
    ) {
      throw new ReplayUploadError("payload_too_large");
    }
    const batch = parseReplayRequest(replayBatchRequestSchema, input);
    // Empty events are only a metadata finalization.
    if (batch.events.length === 0 && !batch.final) throw new ReplayUploadError("invalid_request");
    const { client, subject } = requireReplayRelay(actor);

    const record = z.uuid().safeParse(recordingId).success
      ? await ReplayRecordingModel.findByRecordingId(recordingId.toLowerCase())
      : null;
    UploadReplayBatch.authorize(subject, record);

    const rate = await ReplayRecordingModel.consumeRate(subject.subjectId, "batch", {
      ...BATCH_RATE,
      now: Date.now(),
    });
    if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

    const body: RecordingBatchPayload = {
      contractVersion: 1,
      recordingToken: batch.recordingToken,
      batchId: batch.batchId,
      sequence: batch.sequence,
      events: batch.events,
      final: batch.final,
      subjectId: subject.subjectId,
    };
    // The central wire limit bounds the augmented request too; never raised.
    if (jsonByteLength(body) > REPLAY_RECORDING_LIMITS.maxBatchBytes) throw new ReplayUploadError("payload_too_large");

    let ack: ReplayBatchAcknowledgment;
    try {
      ack = await RecordingsResource.appendBatch(client, record.recordingId, body);
    } catch (error) {
      const failure = toReplayUploadError(error);
      if (failure.code === "delivery_uncertain") {
        await ReplayRecordingModel.transitionStatus(record.recordingId, ["open"], "quarantined").catch(() => null);
      }
      throw failure;
    }

    if (batch.final) {
      await ReplayRecordingModel.transitionStatus(record.recordingId, ["open"], "closed").catch(() => null);
    }
    return ack;
  }

  // Unknown and foreign recordings answer identically.
  private static authorize(
    subject: ReplaySubject,
    record: ReplayRecordingRecord | null,
  ): asserts record is ReplayRecordingRecord & { recordingId: string } {
    if (!ReplayRecordingPolicy.canRelay(subject, record)) throw new ReplayUploadError("recording_not_found");
  }
}
