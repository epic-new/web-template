'use client'

import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import type { ReplayBlockReason } from '@/lib/replay/replay-permission'
import { usePreviewReplayCapture } from '../behaviors/preview-replay-capture/use-preview-replay-capture.hook'

export function replayStatusLabel(status: 'capturing' | 'blocked', reason: ReplayBlockReason | null) {
  return status === 'capturing' ? 'Capturing' : `Blocked: ${reason ?? 'policy_disabled'}`
}

/**
 * The harness's live status. Rendered inside `data-private`: it re-renders on
 * every admitted event, so recording it would record its own counters.
 */
export function ReplayCaptureReadout() {
  const { status, reason, boundary, eventCount } = usePreviewReplayCapture()

  return (
    <div data-private className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
      <Badge variant={status === 'capturing' ? 'default' : 'secondary'} aria-label="Capture status">
        {replayStatusLabel(status, reason)}
      </Badge>
      <span>
        Boundaries: <span className="font-medium text-foreground">{boundary}</span>
      </span>
      <span>
        Buffered events: <span className="font-medium text-foreground">{eventCount}</span>
      </span>
    </div>
  )
}

/** The sanitized events exactly as stored, also inside `data-private`. */
export function ReplayBufferPanel() {
  const { bufferJson } = usePreviewReplayCapture()

  return (
    <div data-private>
      <Textarea readOnly aria-label="Buffered events" value={bufferJson} className="h-96 font-mono text-xs" />
    </div>
  )
}
