import { afterEach, describe, expect, it } from "vitest";

import { epicReplayConsent } from "../replay-consent";

describe("epicReplayConsent", () => {
  afterEach(() => epicReplayConsent.reset());

  it("starts with no consent", () => {
    expect(epicReplayConsent.getSnapshot()).toBe("unknown");
  });

  it("notifies a withdrawal before withdraw() returns", () => {
    epicReplayConsent.grant();
    const heard: string[] = [];
    epicReplayConsent.subscribe((state) => heard.push(state));

    epicReplayConsent.withdraw();

    expect(heard).toEqual(["withdrawn"]);
    expect(epicReplayConsent.getSnapshot()).toBe("withdrawn");
  });

  it("does not notify when nothing changed", () => {
    epicReplayConsent.grant();
    const heard: string[] = [];
    epicReplayConsent.subscribe((state) => heard.push(state));

    epicReplayConsent.grant();

    expect(heard).toEqual([]);
  });
});
