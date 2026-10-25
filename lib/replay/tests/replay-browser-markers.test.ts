// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachReplayBrowserMarkers } from "../replay-browser-markers";
import type { ReplayMarker, ReplayTrackResult } from "../replay-marker.contract";

const emitted = (): ReplayTrackResult => ({ status: "emitted" });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function reject(reason: unknown) {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
  return event;
}
function fail(error: unknown, filename = "/synthetic-script.js") {
  const event = new ErrorEvent("error", { error, filename, message: "synthetic raw error text", cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("root-owned browser markers", () => {
  it("classifies real browser events without raw messages/stacks/rejections or suppressing default handling", () => {
    const markers: ReplayMarker[] = [];
    cleanups.push(attachReplayBrowserMarkers((input) => { markers.push(input as ReplayMarker); return emitted(); }));
    const errorEvent = fail(new TypeError("synthetic-private-error"));
    const rejectionEvent = reject("synthetic-private-rejection");
    expect(markers).toEqual([
      { tag: "epic.browser.error", payload: { version: 1, errorClass: "TypeError", source: "uncaught_error" } },
      { tag: "epic.browser.unhandled_rejection", payload: { version: 1, errorClass: "Error", reasonKind: "primitive" } },
    ]);
    expect(errorEvent.defaultPrevented).toBe(false);
    expect(rejectionEvent.defaultPrevented).toBe(false);
    expect(JSON.stringify(markers)).not.toMatch(/synthetic-private|message|stack/);
  });

  it("contains hostile getters/proxies and excludes resource failures and replay diagnostics", () => {
    const track = vi.fn(emitted);
    cleanups.push(attachReplayBrowserMarkers(track));
    const hostileError = new Error("synthetic-private");
    Object.defineProperty(hostileError, "name", { get() { throw new Error("private"); } });
    Object.defineProperty(hostileError, "stack", { get() { throw new Error("private"); } });
    reject(hostileError);
    reject(new Proxy({}, { getPrototypeOf() { throw new Error("private"); } }));
    window.dispatchEvent(new Event("error"));
    fail(new Error("synthetic-replay-failure"), "/api/epic/replay/config?token=synthetic-private");
    const inaccessible = new Event("unhandledrejection");
    Object.defineProperty(inaccessible, "reason", { get() { throw new Error("private"); } });
    expect(() => window.dispatchEvent(inaccessible)).not.toThrow();
    expect(track.mock.calls).toEqual([
      [{ tag: "epic.browser.unhandled_rejection", payload: { version: 1, errorClass: "Error", reasonKind: "error" } }],
      [{ tag: "epic.browser.unhandled_rejection", payload: { version: 1, errorClass: "Error", reasonKind: "unknown" } }],
    ]);
  });

  it("deduplicates one event/error identity briefly without collapsing distinct errors by class", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const track = vi.fn(emitted);
    cleanups.push(attachReplayBrowserMarkers(track));
    const reason = new Error("synthetic-private");
    const first = fail(reason);
    window.dispatchEvent(first);
    fail(reason);
    fail(new Error("another failure of the same class"));
    expect(track).toHaveBeenCalledTimes(2);
    now.mockReturnValue(11_001);
    fail(reason);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it("contains recursive/throwing tracking and detaches idempotently before remount", () => {
    const track = vi.fn((): ReplayTrackResult => {
      fail(new Error("synthetic-telemetry-failure"));
      throw new Error("synthetic-telemetry-failure");
    });
    const detach = attachReplayBrowserMarkers(track);
    cleanups.push(detach);
    expect(() => fail(new Error("synthetic-private"))).not.toThrow();
    expect(track).toHaveBeenCalledTimes(1);
    detach(); detach();
    // Keep an ordinary host listener so Vitest does not treat this deliberately
    // dispatched, observer-free ErrorEvent as a runner-level uncaught failure.
    const hostErrorListener = () => {};
    window.addEventListener("error", hostErrorListener);
    fail(new Error("synthetic-disposed"));
    window.removeEventListener("error", hostErrorListener);
    expect(track).toHaveBeenCalledTimes(1);
    const next = vi.fn(emitted);
    cleanups.push(attachReplayBrowserMarkers(next));
    reject({ arbitrary: "synthetic-private" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith({ tag: "epic.browser.unhandled_rejection", payload: { version: 1, errorClass: "Error", reasonKind: "object" } });
  });
});
