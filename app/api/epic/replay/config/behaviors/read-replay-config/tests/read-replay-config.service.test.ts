import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearEpicEnv,
  jsonResponse,
  PREVIEW_TOKEN,
  PRODUCTION_TOKEN,
  runtimeConfigFixture,
  stubEpicEnv,
} from "@/lib/replay/tests/runtime-config.fixture";
import { ReadReplayConfig } from "../read-replay-config.service";

const NOW = 1_800_000_000_000;

// Upstream fixtures keyed by the Authorization credential, the way the
// central route binds scope.
const bindings: Record<string, Record<string, unknown>> = {
  [PRODUCTION_TOKEN]: { environment: "production", configVersion: "prod-v3" },
  [PREVIEW_TOKEN]: { environment: "preview", configVersion: "preview-v7" },
};

describe("ReadReplayConfig", () => {
  const upstream = vi.fn<typeof fetch>();
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    clearEpicEnv();
    vi.stubGlobal("fetch", upstream);
    upstream.mockImplementation(async (_url, init) => {
      const token = new Headers(init?.headers).get("Authorization")!.replace("Bearer ", "");
      return jsonResponse(runtimeConfigFixture(bindings[token]));
    });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    upstream.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("gives production and preview each their own versioned policy", async () => {
    stubEpicEnv(PRODUCTION_TOKEN, "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const production = await ReadReplayConfig.execute();
    expect(production).toMatchObject({
      status: "active",
      environment: "production",
      configVersion: "prod-v3",
      release: "abc123",
      fetchedAt: NOW,
    });

    stubEpicEnv(PREVIEW_TOKEN, "preview");
    const preview = await ReadReplayConfig.execute();
    expect(preview).toMatchObject({ environment: "preview", configVersion: "preview-v7" });

    stubEpicEnv(PRODUCTION_TOKEN, "preview");
    expect(await ReadReplayConfig.execute()).toMatchObject({
      status: "disabled",
      reason: "invalid_policy",
    });

    for (const result of [production, preview]) {
      const text = JSON.stringify(result);
      for (const secret of ["test-publishing-token", "proj-1", "epic.test", "app-1"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("keeps capture and reporting independent", async () => {
    stubEpicEnv();
    bindings[PRODUCTION_TOKEN].capture = {
      ...runtimeConfigFixture().capture,
      enabled: false,
    };
    const result = await ReadReplayConfig.execute();
    delete bindings[PRODUCTION_TOKEN].capture;

    expect(result).toMatchObject({
      status: "active",
      capture: { enabled: false },
      reporting: { enabled: true },
    });
  });

  it("fails closed without calling upstream when not configured", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const result = await ReadReplayConfig.execute();

    expect(result).toMatchObject({
      status: "disabled",
      reason: "not_configured",
      environment: "test",
      capture: { enabled: false },
      reporting: { enabled: false },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed with a diagnosable reason", async () => {
    stubEpicEnv(PRODUCTION_TOKEN, "preview");
    const fixture = (overrides: Record<string, unknown>) => async () =>
      jsonResponse(runtimeConfigFixture({ environment: "preview", ...overrides }));
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => new Response(null, { status: 401 }), "unauthorized"],
      [async () => new Response(null, { status: 503 }), "upstream_unavailable"],
      [async () => { throw new DOMException("timed out", "TimeoutError"); }, "upstream_unavailable"],
      [fixture({ contractVersion: 2 }), "invalid_policy"],
      [fixture({ projectId: "other" }), "invalid_policy"],
      [fixture({ environment: "production" }), "invalid_policy"],
      [
        fixture({ capture: { ...runtimeConfigFixture().capture, sessionSampleRate: 1.5 } }),
        "invalid_policy",
      ],
      [fixture({ expiresAt: NOW - 1 }), "expired"],
      [
        fixture({ capture: { ...runtimeConfigFixture().capture, publicKey: "rrweb-private-key" } }),
        "invalid_policy",
      ],
    ];

    for (const [respond, reason] of cases) {
      upstream.mockImplementationOnce(respond);
      const result = await ReadReplayConfig.execute();
      expect(result).toMatchObject({ status: "disabled", reason, capture: { enabled: false } });
      expect(JSON.stringify(result)).not.toContain("rrweb-private-key");
    }

    expect(JSON.stringify(warn.mock.calls)).not.toContain("test-publishing-token");
  });

  it("bounds the refresh interval and lifetime", async () => {
    stubEpicEnv();
    upstream.mockResolvedValueOnce(
      jsonResponse(runtimeConfigFixture({ refreshIntervalMs: 1_000, expiresAt: NOW + 86_400_000 })),
    );
    expect(await ReadReplayConfig.execute()).toMatchObject({
      refreshIntervalMs: 10_000,
      expiresAt: NOW + 300_000,
    });

    upstream.mockResolvedValueOnce(
      jsonResponse(runtimeConfigFixture({ refreshIntervalMs: 3_600_000 })),
    );
    expect(await ReadReplayConfig.execute()).toMatchObject({ refreshIntervalMs: 60_000 });
  });

  it("lets EPIC_ENVIRONMENT override VERCEL_ENV", async () => {
    stubEpicEnv(PREVIEW_TOKEN, "production");
    vi.stubEnv("EPIC_ENVIRONMENT", "preview");
    expect(await ReadReplayConfig.execute()).toMatchObject({ environment: "preview" });
    expect(upstream.mock.calls[0][0]).not.toContain("environment");

    stubEpicEnv(PRODUCTION_TOKEN, "production");
    vi.stubEnv("EPIC_ENVIRONMENT", "preview");
    expect(await ReadReplayConfig.execute()).toMatchObject({ reason: "invalid_policy" });
  });
});
