"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { epicReplayConsent, type ReplayConsentState } from "@/lib/replay/replay-consent";

/**
 * Wires a consent UI to `epicReplayConsent` — the reference for how a host
 * application connects its own consent and disclosure policy.
 *
 * Withdrawal stops capture and clears local recording data; it does not, and
 * must not claim to, delete anything already uploaded.
 */

export const REPLAY_WITHDRAWN_NOTICE = "Capture stopped. Local recording data on this device was cleared.";

export function useManageReplayConsent() {
  const consent = useSyncExternalStore<ReplayConsentState>(
    epicReplayConsent.subscribe,
    epicReplayConsent.getSnapshot,
    () => "unknown",
  );
  const [notice, setNotice] = useState<string | null>(null);

  const grant = useCallback(() => {
    epicReplayConsent.grant();
    setNotice(null);
  }, []);

  const withdraw = useCallback(() => {
    epicReplayConsent.withdraw();
    setNotice(REPLAY_WITHDRAWN_NOTICE);
  }, []);

  return { consent, grant, withdraw, notice };
}
