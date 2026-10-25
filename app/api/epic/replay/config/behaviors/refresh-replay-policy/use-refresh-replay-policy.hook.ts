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

  // On resume, or when the clocks disagree, withhold capture until a fresh
  // response arrives and ask for one now.
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
        untrusted();
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
    window.addEventListener("focus", untrusted);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("resume", untrusted);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", untrusted);
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
