# Epic replay markers

The browser API is `useEpicReplay()` from
`shared/hooks/use-epic-replay.hook.ts`. Features do not import rrweb, open another
recorder, or send a separate event request. Markers pass through the permitted
root recorder, sanitizer and bounded same-origin HTTP upload pipeline.

`lib/replay/replay-marker.contract.ts` is the single browser-safe version-1
producer contract. `lib/replay/tests/fixtures/epic-markers.v1.json` is a synthetic
consumer fixture. The Builder owner has agreed to this producer envelope and
its limits in WEB-5's coordination record. EPI-197 reader implementation still
awaits the verified exports; that agreement does not establish reader,
deployment or Cloud playback acceptance.

## Emit a behavior occurrence

Use static developer-defined behavior IDs and a fresh opaque occurrence UUID.
Never use input text, an email address, an account ID or a secret as an ID.

```tsx
const { track } = useEpicReplay();

async function handleSave() {
  const payload = {
    version: 1 as const,
    behaviorId: "settings.save",
    occurrenceId: crypto.randomUUID(),
  };
  track({ tag: "epic.behavior.started", payload });
  try {
    await saveSettings(); // The application's existing operation.
    track({ tag: "epic.behavior.succeeded", payload });
  } catch (error) {
    track({ tag: "epic.behavior.failed", payload: { ...payload, code: "save_failed" } });
    throw error; // Preserve the application's normal error handling.
  }
}
```

The start and terminal calls share one occurrence. A marker does not confirm
a bug, create an issue, or change the operation result. Tracking does not
automatically instrument application features.

## Contract and privacy

Markers are rrweb Custom events: `type: 5`, recorder-owned `timestamp`, and
`data: { tag, payload }`. The payload includes `version: 1`. No extra EPI-210
transport field is added.

| Tag | Allowlisted payload beyond version |
| --- | --- |
| `epic.screen.viewed` | Sanitized route; optional static screenId. |
| `epic.behavior.started` | Optional behaviorId and occurrenceId. |
| `epic.behavior.succeeded` | Optional behaviorId and occurrenceId. |
| `epic.behavior.failed` | Optional behaviorId, occurrenceId and static code. |
| `epic.bug.reported` | Guarded acknowledged reportId; optional behaviorId and occurrenceId. |
| `epic.browser.error` | Allowlisted errorClass and fixed `source: "uncaught_error"`. |
| `epic.browser.unhandled_rejection` | Allowlisted errorClass and categorical reasonKind. |

The parser projects known fields before serialization. Unknown fields, free
report text, error messages/stacks, rejection values, user identity and arbitrary
metadata are absent. Invalid IDs are rejected, never truncated. IDs/codes have
a 128-character limit, occurrence IDs must be UUIDs, safe routes have a
512-character limit, and normalized marker data is limited to 2,048 UTF-8 bytes.
Projection is not permission to pass user input in an allowed field.

The explicit route map in `sanitizeMarkerRoute` removes queries/fragments and
uses route templates for supported dynamic paths. Unknown routes become
`/[redacted]`. Extend that map when adding a screen; never copy dynamic resource
values into it. The route map does not change capture eligibility.

Browser failures use a fixed standard error-class enum and categorical reason
kind, with generic fallbacks. The root owns listeners and cleanup. It leaves
native browser error handling intact, captures no arbitrary resource-event
targets, and does not patch console or fetch. Reentrant telemetry failure is
contained. Navigation reuses provider lifecycle signals; query/hash-only
changes do not create screen markers.

## Results, readiness and bounds

`track(input)` never throws to application code. It returns either
`{ status: "emitted" }` or `{ status: "dropped", reason }`.

| Reason | Meaning |
| --- | --- |
| `provider_unavailable` | No provider/runtime is available, including SSR defaults. |
| `capture_not_permitted` | Policy, consent, route, identity or ownership currently prevents capture. |
| `recording_unavailable` | A registered active recording/opening snapshot is unavailable. |
| `invalid_payload` | Unsupported or invalid marker data, or an attempt to bypass the report guard. |
| `rate_limited` | The bounded document marker budget is exhausted. |
| `stale_reference` | A frozen report context no longer matches its permitted recording. |
| `recorder_unavailable` | The recorder could not safely admit the marker. |
| `marker_too_large` | The complete event cannot fit the negotiated batch capacity. |
| `duplicate` | A report acknowledgment already emitted its marker. |

Emitted means **local recorder admission**. It is not a receipt, durable
retention, or playable evidence. Dropped calls do not start/load a recorder,
retain payloads for later enablement, or retry on a replacement identity. A
disabled call is gated before inspecting the payload. The same gates are
checked again at admission.

Ordinary `track` targets the permitted current recording **at call time**. A
caller completing older asynchronous work must not treat that as attribution
to the recording where its work started. Reports use the frozen-reference
guarded method instead. Screen markers also obey the budget: a rate-limited
screen marker is dropped for that transition, without a deferred retry when
tokens refill. The next distinct transition or recording boundary may emit.

The per-document marker budget starts with a burst of 20 and replenishes at
120/minute; automatic browser errors have a further 10/minute allowance.
Ordinary remounts do not replenish the budget. Complete Custom events are
preflighted against negotiated batch limits before uploader admission. An
oversized marker is dropped without turning a healthy recording into a
snapshot-size failure. Existing buffer/recovery bounds continue to apply.

## Frozen recording evidence

`getEvidenceReference()` returns a frozen safe value or `null`:
recordingId, original startedAt, boundary, document release, registration
configVersion, capturedAt and offsetMs. It exposes no capability, credential,
Cloud UUID or subject identity and is never an ownership proof.

Both clocks are client milliseconds. For a marker, derive its position as
`event.timestamp - originalRecording.startedAt`; the original rrweb timestamp
is authoritative. A selected report moment uses one current client clock
reading minus that same start. A resumed recording retains the original start,
including the gap before the later Meta/FullSnapshot. No seconds conversion,
server receive-time substitution or resume-time rebasing is supported.

Release comes from the document-frozen provider value. A build-A document
remains build-A even when refreshed backend policy reports build-B and a new
recording is started. Each recording's registration configVersion is separate.
Keep a frozen report value unchanged through submission/retry; do not replace
its context with a later `getEvidenceReference()` result.

## Report acknowledgment boundary

Ordinary `track` cannot emit `epic.bug.reported`. A report consumer must freeze
evidence first, complete durable submission, then call
`trackAcknowledgedReport(ack, frozenEvidence)`. The local adapter accepts
`{ durable: true, reportId, behaviorId?, occurrenceId? }`. This is **not an
EPI-211 response schema**, and a boolean supplied by application code is not
server authorization or proof of persistence. A production consumer must map
its verified durable acknowledgment explicitly.

Only a still-permitted matching recording/context/identity epoch can emit the
marker. Pending or failed submissions emit none. A repeated acknowledgment is
deduplicated. Rotation, revocation, stop/restart or loss of attribution causes a
drop; the API never reopens an old recording or places its marker on a
replacement. Marker time is acknowledgment-time emission; the report's frozen
moment remains separate. Report counts and associations remain authoritative
database data and must never be inferred from markers. This checkout has
synthetic contract tests, no report submission UI or production report-storage
endpoint.

## Inspect and verify

`useEpicReplayDiagnostics()` is opt-in and separate from ordinary provider
state. Render it inside `data-private`; its ring contains at most 50 sanitized
marker summaries. It is not another upload queue. The existing styleguide at
`/styleguide/replay/upload` provides real local successful/failed operations,
browser failure buttons and a frozen evidence display. Controls remain usable
when tracking drops. Its synthetic target is explicitly document-local;
automatic browser/navigation listeners belong to the application root.

Follow [Synthetic local Replay verification](replay-verification.md) for the
actual pinned recorder + root + BFF + local-relay path. An inactive relay policy
is incomplete setup; the in-browser fallback cannot replace that evidence.
Automated tests, browser acceptance, local relay receipt, deployed central
acceptance, Builder consumption and Cloud playback are distinct results.

External work stays with the epic-build owner: EPI-197 implements and verifies
consumption of the agreed producer fixture, EPI-196/EPI-199 verify millisecond
positioning, and the EPI-211 consumer verifies durable acknowledgment mapping.
No real Cloud keys or customer recordings are needed for these local checks.
