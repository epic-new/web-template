import { describe, expect, it } from "vitest";

import { buildLogsRequest, encodeEvidence, encodeReplayEvent, splitUtf8, toUnixNano, utf8Length } from "../replay-otlp";

describe("splitUtf8", () => {
  it("returns small text whole", () => {
    expect(splitUtf8("hello", 100)).toEqual(["hello"]);
  });

  it("never cuts a multi-byte character or a surrogate pair", () => {
    const text = "aé€😀".repeat(50);
    for (const max of [4, 5, 7, 16, 33]) {
      const chunks = splitUtf8(text, max);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) {
        expect(utf8Length(chunk)).toBeLessThanOrEqual(max);
        expect(chunk).not.toContain("�");
      }
    }
  });

  it("rejects a chunk size too small to hold one character", () => {
    expect(() => splitUtf8("x".repeat(10), 3)).toThrow(RangeError);
  });
});

describe("encodeReplayEvent", () => {
  it("builds one record per chunk with the ClickStack attributes", () => {
    const event = { type: 3, timestamp: 1_800_000_000_123, data: { text: "é".repeat(100) } };
    const reserve = (records: number) => ({ offset: 10, event: 4, records });
    const encoded = encodeReplayEvent(event, { maxChunkBytes: 80, reserve })!;

    expect(encoded.records.length).toBeGreaterThan(1);
    const attrs = encoded.records.map(({ record }) =>
      Object.fromEntries(record.attributes.map((entry) => [entry.key, entry.value.stringValue])),
    );
    expect(attrs.map((entry) => entry["rr-web.offset"])).toEqual(encoded.records.map((_, index) => String(10 + index)));
    expect(new Set(attrs.map((entry) => entry["rr-web.event"]))).toEqual(new Set(["4"]));
    expect(attrs.at(-1)!["rr-web.chunk"]).toBe(String(encoded.records.length));
    expect(attrs[0]!["rr-web.total-chunks"]).toBe(String(encoded.records.length));
    expect(encoded.records[0]!.scope).toBe("rum.rr-web");
    expect(encoded.records[0]!.record.timeUnixNano).toBe("1800000000123000000");
    expect(encoded.records.map(({ record }) => record.body.stringValue).join("")).toBe(JSON.stringify(event));
  });

  it("encodes nothing when the session is gone", () => {
    expect(encodeReplayEvent({ timestamp: 1 }, { maxChunkBytes: 100, reserve: () => null })).toBeNull();
  });
});

describe("evidence and requests", () => {
  it("bounds the body and groups records by scope under one session resource", () => {
    const evidence = encodeEvidence({
      event: "browser.error",
      at: 5,
      route: "/x",
      body: "e".repeat(2_000),
    });
    expect(evidence.record.body.stringValue).toHaveLength(500);
    expect(evidence.record.severityText).toBe("ERROR");

    const request = buildLogsRequest({
      sessionId: "0123456789abcdef0123456789abcdef",
      release: null,
      records: [evidence, encodeEvidence({ event: "behavior.started", at: 6, route: "/x", body: "b" })],
    });
    expect(request.resourceLogs).toHaveLength(1);
    expect(request.resourceLogs[0]!.resource.attributes).toEqual([
      { key: "rum.sessionId", value: { stringValue: "0123456789abcdef0123456789abcdef" } },
    ]);
    expect(request.resourceLogs[0]!.scopeLogs).toHaveLength(1);
    expect(request.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
  });

  it("converts milliseconds to a nanosecond string", () => {
    expect(toUnixNano(1_800_000_000_000)).toBe("1800000000000000000");
  });
});
