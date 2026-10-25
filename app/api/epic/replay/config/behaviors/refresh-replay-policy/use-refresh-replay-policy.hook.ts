"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  disabledReplayConfig,
  type PublicReplayConfig,
} from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { replayConfigQuery, replayConfigReceipt } from "../../replay-config.query";

// A wall-clock step this far from monotonic progress means the page was
// suspended or the clock moved, so elapsed time can no longer be trusted.
const HEARTBEAT_MS = 1_000;
const CLOCK_DRIFT_TOLERANCE_MS = 5_000;

const serverSnapshot: PublicReplayConfig = disabledReplayConfig({
  reason: "unavailable",
  environment: null,
  release: null,
  now: 0,
});

export function useRefreshReplayPolicy() {
  const query = useQuery(replayConfigQuery());
  const { data, refetch } = query;

  // Bind each response to the lifecycle with the receipt taken when it
  // arrived; cached data reapplied later keeps that original receipt.
  useEffect(() => {
    if (!data) return;
    const receivedAt = replayConfigReceipt(data);
    if (receivedAt !== undefined) replayLifecycle.apply(data, { receivedAt });
  }, [data]);

  // When the page was frozen (resume, back/forward cache) or the clocks
  // disagree, elapsed time cannot be trusted: withhold capture until a fresh
  // response arrives. Returning to a tab that was merely hidden suspends
  // nothing, so it only asks for a fresh policy: gating there ended the
  // recording and opened a new one on every tab switch, a session cut in
  // pieces and each piece billed. An expired policy still stops capture.
  useEffect(() => {
    const untrusted = () => {
      replayLifecycle.gate();
      void refetch({ cancelRefetch: false });
    };

    let wasHidden = document.visibilityState === "hidden";
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        void refetch({ cancelRefetch: false });
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) untrusted();
    };

    let lastWall = Date.now();
    let lastMonotonic = performance.now();
    const heartbeat = setInterval(() => {
      const wall = Date.now();
      const monotonic = performance.now();
      const drift = wall - lastWall - (monotonic - lastMonotonic);
      lastWall = wall;
      lastMonotonic = monotonic;
      if (Math.abs(drift) > CLOCK_DRIFT_TOLERANCE_MS) untrusted();
    }, HEARTBEAT_MS);

    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("resume", untrusted);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("resume", untrusted);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refetch]);

  const policy = useSyncExternalStore(
    replayLifecycle.subscribe,
    replayLifecycle.getSnapshot,
    () => serverSnapshot,
  );

  return {
    policy,
    isLoading: query.isPending,
    error: query.error ? query.error.message : null,
  };
}
