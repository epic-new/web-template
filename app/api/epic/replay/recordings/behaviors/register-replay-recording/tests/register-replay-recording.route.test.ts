import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearEpicEnv, jsonResponse, stubEpicEnv } from "@/lib/replay/tests/runtime-config.fixture";
import { getUser } from "@/lib/auth";
import { POST } from "../../../route";

vi.mock("@/lib/auth", () => ({ getUser: vi.fn() }));

const ORIGIN = "http://localhost:8080";
const body = JSON.stringify({
  contractVersion: 1,
  idempotencyKey: "6f1c5a0e-1b0e-4d6f-9a52-2f1b9d9d1c11",
  startedAt: 1_800_000_000_000,
  route: "/",
  recorderVersion: "2.2.0",
  configVersion: "3",
  release: null,
  viewport: null,
});

function request(headers: Record<string, string>, payload: BodyInit = body) {
  return new NextRequest(`${ORIGIN}/api/epic/replay/recordings`, { method: "POST", headers, body: payload });
}

describe("POST /api/epic/replay/recordings", () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearEpicEnv();
    stubEpicEnv();
    vi.stubGlobal("fetch", upstream);
    vi.mocked(getUser).mockResolvedValue({ user: { id: "user-1" } } as Awaited<ReturnType<typeof getUser>>);
  });

  afterEach(() => {
    upstream.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("refuses cross-origin and non-JSON writes before relaying", async () => {
    const crossOrigin = await POST(request({ "Content-Type": "application/json", Origin: "https://evil.example" }));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ contractVersion: 1, code: "cross_origin" });
    expect(crossOrigin.headers.get("Cache-Control")).toBe("no-store");

    const wrongType = await POST(request({ "Content-Type": "text/plain", Origin: ORIGIN }));
    expect(wrongType.status).toBe(415);

    const noOrigin = await POST(request({ "Content-Type": "application/json" }));
    expect(noOrigin.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers identity_required for a signed-out visitor when anonymous capture is off", async () => {
    vi.mocked(getUser).mockResolvedValue({ user: null } as Awaited<ReturnType<typeof getUser>>);
    const response = await POST(request({ "Content-Type": "application/json", Origin: ORIGIN }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "identity_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("registers for a signed-in user without exposing identity or credentials", async () => {
    upstream.mockResolvedValue(
      jsonResponse(
        {
          contractVersion: 1,
          recordingId: "0a1b2c3d-1b0e-4d6f-9a52-2f1b9d9d1c11",
          recordingToken: "eprc_1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          tokenExpiresAt: 1_800_000_900_000,
          startedAt: 1_800_000_000_000,
          availability: "waiting_for_events",
          limits: {
            maxBatchBytes: 1_048_576,
            maxBatchEvents: 500,
            maxBufferBytes: 5_242_880,
            maxBufferAgeMs: 60_000,
            flushIntervalMs: 20_000,
            flushBytes: 65_536,
            maxAttempts: 3,
          },
        },
        201,
      ),
    );

    const response = await POST(
      request({
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "session=secret",
        Referer: "http://localhost:8080/private",
        "X-Forwarded-For": "203.0.113.9",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      }),
    );

    expect(response.status).toBe(201);
    const text = await response.text();
    for (const secret of ["subjectId", "test-publishing-token", "proj-1", "user-1"]) {
      expect(text).not.toContain(secret);
    }
    const headers = new Headers(upstream.mock.calls[0]![1]?.headers);
    for (const header of ["cookie", "origin", "referer", "x-forwarded-for", "user-agent"]) {
      expect(headers.has(header)).toBe(false);
    }
  });
});
