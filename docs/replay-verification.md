# Synthetic local Replay verification

This fixture is an external API stand-in for WEB-4. It exercises the application's
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
sequence, status and the last 128 batch metadata entries. It never returns event
payloads, real subject identifiers, capability tokens, cookies or credentials.
Registration/event hashes are SHA-256; raw events are discarded after validation.
Memory is bounded to 100 recordings, 2,000 receipts, 1,000 capabilities, 128 call
entries and 10,000 requests, with a 1 MiB request ceiling and 16 connections.
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
modify a Builder destination. The central owner must supply/execute its actual v1
batch schema against the emitted wire payload before claiming cross-contract
acceptance. No second hand-written fake schema establishes that proof.

The automated tests use Vitest with one worker and `GOMAXPROCS=2`. Coverage spans
the real pinned recorder's loading lifecycle, atomic batch packing, revalidation,
monotonic handoff/clone contention, real auth/identity/Route→Service→SQLite, the
runtime through the real BFF against this relay, and frozen evidence/reference
inputs. The latter uses an explicitly synthetic consumer boundary because the
report submission UI/Controller is owned by later issues.

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
