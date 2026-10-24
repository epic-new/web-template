import { vi } from "vitest";

/**
 * Synthetic EPI-209 conformance fixtures. Never real credentials: the
 * sentinels below must never appear in anything the browser receives.
 */

export const EPIC_API_URL = "https://epic.test";
export const RUNTIME_CONFIG_URL = `${EPIC_API_URL}/api/replay/v1/runtime-config`;
export const PRODUCTION_TOKEN = "test-publishing-token";
export const PREVIEW_TOKEN = "test-publishing-token-preview";

export function runtimeConfigFixture(overrides: Record<string, unknown> = {}) {
  const issuedAt = Date.now();
  return {
    contractVersion: 1,
    projectId: "proj-1",
    applicationId: "app-1",
    environment: "production",
    configVersion: "prod-v3",
    issuedAt,
    expiresAt: issuedAt + 300_000,
    refreshIntervalMs: 30_000,
    capture: {
      enabled: true,
      sessionSampleRate: 0.5,
      routes: { include: ["/"], exclude: ["/admin"] },
      privacy: {
        maskAllInputs: true,
        maskTextSelector: "[data-mask]",
        blockSelector: "[data-private]",
      },
      diagnostics: { console: true, network: false },
    },
    reporting: { enabled: true },
    recording: {
      transport: "epic-http",
      limits: {
        maxBatchBytes: 1_048_576,
        maxBatchEvents: 500,
        maxBufferBytes: 5_242_880,
        maxBufferAgeMs: 30_000,
        flushIntervalMs: 5_000,
        maxAttempts: 3,
      },
    },
    ...overrides,
  };
}

export function stubEpicEnv(token = PRODUCTION_TOKEN, environment = "production") {
  vi.stubEnv("EPIC_API_URL", EPIC_API_URL);
  vi.stubEnv("EPIC_PROJECT_ID", "proj-1");
  vi.stubEnv("EPIC_PUBLISHING_TOKEN", token);
  vi.stubEnv("EPIC_ENVIRONMENT", "");
  vi.stubEnv("VERCEL_ENV", environment);
}

export function clearEpicEnv() {
  for (const name of [
    "EPIC_API_URL",
    "EPIC_PROJECT_ID",
    "EPIC_PUBLISHING_TOKEN",
    "EPIC_ENVIRONMENT",
    "EPIC_RELEASE",
    "VERCEL_ENV",
    "VERCEL_GIT_COMMIT_SHA",
  ]) {
    vi.stubEnv(name, "");
  }
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
