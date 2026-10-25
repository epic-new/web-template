import "server-only";

import {
  REPLAY_BATCH_HARD_MAX_BYTES,
  REPLAY_BATCH_MAX_EVENTS,
  replayBatchRequestSchema,
  type ReplayBatchResponse,
} from "@/lib/replay/replay-upload-contract";
import { relayFailure } from "@/lib/replay/server/relay-failure";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { deriveReplaySubject, type ReplayActor, replaySecret } from "@/lib/replay/server/replay-subject";
import { EpicClient, EpicPublishingError } from "@/shared/integrations/epic/epic";
import {
  RecordingsResource,
  type BatchPayload,
} from "@/shared/integrations/epic/resources/recordings.resource";
import { ReplayRecordingModel } from "@/shared/models/replay-recording";
import { ReplayRecordingPolicy } from "@/shared/policies/replay-recording.policy";

const BATCH_RATE = { limit: 120, windowMs: 60_000 };
// Epic bounds its own provider call at 10 s; leave room for its answer.
const RELAY_TIMEOUT_MS = 15_000;

export interface UploadReplayBatchCommand {
  actor: ReplayActor | null;
  recordingId: string;
  input: unknown;
}

/**
 * Relays one ordered batch for a recording this server registered. The batch
 * is forwarded as the browser froze it plus the trusted subject; Epic's
 * receipt decides accepted, in progress or uncertain, and its answer is
 * returned unchanged. No event is stored or logged here, and the local status
 * never blocks a retry: Epic replays an accepted receipt even after closure.
 */
export class UploadReplayBatch {
  static async execute(command: UploadReplayBatchCommand): Promise<ReplayBatchResponse> {
    try {
      if (UploadReplayBatch.exceedsEventLimit(command.input)) {
        throw new ReplayUploadError("payload_too_large");
      }
      const input = replayBatchRequestSchema.parse(command.input);
      if (input.events.length === 0 && !input.final) {
        throw new ReplayUploadError("invalid_request", { status: 422 });
      }
      if (!command.actor) throw new ReplayUploadError("identity_required");

      const client = EpicClient.fromEnv();
      const secret = replaySecret();
      if (!client || !secret) throw new ReplayUploadError("not_configured");

      const subjectId = deriveReplaySubject(command.actor, secret);
      const record = await ReplayRecordingModel.findByRecordingId(command.recordingId);
      this.authorize({ subjectId }, record);

      // The complete request Epic receives, including the injected subject.
      const payload: BatchPayload = {
        contractVersion: 1,
        subjectId,
        recordingToken: input.recordingToken,
        batchId: input.batchId,
        sequence: input.sequence,
        events: input.events,
        final: input.final,
      };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > REPLAY_BATCH_HARD_MAX_BYTES) {
        throw new ReplayUploadError("payload_too_large");
      }

      const rate = await ReplayRecordingModel.consumeRate(subjectId, "batch", {
        ...BATCH_RATE,
        now: Date.now(),
      });
      if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

      const acknowledgment = await UploadReplayBatch.relay(client, command.recordingId, payload);
      if (input.final || acknowledgment.delivery === "finalized") {
        await ReplayRecordingModel.transitionStatus(command.recordingId, ["registering", "open"], "closed");
      }
      return acknowledgment;
    } catch (error) {
      throw relayFailure(error);
    }
  }

  // Caches what Epic decided, so the local row reads truthfully.
  private static async relay(
    client: EpicClient,
    recordingId: string,
    payload: BatchPayload,
  ): Promise<ReplayBatchResponse> {
    try {
      return await RecordingsResource.appendBatch(client, recordingId, payload, {
        timeoutMs: RELAY_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof EpicPublishingError) {
        if (error.code === "delivery_uncertain") {
          await ReplayRecordingModel.transitionStatus(recordingId, ["registering", "open"], "quarantined");
        } else if (error.code === "recording_closed") {
          await ReplayRecordingModel.transitionStatus(recordingId, ["registering", "open"], "closed");
        }
      }
      throw error;
    }
  }

  // The count check precedes strict parsing so an oversized batch is a 413.
  private static exceedsEventLimit(input: unknown): boolean {
    const events = (input as { events?: unknown } | null)?.events;
    return Array.isArray(events) && events.length > REPLAY_BATCH_MAX_EVENTS;
  }

  private static authorize(
    actor: { subjectId: string },
    record: Awaited<ReturnType<typeof ReplayRecordingModel.findByRecordingId>>,
  ): void {
    if (!ReplayRecordingPolicy.canRelay(actor, record)) {
      throw new ReplayUploadError("recording_not_found");
    }
  }
}
