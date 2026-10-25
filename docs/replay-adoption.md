# Adopting Epic Replay

How to turn Epic Replay on in an application generated from this template, and
how to add it to one generated before the template had it. What is recorded,
and what is hidden, is in [replay-privacy.md](./replay-privacy.md).

Changing the template does not change applications already generated from it.
Each existing repository is adopted by hand, following the steps below.

## What a configured application does

- `GET /api/epic/replay/config` reads the environment's policy from Epic with
  the publishing token, server side. The browser never sees the token.
- With capture on in the policy and consent given (see *Consent modes*), the
  root provider records the session with `@rrweb/record` and sends it, with
  behavior and error evidence, as OTLP/JSON to the app's own
  `POST /api/epic/replay/telemetry`, which relays it to Epic's ClickStack
  ingest. The browser never holds the token.
- With `EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN` set, the server also exports
  OpenTelemetry traces to Epic (`instrumentation.ts`), and same-origin browser
  requests carry a W3C `traceparent`, so a report can cite the server trace of
  the request that preceded it.
- With reporting on, a "Report a problem" button sends a report tied to the
  current session; it reaches the Builder's Replay inbox, where it can become
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
   | `EPIC_OTLP_ENDPOINT` | optional; Epic's OTLP ingest base. Unset, it is `${EPIC_API_URL}/api/observability`. Must be https (or http on localhost outside production); an invalid value leaves telemetry and tracing off |
   | `EPIC_REPLAY_SECRET` | optional; a stable secret for the opaque subject (falls back to `BETTER_AUTH_SECRET`) |
   | `EPIC_REPLAY_ANONYMOUS_CAPTURE` / `_REPORTING` | `allow` to include signed-out visitors; off by default |

3. **Choose the policy in the Builder**: capture, consent mode, sampling,
   excluded routes, masking, console and network diagnostics, retention, and
   reports. A running app picks up a saved change within 60 seconds.
4. **Check Setup** in the Builder's Replay page: it shows whether the
   application has reached Epic, and links to the latest session once one
   arrives.

### Consent modes

The policy's `capture.consentMode` decides who has to say yes:

- `required` (default): nothing is recorded or sent until the visitor accepts
  the template's prompt, or the host calls `epicReplayConsent.grant()`.
- `not_required`: the application decided consent is not needed (for example an
  internal tool). Recording and evidence start without a prompt, the prompt is
  not shown, and the visitor can still opt out: the report form's "Turn off"
  and `epicReplayConsent.withdraw()` stop everything at once, and a remembered
  opt-out is applied on load.

Either way a withdrawal sends nothing more and clears the local buffer
immediately.

### What leaves the browser

Everything goes to this app's `POST /api/epic/replay/telemetry` as OTLP/JSON
`resourceLogs`, never to Epic directly:

- each rrweb event is one log record (scope `rum.rr-web`) in ClickStack's
  session format: the event's compact JSON as the body, `rr-web.offset`,
  `rr-web.event`, `rr-web.chunk` and `rr-web.total-chunks` as attributes. An
  event larger than the policy's `maxChunkBytes` is split on character
  boundaries. Every record carries the resource attribute `rum.sessionId` (32
  hex characters, kept in `sessionStorage`, reused across reloads within 15
  minutes of inactivity, new after 15 minutes idle or 4 hours) and
  `service.version` (the release).
- behavior markers (`epic.behavior.started|succeeded|failed`) and uncaught
  errors are also sent as plain log records (scope `epic.evidence`,
  `epic.event` = `behavior.started|behavior.succeeded|behavior.failed|browser.error`)
  **whether or not the session was sampled for replay**, under the same consent,
  route and policy gates. They stay inside the replay too.
- the relay adds the trusted visitor id (`epic.subject.id`, which Epic hashes)
  and the coarse capture context (`epic.capture.browser` as `Chrome/120`,
  `epic.capture.os`, `epic.capture.device`), removes every `epic.*`,
  `deployment.environment.name` and `service.name` attribute the browser sent,
  attaches the bearer token, and forwards to `${EPIC_OTLP_ENDPOINT}/v1/logs`.
  Cookies, addresses, the full User-Agent and request headers are never
  forwarded. Epic overwrites project, application and environment from the
  token.

### Server tracing

`instrumentation.ts` registers `@vercel/otel` on the Node runtime only when
`EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN` are set, exporting traces as OTLP
http/json to `${EPIC_OTLP_ENDPOINT}/v1/traces` with the bearer token. Only the
route pattern, method, status code and Next.js's own `next.*` attributes leave
a span; query strings, bodies, cookies, headers, fetch URLs and exception text
never do. The relay routes under `/api/epic/replay/` are not traced. Without the
variables nothing is registered. In the browser, a `traceparent` header
(random trace id, sampled flag) is added to same-origin `fetch`/XHR requests
only, never to `/api/epic/replay/*` or another origin; the trace id is recorded
in the network diagnostic and cited by reports.

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
- `app/api/epic/replay/` — the config, identity, telemetry and reports routes
  with their behaviors
- `instrumentation.ts`
- `components/epic-replay-provider.tsx`, `components/replay-policy-loader.tsx`,
  `components/replay-consent-banner.tsx`, `components/replay-report-button.tsx`
- `shared/integrations/epic/`, `shared/models/replay-rate-limit.ts`
- the `replay_rate_limit` table from `db/schema.ts` (generate the migration in
  that app; do not copy the template's numbered one)
- optionally `app/styleguide/replay/` — the development harness — and
  `docs/replay-*.md`

Then:

1. Add `@rrweb/record` and `@rrweb/types` at the template's pinned version
   (`package.json`); do not take a newer one without re-running the replay
   tests. Add `@vercel/otel` and the OpenTelemetry packages it needs at the
   template's pinned versions for server tracing.
2. In `app/layout.tsx`, wrap the children of `Providers` in
   `EpicReplayProvider` (passing `release`, `anonymousCapture` and
   `anonymousReporting` as the template does) and mount `ReplayPolicyLoader`
   once, beside `PreviewBridge`.
3. If the app shows `ReactQueryDevtools`, move its button to `bottom-left`; the
   report button sits bottom-right.
4. Copy the replay block of `.env.example`, set the variables above, and run
   the migration.
5. Check the round trip: sign in, accept the consent prompt (or open the app
   where the mode is `not_required`), use a page, send a report, and confirm the
   session and the report appear in the Builder.

An app with its own consent banner deletes `replay-consent-banner.tsx` and calls
`epicReplayConsent.grant()` / `withdraw()` from its banner instead.

## Rotating the publishing token

Rotate from *Connected applications*. The new token is shown once; the previous
one keeps working for 24 hours, so deploy the new value within that window; it
is used by the policy, the telemetry relay, reports and the trace exporter
alike. Revoking stops the old token immediately. Rotating `EPIC_REPLAY_SECRET`, by
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
  `EPIC_PUBLISHING_TOKEN` (which also switches server tracing off). The app
  keeps working with capture off.
- **Remove:** undo the layout change, delete `instrumentation.ts` and the
  copied files, and drop the `replay_rate_limit` table.

**None of these deletes what was already stored.** Stopping capture, revoking
the token and removing the code leave the sessions, evidence and traces already
in ClickStack where they are until the project's retention (1 to 30 days) expires
them; deleting a session sooner is requested from the session page in the
Builder.

## Migrating from the recording protocol

Earlier versions of the template registered each recording with Epic, renewed a
sealed capability and posted numbered batches. Epic no longer accepts that
protocol (runtime config `contractVersion` 2, `recording.transport` =
`otlp-relay`). To migrate an application generated before:

- delete `app/api/epic/replay/recordings/` (the registration, capability and
  batch routes), `shared/integrations/epic/resources/recordings.resource.ts`,
  `shared/policies/replay-recording.policy.ts` and their tests;
- rename `shared/models/replay-recording.ts` to `replay-rate-limit.ts`
  (`ReplayRateLimitModel`; only the rate counters remain) and drop the
  `replay_recording` table (`db/migrations/0002_drop_replay_recording.sql` in
  the template; generate your own);
- replace `lib/replay/` and `components/replay-*.tsx`, add
  `app/api/epic/replay/telemetry/` and `instrumentation.ts`, and take the new
  `package.json` dependencies;
- report evidence is now `{ sessionId, startedAt, offsetMs, traceId?,
  behaviorId?, occurrenceId? }`; `recordingId` is gone, and so are the error
  codes `capability_expired`, `invalid_capability`, `subject_mismatch`,
  `recording_not_found` and `recording_closed`. `unsupported_media_type` (415)
  is now one of Epic's own;
- deploy this version only after the Epic side that serves OTLP; an older
  browser tab keeps calling the removed routes until it reloads, and fails
  closed.

## Limits and failure states

- Where the recorder cannot start, the app runs with capture off.
- Cross-origin iframes, `<canvas>` and `<video>` contents are not recorded.
- A request leaves 20 s (`flushIntervalMs`) after its oldest record was
  queued, or once 64 KB are queued (`flushBytes`), and immediately, with
  `keepalive` when it fits 64 KB, when the tab is hidden or the page is hidden
  for good. A failed request (network error, 429, 503) is retried with backoff,
  honouring `Retry-After`, a bounded number of times; when every attempt fails
  the boundary is abandoned and a new one starts with a fresh full snapshot. A
  401, 403, 413 or 422 stops capture until the policy changes. Records held past
  60 s (`maxBufferAgeMs`) or the buffer limit are dropped rather than kept.
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
