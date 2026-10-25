import { vi } from "vitest";
import { userAgent } from "next/server";

import { clearEpicEnv, EPIC_API_URL, PREVIEW_TOKEN, PRODUCTION_TOKEN, stubEpicEnv } from "./runtime-config.fixture";
import { createSyntheticCentralFetch, createSyntheticEpi210 } from "./synthetic-epi210.core";

/**
 * Server-side test wiring for the replay relay: the synthetic EPI-210
 * fixture behind a stubbed global `fetch`, accepting both synthetic
 * publishing tokens so rotation can be exercised.
 */

export const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
export const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export function uaOf(value: string) {
  return userAgent({ headers: new Headers({ "user-agent": value }) });
}

export function setupSyntheticCentral({ configured = true }: { configured?: boolean } = {}) {
  clearEpicEnv();
  if (configured) stubEpicEnv();
  const fixture = createSyntheticEpi210();
  const central = createSyntheticCentralFetch(fixture, {
    apiUrl: EPIC_API_URL,
    tokens: [PRODUCTION_TOKEN, PREVIEW_TOKEN],
  });
  const fetchSpy = vi.fn(central.fetch);
  vi.stubGlobal("fetch", fetchSpy);
  return { fixture, central, fetchSpy };
}

export function registrationBody(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    idempotencyKey: crypto.randomUUID(),
    startedAt: 1_800_000_000_000,
    route: "/styleguide/replay/upload",
    recorderVersion: "2.2.0",
    configVersion: "3",
    release: "build-a",
    viewport: { width: 390, height: 844 },
    ...overrides,
  };
}

export function batchBody(recordingToken: string, sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    recordingToken,
    batchId: crypto.randomUUID(),
    sequence,
    events: [{ type: 3, timestamp: 1_800_000_000_100 + sequence, data: { source: 2, type: 2, id: 1 } }],
    final: false,
    ...overrides,
  };
}
