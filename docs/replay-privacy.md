# Replay privacy

How Epic Replay decides whether to record, and what it hides when it does.
Everything here runs in the browser before an event enters a buffer. The
modules live in `lib/replay/`; the development harness at `/styleguide/replay`
exercises them against synthetic content. Turning Replay on, or adding it to an
existing app, is in [replay-adoption.md](./replay-adoption.md).

Adding this code records nothing. No capture session runs outside the harness
until the root provider mounts one, and even then nothing is recorded until the
host application grants consent, unless the policy's consent mode is
`not_required` (see below).

## Consent

```ts
import { epicReplayConsent } from "@/lib/replay/replay-consent";

epicReplayConsent.grant();    // the person agreed under the host's disclosure
epicReplayConsent.withdraw(); // stops capture now
```

- The state starts `"unknown"`, which records nothing under the default
  `consentMode: "required"`. Consent is never inferred from the environment or a
  provider being mounted.
- With `consentMode: "not_required"` in the policy, `"unknown"` is treated as
  granted: recording starts without a prompt and the template's banner is not
  shown. Only an explicit `withdraw()` (or a remembered opt-out, applied on
  load) stops it. The mode is Epic's policy; the application cannot set it.
- The consent state itself lives in memory only. The template ships a default
  prompt (`components/replay-consent-banner.tsx`) that asks once, remembers the
  choice in this browser (`lib/replay/replay-consent-choice.ts`) and re-applies
  it on load. It shows only where a recording could follow: a signed-in user,
  or a visitor when `EPIC_REPLAY_ANONYMOUS_CAPTURE=allow`. A host with its own
  consent banner removes it and calls `grant()` / `withdraw()` itself.
- The report form tells the visitor whether recording is on and lets them turn
  it off or back on, through the same remembered choice. The report button
  shows to a signed-out visitor only when `EPIC_REPLAY_ANONYMOUS_REPORTING=allow`.
- `withdraw()` stops the recorder before it returns and clears the local
  buffer and any pending start, whichever gate is then reported as the reason
  (an expired or disabled policy does not keep earlier events). It does not delete recordings already uploaded; deletion is a
  separate Epic responsibility, and no UI may claim otherwise.
- `app/styleguide/replay/behaviors/manage-replay-consent/` shows how a custom
  consent UI wires to it.

## Gates

`evaluateCapturePermission` (`lib/replay/replay-permission.ts`) runs every gate
in this order. The first failure is the reason capture is blocked:

| Reason | When |
|---|---|
| `policy_disabled` | The policy is not active, capture is off, or its environment is unresolved |
| `policy_expired` | The policy's lifetime ran out (checked synchronously on every event) |
| `consent_absent` | The host has not called `grant()` (mode `required` only) |
| `consent_withdrawn` | The host called `withdraw()` |
| `route_excluded` | The current route is not eligible |
| `not_sampled` | This session was not selected by the sample rate |

Behavior and error **evidence** (see below) passes every gate except
`not_sampled`.

The capture session (`lib/replay/replay-capture.ts`) re-checks every gate before
each event is admitted, stops synchronously on any URL change into an excluded
route, and starts each new recording boundary with a fresh Meta and
FullSnapshot. It never starts on a page loaded directly at an excluded route.

## Privacy markers

| Marker | Effect |
|---|---|
| `data-private` | The element and everything inside it are not recorded; replay shows an empty box of the same size. |
| `data-mask` | Text inside is recorded as `*` of the same length. |
| inputs | Every input, textarea and select value is masked while the policy's `maskAllInputs` is on (the default). Passwords and hidden inputs are always masked, including a `value` changed later through `setAttribute`; a value whose element is not known to the current recording is masked too. |

The policy's `blockSelector` and `maskTextSelector` add to these defaults; they
cannot remove them. Canvas, inline images and fonts are never recorded.

## Routes

Policy route patterns are exact (`/settings`), prefix wildcards (`/admin/*`,
which also matches `/admin`) or single-segment params (`/users/:id`). Exclude
wins over include; an empty include means every route. `/api/*` and `/_next/*`
are always excluded. Paths are matched after decoding and with any trailing
slash, query and hash removed.

## Sampling

Session sampling decides once whether a recording happens at all. The decision
is kept in `sessionStorage` (or memory, when storage is unavailable) for the
policy's `configVersion` and `sessionSampleRate`, so renders, events and
refreshes never resample. It is unrelated to rrweb's event-detail sampling,
which only throttles mousemove, scroll, media and input events inside a
recording that is already sampled in.

## Redaction

`lib/replay/replay-redaction.ts` and `lib/replay/replay-event-sanitizer.ts`:

- **URLs**, wherever they appear (the page `href`, `href`/`src`/`action`/
  `srcset`/`formaction`/`poster` attributes, text, payloads, errors,
  diagnostics): the values of credential query parameters become
  `[redacted]`, as do those in a fragment that carries `=`, and `user:pass@`
  is removed. The parameters are `_proxy_token` (the Epic preview gate token),
  `token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`,
  `auth`, `authorization`, `api_key`, `apikey`, `key`, `secret`,
  `client_secret`, `signature`, `sig`, `x-amz-signature`, `password`,
  `session`, `jwt`, and any name containing `token`, `secret` or `password`.
- **CSS**, wherever it is recorded (`style` attributes and their structured
  diffs, a stylesheet's `_cssText`, `insertRule`/`replace`/`replaceSync`,
  `setProperty`, adopted stylesheets): credential values inside `url(...)`,
  `@import` and any `?name=value` pair are redacted with the same list, and
  the rules keep their structure. A CSS or URL field of an unexpected shape is
  dropped rather than recorded. Embedded frame sources (`rr_src`) are
  sanitized as URLs.
- **Payloads** of custom and plugin events: keys that look like credentials are
  redacted, strings are capped at 1,024 characters, depth at 6, arrays and
  objects at 50 entries, and a payload whose JSON is larger than 16,384 UTF-8
  bytes becomes `{ truncated: true }`.
- **Buffer**: the in-memory buffer is bounded by the policy's
  `maxBatchEvents x 10` events and `maxBufferBytes`, measured as the UTF-8
  bytes of the retained events serialized as one JSON array. Over the bound it
  drops whole recording boundaries, oldest first; a boundary that alone is too
  large is dropped entirely, so a consumer never holds incremental events
  without their FullSnapshot.
- **Errors**: name, message and stack are bounded and have their URLs
  sanitized.
- **Diagnostics**: a network entry keeps only method, sanitized URL, status,
  duration and the `traceparent` trace id of the request. Request and response headers and bodies are never included, and
  the replay configuration, ingestion and report endpoints (`/api/epic/replay/*`)
  are never diagnosed.

## Upload and reports

The recorder feeds `createReplayRecordingPipeline` (`lib/replay/`), mounted once
by `EpicReplayProvider` in the root layout. Nothing leaves the browser except
through this application's own routes under `/api/epic/replay`, which relay to
Epic with the server's publishing credential.

- **Ownership.** Project, application and environment come from the credential,
  the subject from the server's identity: `sub_` plus an HMAC of the signed-in
  user id (or a protected visitor id) under `BETTER_AUTH_SECRET`. The browser
  never sends a subject, project, environment or Epic id; the relay rebuilds
  each OTLP resource from its session id and release, adds the subject
  (`epic.subject.id`, which Epic stores only as a hash) and the coarse capture
  context, and drops every `epic.*`, `deployment.environment.name` and
  `service.name` attribute the browser sent. Rotating the publishing token does
  not change a subject.
- **Anonymous visitors** are off by default. `EPIC_REPLAY_ANONYMOUS_CAPTURE=allow`
  (recording) and `EPIC_REPLAY_ANONYMOUS_REPORTING=allow` (reports) let
  `POST /api/epic/replay/identity` mint a signed, HttpOnly visitor cookie scoped
  to `/api/epic/replay`. Telemetry and reports never mint one; a client that
  blocks the cookie fails closed.
- **Sessions.** The session id (`rum.sessionId`) is 32 hex characters from
  `crypto.getRandomValues`, kept in `sessionStorage` with its start and last
  activity. A reload within 15 minutes of inactivity continues it, with its
  `rr-web.offset` counter; 15 minutes idle or 4 hours of age starts a new one,
  and a new session always opens with a new Meta and FullSnapshot.
- **Requests.** Records wait in bounded memory (`maxBufferBytes`,
  `maxBufferAgeMs`, measured on the monotonic clock). One request is in flight;
  its records (one session, in order, at most `maxBatchBytes` of event bytes and
  `maxBatchEvents` records) are frozen before the first attempt and only that
  request is retried (up to `maxAttempts`, backoff 500 ms, 1 s, 2 s) after a
  network error, `unavailable` or `rate_limited` (which waits `Retry-After`). A
  request leaves after `flushIntervalMs`, once `flushBytes` are queued, or when
  the tab turns hidden (with `keepalive` when it fits 64 KB). A retried request
  may already be stored: Epic's playback drops exact duplicate records. A record
  larger than the request budget ends capture as "snapshot too large"; nothing is
  truncated.
- **A boundary that cannot continue** (every attempt failed, or the buffer was
  exceeded) is never renumbered or continued past a gap: within a restart
  budget of `maxAttempts` that refills only after a boundary uploads two
  requests, a new boundary starts with a new FullSnapshot. A rotated session
  restarts the boundary without spending the budget.
- **Evidence.** `epic.behavior.*` markers and uncaught errors / unhandled
  rejections are also sent as plain log records (scope `epic.evidence`) with
  the session id, a route (pathname only) and a bounded, redacted text body,
  regardless of replay sampling.
- **Evidence stays unverified.** An accepted request is never presented as
  playable; only Epic can verify playback.
- **Reports** (`POST /api/epic/replay/reports`) work with capture off. The form
  freezes the moment, route, build and session reference (session id, session
  start, millisecond offset, the last request's trace id and the last behavior
  marker) when it opens, before the form renders; nothing typed is part of it.
  Submitting first flushes the queued telemetry so the session reaches Epic
  first, keeps the draft on failure, and resends the same idempotency key (also
  on a 503). If Epic refuses the reference (`invalid_evidence`) the form offers
  to send the report without a session. The button and form are `data-private`.
- **Markers.** `useEpicReplay().event(name, payload)` records
  `epic.screen.viewed`, `epic.behavior.started|succeeded|failed` and
  `epic.bug.reported` with only `behaviorId`, `occurrenceId` and `reportId`;
  navigation (`epic.navigate`) and uncaught errors / unhandled rejections
  (`epic.error`) are recorded by the provider. Without a running recording the
  replay markers do nothing; behavior and error evidence is still sent while
  the other gates pass.
- **Trace context.** While capture is allowed, same-origin `fetch` and XHR
  calls (never `/api/epic/replay/*`, never another origin) carry a `traceparent`
  header with a random trace id; the server continues it (see
  [replay-adoption.md](./replay-adoption.md#server-tracing)).

## Diagnostics

Console and network context are separate policy switches (Recording settings →
Diagnostics), both off by default (`lib/replay/replay-diagnostics.ts`).

- **Console:** `console.warn` and `console.error` only, as `epic.console`
  `{ level, message }`. Logged objects go through the payload redaction first
  (sensitive keys lose their values); the text then loses addresses, JWTs,
  auth headers, provider keys, `password=…` pairs and long hex secrets, and is
  cut at 500 characters.
- **Network:** `fetch` and `XMLHttpRequest`, as `epic.network`
  `{ method, url, status, durationMs, traceId? }`. The URL is the path for this site (the
  origin only for another one), never the query or fragment, with id- and
  token-like segments replaced by `:id`; headers and bodies are never read.
  `/api/epic/replay/*` and the framework's own requests
  (`/_next/`, `/__nextjs*`) are never recorded.
- Events land only while the capture session records, so consent, route and
  expiry gates apply. Each stream is capped (20 events per 10 s, 300 per page).
- Each recorded boundary carries `epic.diagnostics` `{ console, network }`,
  again whenever a switch changes, so the Builder can say a stream was not
  collected rather than show an empty panel as if nothing happened.
- The wrappers call the page's original functions with the same arguments and
  return their results (a failed `fetch` stays rejected). Switching a stream
  off, or disposing the provider, restores the originals — unless another
  library patched on top, in which case ours is left in place, inert.
