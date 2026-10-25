import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUser } from "@/lib/auth";
import { clearEpicEnv, jsonResponse, stubEpicEnv } from "@/lib/replay/tests/runtime-config.fixture";
import { POST } from "../../../route";

vi.mock("@/lib/auth", () => ({ getUser: vi.fn() }));

const ORIGIN = "http://localhost:8080";
const SESSION_ID = "0123456789abcdef0123456789abcdef";
const body = JSON.stringify({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "rum.sessionId", value: { stringValue: SESSION_ID } }] },
      scopeLogs: [
        {
          scope: { name: "rum.rr-web" },
          logRecords: [
            {
              timeUnixNano: "1800000000000000000",
              body: { stringValue: '{"type":4,"timestamp":1800000000000,"data":{}}' },
              attributes: [{ key: "rr-web.offset", value: { stringValue: "0" } }],
            },
          ],
        },
      ],
    },
  ],
});

function request(headers: Record<string, string>, payload: BodyInit = body) {
  return new NextRequest(`${ORIGIN}/api/epic/replay/telemetry`, { method: "POST", headers, body: payload });
}

describe("POST /api/epic/replay/telemetry", () => {
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

  it("relays for a signed-in user without cookies, address or the full User-Agent", async () => {
    upstream.mockResolvedValue(jsonResponse({ partialSuccess: {} }));

    const response = await POST(
      request({
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "session=secret",
        Referer: "http://localhost:8080/private",
        "X-Forwarded-For": "203.0.113.9",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partialSuccess: {} });
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://epic.test/api/observability/v1/logs");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-publishing-token");
    for (const header of ["cookie", "origin", "referer", "x-forwarded-for", "user-agent"]) {
      expect(headers.has(header)).toBe(false);
    }
    const sent = String(init?.body);
    for (const secret of ["user-1", "session=secret", "203.0.113.9", "iPhone"]) {
      expect(sent).not.toContain(secret);
    }
  });
});
