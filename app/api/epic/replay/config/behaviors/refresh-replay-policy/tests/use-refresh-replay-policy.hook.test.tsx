// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicReplayConfig } from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import {
  clearEpicEnv,
  jsonResponse,
  runtimeConfigFixture,
  stubEpicEnv,
} from "@/lib/replay/tests/runtime-config.fixture";
import { createTestClient, queryWrapper } from "@/shared/tests/test-utils";
import { GET } from "../../../route";
import { replayConfigKeys } from "../../../replay-config.query";
import { useRefreshReplayPolicy } from "../use-refresh-replay-policy.hook";

const NOW = 1_800_000_000_000;

// Lets the real Route, the query and React settle. Fake timers run a
// zero-delay timeout after 1 ms, as Node does, so each pass moves the clock by
// that much; `setImmediate` stays real so response bodies get their turn.
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await settle();
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useRefreshReplayPolicy", () => {
  let upstreamPolicy: Record<string, unknown>;
  let sameOrigin: (init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    clearEpicEnv();
    stubEpicEnv();
    sameOrigin = () => GET();
    // Transport only: same-origin requests reach the real Route, upstream
    // requests are answered from the mutable fixture.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://epic.test/")) return jsonResponse(upstreamPolicy);
        return sameOrigin(init);
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    replayLifecycle.reset();
    setVisibility("visible");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "Date",
          "performance",
        ],
        now: NOW,
      });
      upstreamPolicy = runtimeConfigFixture();
    });

    async function renderLoaded() {
      const client = createTestClient();
      const hook = renderHook(() => useRefreshReplayPolicy(), {
        wrapper: queryWrapper(client),
      });
      await settle();
      return { client, ...hook };
    }

    it("applies the active policy on initial load", async () => {
      expect(replayLifecycle.getSnapshot()).toMatchObject({
        status: "disabled",
        reason: "unavailable",
      });

      const { client, result } = await renderLoaded();

      expect(result.current.policy).toMatchObject({ status: "active", configVersion: "prod-v3" });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(client.getQueryData(replayConfigKeys.all)).toMatchObject({
        configVersion: "prod-v3",
      });
      expect(replayLifecycle.getSnapshot()).toMatchObject({
        configVersion: "prod-v3",
        capture: { enabled: true },
      });
    });

    it("propagates a central disable within one refresh interval", async () => {
      const { result } = await renderLoaded();
      const listener = vi.fn();
      replayLifecycle.subscribe(listener);

      upstreamPolicy = runtimeConfigFixture({
        configVersion: "prod-v4",
        capture: { ...runtimeConfigFixture().capture, enabled: false },
        reporting: { enabled: true },
      });
      await advance(30_000);

      expect(result.current.policy.configVersion).toBe("prod-v4");
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          configVersion: "prod-v4",
          capture: expect.objectContaining({ enabled: false }),
          reporting: { enabled: true },
        }),
      );
    });

    it("keeps the last policy until it expires, then fails closed", async () => {
      const { result } = await renderLoaded();
      sameOrigin = async () => {
        throw new TypeError("offline");
      };

      await advance(299_000);
      expect(result.current.policy.status).toBe("active");

      await advance(1_000);
      expect(result.current.policy).toMatchObject({ status: "disabled", reason: "expired" });
      expect(replayLifecycle.getSnapshot().capture.enabled).toBe(false);
      expect(result.current.error).not.toBeNull();
    });

    it("is already disabled when timers were suspended past the deadline", async () => {
      const { client, unmount } = await renderLoaded();
      const stale = client.getQueryData<PublicReplayConfig>(replayConfigKeys.all)!;
      sameOrigin = async () => {
        throw new TypeError("offline");
      };

      // The monotonic clock moves on, but no scheduled callback runs.
      const realNow = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(realNow + 300_000);
      expect(replayLifecycle.getSnapshot()).toMatchObject({
        status: "disabled",
        reason: "expired",
      });

      // Reapplying the same stale resource, directly or from the cache on a
      // fresh mount, never extends its authoritative expiry.
      replayLifecycle.apply(stale);
      unmount();
      const { result } = renderHook(() => useRefreshReplayPolicy(), {
        wrapper: queryWrapper(client),
      });
      setVisibility("hidden");
      setVisibility("visible");
      expect(replayLifecycle.getSnapshot().reason).toBe("expired");
      expect(result.current.policy).toMatchObject({
        status: "disabled",
        capture: { enabled: false },
      });
    });

    it("holds capture on resume until a fresh policy arrives", async () => {
      let release!: () => void;
      const { result } = await renderLoaded();

      sameOrigin = () =>
        new Promise((resolve) => {
          release = () => resolve(GET());
        });
      setVisibility("hidden");
      setVisibility("visible");
      await settle();

      expect(replayLifecycle.getSnapshot()).toMatchObject({
        status: "disabled",
        reason: "unavailable",
      });
      expect(result.current.policy.capture.enabled).toBe(false);

      release();
      await settle();
      expect(result.current.policy).toMatchObject({ status: "active", configVersion: "prod-v3" });
    });

    it("never extends the lifetime when the client clock is behind the server", async () => {
      // The server's clock is an hour ahead of the browser's.
      sameOrigin = async () => {
        const body = await (await GET()).json();
        return jsonResponse({
          ...body,
          fetchedAt: body.fetchedAt + 3_600_000,
          expiresAt: body.expiresAt + 3_600_000,
        });
      };
      const { result } = await renderLoaded();
      expect(result.current.policy.status).toBe("active");

      sameOrigin = async () => {
        throw new TypeError("offline");
      };
      await advance(300_000);

      expect(result.current.policy).toMatchObject({ status: "disabled", reason: "expired" });
    });

    it("gates capture after a backward wall-clock jump", async () => {
      const { result } = await renderLoaded();
      sameOrigin = async () => {
        throw new TypeError("offline");
      };

      vi.setSystemTime(Date.now() - 3_600_000);
      await advance(1_000);

      expect(result.current.policy.capture.enabled).toBe(false);
      await advance(300_000);
      expect(result.current.policy).toMatchObject({ status: "disabled", reason: "expired" });
    });
  });

  it("aborts the in-flight request on unmount", async () => {
    let signal: AbortSignal | undefined;
    sameOrigin = (init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    };
    const client = createTestClient();
    const { unmount } = renderHook(() => useRefreshReplayPolicy(), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(signal).toBeDefined());

    unmount();
    client.clear();

    expect(signal!.aborted).toBe(true);
    expect(replayLifecycle.getSnapshot().reason).toBe("unavailable");
  });
});
