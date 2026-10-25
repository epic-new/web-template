"use client";

import type { ReactNode } from "react";
import type { ReplayLifecycleOptions } from "@/lib/replay/replay-runtime-policy";
import { EpicReplayContext } from "@/shared/hooks/use-epic-replay.hook";
import { useInitializeEpicReplay } from "@/shared/hooks/use-initialize-epic-replay.hook";

/** Renders immediately. Neither the manager nor rrweb is imported on the server. */
export function EpicReplayProvider({ children, documentRelease, lifecycle }: {
  children: ReactNode;
  documentRelease: string | null;
  lifecycle?: Partial<ReplayLifecycleOptions>;
}) {
  const runtime = useInitializeEpicReplay({ documentRelease, lifecycle });
  return <EpicReplayContext.Provider value={runtime}>{children}</EpicReplayContext.Provider>;
}
