# Replay privacy

How Epic Replay decides whether to record, and what it hides when it does.
Everything here runs in the browser before an event enters a buffer. The
modules live in `lib/replay/`; the development harness at `/styleguide/replay`
exercises them against synthetic content. Turning Replay on, or adding it to an
existing app, is in [replay-adoption.md](./replay-adoption.md).

Adding this code records nothing. No capture session runs outside the harness
until the root provider mounts one, and even then nothing is recorded until the
host application grants consent.

## Consent

```ts
import { epicReplayConsent } from "@/lib/replay/replay-consent";

epicReplayConsent.grant();    // the person agreed under the host's disclosure
epicReplayConsent.withdraw(); // stops capture now
```

- The state starts `"unknown"`, which records nothing. Consent is never
  inferred from the policy, the environment or a provider being mounted.
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
| `consent_absent` | The host has not called `grant()` |
| `consent_withdrawn` | The host called `withdraw()` |
| `route_excluded` | The current route is not eligible |
| `not_sampled` | This session was not selected by the sample rate |

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
- **Diagnostics**: a network entry keeps only method, sanitized URL, status and
  duration. Request and response headers and bodies are never included, and
  the replay configuration, ingestion and report endpoints (`/api/epic/replay/*`)
  are never diagnosed.

## Upload and reports

The recorder feeds `createReplayRecordingPipeline` (`lib/replay/`), mounted once
by `EpicReplayProvider` in the root layout. Nothing leaves the browser except
through this application's own routes under `/api/epic/replay`, which relay to
Epic with the server's publishing credential.

- **Ownership.** Project and environment come from the credential, the subject
  from the server's identity: `sub_` plus an HMAC of the signed-in user id (or a
  protected visitor id) under `BETTER_AUTH_SECRET`. The browser never sends a
  subject, project, environment or Epic id, and the routes reject them. Rotating
  the publishing token does not change a subject.
- **Anonymous visitors** are off by default. `EPIC_REPLAY_ANONYMOUS_CAPTURE=allow`
  (recording) and `EPIC_REPLAY_ANONYMOUS_REPORTING=allow` (reports) let
  `POST /api/epic/replay/identity` mint a signed, HttpOnly visitor cookie scoped
  to `/api/epic/replay`. Registration and reports never mint one; a client that
  blocks the cookie fails closed.
- **Registration first.** Events wait in bounded memory (`maxBufferBytes`,
  `maxBufferAgeMs`, measured on the monotonic clock) until Epic returns a
  recording id; `startedAt` is the first event's timestamp and survives retries.
- **Batches.** One request in flight; each batch's id, sequence and events are
  frozen before the first attempt and only that batch is retried (up to
  `maxAttempts`, backoff 500 ms, 1 s, 2 s). An expired capability is renewed and
  the identical batch resent. A single event larger than `maxBatchBytes` ends the
  recording as "snapshot too large"; nothing is truncated.
- **Uncertain delivery** (`delivery_uncertain`, `out_of_order`, a closed
  recording) is never resent or renumbered: the recording is marked incomplete and,
  within a restart budget of `maxAttempts` that refills only after a recording
  uploads two batches, a new recording starts with a new key and FullSnapshot.
- **Evidence stays unverified.** A registration or accepted batch is never
  presented as playable; only Epic can verify playback.
- **Reports** (`POST /api/epic/replay/reports`) work with capture off. The form
  freezes the moment, route, build and recording reference (with its
  recording-relative millisecond offset) when it opens, keeps the draft on
  failure, and resends the same idempotency key. The button and form are
  `data-private`.
- **Markers.** `useEpicReplay().event(name, payload)` records
  `epic.screen.viewed`, `epic.behavior.started|succeeded|failed` and
  `epic.bug.reported` with only `behaviorId`, `occurrenceId` and `reportId`;
  navigation (`epic.navigate`) and uncaught errors / unhandled rejections
  (`epic.error`) are recorded by the provider. Without a running recording they
  do nothing.

## Diagnostics

Console and network context are separate policy switches (Recording settings →
Diagnostics), both off by default (`lib/replay/replay-diagnostics.ts`).

- **Console:** `console.warn` and `console.error` only, as `epic.console`
  `{ level, message }`. Logged objects go through the payload redaction first
  (sensitive keys lose their values); the text then loses addresses, JWTs,
  auth headers, provider keys, `password=…` pairs and long hex secrets, and is
  cut at 500 characters.
- **Network:** `fetch` and `XMLHttpRequest`, as `epic.network`
  `{ method, url, status, durationMs }`. The URL is the path for this site (the
  origin only for another one), never the query or fragment, with id- and
  token-like segments replaced by `:id`; headers and bodies are never read. `/api/epic/replay/*` and the framework's own requests
  (`/_next/`, `/__nextjs*`) are never recorded.
- Events land only while the capture session records, so consent, route and
  expiry gates apply. Each stream is capped (20 events per 10 s, 300 per page).
- The wrappers call the page's original functions with the same arguments and
  return their results (a failed `fetch` stays rejected). Switching a stream
  off, or disposing the provider, restores the originals — unless another
  library patched on top, in which case ours is left in place, inert.
