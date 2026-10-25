import "server-only";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { db, type DatabaseExecutor } from "@/db";
import {
  replayRateLimit,
  replayRecording,
  type ReplayRateBucket,
  type ReplayRecordingStatus,
} from "@/db/schema";

export type ReplayRecordingRecord = typeof replayRecording.$inferSelect;
export type NewReplayRecordingRecord = Pick<
  typeof replayRecording.$inferInsert,
  "id" | "subjectId" | "idempotencyKey" | "registrationHash" | "registrationPayload"
>;

export interface ReplayRateDecision {
  allowed: boolean;
  /** Positive only when the call was denied. */
  retryAfterMs: number;
}

// A bound recording never changes subject, so a confirmed owner stays true for
// as long as the row exists; the TTL only bounds how long a pruned row lingers.
const OWNERSHIP_TTL_MS = 5 * 60_000;
const OWNERSHIP_MAX_ENTRIES = 10_000;
const ownership = new Map<string, number>();

const RATE_ROW_RETENTION_MS = 60 * 60_000;
const RECORDING_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrunedAt = 0;

export class ReplayRecordingModel {
  static isOwnershipKnown(recordingId: string, subjectId: string, now = Date.now()): boolean {
    const key = `${recordingId}\u0000${subjectId}`;
    const expiresAt = ownership.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      ownership.delete(key);
      return false;
    }
    return true;
  }

  static rememberOwnership(recordingId: string, subjectId: string, now = Date.now()): void {
    if (ownership.size >= OWNERSHIP_MAX_ENTRIES) {
      const oldest = ownership.keys().next().value;
      if (oldest !== undefined) ownership.delete(oldest);
    }
    ownership.set(`${recordingId}\u0000${subjectId}`, now + OWNERSHIP_TTL_MS);
  }

  static clearOwnershipCache(): void {
    ownership.clear();
    lastPrunedAt = 0;
  }

  /**
   * Deletes spent rate counters and recordings past their retention. Runs at
   * most once per interval per process, from the unauthenticated entry points
   * that create rows, so the tables stay bounded without a cron.
   */
  static async pruneStale(now = Date.now(), executor: DatabaseExecutor = db): Promise<void> {
    if (now - lastPrunedAt < PRUNE_EVERY_MS) return;
    lastPrunedAt = now;
    await executor.delete(replayRateLimit).where(lt(replayRateLimit.windowStartedAt, now - RATE_ROW_RETENTION_MS));
    await executor.delete(replayRecording).where(lt(replayRecording.updatedAt, new Date(now - RECORDING_RETENTION_MS)));
  }

  static async findByIdempotencyKey(
    subjectId: string,
    idempotencyKey: string,
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRecordingRecord | null> {
    const [record] = await executor
      .select()
      .from(replayRecording)
      .where(
        and(eq(replayRecording.subjectId, subjectId), eq(replayRecording.idempotencyKey, idempotencyKey)),
      )
      .limit(1);
    return record ?? null;
  }

  static async findByRecordingId(
    recordingId: string,
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRecordingRecord | null> {
    const [record] = await executor
      .select()
      .from(replayRecording)
      .where(eq(replayRecording.recordingId, recordingId))
      .limit(1);
    return record ?? null;
  }

  /**
   * Inserts a registration, or returns the row already holding the same
   * subject and key unchanged, so a raced insert resolves to its winner.
   */
  static async insertRegistering(
    record: NewReplayRecordingRecord,
    executor: DatabaseExecutor = db,
  ): Promise<{ record: ReplayRecordingRecord; inserted: boolean }> {
    const now = new Date();
    const [inserted] = await executor
      .insert(replayRecording)
      .values({ ...record, status: "registering", createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [replayRecording.subjectId, replayRecording.idempotencyKey] })
      .returning();
    if (inserted) return { record: inserted, inserted: true };

    const existing = await ReplayRecordingModel.findByIdempotencyKey(
      record.subjectId,
      record.idempotencyKey,
      executor,
    );
    if (!existing) throw new Error("Replay registration vanished after a conflict");
    return { record: existing, inserted: false };
  }

  /** Binds Epic's recording id once; repeating the same id is a no-op. */
  static async bindRecordingId(
    localId: string,
    recordingId: string,
    executor: DatabaseExecutor = db,
  ): Promise<boolean> {
    await executor
      .update(replayRecording)
      .set({ recordingId, updatedAt: new Date() })
      .where(
        and(
          eq(replayRecording.id, localId),
          sql`(${replayRecording.recordingId} IS NULL OR ${replayRecording.recordingId} = ${recordingId})`,
        ),
      );
    const [bound] = await executor
      .select({ recordingId: replayRecording.recordingId })
      .from(replayRecording)
      .where(eq(replayRecording.id, localId))
      .limit(1);
    return bound?.recordingId === recordingId;
  }

  /** Moves a recording between statuses only when it is currently in `from`. */
  static async transitionStatus(
    recordingId: string,
    from: readonly ReplayRecordingStatus[],
    to: ReplayRecordingStatus,
    executor: DatabaseExecutor = db,
  ): Promise<boolean> {
    const updated = await executor
      .update(replayRecording)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(replayRecording.recordingId, recordingId), inArray(replayRecording.status, [...from])))
      .returning({ id: replayRecording.id });
    return updated.length > 0;
  }

  /**
   * Counts one call against a fixed window in a single atomic statement, so
   * concurrent requests (and processes) cannot both slip under the limit.
   */
  static async consumeRate(
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
  static async pruneRate(bucket: ReplayRateBucket, olderThan: number, executor: DatabaseExecutor = db): Promise<void> {
    await executor
      .delete(replayRateLimit)
      .where(and(eq(replayRateLimit.bucket, bucket), lt(replayRateLimit.windowStartedAt, olderThan)));
  }
}
