"use client";

import { useMutation } from "@tanstack/react-query";

import type { ReplayReportRequest } from "@/lib/replay/replay-upload-contract";
import { ReplayReportError, submitReplayReport } from "./submit-replay-report.mutation";

export function useSubmitReplayReport() {
  const mutation = useMutation({
    mutationFn: (request: ReplayReportRequest) => submitReplayReport(request),
    // A failure is shown to the reporter, never retried behind their back.
    retry: false,
  });

  return {
    submit: (request: ReplayReportRequest) => mutation.mutate(request),
    isSending: mutation.isPending,
    acknowledgment: mutation.data ?? null,
    errorCode:
      mutation.error instanceof ReplayReportError ? mutation.error.code : mutation.error ? "unavailable" : null,
    reset: mutation.reset,
  };
}
