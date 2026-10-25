import "server-only";

import type { ReplayCaptureContext } from "@/lib/replay/server/capture-context";
import type {
  ReplayBatchAcknowledgment,
  ReplayBatchRequest,
  ReplayRecordingCapability,
  ReplayRegistrationRequest,
} from "@/lib/replay/replay-upload-contract";

/**
 * The EPI-209 (version 1) server-to-server runtime config resource. The
 * publishing credential selects the project, application and environment;
 * this is what the central runtime route returns for it.
 */
export interface RuntimeConfigResource {
  contractVersion: 1;
  projectId: string;
  applicationId: string;
  environment: "production" | "preview" | "development" | "test";
  configVersion: string | null;
  issuedAt: number;
  expiresAt: number;
  refreshIntervalMs: number;
  capture: {
    enabled: boolean;
    sessionSampleRate: number;
    routes: { include: string[]; exclude: string[] };
    privacy: {
      maskAllInputs: boolean;
      maskTextSelector: string | null;
      blockSelector: string | null;
    };
    diagnostics: { console: boolean; network: boolean };
  };
  reporting: { enabled: boolean };
  recording: {
    transport: "epic-http";
    limits: {
      maxBatchBytes: number;
      maxBatchEvents: number;
      maxBufferBytes: number;
      maxBufferAgeMs: number;
      flushIntervalMs: number;
      maxAttempts: number;
    };
  };
}

/**
 * EPI-210 (version 1) recording publishing resources. The publishing
 * credential selects project, application and environment; the application
 * server adds only the trusted opaque `subjectId` (and, at registration, the
 * coarse `captureContext` it derived from its own request).
 */
export type RecordingRegistrationPayload = Omit<ReplayRegistrationRequest, "viewport"> & {
  subjectId: string;
  captureContext: ReplayCaptureContext;
};

export interface RecordingCapabilityPayload {
  contractVersion: 1;
  subjectId: string;
}

export type RecordingBatchPayload = ReplayBatchRequest & { subjectId: string };

/** Registration and renewal share one full shape. */
export type CapabilityResource = ReplayRecordingCapability;

export interface RegistrationResource {
  /** 201 for a new recording, 200 for an idempotent retry of an open one. */
  created: boolean;
  recording: CapabilityResource;
}

export type BatchAcknowledgmentResource = ReplayBatchAcknowledgment;
