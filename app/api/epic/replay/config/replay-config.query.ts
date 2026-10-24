import { queryOptions } from "@tanstack/react-query";
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  publicReplayConfigSchema,
  type PublicReplayConfig,
} from "@/lib/replay/replay-config.contract";

// No actor identity: the policy is application-scoped public configuration,
// and the server binds its scope itself.
export const replayConfigKeys = {
  all: ["replay-config"] as const,
};

export function replayConfigQuery() {
  return queryOptions({
    queryKey: replayConfigKeys.all,
    queryFn: async ({ signal }): Promise<PublicReplayConfig> => {
      const response = await fetch("/api/epic/replay/config", {
        signal,
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Replay config request failed (${response.status})`);
      }
      return publicReplayConfigSchema.parse(await response.json());
    },
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000),
  });
}
