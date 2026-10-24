// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("useRefreshReplayPolicy", () => {
  let upstreamPolicy: Record<string, unknown>;
  let sameOrigin: (init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    clearEpicEnv();
    stubEpicEnv();
    upstreamPolicy = runtimeConfigFixture();
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("applies the active policy on initial load", async () => {
    const client = createTestClient();
    const { result } = renderHook(() => useRefreshReplayPolicy(), {
      wrapper: queryWrapper(client),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.policy).toMatchObject({ status: "active", configVersion: "prod-v3" });
    expect(result.current.error).toBeNull();
    expect(client.getQueryData(replayConfigKeys.all)).toMatchObject({ configVersion: "prod-v3" });
    await waitFor(() =>
      expect(replayLifecycle.getSnapshot()).toMatchObject({
        configVersion: "prod-v3",
        capture: { enabled: true },
      }),
    );
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
