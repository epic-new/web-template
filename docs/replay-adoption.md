# Adopting Epic Replay

How to turn Epic Replay on in an application generated from this template, and
how to add it to one generated before the template had it. What is recorded,
and what is hidden, is in [replay-privacy.md](./replay-privacy.md).

Changing the template does not change applications already generated from it.
Each existing repository is adopted by hand, following the steps below.

## What a configured application does

- `GET /api/epic/replay/config` reads the environment's policy from Epic with
  the publishing token, server side. The browser never sees the token.
- With capture on in the policy and consent granted, the root provider records
  the session with `@rrweb/record` and uploads bounded batches through the
  app's own `/api/epic/replay/*` routes, which relay them to Epic.
- With reporting on, a "Report a problem" button sends a report tied to the
  current recording; it reaches the Builder's Replay inbox, where it can become
  an issue.

Without configuration the app behaves exactly as before: the policy comes back
disabled (`not_configured`), nothing is recorded and no button is shown.

## Turning it on

1. **Register the application in the Builder.** In the project, open
   Replay → Settings, pick the environment, and under *Connected applications*
   choose *Register application*. The publishing token is shown once; copy it
   then.
2. **Set the server variables** (never `NEXT_PUBLIC_`), per deployment
   environment:

   | Variable | Value |
   |---|---|
   | `EPIC_API_URL` | `https://build.epic.new` |
   | `EPIC_PROJECT_ID` | the project id shown with the token |
   | `EPIC_PUBLISHING_TOKEN` | the token for **this** environment |
   | `EPIC_ENVIRONMENT` | optional; overrides `VERCEL_ENV` / `NODE_ENV` |
   | `EPIC_REPLAY_SECRET` | optional; a stable secret for the opaque subject (falls back to `BETTER_AUTH_SECRET`) |
   | `EPIC_REPLAY_ANONYMOUS_CAPTURE` / `_REPORTING` | `allow` to include signed-out visitors; off by default |

3. **Choose the policy in the Builder**: capture, sampling, excluded routes,
   masking, console and network diagnostics, and reports. A running app picks
   up a saved change within 60 seconds.
4. **Check Setup** in the Builder's Replay page: it shows whether the
   application has reached Epic, and links to the latest session once one
   arrives.

### Environments are separate

Each environment (production, preview, development, test) has its own policy
and its own publishing tokens. The token names its environment, and an app
whose own environment differs keeps replay off, so a production token copied
into a development or test deployment records nothing there. An `EPIC_ENVIRONMENT` that is set but empty or not one
of the four names keeps replay off rather than guessing.

### Previews inside Epic

The recorder runs in the application itself. It works the same in a direct
deployment and inside an Epic preview frame, and it does not depend on the
parent workspace, `PreviewBridge` or `PreviewToolbarLoader`.

## Adding it to an existing application

Copy these from the current template, keeping their paths:

- `lib/replay/` (including `lib/replay/server/`)
- `app/api/epic/replay/` — the config, identity, recordings, batches,
  capability and reports routes with their behaviors
- `components/epic-replay-provider.tsx`, `components/replay-policy-loader.tsx`,
  `components/replay-consent-banner.tsx`, `components/replay-report-button.tsx`
- `shared/integrations/epic/`, `shared/models/replay-recording.ts`,
  `shared/policies/replay-recording.policy.ts`
- the `replay_recording` and `replay_rate_limit` tables from `db/schema.ts`
  (generate the migration in that app; do not copy the template's numbered one)
- optionally `app/styleguide/replay/` — the development harness — and
  `docs/replay-*.md`

Then:

1. Add `@rrweb/record` and `@rrweb/types` at the template's pinned version
   (`package.json`); do not take a newer one without re-running the replay
   tests.
2. In `app/layout.tsx`, wrap the children of `Providers` in
   `EpicReplayProvider` (passing `release`, `anonymousCapture` and
   `anonymousReporting` as the template does) and mount `ReplayPolicyLoader`
   once, beside `PreviewBridge`.
3. If the app shows `ReactQueryDevtools`, move its button to `bottom-left`; the
   report button sits bottom-right.
4. Copy the replay block of `.env.example`, set the variables above, and run
   the migration.
5. Check the round trip: sign in, accept the consent prompt, use a page, send a
   report, and confirm the session and the report appear in the Builder.

An app with its own consent banner deletes `replay-consent-banner.tsx` and calls
`epicReplayConsent.grant()` / `withdraw()` from its banner instead.

## Rotating the publishing token

Rotate from *Connected applications*. The new token is shown once; the previous
one keeps working for 24 hours, so deploy the new value within that window.
Revoking stops the old token immediately. Rotating `EPIC_REPLAY_SECRET`, by
contrast, changes every visitor's subject, so keep it stable.

## Rolling out

Start in development or preview with sampling at 100% and verify the round
trip, then enable production with the sampling you want. Turning reports on
without capture is valid: reports arrive without a recording.

## Turning it off, and removing it

- **Pause:** switch capture (and reports) off in the Builder. Pages stop
  recording on their next refresh, and a page that cannot refresh treats its
  settings as off after 5 minutes.
- **Disconnect:** revoke the application's token, or unset
  `EPIC_PUBLISHING_TOKEN`. The app keeps working with capture off.
- **Remove:** undo the layout change and delete the copied files and tables.

None of these deletes what was already uploaded. Recordings expire with the
provider's retention; deleting one sooner is requested from the session page in
the Builder.

## Limits and failure states

- Where the recorder cannot start, the app runs with capture off.
- Cross-origin iframes, `<canvas>` and `<video>` contents are not recorded.
- A batch leaves every 20 s (`flushIntervalMs`) or once 64 KB are queued
  (`flushBytes`), and immediately when the tab is hidden. A failed upload is
  retried with backoff a bounded number of times; when every attempt fails the
  recording is abandoned and a new one starts with a fresh full snapshot.
  Events held past 60 s (`maxBufferAgeMs`) or the buffer limit are dropped
  rather than kept.
- Consent withdrawn, an excluded route, a disabled or expired policy, or an
  unsampled session all record nothing, and say which in the readout at
  `/styleguide/replay`.

## Measured overhead

Measured on 2026-10-25 against `/styleguide` in development mode (`next dev`,
unminified), Chrome, with capture, console and network diagnostics on. These
are a baseline to agree budgets from, not production figures; re-measure on a
production build of the app being adopted.

| What | Measured |
|---|---|
| Recorder chunk (`@rrweb/record`, dev, unminified) | 187 KB, fetched only when a recording may start — never for a visitor who cannot be recorded |
| First full snapshot of the page | 374 KB of JSON, of which 239 KB is inlined CSS (dev Tailwind) |
| Steady state, scrolling for 50 s | 9 batches, 3.8 KB in total (measured at the former 5 s cadence; at 20 s expect about a third as many) |
| Long tasks (> 50 ms) during those 50 s | none |
| JS heap across those 50 s | no growth (58.7 MB → 57.7 MB) |

The full snapshot dominates upload volume and grows with the page's DOM and
stylesheets; stylesheets are inlined so the hosted player does not have to
fetch them from a preview it cannot reach.
