'use client'

import Link from 'next/link'
import { ReplayCaptureReadout } from './ReplayCaptureReadout'

/** A page the synthetic policies exclude; none of it may enter the buffer. */
export function ReplayExcludedContent() {
  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Excluded route</h1>
      <ReplayCaptureReadout />
      <p className="text-foreground">Synthetic excluded content EXCLUDED-7731</p>
      <Link href="/styleguide/replay" className="text-sm text-primary underline-offset-4 hover:underline">
        Back to harness
      </Link>
    </div>
  )
}
