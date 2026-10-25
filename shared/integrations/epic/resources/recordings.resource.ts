import "server-only";

import {
  replayBatchAcknowledgmentSchema,
  replayRecordingCapabilitySchema,
} from "@/lib/replay/replay-upload-contract";
import { EpicIntegrationError, type EpicClient } from "../epic";
import type {
  BatchAcknowledgmentResource,
  CapabilityResource,
  RecordingBatchPayload,
  RecordingCapabilityPayload,
  RecordingRegistrationPayload,
  RegistrationResource,
} from "../resources";

const RECORDINGS_PATH = "/api/replay/v1/recordings";
const BATCH_TIMEOUT_MS = 10_000;

function recordingPath(recordingId: string, leaf: "capability" | "batches") {
  return `${RECORDINGS_PATH}/${encodeURIComponent(recordingId)}/${leaf}`;
}

// Strict: a success body carrying anything outside v1 (an rrweb recording id,
// a private key, ...) is an invalid response, never forwarded.
function parseCapability(payload: unknown): CapabilityResource {
  const parsed = replayRecordingCapabilitySchema.safeParse(payload);
  if (!parsed.success) throw new EpicIntegrationError("invalid_response");
  return parsed.data;
}

export const RecordingsResource = {
  /** POST /api/replay/v1/recordings: 201 new, 200 idempotent retry. */
  async register(
    client: EpicClient,
    payload: RecordingRegistrationPayload,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<RegistrationResource> {
    const { status, payload: body } = await client.post(RECORDINGS_PATH, payload, { signal });
    if (status !== 200 && status !== 201) throw new EpicIntegrationError("invalid_response", status);
    const recording = parseCapability(body);
    if (recording.startedAt !== payload.startedAt) throw new EpicIntegrationError("invalid_response", status);
    return { created: status === 201, recording };
  },

  /** POST .../[recordingId]/capability: the complete registration shape. */
  async renewCapability(
    client: EpicClient,
    recordingId: string,
    { subjectId }: { subjectId: string },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<CapabilityResource> {
    const body: RecordingCapabilityPayload = { contractVersion: 1, subjectId };
    const { status, payload } = await client.post(recordingPath(recordingId, "capability"), body, { signal });
    if (status !== 200) throw new EpicIntegrationError("invalid_response", status);
    const capability = parseCapability(payload);
    if (capability.recordingId !== recordingId) throw new EpicIntegrationError("invalid_response", status);
    return capability;
  },

  /** POST .../[recordingId]/batches: an accepted or finalized receipt. */
  async appendBatch(
    client: EpicClient,
    recordingId: string,
    body: RecordingBatchPayload,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<BatchAcknowledgmentResource> {
    const { status, payload } = await client.post(recordingPath(recordingId, "batches"), body, {
      signal,
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    const parsed = replayBatchAcknowledgmentSchema.safeParse(payload);
    if (
      status !== 200 ||
      !parsed.success ||
      parsed.data.recordingId !== recordingId ||
      parsed.data.batchId !== body.batchId ||
      parsed.data.sequence !== body.sequence ||
      // Only an empty final batch may be a metadata-only finalization.
      (parsed.data.delivery === "finalized") !== (body.events.length === 0 && body.final)
    ) {
      throw new EpicIntegrationError("invalid_response", status);
    }
    return parsed.data;
  },
};
