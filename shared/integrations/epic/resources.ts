import "server-only";

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
