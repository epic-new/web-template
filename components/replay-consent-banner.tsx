"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { epicReplayConsent } from "@/lib/replay/replay-consent";

const COPY = {
  body: "This app records how pages are used, with text and inputs masked, to help fix problems faster.",
  allow: "Allow",
  decline: "No thanks",
};

const STORAGE_KEY = "epic-replay-consent";

function readStoredChoice(): "granted" | "withdrawn" | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "granted" || value === "withdrawn" ? value : null;
  } catch {
    return null;
  }
}

function storeChoice(choice: "granted" | "withdrawn") {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

/**
 * The template's default consent prompt for session replay: shown only while
 * capture is enabled and no choice exists, remembered per browser, and
 * re-granted on load from that choice. Consent stays explicit — replay never
 * starts from the policy alone. A host with its own consent banner replaces
 * this with calls to `epicReplayConsent.grant()` / `.withdraw()`.
 */
export function ReplayConsentBanner() {
  const consent = useSyncExternalStore(
    epicReplayConsent.subscribe,
    epicReplayConsent.getSnapshot,
    () => "unknown" as const,
  );

  useEffect(() => {
    const stored = readStoredChoice();
    if (stored === "granted") epicReplayConsent.grant();
    if (stored === "withdrawn") epicReplayConsent.withdraw();
  }, []);

  if (consent !== "unknown") return null;

  const choose = (choice: "granted" | "withdrawn") => {
    storeChoice(choice);
    if (choice === "granted") epicReplayConsent.grant();
    else epicReplayConsent.withdraw();
  };

  return (
    <div
      data-private
      role="region"
      aria-label="Session recording consent"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg sm:flex-row sm:items-center"
    >
      <p className="flex-1 text-muted-foreground">{COPY.body}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => choose("withdrawn")}>
          {COPY.decline}
        </Button>
        <Button size="sm" onClick={() => choose("granted")}>
          {COPY.allow}
        </Button>
      </div>
    </div>
  );
}
