import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";

import { db, type DatabaseExecutor } from "@/db";
import { replayRateLimit, type ReplayRateBucket } from "@/db/schema";

export interface ReplayRateDecision {
  allowed: boolean;
  /** Positive only when the call was denied. */
  retryAfterMs: number;
}

const RATE_ROW_RETENTION_MS = 60 * 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrunedAt = 0;

export class ReplayRateLimitModel {
  static clearPruneClock(): void {
    lastPrunedAt = 0;
  }

  /**
   * Deletes spent rate counters. Runs at most once per interval per process,
   * from the unauthenticated entry points that create rows, so the table stays
   * bounded without a cron.
   */
  static async pruneStale(now = Date.now(), executor: DatabaseExecutor = db): Promise<void> {
    if (now - lastPrunedAt < PRUNE_EVERY_MS) return;
    lastPrunedAt = now;
    await executor.delete(replayRateLimit).where(lt(replayRateLimit.windowStartedAt, now - RATE_ROW_RETENTION_MS));
  }

  /**
   * Counts one call against a fixed window in a single atomic statement, so
   * concurrent requests (and processes) cannot both slip under the limit.
   */
  static async consume(
    subjectId: string,
    bucket: ReplayRateBucket,
    { limit, windowMs, now }: { limit: number; windowMs: number; now: number },
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRateDecision> {
    const expired = sql`${replayRateLimit.windowStartedAt} <= ${now - windowMs}`;
    const [row] = await executor
      .insert(replayRateLimit)
      .values({ subjectId, bucket, windowStartedAt: now, count: 1 })
      .onConflictDoUpdate({
        target: [replayRateLimit.subjectId, replayRateLimit.bucket],
        set: {
          windowStartedAt: sql`CASE WHEN ${expired} THEN ${now} ELSE ${replayRateLimit.windowStartedAt} END`,
          count: sql`CASE WHEN ${expired} THEN 1 ELSE ${replayRateLimit.count} + 1 END`,
        },
      })
      .returning({ windowStartedAt: replayRateLimit.windowStartedAt, count: replayRateLimit.count });

    if (row && row.count <= limit) return { allowed: true, retryAfterMs: 0 };
    const windowStartedAt = row?.windowStartedAt ?? now;
    return { allowed: false, retryAfterMs: Math.max(windowStartedAt + windowMs - now, 1) };
  }

  /** Drop a bucket's counters whose window ended long ago, so per-address rows do not pile up. */
  static async pruneBucket(bucket: ReplayRateBucket, olderThan: number, executor: DatabaseExecutor = db): Promise<void> {
    await executor
      .delete(replayRateLimit)
      .where(and(eq(replayRateLimit.bucket, bucket), lt(replayRateLimit.windowStartedAt, olderThan)));
  }
}
