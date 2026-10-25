import { z } from "zod";
import { replayRecordingLimitsSchema } from "./replay-config.contract";

import {
  MAX_REPLAY_SEQUENCE,
  replayBatchAcknowledgmentSchema,
  replayRegistrationRequestSchema,
} from "./replay-upload-contract";

/** Metadata only. Never serialize an uploader's private Recording object. */
export const replayUploadCheckpointSchema = z.object({
  registration: replayRegistrationRequestSchema,
  recordingId: z.uuid(),
  startedAt: z.number().int().nonnegative(),
  nextSequence: z.number().int().positive().max(MAX_REPLAY_SEQUENCE),
  limits: replayRecordingLimitsSchema,
  lastAcknowledgment: replayBatchAcknowledgmentSchema,
  acceptedBatches: z.number().int().positive().max(MAX_REPLAY_SEQUENCE),
  snapshotReceived: z.literal(true),
}).strict().superRefine((checkpoint, ctx) => {
  const ack = checkpoint.lastAcknowledgment;
  if (
    checkpoint.registration.startedAt !== checkpoint.startedAt ||
    ack.recordingId !== checkpoint.recordingId ||
    ack.nextSequence !== checkpoint.nextSequence ||
    ack.delivery !== "accepted" ||
    checkpoint.acceptedBatches > checkpoint.nextSequence
  ) {
    ctx.addIssue({ code: "custom", message: "Checkpoint does not match its acknowledged frontier" });
  }
});

export type ReplayUploadCheckpoint = z.infer<typeof replayUploadCheckpointSchema>;
