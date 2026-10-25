// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import {
  resetPreviewReplayCapture,
  usePreviewReplayCapture,
  useReplayHarnessSource,
} from "../use-preview-replay-capture.hook";

function useHarness() {
  return { ...usePreviewReplayCapture(), ...useReplayHarnessSource() };
}

describe("usePreviewReplayCapture", () => {
  // The session loads the recorder on its first permitted start; transforming
  // it the first time is slower than a waitFor, so it is loaded up front.
  beforeAll(async () => {
    await import("@rrweb/record");
  }, 60_000);

  beforeEach(() => {
    window.history.replaceState({}, "", "/styleguide/replay");
    window.sessionStorage.clear();
    document.body.innerHTML = '<p data-mask>Synthetic SSN 000-12-3456</p>';
  });

  afterEach(() => {
    // Unmount before resetting, so the unmount's deferred dispose cannot land in the next test.
    cleanup();
    resetPreviewReplayCapture();
    epicReplayConsent.reset();
    replayLifecycle.reset();
  });

  it("keeps capture off under the application policy, even with consent", () => {
    const { result } = renderHook(() => useHarness());

    act(() => epicReplayConsent.grant());

    expect(result.current).toMatchObject({ status: "blocked", reason: "policy_disabled", eventCount: 0 });
    expect(result.current.bufferJson).toBe("[]");
  });

  it("blocks a synthetic policy until consent, then captures a first boundary", async () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setSource("synthetic-sampled"));
    expect(result.current).toMatchObject({ status: "blocked", reason: "consent_absent", eventCount: 0 });

    act(() => epicReplayConsent.grant());

    // The recorder is loaded on the first permitted start.
    await waitFor(() => expect(result.current.status).toBe("capturing"));
    expect(result.current).toMatchObject({ status: "capturing", reason: null, boundary: 1, source: "synthetic-sampled" });
    expect(result.current.eventCount).toBeGreaterThanOrEqual(2);
    expect(result.current.events.slice(0, 2).map((entry) => entry.event.type)).toEqual([4, 2]);
    expect(result.current.bufferJson).not.toContain("Synthetic SSN 000-12-3456");
  });

  it("stays not sampled for an unsampled policy across re-grants", () => {
    const { result } = renderHook(() => useHarness());

    act(() => {
      result.current.setSource("synthetic-unsampled");
      epicReplayConsent.grant();
    });
    act(() => {
      epicReplayConsent.withdraw();
      epicReplayConsent.grant();
    });

    expect(result.current).toMatchObject({ status: "blocked", reason: "not_sampled", eventCount: 0 });
  });

  it("clears the buffer on withdrawal", async () => {
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.setSource("synthetic-sampled");
      epicReplayConsent.grant();
    });
    await waitFor(() => expect(result.current.eventCount).toBeGreaterThan(0));

    act(() => epicReplayConsent.withdraw());

    expect(result.current).toMatchObject({ status: "blocked", reason: "consent_withdrawn", eventCount: 0 });
  });
});
