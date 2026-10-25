import "server-only";

import {
  REPLAY_UPLOAD_CONTRACT_VERSION,
  REPLAY_UPLOAD_ERROR_MESSAGES,
  REPLAY_UPLOAD_ERROR_STATUS,
  type ReplayUploadErrorBody,
  type ReplayUploadErrorCode,
} from "../replay-upload-contract";

/**
 * A typed failure of the replay relay. Services throw it, routes turn it into
 * the flat envelope; the message is fixed text and never parsed by clients.
 */
export class ReplayUploadError extends Error {
  readonly status: number;

  constructor(
    readonly code: ReplayUploadErrorCode,
    readonly extras: { status?: number; expectedSequence?: number; retryAfterMs?: number } = {},
  ) {
    super(REPLAY_UPLOAD_ERROR_MESSAGES[code]);
    this.name = "ReplayUploadError";
    this.status = extras.status ?? REPLAY_UPLOAD_ERROR_STATUS[code];
  }

  toBody(): ReplayUploadErrorBody {
    return {
      contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION,
      error: this.message,
      code: this.code,
      ...(this.extras.expectedSequence !== undefined
        ? { expectedSequence: this.extras.expectedSequence }
        : {}),
      ...(this.extras.retryAfterMs !== undefined ? { retryAfterMs: this.extras.retryAfterMs } : {}),
    };
  }
}
