import "server-only";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DatabaseExecutor } from "@/db";
import { replayRateLimit, replayRecording } from "@/db/schema";

export type ReplayRecordingRecord = typeof replayRecording.$inferSelect;
export type NewReplayRecordingRecord = typeof replayRecording.$inferInsert;
export type ReplayRecordingStatus = ReplayRecordingRecord["status"];
export type ReplayRateBucket = (typeof replayRateLimit.$inferSelect)["bucket"];

export class ReplayRecordingModel {
  static async findByIdempotencyKey(
    subjectId: string,
    idempotencyKey: string,
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRecordingRecord | null> {
    const [record] = await executor
      .select()
      .from(replayRecording)
      .where(
        and(
          eq(replayRecording.subjectId, subjectId),
          eq(replayRecording.idempotencyKey, idempotencyKey),
        ),
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
   * Inserts a `registering` row. A row with the same subject and key wins:
   * it is returned unchanged and never overwritten.
   */
  static async insertRegistering(
    values: Omit<NewReplayRecordingRecord, "status" | "recordingId">,
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRecordingRecord> {
    const [inserted] = await executor
      .insert(replayRecording)
      .values({ ...values, status: "registering", recordingId: null })
      .onConflictDoNothing({
        target: [replayRecording.subjectId, replayRecording.idempotencyKey],
      })
      .returning();
    if (inserted) return inserted;

    const existing = await ReplayRecordingModel.findByIdempotencyKey(
      values.subjectId,
      values.idempotencyKey,
      executor,
    );
    if (!existing) throw new Error("Unable to register replay recording");
    return existing;
  }

  /**
   * Binds the central recording id and opens the row. Idempotent when the row
   * is already bound to the same id; returns null when it is bound to another.
   */
  static async bindRecordingId(
    id: string,
    recordingId: string,
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRecordingRecord | null> {
    const [record] = await executor
      .update(replayRecording)
      .set({
        recordingId,
        status: sql`CASE WHEN ${replayRecording.status} = 'registering' THEN 'open' ELSE ${replayRecording.status} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(replayRecording.id, id),
          or(
            isNull(replayRecording.recordingId),
            eq(replayRecording.recordingId, recordingId),
          ),
        ),
      )
      .returning();
    return record ?? null;
  }

  static async transitionStatus(
    recordingId: string,
    from: readonly ReplayRecordingStatus[],
    to: ReplayRecordingStatus,
    executor: DatabaseExecutor = db,
  ): Promise<ReplayRecordingRecord | null> {
    const [record] = await executor
      .update(replayRecording)
      .set({ status: to, updatedAt: new Date() })
      .where(
        and(
          eq(replayRecording.recordingId, recordingId),
          inArray(replayRecording.status, [...from]),
        ),
      )
      .returning();
    return record ?? null;
  }

  /**
   * Counts one request in the subject's fixed window, atomically (a single
   * upsert, so concurrent requests cannot both take the last slot). A denial
   * carries the positive delay until the window resets.
   */
  static async consumeRate(
    subjectId: string,
    bucket: ReplayRateBucket,
    { limit, windowMs, now }: { limit: number; windowMs: number; now: number },
    executor: DatabaseExecutor = db,
  ): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    const expired = sql`${now} - ${replayRateLimit.windowStartedAt} >= ${windowMs}`;
    const [row] = await executor
      .insert(replayRateLimit)
      .values({ subjectId, bucket, windowStartedAt: now, count: 1 })
      .onConflictDoUpdate({
        target: [replayRateLimit.subjectId, replayRateLimit.bucket],
        set: {
          count: sql`CASE WHEN ${expired} THEN 1 ELSE ${replayRateLimit.count} + 1 END`,
          windowStartedAt: sql`CASE WHEN ${expired} THEN ${now} ELSE ${replayRateLimit.windowStartedAt} END`,
        },
      })
      .returning({ count: replayRateLimit.count, windowStartedAt: replayRateLimit.windowStartedAt });
    if (row && row.count <= limit) return { allowed: true };
    const windowStartedAt = row?.windowStartedAt ?? now;
    return { allowed: false, retryAfterMs: Math.max(1, windowStartedAt + windowMs - now) };
  }
}
