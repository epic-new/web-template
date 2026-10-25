import { describe, expect, it } from "vitest";

import { ReplayRateLimitModel } from "../replay-rate-limit";

describe("ReplayRateLimitModel", () => {
  it("counts a fixed window atomically", async () => {
    const limit = { limit: 2, windowMs: 1_000 };
    const consume = (now: number) => ReplayRateLimitModel.consume("sub_a", "report", { ...limit, now });

    await expect(consume(10_000)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await expect(consume(10_100)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await expect(consume(10_200)).resolves.toEqual({ allowed: false, retryAfterMs: 800 });
    await expect(consume(11_000)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("prunes only a bucket's counters whose window ended before the cutoff", async () => {
    const window = { limit: 1, windowMs: 1_000 };
    await ReplayRateLimitModel.consume("ip_old", "identity", { ...window, now: 1_000 });
    await ReplayRateLimitModel.consume("ip_new", "identity", { ...window, now: 50_000 });
    await ReplayRateLimitModel.consume("sub_old", "report", { ...window, now: 1_000 });

    await ReplayRateLimitModel.pruneBucket("identity", 10_000);

    // A pruned counter starts over; the kept ones are still spent.
    await expect(ReplayRateLimitModel.consume("ip_old", "identity", { ...window, now: 50_100 })).resolves.toMatchObject({ allowed: true });
    await expect(ReplayRateLimitModel.consume("ip_new", "identity", { ...window, now: 50_100 })).resolves.toMatchObject({ allowed: false });
    await expect(ReplayRateLimitModel.consume("sub_old", "report", { ...window, now: 1_100 })).resolves.toMatchObject({ allowed: false });
  });

  it("prunes spent counters, at most once per interval", async () => {
    ReplayRateLimitModel.clearPruneClock();
    const now = Date.now();
    const window = { limit: 1, windowMs: 1_000 };
    await ReplayRateLimitModel.consume("sub_old", "identity", { ...window, now: now - 2 * 60 * 60_000 });
    await ReplayRateLimitModel.consume("sub_new", "identity", { ...window, now });

    await ReplayRateLimitModel.pruneStale(now);

    await expect(ReplayRateLimitModel.consume("sub_old", "identity", { ...window, now })).resolves.toMatchObject({ allowed: true });
    await expect(ReplayRateLimitModel.consume("sub_new", "identity", { ...window, now })).resolves.toMatchObject({ allowed: false });
  });
});
