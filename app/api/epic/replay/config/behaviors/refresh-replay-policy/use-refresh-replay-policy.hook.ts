"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  disabledReplayConfig,
  type PublicReplayConfig,
} from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { replayConfigQuery } from "../../replay-config.query";

function effectivePolicy(
  data: PublicReplayConfig | undefined,
  now: number,
): PublicReplayConfig {
  if (!data) {
    return disabledReplayConfig({
      reason: "unavailable",
      environment: "development",
      release: null,
      now,
    });
  }
  if (data.status === "active" && data.expiresAt <= now) {
    return disabledReplayConfig({
      reason: "expired",
      environment: data.environment,
      release: data.release,
      now: data.expiresAt,
    });
  }
  return data;
}

export function useRefreshReplayPolicy() {
  const query = useQuery(replayConfigQuery());
  // Bumped when the current policy's expiry passes, so a run of failed
  // refreshes still re-evaluates and fails closed.
  const [now, setNow] = useState(() => Date.now());
  const data = query.data;
  const policy = effectivePolicy(data, now);

  useEffect(() => {
    if (!data || data.status !== "active") return;
    const delay = Math.max(data.expiresAt - Date.now(), 0);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (data) replayLifecycle.apply(policy);
  }, [data, policy]);

  return {
    policy,
    isLoading: query.isPending,
    error: query.error ? query.error.message : null,
  };
}
