import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearEpicEnv, jsonResponse, stubEpicEnv } from "@/lib/replay/tests/runtime-config.fixture";
import { deriveReplaySubject } from "@/lib/replay/server/replay-subject";
import { RelayReplayTelemetry } from "../relay-replay-telemetry.service";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const actor = { kind: "user", userId: "user-1" } as const;
const userAgent = {
  browser: { name: "Chrome", version: "120.0.6099.109" },
  os: { name: "Mac OS", version: "14.2.1" },
  device: {},
};

const text = (key: string, value: string) => ({ key, value: { stringValue: value } });

function telemetry(resourceAttributes = [text("rum.sessionId", SESSION_ID)]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: "epic.evidence" },
            logRecords: [
              {
                timeUnixNano: "1800000000000000000",
                body: { stringValue: "TypeError: x is not a function" },
                attributes: [text("epic.event", "browser.error"), text("epic.route", "/"), text("other", "dropped")],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("RelayReplayTelemetry", () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearEpicEnv();
    stubEpicEnv();
    vi.stubGlobal("fetch", upstream);
    upstream.mockImplementation(async () => jsonResponse({ partialSuccess: {} }));
  });

  afterEach(() => {
    upstream.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function relay(input: unknown) {
    await RelayReplayTelemetry.execute({ actor, input, userAgent });
    return JSON.parse(String(upstream.mock.calls[0]![1]?.body));
  }

  it("adds the trusted visitor and capture context, and keeps the session", async () => {
    const sent = await relay(telemetry([text("rum.sessionId", SESSION_ID), text("service.version", "abc123")]));

    const resource = Object.fromEntries(
      sent.resourceLogs[0].resource.attributes.map((a: { key: string; value: { stringValue: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(resource).toEqual({
      "rum.sessionId": SESSION_ID,
      "service.version": "abc123",
      "epic.subject.id": deriveReplaySubject(actor, process.env.BETTER_AUTH_SECRET!),
      "epic.capture.browser": "Chrome/120",
      "epic.capture.os": "macOS/14",
      "epic.capture.device": "desktop",
    });
  });

  it("drops scope attributes the browser sent and keeps only evidence and replay record attributes", async () => {
    const sent = await relay(
      telemetry([
        text("rum.sessionId", SESSION_ID),
        text("epic.project.id", "other-project"),
        text("epic.subject.id", "sub_forged"),
        text("deployment.environment.name", "production"),
        text("service.name", "other-app"),
      ]),
    );

    const keys = sent.resourceLogs[0].resource.attributes.map((a: { key: string }) => a.key);
    expect(keys).not.toContain("epic.project.id");
    expect(keys).not.toContain("deployment.environment.name");
    expect(keys).not.toContain("service.name");
    expect(JSON.stringify(sent)).not.toContain("sub_forged");
    const recordKeys = sent.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a: { key: string }) => a.key);
    expect(recordKeys).toEqual(["epic.event", "epic.route"]);
  });

  it("refuses a session id that is not 32 lowercase hex characters, without relaying", async () => {
    await expect(
      RelayReplayTelemetry.execute({ actor, input: telemetry([text("rum.sessionId", "SESSION")]), userAgent }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_request" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires an identity", async () => {
    await expect(
      RelayReplayTelemetry.execute({ actor: null, input: telemetry(), userAgent }),
    ).rejects.toMatchObject({ code: "identity_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("maps Epic's refusals back with their status and Retry-After", async () => {
    upstream.mockResolvedValueOnce(
      jsonResponse({ contractVersion: 1, error: "x", code: "rate_limited", retryAfterMs: 2_000 }, 429),
    );
    await expect(RelayReplayTelemetry.execute({ actor, input: telemetry(), userAgent })).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      extras: { retryAfterMs: 2_000 },
    });

    upstream.mockResolvedValueOnce(jsonResponse({ contractVersion: 1, error: "x", code: "capture_disabled" }, 403));
    await expect(RelayReplayTelemetry.execute({ actor, input: telemetry(), userAgent })).rejects.toMatchObject({
      code: "capture_disabled",
      status: 403,
    });
  });

  it("derives the ingest address from the API URL unless EPIC_OTLP_ENDPOINT is set", async () => {
    await relay(telemetry());
    expect(upstream.mock.calls[0]![0]).toBe("https://epic.test/api/observability/v1/logs");

    upstream.mockClear();
    vi.stubEnv("EPIC_OTLP_ENDPOINT", "https://otlp.epic.test/ingest/");
    await relay(telemetry());
    expect(upstream.mock.calls[0]![0]).toBe("https://otlp.epic.test/ingest/v1/logs");
  });
});
