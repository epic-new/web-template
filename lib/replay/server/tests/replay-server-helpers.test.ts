import { describe, expect, it } from "vitest";
import { NextRequest, userAgent } from "next/server";

import { ReplayUploadError } from "@/lib/replay/replay-upload-contract";
import { deriveCaptureContext } from "../capture-context";
import { assertSameOrigin, readJsonBody } from "../replay-request";
import { deriveReplaySubject } from "../replay-subject";
import { mintReplayVisitor, readReplayVisitorId } from "../replay-visitor-cookie";

const SECRET = "test-secret-key-for-testing-only-32-chars-min";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function uaOf(value: string) {
  return userAgent({ headers: new Headers({ "user-agent": value }) });
}

async function errorCode(run: () => unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof ReplayUploadError ? error.code : "unexpected";
  }
}

describe("deriveReplaySubject", () => {
  it("is stable for one identity and independent of the publishing token", () => {
    const first = deriveReplaySubject({ kind: "user", userId: "user-1" }, SECRET);
    process.env.EPIC_PUBLISHING_TOKEN = "rotated-token";
    expect(deriveReplaySubject({ kind: "user", userId: "user-1" }, SECRET)).toEqual(first);
    delete process.env.EPIC_PUBLISHING_TOKEN;

    expect(first.subjectId).toMatch(/^sub_[A-Za-z0-9_-]{43}$/);
    expect(first.subjectId).not.toContain("user-1");
    expect(deriveReplaySubject({ kind: "user", userId: "user-2" }, SECRET)).not.toEqual(first);
    expect(deriveReplaySubject({ kind: "anonymous", visitorId: "user-1" }, SECRET)).not.toEqual(first);
  });
});

describe("replay visitor cookie", () => {
  it("verifies its own signature and rejects tampering", () => {
    const { visitorId, setCookie } = mintReplayVisitor(SECRET, false);
    const value = setCookie.split(";")[0]!.split("=")[1]!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/api/epic/replay");
    expect(readReplayVisitorId(value, SECRET)).toBe(visitorId);
    expect(readReplayVisitorId(`${visitorId}.forged`, SECRET)).toBeNull();
    expect(readReplayVisitorId(value, "another-secret")).toBeNull();
    expect(readReplayVisitorId(undefined, SECRET)).toBeNull();
  });
});

describe("deriveCaptureContext", () => {
  it("maps a mobile Safari request to coarse mobile context", () => {
    expect(deriveCaptureContext(uaOf(IPHONE_SAFARI), { width: 390, height: 844 })).toEqual({
      browser: { name: "Safari", majorVersion: "17" },
      os: { name: "iOS", majorVersion: "17" },
      deviceClass: "mobile",
      viewport: { width: 390, height: 844 },
    });
  });

  it("maps desktop Chrome, garbage versions and unknown agents", () => {
    expect(deriveCaptureContext(uaOf(DESKTOP_CHROME), null)).toMatchObject({
      browser: { name: "Chrome", majorVersion: "129" },
      os: { name: "macOS" },
      deviceClass: "desktop",
      viewport: null,
    });
    expect(
      deriveCaptureContext(
        { ua: "x", browser: { name: "Firefox", version: "12345.1" }, os: { name: "Plan 9" }, device: {} },
        null,
      ),
    ).toMatchObject({ browser: { name: "Firefox", majorVersion: null }, os: { name: "Other" } });
    expect(deriveCaptureContext(uaOf(""), null)).toEqual({
      browser: { name: "Unknown", majorVersion: null },
      os: { name: "Unknown", majorVersion: null },
      deviceClass: "unknown",
      viewport: null,
    });
  });
});

describe("replay request protections", () => {
  const url = "http://localhost:8080/api/epic/replay/recordings";

  it("accepts only same-origin writes", async () => {
    const make = (headers: Record<string, string>) => new NextRequest(url, { method: "POST", headers });
    expect(await errorCode(() => assertSameOrigin(make({ origin: "http://localhost:8080" })))).toBeNull();
    expect(await errorCode(() => assertSameOrigin(make({ origin: "https://evil.example" })))).toBe("cross_origin");
    expect(await errorCode(() => assertSameOrigin(make({})))).toBe("cross_origin");
    expect(
      await errorCode(() =>
        assertSameOrigin(make({ origin: "http://localhost:8080", "sec-fetch-site": "cross-site" })),
      ),
    ).toBe("cross_origin");
  });

  it("enforces streamed bytes and JSON content", async () => {
    const big = JSON.stringify({ padding: "x".repeat(4_096) });
    const lying = new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect(await errorCode(() => readJsonBody(lying, 1_024))).toBe("payload_too_large");

    const text = new NextRequest(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(await errorCode(() => readJsonBody(text, 1_024))).toBe("unsupported_media_type");

    const ok = new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await readJsonBody(ok, 1_024)).toEqual({ a: 1 });
  });
});
