import { afterEach, describe, expect, it, vi } from "vitest";

import { epicReplayConsent } from "../replay-consent";
import { chooseReplayConsent, followReplayConsentWithdrawals, readReplayConsentChoice } from "../replay-consent-choice";

function stubStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  epicReplayConsent.reset();
});

describe("replay consent choice", () => {
  it("applies a choice at once and remembers it for the next visit", () => {
    stubStorage();
    expect(readReplayConsentChoice()).toBeNull();

    chooseReplayConsent("granted");
    expect(epicReplayConsent.getSnapshot()).toBe("granted");
    expect(readReplayConsentChoice()).toBe("granted");

    chooseReplayConsent("withdrawn");
    expect(epicReplayConsent.getSnapshot()).toBe("withdrawn");
    expect(readReplayConsentChoice()).toBe("withdrawn");
  });

  it("still applies the choice when storage is blocked", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });

    chooseReplayConsent("granted");
    expect(epicReplayConsent.getSnapshot()).toBe("granted");
    expect(readReplayConsentChoice()).toBeNull();
  });

  it("stops this tab when another tab of the browser withdraws", () => {
    let listener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (_: string, fn: typeof listener) => (listener = fn),
      removeEventListener: () => (listener = undefined),
    });
    epicReplayConsent.grant();
    const stop = followReplayConsentWithdrawals();

    listener!({ key: "epic-replay-consent", newValue: "granted" } as StorageEvent);
    expect(epicReplayConsent.getSnapshot()).toBe("granted");

    listener!({ key: "epic-replay-consent", newValue: "withdrawn" } as StorageEvent);
    expect(epicReplayConsent.getSnapshot()).toBe("withdrawn");
    stop();
  });
});
