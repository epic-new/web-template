import "server-only";

import type { OtlpLogsRequest } from "@/lib/replay/replay-otlp";
import type { EpicClient } from "../epic";

export const TelemetryResource = {
  /**
   * Sends one OTLP/JSON logs request to Epic's ingest. Success is Epic's 200
   * `{"partialSuccess":{}}`; a refusal throws the typed publishing error.
   */
  async sendLogs(
    client: EpicClient,
    request: OtlpLogsRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    await client.postOtlp("logs", request, options);
  },
};
