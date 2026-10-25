import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

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
}
