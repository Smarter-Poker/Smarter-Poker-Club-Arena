# Global release policy: bootstrap journal v1

The base journal contract below remains unchanged. The additive, inactive provider runner and
native installation/upgrade implementation are described in [provider-boundary.md](provider-boundary.md).
That slice adds executable provider operations behind installed-identity gates; it does not install,
activate or qualify the global release train.

The release journal is implemented in `operations/release/` and the allocated migration
`supabase/migrations/20260911151748_private_global_release_journal.sql`. The machine-readable
policy is `operations/release/policy.json`. This document describes the current implementation
and its activation boundary. It does not replace the installed release train yet.

**Current status: local runnable journal, OBSERVE only.** No production migration, controller
installation, provider adapter installation, publisher retirement, privilege reassignment, queue
activation, on-demand maintenance activation or 24-hour qualification is established by this
phase. The consumer has no execution branch and never calls GitHub, Hetzner, Vercel, Docker,
production SQL, or a publishing command. Setting a database flag cannot make this consumer publish.
The current engine release owner remains authoritative until its operation is reconciled and an
installed takeover has receipts. See `../handoffs/active-operations.md` for the dated owner record.

Club Arena is the canonical source of this shared policy and journal code. The journal's future
service belongs on verified existing operations capacity, outside the game engine. Club Arena's
engine and static origin remain on Hetzner; World Hub remains in its existing `hub-vanguard`
Vercel project. Workers are a separate existing Hetzner target. The target registry is an admission
allowlist, not evidence that any adapter, provider configuration or new service is installed.

## Durable admission and identity

`release_ops.enqueue(client_key, intent, actor)` takes the singleton controller row lock before
allocating an admission position. That lock remains held through transaction commit. Rollback
returns the counter with the rest of the transaction; independent PostgreSQL sequences are not
used for FIFO. The client library waits for successful COMMIT before printing a queue receipt.
Every mutation uses synchronous commit. An uncertain commit response is resolved by repeating the
same caller key and identical intent, never by manufacturing a fresh request.

Admission fixes the repository, project, target, feature head, optional expected base/PR, declared
manifest, purpose and dependencies. It stores both a canonical intent digest and a manifest digest.
JSON object key order is normalized by PostgreSQL JSONB; dependency IDs are sorted and deduplicated.
Array order within a component manifest remains meaningful. Actor labels and client keys do not
change canonical intent. Canonical identity uses the exact source head and omits observed base/PR
metadata; later observations of the same candidate return the original admission. The full
normalized request has a separate digest for caller-key mismatch detection. Changed dependencies
under the same canonical identity are rejected, not admitted as another release. Two authenticated
callers receive the original ID and position. An accepted candidate head cannot be replaced by a
later branch push; actual integration base and merged source are appended as evidence.

The allowlist requires the repository/project/target tuple to match, and every manifest component
must name an allowed target. Admission purposes are `release`, `documentation`, `redeploy` and
`recovery`. A separate redeploy or recovery admission requires a terminal predecessor. Recovery of
an active release stays inside that release, behind its existing ownership barrier; it is not a
second queue item. This bootstrap does not implement the later source-repair/revert adapter.

Unmet dependencies must already be admitted and cannot be withdrawn. Unknown or future dependencies
fail admission. This ordering plus immutable dependency edges prevents cycles. Withdraw dependents
before their prerequisite. Emergency priority changes are audited, affect queued work only, retain
the immutable admission sequence, preserve dependency order, and never move work ahead of an active
or uncertain operation. Withdrawal after integration is refused: source still on main requires
owned repair/revert and actual reconciliation before progression. The current withdrawal command
accepts queued items only (including the represented blocked-dependency state). Withdrawing an
already claimed pre-merge item remains unsupported in this bootstrap: it requires a trusted
owner procedure proving source was not integrated and accepted external work is terminal. Do not
widen the operator command based solely on the queue's `integrated` flag.

## States, attempts and receipts

The normal journal states are:

`QUEUED -> VALIDATING -> MERGING -> BUILDING -> STAGED -> READY -> APPLYING -> VERIFYING -> VERIFIED`

The schema also represents blocked dependencies, blocked work, integration failure, retry waiting,
unknown external outcome, recovery required, rollback, cancellation and documentation-only
completion. Only the oldest unresolved item can be claimed. An active row occupies the singleton
barrier until verified or an allowed terminal disposition. A blocked release leaves healthy play
running; this journal never locks out tables or players.

Admission data, submission aliases, dependency edges, events and resolution receipts are immutable.
State is versioned separately. Receipts are append-only and idempotent by release and receipt key;
changed data under the same key is rejected. Recording evidence does not select it. The owner
selects an exact receipt in the current phase with an expected state version. The selected chain
links validation, integration, build, staging, readiness and certification. Selecting an upstream
receipt clears its downstream selections. Selection rejects another recovery revision or manifest.
Progression requires the selected evidence, not any historical successful receipt:

| Transition               | Required receipt data                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Into MERGING             | Successful validation of the accepted head, expected base and prospective tree                                                                         |
| Into BUILDING            | Integration identifies the exact merged SHA/tree and links the matching validation                                                                     |
| Into STAGED              | Successful build identifies its artifact, exact source and integration receipt                                                                         |
| Into READY               | Staging links the successful build and verified compatibility                                                                                          |
| Into APPLYING            | Readiness links staging, technical gates and expected current target                                                                                   |
| Into VERIFIED            | Certification links the selected build, provider run, every required served component and exact artifact identity, cleanup and unchanged-release proof |
| Documentation completion | Integration plus evidence of no runtime change; no engine restart required                                                                             |

Provider-native artifacts may use deployment/image identities appropriate to that provider; the
journal does not invent a GitHub build digest for a native Vercel build. Reference documents and
receipts must carry exact input/provenance evidence. SQL validates identity linkage and structure;
it does not independently fetch provider evidence. The installed trusted adapters/verifier must
establish its truth. That boundary is unimplemented and execution remains disabled.

Retries accept only explicitly classified transport/provider-temporary failures, never failed
tests or an uncertain accepted operation. The v1 policy is three attempts with requested retry
delays from 1 to 3,600 seconds. Counts, deadlines, next eligibility and error reasons are persisted;
restart does not reset them. Exhaustion blocks the same active item. Attempt deadlines are explicit
absolute timestamps supplied by the trusted owner. These are release-delivery budgets, not a
change to current maintenance timing. A retry cannot override the immutable deadline of an
already accepted Hetzner request.

`begin_recovery(owner, epoch, release_id, expected_version, recovery_key, intent, actor, reason)`
is a real journal operation for the current authenticated controller session. It starts only for
failed/blocked/integration-failed work or an expired attempt. An unresolved external intent refuses
recovery even after expiration; terminal evidence must first reconcile that operation. A new owner
must reconcile its fresh epoch before beginning or reattaching recovery.

The immutable revision records `failed_release_id`, `prior_attempt_id`, `parent_recovery_id`,
`purpose` (`forward-repair` or `forward-revert`), exact `source_revision`, `expected_base_sha`,
nonempty `scope`, complete `manifest.components`, `expected_current`, `compatibility_evidence`,
`receipt_refs`, `budget_seconds` and absolute `deadline`. The component target set must remain
identical to the admission. The journal gives the revision a new attempt ID, preserving the active
release, original admission, normal attempt count and prior recovery linkage. A repeated recovery
key with identical intent only reattaches; changed intent fails. There are at most three recovery
revisions, each with a positive budget capped at 21,600 seconds. This ceiling does not change any
host maintenance or accepted intake deadline. Exhausted normal retries are never reset.

Recovery starts at VALIDATING with empty receipt selections and the exact recovery source/manifest.
New evidence is stamped with the revision identity; earlier evidence cannot be reselected even if
its source and manifest happen to match. Failed recovery requires another bounded revision, not an
ordinary retry or a direct jump back into the failed phase. Forward repair must complete the full
chain to VERIFIED. Forward revert completes validation/integration/build/staging/readiness, then
ROLLING_BACK and VERIFYING, and terminates as RECOVERED. Its certification must link the revision,
prove source reconciliation and certify the exact rebuilt artifact. RECOVERED releases do not
satisfy feature dependencies; those dependents remain blocked until explicitly withdrawn/replaced.
No force push, provider action or source change is executed by this data-model operation.

## Ownership and external uncertainty

A controller holds PostgreSQL session advisory lock `(77319011, 1)` on its dedicated connection.
It also owns the durable singleton owner UUID, random epoch, monotonic generation and active release
ID. Every new owner session creates a fresh epoch, updates the active row and requires verified
reconciliation. A stale epoch or another database session cannot run execution transitions.
Database unavailability stops new journal authority. This is not fencing of an existing remote
SSH or provider request; the actual adapter must enforce the corresponding mutation boundary.

Before any future external action, `begin_external` commits an immutable operation intent with the
active release, epoch, exact manifest and expected current target. The first committed receipt
permits a future adapter to attempt submission; replay returns the same operation with
`may_submit=false`, meaning reattach only. Loss of the commit response is uncertain, even if a
caller cannot tell whether submission began. There is at most one unresolved external operation
for the active release, and a global guard rejects starting another one.

A lost runner/process or a timeout retains exclusive ownership as `UNKNOWN_EXTERNAL_OUTCOME`.
A new owner converts outstanding intent records to unknown and retains the active barrier.
Only terminal provider evidence, confirmed cancellation or proven nonacceptance can resolve the
record. A convenient current-domain readback or elapsed lease is insufficient. Terminal results
are immutable, changed replay is rejected, and successful provider completion is still separate
from the release's final behavioral certification. The journal does not claim exactly-once
external execution.

Reuse Hetzner's existing run-attempt intake, immutable control generation, sealed result and
observer. The global release UUID/epoch is a separate mapping; never insert it into frozen host v1
fields or rewrite accepted deadlines. Actual provider correlation, host readback and Vercel
promotion adapters remain a subsequent installed workstream.

## Commands and authentication

Install the package's pinned dependencies with `npm ci --ignore-scripts --prefix operations/release`.
Use an existing service-specific database credential through `RELEASE_JOURNAL_DATABASE_URL`.
The safe template is `operations/release/environment.example`. The code does not read repository
`.env` files or fall back to a general `DATABASE_URL`. Never pass a credential on a command line,
commit it, print it or copy a browser identity into this service.

`RELEASE_JOURNAL_CONNECTION_MODE` must explicitly be `direct` or `session`; transaction pooling is
rejected. This configuration declaration is not an installed pooler-mode proof. Verify the actual
endpoint's session behavior and retain its receipt before deployment. The native integration suite
uses a real direct PostgreSQL session, including disconnect/reconnect and advisory-lock behavior.

The migration creates five **NOLOGIN** privilege groups, without credential values or login-role
creation. An installation must bind suitable existing dedicated identities under the reviewed
permission change. Ordinary browser roles receive no schema usage or functions. No group has
write access to tables or private helpers.

| Group                        | Allowed API                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `release_journal_reader`     | paginated inspect, compact observation, schema version                                                                                     |
| `release_journal_submitter`  | enqueue, inspect                                                                                                                           |
| `release_journal_operator`   | retry request, withdrawal, priority change, inspect                                                                                        |
| `release_journal_verifier`   | reconciliation receipt, inspect                                                                                                            |
| `release_journal_controller` | session ownership, claim/transition, record/select receipts, bounded recovery revision, external intent/outcome, retry resumption, inspect |

The database records the authenticated session principal alongside the required actor label.
A label is context, not authorization. Shared unrestricted credentials still permit shared
capabilities; this schema does not prove that the existing GitHub/Vercel/host credentials are
exclusive. Ordinary agents must not receive controller or verifier membership.

Run commands with `node operations/release/cli.mjs`:

| Command        | Required options                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `enqueue`      | `--file intent.json --key CALLER_KEY --actor ACTOR`                                                 |
| `inspect`      | Optional `--id RELEASE_UUID --after ADMISSION_CURSOR --limit 100 --after-event EVENT_CURSOR`        |
| `retry`        | `--id UUID --version STATE_VERSION --after SECONDS --class TRANSPORT --actor ACTOR --reason REASON` |
| `withdraw`     | `--id UUID --version STATE_VERSION --actor ACTOR --reason REASON`                                   |
| `reprioritize` | `--id UUID --before QUEUED_UUID --version STATE_VERSION --actor ACTOR --reason REASON`              |
| `reconcile`    | `--file evidence.json --epoch EPOCH_UUID --observed-event EVENT_NO --actor ACTOR --reason REASON`   |
| `observe`      | Optional `--once` and `--actor ACTOR`                                                               |

An enqueue file is an object with `repository`, `project`, `target`, `head_sha`, `purpose`,
`manifest.components` and `dependencies`. Optional keys are `base_sha`, `pull_request` and the
purpose-specific `related_release_id`. Use full lowercase 40-character commit identities.
A component must include its allowed `target`; keep configuration/migration/checksum and
compatibility details in the immutable manifest. Do not put secrets or raw environment contents
in manifests, reasons or evidence. Inspect returns bounded pages of at most 200 admissions/events
with separate `next_admission` and `next_event` cursors. Exact-release inspection includes bounded
external history; global inspection includes unresolved external operations. Journal history is
retained in PostgreSQL. Every library call checks the supported database schema version before
acting; installing mismatched code and schema fails closed.

Reconciliation requires the exact current instance, epoch and event version, every registered
repository head and target component, the exact unresolved external operation ID set, and nonempty
verified evidence references. Another admitted event makes an older reconciliation snapshot stale.
The verifier authenticates separately and supplies checked external facts; user-provided
`verified:true` is not sufficient outside that trusted boundary. Reconciliation records do not
automatically resolve unknown provider outcomes or enable publication.

## Event loop, backup and restore

The consumer commits LISTEN registration first, then reads durable pending state in a new
transaction. The wakeup query returns only unresolved counts, the oldest item identity/state,
retry eligibility and unresolved external counts; it does not aggregate full ledger history or
manifest payloads. Committed event numbers deduplicate the registration/read overlap. Startup and
reconnection always rescan. Notifications only wake it; they are not the queue. Known retry
deadlines create a bounded wakeup from their persisted timestamp. There is no periodic publisher,
cron discovery loop or workflow handoff chain. The observation consumer reports due retries but
does not execute them. Three bounded connection retries precede a visible failure; an installed
native supervisor is a later deployment concern. Production activation also requires receipts for
the actual existing identity memberships, least-privilege separation, compatible installed schema
version and provider adapters. No self-reported metadata file establishes those capabilities.

Back up this private schema using the database's existing protected backup/PITR facility. Restore
is a reconciliation boundary. Stop new external mutation, reconnect the controller with a fresh
epoch, compare actual repository heads, host intake/seals, images, Vercel operations/domains,
configuration and migration receipts against the restored snapshot, and identify operations newer
than the backup. Never replay restored intents blindly. A fresh random epoch alone does not stop
an old provider operation. Missing terminal evidence retains the barrier. Only the later trusted
installation/activation procedure may enable execution after reconciled capability and adapter
receipts; this bootstrap supplies no activation command.

Native tests use PostgreSQL 17 binaries, isolated databases under `work/release-journal-pg-*` and a
private temporary Unix-socket directory because of macOS socket-path length limits. TCP listening
is disabled. They exercise real commit/rollback/concurrency, lost commit responses, session loss,
notifications, restart and `pg_dump`/`pg_restore`, plus expired recovery attempts, recovery takeover,
UNKNOWN barriers, bounded budgets, exact selected receipt chains and source-reconciled reverts. State-machine tests explicitly install a local
administrative fixture marker to exercise guarded transitions. That marker is not a provider
adapter or a production activation receipt. Tests make zero production reads/writes.

Run `npm test --prefix operations/release`. Production deployment, complete adapter verification,
the four-agent sequential publication demonstration and the engine qualification campaign remain
separate required work; a passing journal test suite does not establish them.
