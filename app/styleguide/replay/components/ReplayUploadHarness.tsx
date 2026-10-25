'use client'

import Link from 'next/link'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useManageReplayConsent } from '../behaviors/manage-replay-consent/use-manage-replay-consent.hook'
import {
  SYNTHETIC_FIXTURE_BADGE,
  SYNTHETIC_FIXTURE_MODES,
  type SyntheticFixtureMode,
} from '../behaviors/preview-replay-upload/synthetic-epi210'
import {
  usePreviewReplayUploadControls,
  type ReplayUploadTarget,
} from '../behaviors/preview-replay-upload/use-preview-replay-upload.hook'
import { ReplayUploadReadout } from './ReplayUploadReadout'

export const REPLAY_UPLOAD_PATH = '/styleguide/replay/upload'
export const REPLAY_UPLOAD_SECOND_PATH = '/styleguide/replay/upload/second'

const TARGETS: { value: ReplayUploadTarget; label: string; description: string }[] = [
  {
    value: 'application',
    label: 'Application relay',
    description: 'The real same-origin routes under /api/epic/replay/recordings. Unconfigured, they answer not_configured.',
  },
  {
    value: 'synthetic',
    label: 'Synthetic EPI-210 fixture',
    description: 'An in-browser stand-in for the agreed central v1 responses. It never claims playback.',
  },
]

/**
 * Development harness for replay upload: the real recorder, gates, redaction
 * and upload transport, against the application relay or a labelled
 * synthetic fixture. Nothing here is evidence that a recording is playable.
 */
export function ReplayUploadHarness({ page = 'first' }: { page?: 'first' | 'second' }) {
  const { state, setTarget, setFixtureMode, start, stop, restart, emitCustomEvent, sendForgedRequests } = usePreviewReplayUploadControls()
  const { consent, grant, withdraw, notice } = useManageReplayConsent()
  const synthetic = state.target === 'synthetic'

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Replay Upload{page === 'second' ? ' - second page' : ''}</h1>
        <p className="mt-2 text-muted-foreground">
          Development harness for recording registration and batch upload. Registration and accepted batches are never
          shown as a playable recording.
        </p>
      </div>

      <Card data-private>
        <CardHeader>
          <CardTitle>Target</CardTitle>
          <CardDescription>Where the upload transport sends its requests.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RadioGroup
            value={state.target}
            onValueChange={(value) => setTarget(value as ReplayUploadTarget)}
            aria-label="Upload target"
          >
            {TARGETS.map((target) => (
              <div key={target.value} className="flex items-start gap-3">
                <RadioGroupItem value={target.value} id={`target-${target.value}`} />
                <div className="space-y-1">
                  <Label htmlFor={`target-${target.value}`}>{target.label}</Label>
                  <p className="text-xs text-muted-foreground">{target.description}</p>
                </div>
              </div>
            ))}
          </RadioGroup>

          {synthetic ? (
            <div className="space-y-3">
              <Badge variant="outline">{SYNTHETIC_FIXTURE_BADGE}</Badge>
              <div className="max-w-sm space-y-2">
                <Label htmlFor="fixture-mode">Fixture mode</Label>
                <NativeSelect
                  id="fixture-mode"
                  value={state.fixtureMode}
                  onChange={(event) => setFixtureMode(event.target.value as SyntheticFixtureMode)}
                >
                  {SYNTHETIC_FIXTURE_MODES.map((mode) => (
                    <NativeSelectOption key={mode.value} value={mode.value}>
                      {mode.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Uses the application&apos;s root provider and its configuration, consent and identity gates.
              An inactive application policy stays disabled.
            </p>
          )}
        </CardContent>
      </Card>

      <Card data-private>
        <CardHeader>
          <CardTitle>Recording</CardTitle>
          <CardDescription>Capture starts only when the policy, consent, route and sample all allow it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Consent: <span className="font-medium text-foreground">{consent}</span>
            </p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={grant} disabled={consent === 'granted'}>
                Grant consent
              </Button>
              <Button variant="outline" onClick={withdraw} disabled={consent !== 'granted'}>
                Withdraw consent
              </Button>
              <Button onClick={start} disabled={state.running}>
                Start recording
              </Button>
              <Button variant="outline" onClick={stop} disabled={!state.running}>
                Stop recording
              </Button>
              <Button variant="outline" onClick={restart}>
                Restart recording
              </Button>
              <Button variant="secondary" onClick={emitCustomEvent}>
                Emit custom event
              </Button>
              <Button variant="secondary" onClick={() => void sendForgedRequests()}>
                Send forged requests
              </Button>
            </div>
            {notice && (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
          </div>

          <ReplayUploadReadout />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Application</CardTitle>
          <CardDescription>Transport failures only change the readout; navigation and forms keep working.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm space-y-2">
            <Label htmlFor="replay-upload-input">Harness input</Label>
            <Input id="replay-upload-input" placeholder="Type to generate input events" />
          </div>
          <Link
            href={page === 'first' ? REPLAY_UPLOAD_SECOND_PATH : REPLAY_UPLOAD_PATH}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Navigate
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
