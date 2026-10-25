import { epicReplayConsent } from "@/lib/replay/replay-consent";

const STORAGE_KEY = "epic-replay-consent";

export type ReplayConsentChoice = "granted" | "withdrawn";

/** The visitor's remembered choice in this browser, or null when none was made or storage is blocked. */
export function readReplayConsentChoice(): ReplayConsentChoice | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "granted" || value === "withdrawn" ? value : null;
  } catch {
    return null;
  }
}

/** Applies a choice now and remembers it for the next visit. */
export function chooseReplayConsent(choice: ReplayConsentChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
  if (choice === "granted") epicReplayConsent.grant();
  else epicReplayConsent.withdraw();
}

/**
 * Follows a withdrawal made in another tab of this browser, so declining in
 * one tab stops every tab. Only a withdrawal is applied: a grant needs this
 * tab's own prompt or its own load.
 */
export function followReplayConsentWithdrawals(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue === "withdrawn") epicReplayConsent.withdraw();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
