# Replay privacy

How Epic Replay decides whether to record, and what it hides when it does.
Everything here runs in the browser before an event enters a buffer. The
modules live in `lib/replay/`; the development harness at `/styleguide/replay`
exercises them against synthetic content.

The canonical root mounts one lazy EpicReplayProvider. It records nothing until
runtime policy, consent, route, sampling and acknowledged identity all permit
capture. The recorder chunk loads only after these gates and DOM readiness.

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
  local events discarded, and - at most `maxAttempts` automatic rotations - a
  fresh recording starts with a new key and a new FullSnapshot. Root recovery
  debt survives remounts, automatic boundaries and successful reload handoff.
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

## Root lifecycle and public context

`useEpicReplay()` in `shared/hooks/use-epic-replay.hook.ts` exposes meaningful
status/reason, a registered immutable reference, snapshot receipt and continuity.
It is harmless outside the provider. Event/buffer counters are isolated in
`useEpicReplayDiagnostics()`; render that opt-in view under `data-private`.
Registration, snapshot receipt and playable evidence are separate facts.

The server root passes deliberately public `NEXT_PUBLIC_EPIC_DOCUMENT_RELEASE`.
The first value is frozen for that document, even if a router refresh or runtime
policy reports a different deployment. `getDocumentRelease` never reads refreshed
policy.release. Unknown release is null and cannot prove reload continuity.
Frozen report inputs retain their original recordingId, millisecond startedAt
and offset; this provider does not implement or reassign report storage.

Authentication entry hooks stop replay synchronously before changing accounts.
The redirecting sign-out navigation also invalidates capture. A new identity
waits for visitor reset acknowledgment where needed, then identity POST
acknowledgment. These requests are serialized and cancellable; replay failures
never block authentication. Ordinary reload and publishing-token rotation do
not reset the visitor. A non-secret pending-reset marker may survive an actual
auth navigation, but no identity, consent, raw event or capability is persisted.

rrweb 2.2.0 can emit DOMContentLoaded/Load before its opening snapshot when
initialized while loading. Every capture start/restart waits for readiness and
stages a valid Meta/FullSnapshot pair. Fresh startedAt is the actual Meta
timestamp. Waiting and staged capture are cancelled on loss of permission.

### Proposed pilot defaults

Provider `lifecycle` options are local public configuration, not new central v1
fields and not prior measured acceptance:

| Option | Default | Accepted range |
| --- | --- | --- |
| maxDurationMs | 30 minutes | 1–60 minutes |
| inactivityMs | 5 minutes | 30 seconds–15 minutes, bounded by duration |
| handoffWindowMs | 15 seconds | 1–30 seconds |

Invalid options fall back to bounded defaults. Activity tracks only coarse
trusted user-event timestamps, never keys or content. Idle capture stops until
activity returns. Expiry and policy gates always win over lifecycle timers.
Three automatic recovery rotations is the maximum (policy may lower it).
Registration and the initial snapshot alone do not replenish that budget;
healthy capture must last at least 30 seconds with three acknowledged non-final
batches including post-opening activity, or the host must explicitly restart.

## Cooperative clean reload handoff

Only a registered non-final stream with an acknowledged opening snapshot and
an empty, settled ACK frontier can hand off. The old recorder and timers are
detached before eligibility is checked. No queued/inflight/retry/closing work
or unknown delivery is discarded to manufacture a clean frontier.

The predecessor holds a cooperative Web Lock throughout recording. Shared
IndexedDB metadata prearms a one-shot generation while the page is alive.
Eligible pagehide writes a strict metadata-only sessionStorage checkpoint
(at most 8 KiB), then retires the old capability locally and releases ownership.
Only this branch skips the existing final:true pagehide path. The shared ledger
is bounded to 100 live records and never overwrites a consumed generation.

A successor requires a real reload, no opener/BFCache/history/discarded recovery,
fresh consent/configuration/identity, matching known document release and effective
configuration, and the same exclusive lock. It atomically consumes the generation
before network work, resends the exact original registration, and requires the
same recordingId, original startedAt and exactly the locally acknowledged
nextSequence. Fresh registration still rejects nonzero nextSequence. An advanced
server cursor is never adopted. A fresh Meta/FullSnapshot is appended under that
same durable recording; “resumed” appears only after its ACK. Actual timestamps
preserve the gap. Closed or uncertain streams cannot be reopened.

No raw events, capabilities, cookies or auth data enter the checkpoint. Only
immutable registration/receipt metadata, context fingerprint and remaining
lifecycle/recovery bounds are retained. Missing locks/storage, stale or malformed
metadata, changes of subject/context or lost ACKs require conservative rotation.
Fresh unique recordings may still work with document-local ownership when browser
locks/storage are unavailable; they cannot reuse an existing stream.

These are cooperating producers within one browser storage bucket. An
indistinguishable cloned candidate may race; exactly one consumer can win, all
losers start fresh. This is not cryptographic physical-tab identity or a central
producer fence: older capabilities remain valid centrally.

### Expiry and the central lifecycle boundary

The reload window starts at the clean offer and cannot be extended by retries;
preparation itself has a 60-second cap. Duration/inactivity/recovery debt is
carried forward. Expired metadata prevents reuse, not server cleanup.

Pagehide cannot know whether a successor will reload. A skipped final with no
successor leaves a stale unresumed open row; current central v1 has no idle-close
operation. Open is never evidence of active recording. Dirty/unacknowledged
unload is incomplete/uncertain, and only an acknowledged final is closed.

Before production handoff, Builder/central owners must settle stale-row
classification, reconciliation/retention and actual same-recording list/player
behavior. Broader continuity needs reviewed durable subject-scoped logical
session/predecessor/ordinal metadata, atomic continuation/fork prevention, explicit
gaps and Builder consumption. Those fields/endpoints are not invented here.

### Verification boundaries

Vitest covers the real pinned recorder's loading sequence, cancellation, bounded
root recovery, exact same-recording fixture handoff, stale/clone/expiry rejection,
identity barriers, stable context and existing real Route/Service/SQLite paths.
The synthetic fixture is not Cloud receipt, append/playback or production-readiness
evidence. Native browser verification remains a separate read-only phase, using
synthetic accounts/content and a controlled relay fixture surviving documents.
No live customer capture is needed for these local tests.
