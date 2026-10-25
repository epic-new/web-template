// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_TAG,
  createReplayDiagnostics,
  diagnosticPath,
  NETWORK_TAG,
  REPLAY_DIAGNOSTIC_LIMITS,
  type ReplayDiagnosticsSettings,
} from "../replay-diagnostics";

type Recorded = { tag: string; payload: Record<string, unknown> };

describe("replay diagnostics", () => {
  let recorded: Recorded[];
  let settings: ReplayDiagnosticsSettings;
  let pageWarn: ReturnType<typeof vi.fn>;
  let pageFetch: ReturnType<typeof vi.fn>;

  const create = (clock?: () => number) =>
    createReplayDiagnostics(
      (tag, payload) => {
        recorded.push({ tag, payload: payload as Record<string, unknown> });
        return true;
      },
      () => settings,
      clock,
    );

  beforeEach(() => {
    recorded = [];
    settings = { console: false, network: false };
    pageWarn = vi.fn();
    pageFetch = vi.fn(async () => new Response("ok", { status: 201 }));
    console.warn = pageWarn as unknown as typeof console.warn;
    window.fetch = pageFetch as unknown as typeof window.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs nothing while both streams are off", async () => {
    const diagnostics = create();
    diagnostics.start();

    console.warn("hello");
    await window.fetch("/api/orders");

    expect(console.warn).toBe(pageWarn);
    expect(window.fetch).toBe(pageFetch);
    expect(recorded).toEqual([]);
  });

  it("records only the stream that is on, and the page's call still happens", async () => {
    settings = { console: true, network: false };
    const diagnostics = create();
    diagnostics.start();

    console.warn("low stock", { sku: "A1" });
    const response = await window.fetch("/api/orders");

    expect(pageWarn).toHaveBeenCalledWith("low stock", { sku: "A1" });
    expect(response.status).toBe(201);
    expect(recorded).toEqual([{ tag: CONSOLE_TAG, payload: { level: "warn", message: 'low stock {"sku":"A1"}' } }]);
  });

  it("records method, path, status and duration — never the query, Epic's own replay routes or the framework's traffic", async () => {
    settings = { console: false, network: true };
    const diagnostics = create();
    diagnostics.start();

    await window.fetch("/api/orders?token=secret#frag", { method: "post" });
    await window.fetch("/api/epic/replay/recordings/abc/batches", { method: "POST" });
    await window.fetch("/__nextjs_original-stack-frames", { method: "POST" });
    await window.fetch("/_next/static/chunks/app.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ tag: NETWORK_TAG, payload: { method: "POST", url: "/api/orders", status: 201 } });
    expect(JSON.stringify(recorded)).not.toContain("secret");
  });

  it("bounds a burst of events per stream", () => {
    settings = { console: true, network: false };
    let at = 0;
    const diagnostics = create(() => at);
    diagnostics.start();

    for (let i = 0; i < 50; i++) console.warn(`burst ${i}`);
    expect(recorded).toHaveLength(REPLAY_DIAGNOSTIC_LIMITS.burst);

    at += REPLAY_DIAGNOSTIC_LIMITS.windowMs;
    console.warn("after the window");
    expect(recorded).toHaveLength(REPLAY_DIAGNOSTIC_LIMITS.burst + 1);
  });

  it("removes a stream switched off and restores everything on stop", () => {
    settings = { console: true, network: true };
    const diagnostics = create();
    diagnostics.start();
    expect(console.warn).not.toBe(pageWarn);
    expect(window.fetch).not.toBe(pageFetch);

    settings = { console: false, network: true };
    diagnostics.sync();
    expect(console.warn).toBe(pageWarn);
    expect(window.fetch).not.toBe(pageFetch);

    diagnostics.stop();
    expect(window.fetch).toBe(pageFetch);
  });

  it("keeps only the path for this site and drops non-http URLs", () => {
    expect(diagnosticPath(`${window.location.origin}/a/b?x=1`)).toBe("/a/b");
    expect(diagnosticPath("https://api.example.com/v1/items?key=1")).toBe("https://api.example.com/v1/items");
    expect(diagnosticPath("data:text/plain,hi")).toBeNull();
  });
});
