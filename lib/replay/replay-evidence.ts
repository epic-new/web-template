/** Safe immutable recording context; never a credential or ownership proof. */
export interface ReplayRecordingContext {
  readonly recordingId: string;
  readonly startedAt: number;
  readonly boundary: number;
  readonly release: string | null;
  readonly configVersion: string;
}

export interface ReplayEvidenceReference extends ReplayRecordingContext {
  readonly capturedAt: number;
  readonly offsetMs: number;
}

/** Both timestamps use the original client clock, including resumed recordings. */
export function freezeReplayEvidence(context: ReplayRecordingContext | null, capturedAt: number): ReplayEvidenceReference | null {
  if (!context || !Number.isSafeInteger(context.startedAt) || context.startedAt < 0 ||
      !Number.isSafeInteger(capturedAt) || capturedAt < context.startedAt) return null;
  return Object.freeze({ recordingId: context.recordingId, startedAt: context.startedAt,
    boundary: context.boundary, release: context.release, configVersion: context.configVersion,
    capturedAt, offsetMs: capturedAt - context.startedAt });
}
