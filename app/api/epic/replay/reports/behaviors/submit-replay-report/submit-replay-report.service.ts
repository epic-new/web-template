import "server-only";

import {
  replayReportRequestSchema,
  type ReplayReportResponse,
} from "@/lib/replay/replay-upload-contract";
import { relayFailure } from "@/lib/replay/server/relay-failure";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { deriveReplaySubject, type ReplayActor } from "@/lib/replay/server/replay-subject";
import { EpicClient } from "@/shared/integrations/epic/epic";
import {
  ReportsResource,
  type ReportPayload,
} from "@/shared/integrations/epic/resources/reports.resource";
import { ReplayRecordingModel, type ReplayRecordingRecord } from "@/shared/models/replay-recording";
import { ReplayRecordingPolicy } from "@/shared/policies/replay-recording.policy";

const REPORT_RATE = { limit: 10, windowMs: 60_000 };

export interface SubmitReplayReportCommand {
  actor: ReplayActor | null;
  input: unknown;
}

export interface ReportSubmission {
  /** True for a new report (201), false for a durable retry (200). */
  created: boolean;
  report: ReplayReportResponse;
}

/**
 * Relays a frozen bug report to Epic for the current trusted subject. The
 * browser's key, moment, route, release and evidence reference are forwarded
 * as frozen; only the subject is added. Nothing is acknowledged unless Epic
 * says it was stored, and a retry with the same key reaches Epic's own
 * idempotency, even after reporting has been switched off.
 */
export class SubmitReplayReport {
  static async execute(command: SubmitReplayReportCommand): Promise<ReportSubmission> {
    try {
      const input = replayReportRequestSchema.parse(command.input);
      if (!command.actor) throw new ReplayUploadError("identity_required");

      const client = EpicClient.fromEnv();
      const secret = process.env.BETTER_AUTH_SECRET;
      if (!client || !secret) throw new ReplayUploadError("not_configured");

      const subjectId = deriveReplaySubject(command.actor, secret);
      if (input.evidence) {
        const record = await ReplayRecordingModel.findByRecordingId(input.evidence.recordingId);
        this.authorize({ subjectId }, record, input.evidence.startedAt);
      }

      const rate = await ReplayRecordingModel.consumeRate(subjectId, "report", {
        ...REPORT_RATE,
        now: Date.now(),
      });
      if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });

      const payload: ReportPayload = {
        contractVersion: 1,
        idempotencyKey: input.idempotencyKey,
        subjectId,
        description: input.description,
        ...(input.expected ? { expected: input.expected } : {}),
        reportedAt: input.reportedAt,
        route: input.route,
        release: input.release,
        evidence: input.evidence,
      };
      return await ReportsResource.submit(client, payload);
    } catch (error) {
      throw relayFailure(error);
    }
  }

  // A recording this server never registered for the subject, or whose frozen
  // start differs, is not evidence; it answers like any invalid reference.
  private static authorize(
    actor: { subjectId: string },
    record: ReplayRecordingRecord | null,
    startedAt: number,
  ): void {
    const frozenStart = (record?.registrationPayload as { startedAt?: unknown } | undefined)?.startedAt;
    if (!ReplayRecordingPolicy.canAttach(actor, record) || frozenStart !== startedAt) {
      throw new ReplayUploadError("invalid_evidence");
    }
  }
}
