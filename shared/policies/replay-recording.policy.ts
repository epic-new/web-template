import type { ReplayRecordingRecord } from "@/shared/models/replay-recording";

/** The trusted, server-derived replay subject. Never browser input. */
export interface ReplaySubject {
  subjectId: string;
}

/**
 * Host-side ownership of replay recordings. Local status (`closed`,
 * `quarantined`) is cached state, not append authority: Epic central enforces
 * open state, capability and receipt ordering, and must still be reachable to
 * replay an accepted or finalized receipt for an exact retry.
 */
export class ReplayRecordingPolicy {
  /** Capability renewal and batch relay: the subject's own bound recording. */
  static canRelay(subject: ReplaySubject, recording: ReplayRecordingRecord | null): boolean {
    return ReplayRecordingPolicy.ownsBinding(subject, recording);
  }

  /**
   * Attaching a recording reference to a report: the subject's own bound
   * recording, whatever happened to it since. The association never moves.
   */
  static canAttach(subject: ReplaySubject, recording: ReplayRecordingRecord | null): boolean {
    return ReplayRecordingPolicy.ownsBinding(subject, recording);
  }

  private static ownsBinding(subject: ReplaySubject, recording: ReplayRecordingRecord | null): boolean {
    return !!recording && recording.subjectId === subject.subjectId && recording.recordingId !== null;
  }
}
