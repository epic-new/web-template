import "server-only";

import {
  replayBatchResponseSchema,
  replayRecordingResponseSchema,
  type ReplayBatchResponse,
  type ReplayRecordingResponse,
} from "@/lib/replay/replay-upload-contract";
import type { ReplayCaptureContext } from "@/lib/replay/server/capture-context";
import { EpicIntegrationError, type EpicClient } from "../epic";

/**
 * The frozen registration Epic receives (EPI-210): the browser's immutable
 * intent plus the trusted subject and server-derived coarse context.
 */
export interface RegistrationPayload {
  contractVersion: 1;
  idempotencyKey: string;
  subjectId: string;
  startedAt: number;
  route: string;
  release: string | null;
  recorderVersion: string;
  configVersion: string;
  captureContext: ReplayCaptureContext;
}

export interface BatchPayload {
  contractVersion: 1;
  subjectId: string;
  recordingToken: string;
  batchId: string;
  sequence: number;
  events: unknown[];
  final: boolean;
}

const RECORDINGS_PATH = "/api/replay/v1/recordings";

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, status: number): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EpicIntegrationError("invalid_response", status);
  return parsed.data;
}

export const RecordingsResource = {
  /** `created` is true for a new recording (201), false for an idempotent retry (200). */
  async register(
    client: EpicClient,
    payload: RegistrationPayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ created: boolean; recording: ReplayRecordingResponse }> {
    const { status, body } = await client.post(RECORDINGS_PATH, payload, options);
    return {
      created: status === 201,
      recording: parse(replayRecordingResponseSchema, body, status),
    };
  },

  async renewCapability(
    client: EpicClient,
    recordingId: string,
    { subjectId }: { subjectId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ReplayRecordingResponse> {
    const { status, body } = await client.post(
      `${RECORDINGS_PATH}/${encodeURIComponent(recordingId)}/capability`,
      { contractVersion: 1, subjectId },
      options,
    );
    return parse(replayRecordingResponseSchema, body, status);
  },

  async appendBatch(
    client: EpicClient,
    recordingId: string,
    payload: BatchPayload,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ReplayBatchResponse> {
    const { status, body } = await client.post(
      `${RECORDINGS_PATH}/${encodeURIComponent(recordingId)}/batches`,
      payload,
      options,
    );
    return parse(replayBatchResponseSchema, body, status);
  },
};
