// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { replayDocumentOwners } from "@/lib/replay/replay-document-owner";
import { beginReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import {
  resetPreviewReplayCapture,
  usePreviewReplayCapture,
  useReplayHarnessSource,
} from "../use-preview-replay-capture.hook";

function useHarness() {
  return { ...usePreviewReplayCapture(), ...useReplayHarnessSource() };
}

async function acknowledge() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("usePreviewReplayCapture", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/styleguide/replay");
    window.sessionStorage.clear();
    document.body.innerHTML = '<p data-mask>Synthetic SSN 000-12-3456</p>';
  });

  afterEach(() => {
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
    await acknowledge();

    act(() => result.current.setSource("synthetic-sampled"));
    expect(result.current).toMatchObject({ status: "blocked", reason: "consent_absent", eventCount: 0 });

    act(() => epicReplayConsent.grant());
    await acknowledge();

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
    await acknowledge();
    act(() => {
      result.current.setSource("synthetic-sampled");
      epicReplayConsent.grant();
    });
    await acknowledge();
    expect(result.current.eventCount).toBeGreaterThan(0);

    act(() => epicReplayConsent.withdraw());

    expect(result.current).toMatchObject({ status: "blocked", reason: "consent_withdrawn", eventCount: 0 });
  });

  it("displaces the root before memory-only capture and stops when another harness owns the document", async () => {
    const owners = replayDocumentOwners();
    const stopRoot = vi.fn();
    const rootRelease = owners.acquire("root", stopRoot);
    const { result } = renderHook(() => useHarness());
    expect(stopRoot).toHaveBeenCalledTimes(1);
    await acknowledge();
    act(() => { result.current.setSource("synthetic-sampled"); epicReplayConsent.grant(); });
    await acknowledge();
    expect(result.current.status).toBe("capturing");
    let replacement: (() => void) | null = null;
    act(() => { replacement = owners.acquire("harness", () => {}); });
    expect(result.current.status).toBe("blocked");
    expect(result.current.eventCount).toBe(0);
    act(() => replacement?.());
    rootRelease?.();
  });

  it("discards memory-only capture synchronously during auth and reacknowledges after settlement", async () => {
    const { result } = renderHook(() => useHarness());
    act(() => { result.current.setSource("synthetic-sampled"); epicReplayConsent.grant(); });
    await acknowledge();
    expect(result.current.status).toBe("capturing");
    const before = result.current.boundary;
    let finish = () => {};
    act(() => { finish = beginReplayIdentityBoundary(); });
    expect(result.current.status).toBe("blocked");
    expect(result.current.eventCount).toBe(0);
    await acknowledge();
    expect(result.current.eventCount).toBe(0);
    act(() => finish());
    await acknowledge();
    expect(result.current.status).toBe("capturing");
    expect(result.current.boundary).toBeGreaterThan(before);
    expect(result.current.events[0]?.boundary).toBe(result.current.boundary);
  });
});
