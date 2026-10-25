import "server-only";

import { ZodError } from "zod";

import { EpicPublishingError } from "@/shared/integrations/epic/epic";
import { ReplayUploadError } from "./replay-upload-error";

/**
 * Maps whatever a relay step threw to the typed error the route returns.
 * Epic's refusals keep their exact status, code and typed fields; every other
 * failure is a generic `unavailable` so no raw exception, body or header
 * escapes to the browser.
 */
export function relayFailure(error: unknown): ReplayUploadError {
  if (error instanceof ReplayUploadError) return error;
  if (error instanceof EpicPublishingError) {
    return new ReplayUploadError(error.code, {
      status: error.status,
      expectedSequence: error.expectedSequence,
      retryAfterMs: error.retryAfterMs,
    });
  }
  if (error instanceof ZodError) return new ReplayUploadError("invalid_request", { status: 400 });
  return new ReplayUploadError("unavailable");
}
