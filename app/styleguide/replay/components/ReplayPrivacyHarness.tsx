'use client'

import Link from 'next/link'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useManageReplayConsent } from '../behaviors/manage-replay-consent/use-manage-replay-consent.hook'
import {
  REPLAY_HARNESS_EXCLUDED_PATH,
  type ReplayHarnessSource,
} from '../behaviors/preview-replay-capture/synthetic-policies'
import { useReplayHarnessSource } from '../behaviors/preview-replay-capture/use-preview-replay-capture.hook'
import { ReplayBufferPanel, ReplayCaptureReadout } from './ReplayCaptureReadout'

const SOURCES: { value: ReplayHarnessSource; label: string; description: string }[] = [
  { value: 'application', label: 'Application policy', description: 'The effective policy from this deployment.' },
  { value: 'synthetic-sampled', label: 'Synthetic policy, sampled', description: `Active, sample rate 1, excludes ${REPLAY_HARNESS_EXCLUDED_PATH}.` },
  { value: 'synthetic-unsampled', label: 'Synthetic policy, not sampled', description: 'Same policy with sample rate 0.' },
]

const EXCLUDED_LINK = `${REPLAY_HARNESS_EXCLUDED_PATH}?access_token=synthetic-access-token&_proxy_token=synthetic-proxy-token`

/**
 * Development harness for replay privacy: real consent, gates, recorder and
 * sanitizers, writing into a local buffer that is shown here and never
 * uploaded. Every value on this page is synthetic.
 */
export function ReplayPrivacyHarness() {
  const { source, setSource } = useReplayHarnessSource()
  const { consent, grant, withdraw, notice } = useManageReplayConsent()

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Replay Privacy</h1>
        <p className="mt-2 text-muted-foreground">
          Development harness for replay consent, masking and route exclusion. Events stay in this tab&apos;s memory and are
          never uploaded.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Capture</CardTitle>
          <CardDescription>Capture starts only when the policy, consent, route and sample all allow it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ReplayCaptureReadout />

          <fieldset className="space-y-3">
            <legend className="mb-3 text-sm font-medium text-foreground">Policy source</legend>
            <RadioGroup
              value={source}
              onValueChange={(value) => setSource(value as ReplayHarnessSource)}
              aria-label="Policy source"
            >
              {SOURCES.map((source) => (
                <div key={source.value} className="flex items-start gap-3">
                  <RadioGroupItem value={source.value} id={`source-${source.value}`} />
                  <div className="space-y-1">
                    <Label htmlFor={`source-${source.value}`}>{source.label}</Label>
                    <p className="text-xs text-muted-foreground">{source.description}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </fieldset>

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Consent: <span className="font-medium text-foreground">{consent}</span>
            </p>
            <div className="flex gap-3">
              <Button onClick={grant} disabled={consent === 'granted'}>
                Grant consent
              </Button>
              <Button variant="outline" onClick={withdraw} disabled={consent !== 'granted'}>
                Withdraw consent
              </Button>
            </div>
            {notice && (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Synthetic sensitive content</CardTitle>
          <CardDescription>None of these values may appear in the buffered events.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div data-private className="space-y-2 rounded-md border border-dashed border-border p-4">
            <Label htmlFor="replay-private-input">Private field (inside data-private)</Label>
            <Input id="replay-private-input" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="replay-password">Password</Label>
            <Input id="replay-password" type="password" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="replay-email">Email</Label>
            <Input id="replay-email" type="email" autoComplete="off" />
          </div>
          <p data-mask className="text-sm text-foreground">
            Synthetic SSN 000-12-3456
          </p>
          <Link href={EXCLUDED_LINK} className="text-sm text-primary underline-offset-4 hover:underline">
            Open the excluded page
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Privacy markers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <code className="text-foreground">data-private</code> keeps an element and everything inside it out of the
            recording; replay shows an empty box of the same size.
          </p>
          <p>
            <code className="text-foreground">data-mask</code> records the text inside as asterisks.
          </p>
          <p>Input values are masked by default, and passwords always are.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Buffered events</CardTitle>
          <CardDescription>The sanitized events exactly as stored, grouped by boundary.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReplayBufferPanel />
        </CardContent>
      </Card>
    </div>
  )
}
