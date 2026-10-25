import { describe, expect, it } from "vitest";
import { createReplayDocumentOwners } from "../replay-document-owner";
import { createReplayRecoveryBudget, publicDocumentRelease, replayContextFingerprint, replayLifecycleOptions } from "../replay-runtime-policy";
import { activeReplayPolicy } from "./replay-policy.fixture";

describe("root lifecycle policy", () => {
  it("bounds configurable pilot defaults and keeps release separate from refreshed policy", () => {
    const options = replayLifecycleOptions({ maxDurationMs: Infinity, inactivityMs: -1, handoffWindowMs: 100_000 });
    expect(options).toEqual({ maxDurationMs: 1_800_000, inactivityMs: 300_000, handoffWindowMs: 15_000 });
    expect(publicDocumentRelease("build-A")).toBe("build-A");
    expect(publicDocumentRelease("not a release")).toBeNull();
    const policy = activeReplayPolicy();
    expect(replayContextFingerprint(policy, options)).toBe(replayContextFingerprint({ ...policy, release: "build-B", fetchedAt: 123, expiresAt: 456 }, options));
    expect(replayContextFingerprint(policy, options)).not.toBe(replayContextFingerprint({ ...policy, environment: "production" }, options));
  });

  it("does not replenish rotations after each successful opening snapshot", () => {
    const budget = createReplayRecoveryBudget();
    for (let n = 0; n < 3; n++) {
      budget.acknowledged(`recording-${n}`, 1, 0, n * 60_000);
      expect(budget.take(3)).toBe(true);
    }
    expect(budget.take(3)).toBe(false);
    budget.acknowledged("healthy", 1, 0, 180_000);
    budget.acknowledged("healthy", 3, 2, 210_000);
    expect(budget.debt).toBe(0);
  });

  it("stops a previous recorder before a harness takes ownership and prevents a competing root", () => {
    const owners = createReplayDocumentOwners();
    const events: string[] = [];
    const release = owners.acquire("root", () => events.push("root stopped"))!;
    expect(owners.acquire("root", () => {})).toBeNull();
    const harness = owners.acquire("harness", () => events.push("harness stopped"))!;
    expect(events).toEqual(["root stopped"]);
    release();
    expect(owners.getOwner()).toBe("harness");
    harness();
    expect(owners.getOwner()).toBeNull();
  });
});
