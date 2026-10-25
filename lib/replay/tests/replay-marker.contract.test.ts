import { describe, expect, it } from "vitest";
import fixture from "./fixtures/epic-markers.v1.json";
import { parseReplayMarker, REPLAY_MARKER_MAX_BYTES, sanitizeMarkerRoute } from "../replay-marker.contract";
import { jsonByteLength } from "../replay-redaction";

describe("Replay marker v1 contract", () => {
  it("round-trips every synthetic supported marker without replacing its original clock", () => {
    expect(fixture.events).toHaveLength(7);
    for (const event of fixture.events) {
      expect(parseReplayMarker(event.data)).toEqual({ success: true, marker: event.data });
      expect(jsonByteLength(event.data)).toBeLessThanOrEqual(REPLAY_MARKER_MAX_BYTES);
      expect(Number.isSafeInteger(event.timestamp - fixture.startedAt)).toBe(true);
    }
  });

  it("projects safe fields without touching secrets, cycles, getters or caller timestamp overrides", () => {
    const payload: Record<string, unknown> = { version: 1, behaviorId: "replay.example", reportText: "synthetic-private", timestamp: 1 };
    payload.self = payload;
    Object.defineProperty(payload, "secret", { get() { throw new Error("must not inspect unknown metadata"); } });
    expect(parseReplayMarker({ tag: "epic.behavior.started", payload, release: "override" })).toEqual({
      success: true, marker: { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "replay.example" } },
    });
  });

  it("rejects invalid contracts and identity values without throwing or truncating", () => {
    const candidates: unknown[] = [null, [], {}, { tag: "custom", payload: { version: 1 } },
      { tag: "epic.behavior.started", payload: { version: 2 } },
      { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "x".repeat(129) } },
      { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "é".repeat(128) } },
      { tag: "epic.behavior.started", payload: { version: 1, occurrenceId: "not-a-uuid" } },
      { tag: "epic.bug.reported", payload: { version: 1 } },
      { tag: "epic.screen.viewed", payload: { version: 1 } },
      { tag: "epic.browser.error", payload: { version: 1, errorClass: "secret-error", source: "uncaught_error" } },
      { tag: "epic.browser.unhandled_rejection", payload: { version: 1, errorClass: "Error", reasonKind: "synthetic-secret" } },
      { tag: "epic.behavior.started", payload: Object.defineProperty({ version: 1 }, "behaviorId", { get() { throw new Error("private"); } }) },
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private"); } }),
    ];
    for (const input of candidates) expect(parseReplayMarker(input)).toEqual({ success: false });
  });

  it("maps known static/template routes and strips all query, hash and dynamic input", () => {
    expect(sanitizeMarkerRoute("/styleguide/replay/upload?token=synthetic-secret#synthetic-private")).toBe("/styleguide/replay/upload");
    expect(sanitizeMarkerRoute("/admin/database/synthetic-private-table")).toBe("/admin/database/:tableName");
    expect(sanitizeMarkerRoute("/styleguide/components/button")).toBe("/styleguide/components/button");
    for (const input of ["/users/private@example.com", "//user:password@host/path", "/styleguide/components/private", "/x/" + "é".repeat(2_049)]) {
      expect(sanitizeMarkerRoute(input)).toBe("/[redacted]");
    }
    expect(parseReplayMarker({ tag: "epic.screen.viewed", payload: { version: 1, route: "/users/synthetic-private" } }))
      .toEqual({ success: true, marker: { tag: "epic.screen.viewed", payload: { version: 1, route: "/[redacted]" } } });
  });
});
