"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { disabledReplayConfig } from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import {
  chooseReplayConsent,
  followReplayConsentWithdrawals,
  readReplayConsentChoice,
} from "@/lib/replay/replay-consent-choice";

const serverPolicy = disabledReplayConfig({ reason: "unavailable", environment: null, release: null, now: 0 });

const COPY = {
  body: "This app records how its pages are used, with anything you type hidden, to help fix problems faster.",
  allow: "Allow",
  decline: "No thanks",
};

/**
 * The template's default consent prompt for session replay: shown only while
 * capture is enabled and no choice exists, remembered per browser, and
 * re-granted on load from that choice. Consent stays explicit — replay never
 * starts from the policy alone. Where the policy's consent mode is
 * `not_required` nothing is asked and recording is implied, but a remembered
 * opt-out is still applied. A host with its own consent banner replaces this
 * with calls to `epicReplayConsent.grant()` / `.withdraw()`.
 */
export function ReplayConsentBanner() {
  const consent = useSyncExternalStore(
    epicReplayConsent.subscribe,
    epicReplayConsent.getSnapshot,
    () => "unknown" as const,
  );

  const policy = useSyncExternalStore(replayLifecycle.subscribe, replayLifecycle.getSnapshot, () => serverPolicy);

  useEffect(() => {
    const stored = readReplayConsentChoice();
    if (stored) chooseReplayConsent(stored);
    return followReplayConsentWithdrawals();
  }, []);

  if (consent !== "unknown" || policy.capture.consentMode === "not_required") return null;

  return (
    <div
      data-private
      role="region"
      aria-label="Session recording consent"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg sm:flex-row sm:items-center"
    >
      <p className="flex-1 text-muted-foreground">{COPY.body}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => chooseReplayConsent("withdrawn")}>
          {COPY.decline}
        </Button>
        <Button size="sm" onClick={() => chooseReplayConsent("granted")}>
          {COPY.allow}
        </Button>
      </div>
    </div>
  );
}
