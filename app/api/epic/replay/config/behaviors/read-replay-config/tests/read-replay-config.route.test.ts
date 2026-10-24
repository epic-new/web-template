import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { publicReplayConfigSchema } from "@/lib/replay/replay-config.contract";
import {
  clearEpicEnv,
  jsonResponse,
  RUNTIME_CONFIG_URL,
  runtimeConfigFixture,
  stubEpicEnv,
} from "@/lib/replay/tests/runtime-config.fixture";
import { GET } from "../../../route";

// Next invokes route handlers with the request; ours ignores it on purpose.
const invoke = GET as unknown as (request?: NextRequest) => Promise<Response>;

describe("GET /api/epic/replay/config", () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearEpicEnv();
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    upstream.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the allowlisted public policy", async () => {
    stubEpicEnv();
    upstream.mockResolvedValue(jsonResponse(runtimeConfigFixture()));

    const response = await invoke();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = publicReplayConfigSchema.parse(JSON.parse(text));
    expect(body).toMatchObject({ status: "active", configVersion: "prod-v3" });
    for (const secret of ["test-publishing-token", "rrweb-private-key", "proj-1", "epic.test"]) {
      expect(text).not.toContain(secret);
    }

    const leaky = runtimeConfigFixture();
    (leaky.capture as Record<string, unknown>).privateKey = "rrweb-private-key";
    upstream.mockResolvedValue(jsonResponse(leaky));

    const failed = await invoke();
    const failedText = await failed.text();
    expect(JSON.parse(failedText)).toMatchObject({
      status: "disabled",
      reason: "invalid_policy",
    });
    expect(failedText).not.toContain("rrweb-private-key");
  });

  it("ignores browser-supplied scope", async () => {
    stubEpicEnv();
    vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
    upstream.mockImplementation(async () => jsonResponse(runtimeConfigFixture()));

    const plain = await (await invoke()).json();
    upstream.mockClear();
    const forged = await (
      await invoke(
        new NextRequest(
          "http://localhost/api/epic/replay/config?projectId=other&environment=production&upstream=https://evil.example",
          { headers: { "x-epic-project": "other" } },
        ),
      )
    ).json();
    vi.useRealTimers();

    expect(forged).toEqual(plain);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(RUNTIME_CONFIG_URL);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-publishing-token",
    );
  });

  it("fails closed when the app is not configured", async () => {
    const response = await invoke();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      contractVersion: 1,
      status: "disabled",
      reason: "not_configured",
      environment: "test",
      capture: { enabled: false },
      reporting: { enabled: false },
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "contractVersion",
        "status",
        "reason",
        "configVersion",
        "environment",
        "release",
        "fetchedAt",
        "expiresAt",
        "refreshIntervalMs",
        "capture",
        "reporting",
        "recording",
      ].sort(),
    );
    expect(upstream).not.toHaveBeenCalled();
  });
});
