# Replay privacy

How Epic Replay decides whether to record, and what it hides when it does.
Everything here runs in the browser before an event enters a buffer. The
modules live in `lib/replay/`; the development harness at `/styleguide/replay`
exercises them against synthetic content.

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
- The template keeps consent in memory only. The host's consent and disclosure
  policy decides what to remember, and calls `grant()` again on load.
- `withdraw()` stops the recorder before it returns and clears the local
  buffer and any pending start, whichever gate is then reported as the reason
  (an expired or disabled policy does not keep earlier events). It does not delete recordings already uploaded; deletion is a
  separate Epic responsibility, and no UI may claim otherwise.
- `app/styleguide/replay/behaviors/manage-replay-consent/` shows how a consent
  UI wires to it.

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
  the rules keep their structure. Raw CSSOM resource URLs or URL function names
  containing CSS escapes are replaced with a safe placeholder, including hex
  escapes and escaped delimiters; those assets are omitted from replay. Ordinary
  escaped selectors (including Tailwind selectors) remain unchanged. A CSS or URL field of an unexpected shape is
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

## Upload

`lib/replay/replay-uploader.ts` turns each capture boundary into one recording
and sends it through this application's same-origin relay
(`POST /api/epic/replay/recordings`, `.../[recordingId]/capability`,
`.../[recordingId]/batches`), which forwards it to Epic central ingestion
(EPI-210 v1). The browser never talks to Epic or rrweb Cloud directly and
never holds a publishing credential. The development harness at
`/styleguide/replay/upload` drives it against the real relay or a labelled
synthetic fixture.

### Identity and ownership

- Project, application and environment come only from the server's publishing
  credential (`EPIC_API_URL`, `EPIC_PROJECT_ID`, `EPIC_PUBLISHING_TOKEN`).
- The subject is an opaque `sub_...` HMAC derived on the server from the
  signed-in user id, keyed with the stable `BETTER_AUTH_SECRET` - never the
  rotating publishing token, never an email or name. Rotating the publishing
  token keeps every subject; rotating `BETTER_AUTH_SECRET` starts new ones.
- Anonymous capture is off by default. With
  `EPIC_REPLAY_ANONYMOUS_CAPTURE=allow`, the same-origin `POST /identity`
  mints a random visitor id in a signed, HttpOnly `epic-replay-visitor`
  cookie scoped to `/api/epic/replay`. It creates no recording or central state.
  The uploader waits for that acknowledgment before registration, which requires
  the existing protected identity. Lost bootstrap responses are harmless; a lost
  registration response retries under the same subject. A missing/tampered or
  browser-blocked cookie cannot silently mint a replacement during registration.
  `DELETE /identity` clears only this cookie for the provider's account boundary;
  both methods require same-origin JSON `{ contractVersion: 1 }` and answer the
  same no-store acknowledgment. Authentication cookies remain untouched.
- A browser body carrying `subjectId`, `projectId`, `applicationId`,
  `environment`, `captureContext`, a Cloud id or any unknown field is a 400
  `invalid_request`. A recording id this server never bound to the current
  subject answers the same 404 `recording_not_found` as an unknown one.
- Missing credential or identity secret answers 503 `not_configured`; no other
  write path is tried.

### What is sent

The registration carries a frozen idempotency key, the first event's
`startedAt`, a safe pathname (no query or fragment), recorder and config
versions, the document's own build release (or null - never the server's
current deployment) and a clamped viewport. The server adds the subject and a
coarse `captureContext` (browser and OS family with a 1-4 digit major version,
device class, viewport) parsed from its own request. It persists that
normalized payload and resends it verbatim on a retry under the same key, so a
later User-Agent or deployment change never re-derives it; a changed body
under the same key is a 409 `idempotency_conflict`. Raw User-Agent, IP,
location, cookies, title, referrer and screen size are never collected or
forwarded, and the relay never copies incoming headers upstream. The browser-only
viewport is projected into `captureContext`; it is not a central top-level field.
Raw events and recording capabilities are never stored in the local database.

### Bounds

- No batch is sent before a successful registration. Meanwhile events wait in
  memory bounded by `maxBufferBytes` and `maxBufferAgeMs`, measured from the
  oldest held event on a monotonic clock; a forward wall-clock jump or a
  suspension counts as elapsed time, a backward jump never extends retention.
  Over either bound the recording ends `buffer_exceeded` and its local events
  are discarded.
- Batches hold at most `maxBatchEvents` events and their complete UTF-8 JSON
  request, plus a 128-byte allowance for the subject the server injects, is at
  most `maxBatchBytes` (1 MiB). The relay enforces the same limit on the bytes
  actually streamed and again on the augmented central request; there is no
  extra envelope allowance. An event that alone exceeds the limit (typically a
  FullSnapshot) ends the recording `snapshot_too_large`: never truncated,
  never fragmented.
- One request is in flight across the transport, including a closing recording.
  Current and closing recordings share one private-data buffer budget. Fetches
  have a 12-second deadline within remaining retention and are aborted on
  withdrawal, disposal or expiry. A batch's id, sequence, events and
  `final` flag are frozen before its first attempt, and only that frozen body
  is ever retried: up to `maxAttempts` (3) for network errors, 503 and 429,
  with backoff 500 ms, 1 s, 2 s and any `retryAfterMs`. Offline, no attempt is
  spent and the retention bounds keep running.
- Per-subject server rates: 10 registrations, 30 capability renewals and 120
  batches per minute.

### Uncertainty and availability

- `capability_expired` renews once and resends the identical batch; renewal's
  `nextSequence` never renumbers it. `out_of_order` ends the recording as
  incomplete.
- `delivery_uncertain` is never resent: the recording is quarantined, its
  local events discarded, and - at most `maxAttempts` times per page - a fresh
  recording starts with a new key and a new FullSnapshot.
- Central receipts are the authority. A recording the server has cached as
  closed or quarantined still reaches Epic, so an exact retry recovers its
  original accepted or finalized acknowledgment.
- The state's `evidence` is always `"unverified"`. "Registered" and "Pending -
  received, playback not verified" are the furthest a recording gets here;
  `finalized` (an empty final batch) is metadata only. Only a central
  provider-read check can make a recording playable, and this template has none.
- Withdrawing consent stops capture and drops queued local data. It does not
  delete anything already uploaded, and earlier recording references stay in
  the transport's history.
