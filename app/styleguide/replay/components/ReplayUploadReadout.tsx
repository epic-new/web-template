'use client'

import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ReplayRecordingHistoryEntry, ReplayUploadReason, ReplayUploadStatus } from '@/lib/replay/replay-uploader'
import { usePreviewReplayUpload } from '../behaviors/preview-replay-upload/use-preview-replay-upload.hook'

const REASON_TEXT: Partial<Record<NonNullable<ReplayUploadReason>, string>> = {
  REPLAY_CREDENTIAL_INVALID: 'publishing credential invalid',
  not_configured: 'not configured',
  attempts_exhausted: 'attempts exhausted',
  snapshot_too_large: 'snapshot too large',
  buffer_exceeded: 'buffer exceeded',
  delivery_uncertain: 'delivery uncertain',
  out_of_order: 'out of order',
}

export function replayUploadReasonText(reason: ReplayUploadReason) {
  if (!reason) return 'unavailable'
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ')
}

// Reasons after which a recording that had begun is incomplete rather than unavailable.
const INCOMPLETE_REASONS = new Set<ReplayUploadReason>([
  'delivery_uncertain',
  'out_of_order',
  'invalid_capability',
  'subject_mismatch',
  'recording_not_found',
  'recording_closed',
])

/** The one honest label for a transport state. There is no playable state here. */
export function replayUploadStatusLabel(status: ReplayUploadStatus, reason: ReplayUploadReason) {
  switch (status) {
    case 'idle':
      return 'Idle'
    case 'recorder_started':
      return reason === 'offline'
        ? 'Recorder started - waiting for registration (offline)'
        : 'Recorder started - waiting for registration'
    case 'registered':
      return 'Registered'
    case 'uploading':
      return 'Uploading'
    case 'pending':
      return reason === 'offline' ? 'Pending upload - offline' : 'Pending - received, playback not verified'
    case 'unavailable':
      return INCOMPLETE_REASONS.has(reason)
        ? `Incomplete - ${replayUploadReasonText(reason)}`
        : `Unavailable - ${replayUploadReasonText(reason)}`
  }
}

export function replayHistoryOutcomeLabel(entry: ReplayRecordingHistoryEntry) {
  switch (entry.outcome) {
    case 'open':
      return entry.acceptedBatches > 0 ? 'Open - received, playback not verified' : 'Open - registered'
    case 'closed':
      return 'Closed - playback not verified'
    case 'incomplete':
      return entry.reason ? `Incomplete - ${replayUploadReasonText(entry.reason)}` : 'Incomplete - stopped locally'
    case 'unavailable':
      return `Unavailable - ${replayUploadReasonText(entry.reason)}`
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm break-all text-foreground">{value}</dd>
    </div>
  )
}

/**
 * The upload harness's live readout. Rendered inside `data-private`: it
 * re-renders on every admitted event, so recording it would record its own
 * counters.
 */
export function ReplayUploadReadout() {
  const { state } = usePreviewReplayUpload()
  const { capture, upload } = state.pipeline
  const currentEntry = upload.current
    ? upload.history.find((entry) => entry.reference.recordingId === upload.current!.recordingId)
    : undefined

  return (
    <div data-private className="space-y-6">
      {state.provider && (
        <div className="space-y-3">
          <Badge variant="outline" aria-label="Provider state">
            Root provider: {state.provider.status}{state.provider.reason ? ` - ${state.provider.reason.replace(/_/g, ' ')}` : ''}
          </Badge>
          <p className="text-sm text-muted-foreground" aria-label="Reload continuity">
            {state.provider.continuity === 'resumed' && 'Continued the same recording after reload; fresh snapshot received, playback not verified.'}
            {state.provider.continuity === 'resuming' && 'Checking reload continuity; the recording has not resumed yet.'}
            {state.provider.continuity === 'new_recording' && 'New recording; previous continuity could not be established.'}
            {state.provider.continuity === 'handoff' && 'Unresumed handoff; the server row may remain open.'}
            {state.provider.continuity === 'fresh' && 'Fresh recording boundary.'}
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Clean handoff" value={state.eligibleHandoff ? 'Eligible acknowledged frontier' : 'Not eligible'} />
            <Field label="Recovery attempts used" value={state.recoveryDebt ?? 0} />
          </dl>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={upload.status === 'unavailable' ? 'destructive' : 'secondary'} aria-label="Upload status">
          {replayUploadStatusLabel(upload.status, upload.reason)}
        </Badge>
        <Badge variant="outline">Evidence: {upload.evidence}</Badge>
        <span className="text-sm text-muted-foreground">
          Recorder:{' '}
          <span className="font-medium text-foreground">
            {capture.status === 'capturing' ? 'recording' : `stopped (${capture.reason ?? 'policy_disabled'})`}
          </span>
        </span>
      </div>

      <dl className="grid gap-4 sm:grid-cols-3">
        <Field label="Recording reference" value={upload.current?.recordingId ?? 'none'} />
        <Field label="startedAt" value={upload.current ? upload.current.startedAt : 'none'} />
        <Field label="Boundary" value={capture.boundary} />
        <Field label="Buffered events" value={upload.bufferedEvents} />
        <Field label="Buffered bytes" value={upload.bufferedBytes} />
        <Field label="Accepted batches" value={currentEntry?.acceptedBatches ?? 0} />
      </dl>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Recording history</h3>
        <p className="text-xs text-muted-foreground">An open row can be stale or unresumed; its status alone does not establish active capture.</p>
        {upload.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recording has been registered in this tab.</p>
        ) : (
          <Table aria-label="Recording history">
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>startedAt</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Accepted batches</TableHead>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upload.history.map((entry) => (
                <TableRow key={entry.reference.recordingId}>
                  <TableCell className="font-mono text-xs">{entry.reference.recordingId}</TableCell>
                  <TableCell className="font-mono text-xs">{entry.reference.startedAt}</TableCell>
                  <TableCell>{replayHistoryOutcomeLabel(entry)}</TableCell>
                  <TableCell>{entry.acceptedBatches}</TableCell>
                  <TableCell>Evidence: unverified</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {state.forged.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Forged requests</h3>
          <ul aria-label="Forged request results" className="space-y-1 text-sm">
            {state.forged.map((result) => (
              <li key={result.label} className="font-mono text-foreground">
                {result.status} {result.code ?? 'no code'} <span className="text-muted-foreground">- {result.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">
          {state.target === 'synthetic' ? 'Fixture log' : 'Relay request log'}
        </h3>
        <p className="text-xs text-muted-foreground">Routing fields and body keys only; event content is never logged.</p>
        {state.log.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        ) : (
          <Table aria-label="Request log">
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Sequence</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Body keys</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.log.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.id}</TableCell>
                  <TableCell className="font-mono text-xs">{entry.path}</TableCell>
                  <TableCell>{entry.status}</TableCell>
                  <TableCell className="font-mono text-xs">{entry.code ?? ''}</TableCell>
                  <TableCell className="font-mono text-xs">{entry.batchId?.slice(0, 8) ?? ''}</TableCell>
                  <TableCell>{entry.sequence ?? ''}</TableCell>
                  <TableCell>
                    {entry.eventCount ?? ''}
                    {entry.firstEventTypes && entry.firstEventTypes.length > 0 ? ` (types ${entry.firstEventTypes.join(', ')}...)` : ''}
                    {entry.final ? ' final' : ''}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{entry.bodyKeys.join(', ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
