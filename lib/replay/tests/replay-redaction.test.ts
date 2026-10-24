import { describe, expect, it } from "vitest";

import {
  isCredentialParam,
  jsonByteLength,
  REDACTED,
  REPLAY_PAYLOAD_LIMITS,
  sanitizeCssText,
  sanitizeNetworkDiagnostic,
  sanitizeReplayError,
  sanitizeReplayPayload,
  sanitizeUrl,
} from "../replay-redaction";

describe("sanitizeUrl", () => {
  it("redacts the Epic preview token and fragment credentials", () => {
    expect(
      sanitizeUrl("https://3000-abc.proxy.epic.new/a?_proxy_token=synthetic&x=1#access_token=synthetic2"),
    ).toBe("https://3000-abc.proxy.epic.new/a?_proxy_token=%5Bredacted%5D&x=1#access_token=%5Bredacted%5D");
  });

  it("removes userinfo and keeps relative URLs relative", () => {
    expect(sanitizeUrl("https://u:p@example.test/x")).toBe("https://example.test/x");
    expect(sanitizeUrl("//u@example.test/x?ok=1")).toBe("//example.test/x?ok=1");
    expect(sanitizeUrl("/cb?code=synthetic&state=s")).toBe("/cb?code=%5Bredacted%5D&state=%5Bredacted%5D");
    expect(sanitizeUrl("cb?myToken=synthetic")).toBe("cb?myToken=%5Bredacted%5D");
  });

  it("leaves plain URLs and anchors alone", () => {
    expect(sanitizeUrl("/settings?tab=profile#section")).toBe("/settings?tab=profile#section");
  });

  it.each(["token", "API_KEY", "x-amz-signature", "client_secret", "resetPasswordCode", "sessionToken"])(
    "treats %s as a credential",
    (name) => expect(isCredentialParam(name)).toBe(true),
  );
});

describe("sanitizeReplayPayload", () => {
  it("redacts sensitive keys and bounds strings and arrays", () => {
    const result = sanitizeReplayPayload({
      password: "p",
      nested: { apiKey: "k" },
      note: "a".repeat(5000),
      list: Array(100).fill(1),
    }) as { password: string; nested: { apiKey: string }; note: string; list: number[] };

    expect(result.password).toBe(REDACTED);
    expect(result.nested.apiKey).toBe(REDACTED);
    expect(result.note.length).toBeLessThanOrEqual(1_024 + "…[truncated]".length);
    expect(result.list).toHaveLength(50);
  });

  it("sanitizes URLs inside strings, handles cycles, and drops functions", () => {
    const value: Record<string, unknown> = {
      href: "https://example.test/?access_token=synthetic-access-token",
      fn: () => 1,
    };
    value.self = value;

    const result = sanitizeReplayPayload(value);

    expect(JSON.stringify(result)).not.toContain("synthetic-access-token");
    expect(result).toEqual({
      href: "https://example.test/?access_token=%5Bredacted%5D",
      self: "[circular]",
    });
  });

  it("collapses an oversized payload", () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "x".repeat(1_000)]));
    expect(sanitizeReplayPayload(big)).toEqual({ truncated: true });
  });
});

describe("sanitizeReplayError", () => {
  it("redacts URLs in message and stack", () => {
    const error = new Error("Failed GET /api/x?token=synthetic-token");
    error.stack = "Error: at https://example.test/app.js?sig=synthetic-sig:1:2";

    const result = sanitizeReplayError(error);

    expect(JSON.stringify(result)).not.toMatch(/synthetic-(token|sig)/);
    expect(result.name).toBe("Error");
  });
});

describe("sanitizeNetworkDiagnostic", () => {
  it("never diagnoses the replay endpoints", () => {
    expect(sanitizeNetworkDiagnostic({ method: "GET", url: "/api/epic/replay/config", status: 200, durationMs: 5 })).toBeNull();
    expect(
      sanitizeNetworkDiagnostic({ method: "post", url: "https://app.test/api/epic/replay", status: 202, durationMs: 1 }),
    ).toBeNull();
  });

  it("keeps only method, sanitized URL, status and duration", () => {
    expect(
      sanitizeNetworkDiagnostic({ method: "get", url: "/api/items?token=synthetic", status: 200, durationMs: 12.6 }),
    ).toEqual({ method: "GET", url: "/api/items?token=%5Bredacted%5D", status: 200, durationMs: 13 });
  });
});

describe("sanitizeCssText", () => {
  it("redacts credentials in url(), @import and relative pairs and keeps the rule", () => {
    expect(sanitizeCssText(".a{background:url(\"/bg.png?token=synthetic-a\")}")).toBe(
      ".a{background:url(\"/bg.png?token=%5Bredacted%5D\")}",
    );
    expect(sanitizeCssText("@import 'x.css?key=synthetic-b';")).toBe("@import 'x.css?key=%5Bredacted%5D';");
    expect(sanitizeCssText("background: url(//cdn.test/a.png?sig=synthetic-c) no-repeat")).toBe(
      "background: url(//cdn.test/a.png?sig=%5Bredacted%5D) no-repeat",
    );
    expect(sanitizeCssText(".plain { color: red; }")).toBe(".plain { color: red; }");
  });
});

describe("UTF-8 payload bound", () => {
  it("measures encoded bytes, not characters", () => {
    expect(jsonByteLength("é")).toBe(4);
    expect(jsonByteLength("😀")).toBe(6);
  });

  it("truncates a payload whose characters fit but whose bytes do not", () => {
    // Every item is under the string limit, and the JSON is under the byte
    // cap in characters but over it in UTF-8 bytes.
    const item = "😀".repeat(150);
    const payload = Array.from({ length: 50 }, () => item);
    expect(JSON.stringify(payload).length).toBeLessThan(REPLAY_PAYLOAD_LIMITS.maxPayloadBytes);
    expect(sanitizeReplayPayload(payload)).toEqual({ truncated: true });
    expect(sanitizeReplayPayload(["é".repeat(100)])).toEqual(["é".repeat(100)]);
  });
});
