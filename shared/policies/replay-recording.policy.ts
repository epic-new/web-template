import type { ReplayRecordingRecord } from "@/shared/models/replay-recording";

/**
 * Whether the current trusted subject may use a registered recording. The
 * local status is cached state, not append authority: Epic decides open,
 * closed and uncertain, and replays an accepted receipt even after this host
 * has marked the recording closed, so status is deliberately not consulted.
 */
export interface ReplayRecordingActor {
  subjectId: string;
}

type BoundRecord = Pick<ReplayRecordingRecord, "subjectId" | "recordingId">;

function owns(actor: ReplayRecordingActor, record: BoundRecord | null): boolean {
  return !!record && record.recordingId !== null && record.subjectId === actor.subjectId;
}

export class ReplayRecordingPolicy {
  static canRelay(actor: ReplayRecordingActor, record: BoundRecord | null): boolean {
    return owns(actor, record);
  }

  /** A closed or quarantined recording stays attachable evidence for reports. */
  static canAttach(actor: ReplayRecordingActor, record: BoundRecord | null): boolean {
    return owns(actor, record);
  }
}
