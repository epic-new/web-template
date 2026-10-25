// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReplayTracing, newTraceparent, traceIdOf } from "../replay-tracing";

describe("replay tracing", () => {
  let pageFetch: ReturnType<typeof vi.fn>;
  let enabled: boolean;

  const headersOf = (call: number) => new Headers(pageFetch.mock.calls[call]![1]?.headers);

  beforeEach(() => {
    enabled = true;
    pageFetch = vi.fn(async () => new Response("ok"));
    window.fetch = pageFetch as unknown as typeof window.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a W3C traceparent with random ids and the sampled flag", () => {
    const { header, traceId } = newTraceparent();
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceIdOf(header)).toBe(traceId);
    expect(traceIdOf("nonsense")).toBeNull();
    expect(newTraceparent().traceId).not.toBe(traceId);
  });

  it("adds the header to same-origin requests and remembers the latest trace id", async () => {
    const tracing = createReplayTracing({ isEnabled: () => enabled });
    tracing.start();

    await window.fetch("/api/orders?q=1", { method: "POST", body: "x" });
    const first = tracing.getLastTraceId();
    await window.fetch(`${window.location.origin}/api/other`);

    expect(headersOf(0).get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceIdOf(headersOf(0).get("traceparent"))).toBe(first);
    expect(pageFetch.mock.calls[0]![1]?.method).toBe("POST");
    expect(pageFetch.mock.calls[0]![1]?.body).toBe("x");
    expect(tracing.getLastTraceId()).not.toBe(first);
    tracing.stop();
  });

  it("never touches cross-origin requests or the relay routes", async () => {
    const tracing = createReplayTracing({ isEnabled: () => enabled });
    tracing.start();

    await window.fetch("https://third-party.example/api");
    await window.fetch("/api/epic/replay/telemetry", { method: "POST" });
    await window.fetch("/api/epic/replay/reports", { method: "POST" });

    for (const call of [0, 1, 2]) expect(headersOf(call).has("traceparent")).toBe(false);
    expect(tracing.getLastTraceId()).toBeNull();
    tracing.stop();
  });

  it("keeps a traceparent the page already sent and adopts its trace id", async () => {
    const tracing = createReplayTracing({ isEnabled: () => enabled });
    tracing.start();
    const own = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;

    await window.fetch("/api/orders", { headers: { traceparent: own } });

    expect(headersOf(0).get("traceparent")).toBe(own);
    expect(tracing.getLastTraceId()).toBe("c".repeat(32));
    tracing.stop();
  });

  it("adds nothing while disabled, and restores fetch on stop", async () => {
    const tracing = createReplayTracing({ isEnabled: () => enabled });
    tracing.start();
    enabled = false;
    await window.fetch("/api/orders");
    expect(headersOf(0).has("traceparent")).toBe(false);

    tracing.stop();
    expect(window.fetch).toBe(pageFetch);
  });

  it("sets the header on same-origin XHR and leaves cross-origin XHR alone", () => {
    const proto = XMLHttpRequest.prototype;
    const setHeader = vi.spyOn(proto, "setRequestHeader").mockImplementation(() => undefined);
    vi.spyOn(proto, "send").mockImplementation(() => undefined);
    const tracing = createReplayTracing({ isEnabled: () => enabled });
    tracing.start();

    const same = new XMLHttpRequest();
    same.open("GET", "/api/orders");
    same.send();
    const cross = new XMLHttpRequest();
    cross.open("GET", "https://third-party.example/x");
    cross.send();

    const traced = setHeader.mock.calls.filter(([name]) => name.toLowerCase() === "traceparent");
    expect(traced).toHaveLength(1);
    expect(traceIdOf(traced[0]![1])).toBe(tracing.traceIdOfXhr(same));
    expect(tracing.traceIdOfXhr(cross)).toBeNull();
    tracing.stop();
  });
});
