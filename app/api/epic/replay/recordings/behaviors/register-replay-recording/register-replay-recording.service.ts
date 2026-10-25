import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  parseReplayRequest,
  replayRegistrationRequestSchema,
  ReplayUploadError,
  safeReplayPathname,
  type ReplayRecordingCapability,
  type ReplayRegistrationRequest,
} from "@/lib/replay/replay-upload-contract";
import { deriveCaptureContext, type ReplayUserAgent } from "@/lib/replay/server/capture-context";
import { requireReplayRelay, toReplayUploadError } from "@/lib/replay/server/replay-relay";
import type { ReplayActor } from "@/lib/replay/server/replay-subject";
import type { RecordingRegistrationPayload } from "@/shared/integrations/epic/resources";
import { RecordingsResource } from "@/shared/integrations/epic/resources/recordings.resource";
import { ReplayRecordingModel, type ReplayRecordingRecord } from "@/shared/models/replay-recording";

export interface RegisterReplayRecordingCommand {
  actor: ReplayActor | null;
  input: unknown;
  userAgent: ReplayUserAgent;
}

export interface RegistrationResult {
  /** 201 for a new central recording, 200 for an idempotent retry. */
  created: boolean;
  recording: ReplayRecordingCapability;
}

const REGISTER_RATE = { limit: 10, windowMs: 60_000 };

/**
 * Registers one recording with Epic. Ownership is the publishing credential
 * plus the server-derived opaque subject; the browser contributes only its
 * frozen, immutable intent. The first normalized central payload (subject,
 * document release, coarse capture context) is persisted and a retry under
 * the same key resends it verbatim, so later User-Agent or deployment
 * changes never re-derive it.
 */
export class RegisterReplayRecording {
  static async execute({ actor, input, userAgent }: RegisterReplayRecordingCommand): Promise<RegistrationResult> {
    const request = parseReplayRequest(replayRegistrationRequestSchema, input);
    const { client, subject } = requireReplayRelay(actor);

    const rate = await ReplayRecordingModel.consumeRate(subject.subjectId, "register", {
      ...REGISTER_RATE,
      now: Date.now(),
    });
    if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

    const intent = RegisterReplayRecording.normalize(request);
    const registrationHash = createHash("sha256")
      .update(JSON.stringify([subject.subjectId, intent]))
      .digest("base64url");

    // The stored payload wins before anything is derived again.
    let record = await ReplayRecordingModel.findByIdempotencyKey(subject.subjectId, intent.idempotencyKey);
    if (!record) {
      const { viewport, ...registration } = intent;
      const payload: RecordingRegistrationPayload = {
        ...registration,
        subjectId: subject.subjectId,
        captureContext: deriveCaptureContext(userAgent, viewport),
      };
      const now = new Date();
      record = await ReplayRecordingModel.insertRegistering({
        id: randomUUID(),
        subjectId: subject.subjectId,
        idempotencyKey: intent.idempotencyKey,
        registrationHash,
        registrationPayload: JSON.stringify(payload),
        createdAt: now,
        updatedAt: now,
      });
    }
    // A different intent under the key, including a raced insert's winner.
    if (record.registrationHash !== registrationHash) throw new ReplayUploadError("idempotency_conflict");

    let result: Awaited<ReturnType<typeof RecordingsResource.register>>;
    try {
      result = await RecordingsResource.register(client, RegisterReplayRecording.storedPayload(record));
    } catch (error) {
      throw toReplayUploadError(error);
    }

    // Ownership is never reassigned: a conflicting central id is a failure.
    const bound = await ReplayRecordingModel.bindRecordingId(record.id, result.recording.recordingId).catch(() => null);
    if (!bound) throw new ReplayUploadError("unavailable");

    return result;
  }

  // Immutable browser intent, bounded: a safe pathname only, the document's
  // frozen release (never this server's deployment), versions, viewport.
  private static normalize(request: ReplayRegistrationRequest): ReplayRegistrationRequest {
    const route = safeReplayPathname(request.route);
    if (route === null) throw new ReplayUploadError("invalid_request");
    return {
      contractVersion: 1,
      idempotencyKey: request.idempotencyKey.toLowerCase(),
      startedAt: request.startedAt,
      route,
      recorderVersion: request.recorderVersion,
      configVersion: request.configVersion.trim(),
      release: request.release === null ? null : request.release.trim(),
      viewport: request.viewport ? { width: request.viewport.width, height: request.viewport.height } : null,
    };
  }

  private static storedPayload(record: ReplayRecordingRecord): RecordingRegistrationPayload {
    try {
      return JSON.parse(record.registrationPayload) as RecordingRegistrationPayload;
    } catch {
      throw new ReplayUploadError("unavailable");
    }
  }
}
