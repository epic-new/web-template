import "server-only";

import { replayReportResponseSchema, type ReplayReportResponse } from "@/lib/replay/replay-upload-contract";
import { EpicIntegrationError, type EpicClient } from "../epic";

/** The EPI-211 version 1 report body: the browser's frozen content plus the trusted subject. */
export interface ReportPayload {
  contractVersion: 1;
  idempotencyKey: string;
  subjectId: string;
  description: string;
  expected?: string;
  reportedAt: number;
  route: string;
  release: string | null;
  evidence: { recordingId: string; startedAt: number; offsetMs: number } | null;
}

export const ReportsResource = {
  /** `created` is true for a new report (201), false for a durable retry (200). */
  async submit(
    client: EpicClient,
    payload: ReportPayload,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ created: boolean; report: ReplayReportResponse }> {
    const { status, body } = await client.post("/api/replay/v1/reports", payload, options);
    const parsed = replayReportResponseSchema.safeParse(body);
    if (!parsed.success) throw new EpicIntegrationError("invalid_response", status);
    return { created: status === 201, report: parsed.data };
  },
};
