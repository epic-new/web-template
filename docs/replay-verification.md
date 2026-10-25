# Synthetic local Replay verification

This fixture is an external API stand-in for WEB-4/WEB-5. It exercises the application's
real `/api/epic/replay/*` BFF and root provider. State lives in a separate process,
so browser reloads retain registrations, idempotency receipts and sequence state.
It never calls Epic central or rrweb Cloud. It is not evidence of Cloud receipt,
playback, Builder behavior, or conformance to an independently supplied central
schema. The existing in-browser synthetic target remains document-local.

## Setup

Use only the synthetic seeded accounts/content and this checkout. The application
preview must already be owned by Epic; do not start or stop Next.js. All scratch
files and captured evidence belong under `.agent-runs/` in this checkout.

1. Keep a private backup of the preview's current environment in `.agent-runs/`.
   Provision these **temporary synthetic values** for the Epic-managed preview:

   ```dotenv
   EPIC_API_URL=http://localhost:4319
   EPIC_PROJECT_ID=synthetic-web4
   EPIC_PUBLISHING_TOKEN=synthetic-web4-local-only
   EPIC_ENVIRONMENT=development
   EPIC_REPLAY_ANONYMOUS_CAPTURE=allow
   NEXT_PUBLIC_EPIC_DOCUMENT_RELEASE=synthetic-build-A
   ```

   Preserve `BETTER_AUTH_SECRET`, `DATABASE_URL`, and the exact existing HTTPS
   `NEXT_PUBLIC_BASE_URL`/`BASE_URL`. Never edit `.env.test`. If the preview inherits
   conflicting process environment, its owner must apply the values; do not
   replace its process with a second server. The public build release must be
   present when that document is generated; refreshing policy cannot add it.

2. Start only the fake external API, in a separate terminal at this checkout:

   ```sh
   bun run replay:fixture
   ```

   It binds `127.0.0.1:4319` only and prints **SYNTHETIC Replay relay**. It requires
   the fixed synthetic sentinel above, rejects production mode, non-loopback
   hosts and browser Origin headers, and provides no CORS. It has no outbound
   network calls or filesystem persistence. Stop it with Ctrl-C; it also closes
   after one hour. `REPLAY_FIXTURE_PORT` may select another local port if the
   preview configuration is changed to match.

3. Use the project's existing seeded user-1 and user-2 credentials. If they need
   reconciliation, `bun run db:seed` writes the normal ignored credentials file
   under `db/seed/.credentials/`; do not put credentials into evidence. Confirm
   the real `/api/epic/replay/config` response is active with configVersion `4`,
   environment `development`, 100% sampling and masked inputs. A disabled policy
   means setup is incomplete; do not use the harness's synthetic fallback to
   claim application-relay verification.

4. On `/styleguide/replay/upload`, select **Application relay** and explicitly
   grant consent. This target uses real application routes backed by the local
   synthetic API. Label every captured artifact **synthetic local relay**.
   The controlled policy includes `/styleguide/replay/*` and `/auth/signin`, and
   excludes `/styleguide/replay/excluded`; production route/auth guards are intact.

## Diagnostics and deterministic controls

Only local CLI/BFF clients can access the fixture. These commands use a public
synthetic sentinel, never a real credential:

```sh
curl -sS -H 'Authorization: Bearer synthetic-web4-local-only' \
  'http://localhost:4319/__synthetic/state'

curl -sS -X POST -H 'Authorization: Bearer synthetic-web4-local-only' \
  -H 'Content-Type: application/json' \
  --data '{"mode":"advanced_cursor_next_retry"}' \
  'http://localhost:4319/__synthetic/control'
```

State contains recording/start/release, opaque diagnostic subject ordinals,
sequence, status, the last 128 batch metadata entries and at most 50 validated
marker summaries. It never returns raw event payloads, real subject identifiers,
capability tokens, cookies or credentials.
Registration/event hashes are SHA-256; raw events are discarded after validation.
Memory is bounded to 100 recordings, 2,000 receipts, 1,000 capabilities, 128 call
entries, 50 marker summaries and 10,000 requests, with a 1 MiB request ceiling
and 16 connections.
When capacity is exhausted, restart the fixture to begin a new synthetic run.

| Mode | Effect |
| --- | --- |
| `accept` | Normal synthetic acknowledgments; clears a pending fault. |
| `advanced_cursor_next_retry` | The next successful exact registration retry advances central fixture state by one. The browser must reject its old frontier. |
| `close_next_append` | Close the stream immediately before the next batch, after any successful resume registration. The first resumed append returns `recording_closed`. |
| `lose_next_receipt` | Accept the next batch, retain its immutable receipt, then drop the connection. An exact in-memory retry recovers it once. |
| `lose_next_registration` | Accept the next registration, then drop its response. |
| `offline` | Drop publishing requests until changed to `accept`. |
| `fail_503` | Reject new batches with `unavailable` until reset. |
| `tiny_batch` | Negotiate a 2,048-byte budget on newly registered recordings. |

Finalization closes the fixture row, and empty finalization does not simulate a
provider append. A closed row cannot reopen. Lost receipts do not prove a clean
local frontier; no server cursor repairs unknown local history.

## Verify scenarios and evidence

Wait for **Eligible acknowledged frontier** before offering a reload. Regrant
consent within 15 seconds after reload; consent is never copied. Compare the same
recordingId, original startedAt and increasing acknowledged sequence, with a
fresh `[4, 2]` Meta/FullSnapshot pair and later actual timestamps. “Resumed” must
wait for that snapshot ACK. A normal opener tab needs a different recording.
Clone contention is covered at the lock/one-shot-ledger test boundary: only one
consumer can resume, every loser must start fresh. This is cooperative ownership,
not physical-tab lineage or a central producer fence.

For identity, grant consent before logout. Use the existing sign-out control,
observe a new anonymous boundary on `/auth/signin`, then sign in as user-2 and
compare distinct `subject-1`/`subject-2`/`subject-3` diagnostic ordinals and recording
IDs. They are opaque local labels, not identities. Replay failure must not delay
these forms. Test offline/rejection, route exclusion and withdrawal independently.

Repeat direct use inside the **actual existing Epic preview host** with its owner.
A local iframe demonstrates only local framing and must be labeled separately;
it cannot close the Epic-host acceptance item. This checkout does not create or
modify a Builder destination. Cross-contract acceptance requires exercising the
actual central v1 batch schema against the emitted BFF wire payload using a
completed integration source explicitly authorized by the owning issue. No
second hand-written fake schema establishes that proof.

The automated tests use Vitest with one worker and `GOMAXPROCS=2`. Coverage spans
the real pinned recorder's loading lifecycle, atomic batch packing, revalidation,
monotonic handoff/clone contention, real auth/identity/Route→Service→SQLite, the
runtime through the real BFF against this relay, and frozen evidence/reference
inputs. The latter uses an explicitly synthetic consumer boundary because the
report submission UI/Controller is owned by later issues.

### Regression coverage for lifecycle races

These automated boundaries prepare the browser verification above; they do not
replace actual Epic-host or Cloud evidence.

| Scenario | Automated boundary |
| --- | --- |
| Consent, route, policy, auth and unmount revoke a pending lightweight runtime import | `components/tests/epic-replay-provider-runtime.test.tsx` uses the real runtime after delayed module delivery. |
| Revocation during the pipeline import, including a stale import after regrant | `lib/replay/tests/replay-root-runtime.test.ts` checks recorder initialization and registration remain gated. |
| Cross-tab invalidation stops the old producer while auth resolves | `components/tests/epic-replay-provider-runtime.test.tsx` delivers metadata-only BroadcastChannel messages and checks old recorder callbacks cannot enter the new stream. |
| Two document runtimes follow a shared account change without crossing server subjects | `lib/replay/tests/replay-cross-tab-identity.test.ts` exercises real identity/recording/batch routes, Better Auth sessions, SQLite and the synthetic relay. |
| Recovery debt survives remount, policy refresh, route reentry, repeated consent and reload | `lib/replay/tests/replay-root-runtime.test.ts` checks exhausted state/history, explicit restart and the healthy-progress threshold. |
| Lost resume-registration ACK spends its one-shot handoff | `lib/replay/tests/replay-relay-lifecycle.test.ts` checks a budgeted fresh boundary and rejects a copied consumed candidate through the real BFF. |
| Lost resumed-snapshot ACK retries the immutable batch | `lib/replay/tests/replay-relay-lifecycle.test.ts` and `replay-uploader.test.ts` check unchanged request bytes, a single accepted cursor advance, withheld resumed status and bounded retry exhaustion. |
| A fresh build-B document rejects a clean build-A handoff and registers its own release | `lib/replay/tests/replay-relay-lifecycle.test.ts` checks distinct recording/start/key, sequence-zero snapshot acknowledgment, relay release metadata and persisted BFF rows. `replay-evidence-boundary.test.ts` separately keeps the loaded build-A document and frozen evidence unchanged after policy refresh to build-B. |

Keep the independent central `replayBatchSchema` check separate from the regular
test suite so it does not acquire a dependency on an external checkout. Retain
the approved source path, source SHA-256 and assertion results under
`.agent-runs/`, without raw events or credentials. Schema acceptance does not
establish deployed central behavior or Cloud playback. Do not read another
issue's unfinished worktree to close this item.

## WEB-5 marker verification

Complete Setup above first. This is a procedure for the separate Verify phase,
not a claim that browser acceptance has run. Sign in as seeded user-1, open
`/styleguide/replay/upload`, keep **Application relay** selected, grant consent
and wait for a registered recording and opening snapshot receipt. Use
`NEXT_PUBLIC_EPIC_DOCUMENT_RELEASE=synthetic-build-A` when this document is
generated. The in-browser Synthetic target is useful for local controls but
does not establish the root/BFF/local-relay path.

The local relay's `GET /__synthetic/state` now includes `markers`: at most 50
shared-contract-validated summaries from accepted batches, carrying their
recording/batch/sequence and original event timestamp/start/offset. Exact retry
acknowledgments do not duplicate a committed summary. Full payloads, messages,
stacks, report text and credentials are not retained. Use only the synthetic
CLI sentinel shown above; this is not a browser or production diagnostics API.

1. **Behavior occurrences reach the local relay.** Choose Run successful example
   and Run failed example. Expect total 10 and a fixed JSON parse failure,
   respectively. Each has started + succeeded/failed markers sharing one UUID;
   the two operations have different UUIDs. Compare the private Marker summaries
   table with the relay's accepted `markers` after the batch flush. Confirm
   `offsetMs === timestamp - startedAt`, safe integers and the original recording
   association. Type into Harness input and use Navigate afterward. No automatic
   issue creation, confirmed-bug label or playback claim is expected.
2. **Disabled and withdrawn tracking.** Use a fresh signed-in document. Consent
   starts in memory as `unknown`, with no stored consent key. Run the successful
   example before granting: the operation still returns total 10, both tracking
   results are Dropped and no marker reaches the relay. Grant, wait for capture,
   run once, withdraw, and run again. Only the permitted occurrence emits.
   Withdrawal clears pending data, not acknowledged relay history. Keep the
   receipt baseline by recording/occurrence so earlier accepted markers are not
   mistaken for new capture.
3. **Navigate between existing screens.** Expect one initial screen marker for
   the ready recording. Follow Navigate to `/styleguide/replay/upload/second`,
   then browser Back. Each committed pathname transition adds one destination
   marker. Follow Query/hash only on the current page: no new screen view, query
   or fragment appears in marker summaries. Existing route exclusion still
   applies independently of the marker's sanitized route value.
4. **Errors remain single after repeated use.** Choose Raise browser error and
   Reject promise once each. Dismiss a development error overlay normally if
   necessary; the controls deliberately preserve default browser handling.
   Expect exactly one `epic.browser.error` and one
   `epic.browser.unhandled_rejection`, with classification and milliseconds,
   never the synthetic message, stack or rejected object. Restart recording,
   wait for readiness, navigate to the second page and repeat. New markers must
   belong to the replacement recording, without accumulating listener duplicates
   or recursive telemetry. Do not use the Synthetic target to claim automatic
   root-listener acceptance.
5. **Freeze evidence through restart.** Choose Freeze evidence reference and
   record its safe recording/start/release/configVersion/capturedAt/offset fields.
   Restart and wait for a new current recording. The frozen values remain
   unchanged and the current recording differs. Evidence stays unverified;
   no capability, Cloud UUID or raw user identity appears.

Save only sanitized counts, safe summaries and screenshots under `.agent-runs/`
in this checkout, labeled **synthetic local relay**. DOM/readout emission alone
is not proof of upload. Accepted local summaries are not proof of actual central
schema agreement, Builder positioning or Cloud playback. The retained build-A /
refreshed build-B report-context regression and late acknowledgment guard are
technical tests because this checkout has no report-submission UI. No report
endpoint is invented for browser verification.

### WEB-5 automated traceability

| Functional scenario | Owning automated boundary |
| --- | --- |
| Behavior occurrences reach the local relay | Preview-upload Hook tests use the real pinned recorder and synthetic transport; relay/runtime tests separately exercise real BFF, Services and SQLite. Harness component tests cover controls and safe summaries. |
| Disabled and withdrawn tracking | `shared/hooks/tests/use-epic-replay.hook.test.tsx` covers no-provider/SSR defaults; preview-upload Hook tests keep local operation outcomes with dropped capture. Runtime/pipeline tests own permission revocation and absence of deferred emissions. |
| Navigate between existing screens | Root browser-marker/runtime tests own commit/readiness/deduplication; `replay-upload-harness.test.tsx` checks both real route links, including Query/hash only. |
| Errors remain single after repeated use | Browser-marker/runtime tests own classifications, listener cleanup and remount behavior; component tests call the public failure controls. Actual browser error handling is a Verify step. |
| Freeze evidence through restart | Preview-upload Hook tests retain a frozen selected reference across a new recording; shared Hook tests expose immutable build-A context. Evidence/runtime tests own attribution, retry and immutable-release regressions. |

The WEB-5 closeout regressions keep fault injection separate from actual
recorder evidence:

| Technical regression | Owning automated boundary |
| --- | --- |
| A valid public marker exceeds negotiated batch capacity | `replay-markers-runtime.test.ts` negotiates a schema-valid 900-byte capability through synthetic transport with an injected recorder. The 2,048-byte fixture normally fits every allowed ordinary marker. The larger marker passes parsing but returns `marker_too_large` before recorder admission; queue/history stay healthy and a smaller marker is accepted on the same recording. No marker allowlist or production wire limit changes. |
| A recorder or sink throws while processing an error | `replay-capture.test.ts` injects each failure separately with the real browser-marker observer. No recursive emission, queue growth, unhandled rejection or application exception occurs; recovery admits only a new explicit marker. The pinned rrweb marker test in that file uses the actual recorder separately. |
| A report acknowledgment arrives after stop/restart or consent withdrawal | `replay-evidence-boundary.test.ts` uses the public root runtime and injected recorder. Calls while unavailable and after replacement are dropped; only a new current-boundary report reaches synthetic transport, and the frozen build-A bookmark remains byte-stable. |

These are automated local boundary checks, not the five Application relay
browser scenarios. Run those in the separate Verify phase after the preview
owner configures the active loopback relay policy.

For Hook/component changes, run focused tests serially with one worker:

```sh
GOMAXPROCS=2 bun run test 'shared/hooks/tests/use-epic-replay.hook.test.tsx' 'app/styleguide/replay/behaviors/preview-replay-upload/tests/use-preview-replay-upload.hook.test.tsx' 'app/styleguide/replay/components/tests/replay-upload-harness.test.tsx' --maxWorkers=1
```

Run changed core/relay tests separately under the same limits. Lint changed
files and run the project's typecheck once after integration. Do not run a
production build or create a Playwright spec/server. Keep externally supplied
contract verification separate and do not read another issue's unfinished
worktree. EPI-197 owns Builder consumption, EPI-196/EPI-199 own central timeline
millisecond acceptance, and the EPI-211 consumer owns acknowledgment mapping.

## Cleanup

Withdraw consent, close the synthetic app tabs, and stop the fixture terminal
with Ctrl-C. Restore only the temporary environment changes from the private
checkout-local backup through the preview owner; keep its HTTPS URL unchanged.
Use a fresh browser context or clear this synthetic origin's Replay storage for
another run. Stopping the fixture discards all its in-memory data; it does not
delete already uploaded production data. An unresumed handoff can leave an open
synthetic row until process exit; open is not evidence of active capture.

Central/Builder stale-row classification, retention, signed access and actual
Cloud playback still require their owners' authorized validation before
production enablement.
